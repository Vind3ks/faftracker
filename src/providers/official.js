const { fafRequest } = require("../faf-client");
const { buildIncludedIndex, getRelationshipResource, getRelationshipResources } = require("../jsonapi");
const { getCacheState, writeCache } = require("../player-cache");

const GAME_PAGE_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.FAF_GAME_PAGE_CONCURRENCY || 4)));
const OFFICIAL_CACHE_VERSION = 2;

function providerError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

function parseRatings(document) {
  const includedIndex = buildIncludedIndex(document);

  return (document.data || []).map((resource) => {
    const attrs = resource.attributes || {};
    const leaderboard = getRelationshipResource(resource, "leaderboard", includedIndex);
    return {
      id: Number(resource.id),
      technicalName: normalizeLeaderboardName(leaderboard?.attributes?.technicalName || leaderboard?.attributes?.nameKey || `leaderboard-${resource.id}`),
      rating: attrs.rating,
      mean: attrs.mean,
      deviation: attrs.deviation,
      totalGames: attrs.totalGames,
      wonGames: attrs.wonGames
    };
  });
}

function pickPrimaryRatingChange(ratingChanges) {
  return ratingChanges.find((entry) => entry.leaderboardTechnicalName) || ratingChanges[0] || null;
}

function displayedRating(mean, deviation) {
  if (mean == null) {
    return null;
  }
  const numericMean = Number(mean);
  const numericDeviation = Number(deviation || 0);
  if (!Number.isFinite(numericMean)) {
    return null;
  }
  return numericMean - 3 * (Number.isFinite(numericDeviation) ? numericDeviation : 0);
}

function ratingChangeDelta(entry) {
  const before = displayedRating(entry.meanBefore, entry.deviationBefore);
  const after = displayedRating(entry.meanAfter, entry.deviationAfter);
  if (before == null || after == null) {
    return null;
  }
  return Number((after - before).toFixed(2));
}

function normalizeLeaderboardName(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    ladder1v1: "ladder_1v1",
    tmm2v2: "tmm_2v2",
    tmm3v3: "tmm_3v3",
    tmm4v4: "tmm_4v4_full_share",
    tmm_4v4: "tmm_4v4_full_share"
  };
  return aliases[raw] || raw;
}

function inferQueueCategory(featuredMod, primaryRatingChange, stats) {
  if (primaryRatingChange?.leaderboardTechnicalName) {
    return normalizeLeaderboardName(primaryRatingChange.leaderboardTechnicalName);
  }

  const attrs = featuredMod?.attributes || {};
  const raw = `${attrs.technicalName || ""} ${attrs.displayName || ""} ${attrs.name || ""}`.toLowerCase();
  if (raw.includes("4v4") || raw.includes("tmm4")) {
    return "tmm_4v4_full_share";
  }
  if (raw.includes("3v3") || raw.includes("tmm3")) {
    return "tmm_3v3";
  }
  if (raw.includes("2v2") || raw.includes("tmm2")) {
    return "tmm_2v2";
  }
  if (raw.includes("ladder") || raw.includes("1v1")) {
    return "ladder_1v1";
  }

  return "global";
}

function hasCollapsedTeams(stats) {
  const teams = new Set(stats.map((entry) => entry.team).filter((team) => team != null));
  return teams.size <= 1;
}

function isLegacyBrokenOneVsOne(stats) {
  return stats.length === 2 && hasCollapsedTeams(stats);
}

function getTwoPlayerScoreOutcome(selfStats, stats) {
  if (!Array.isArray(stats) || stats.length !== 2) {
    return null;
  }
  const other = stats.find((entry) => entry.player.id !== selfStats.player.id);
  const selfScore = Number(selfStats.score);
  const otherScore = Number(other?.score);
  if (!Number.isFinite(selfScore) || !Number.isFinite(otherScore)) {
    return null;
  }
  if (selfScore === otherScore) {
    return "DRAW";
  }
  return selfScore > otherScore ? "WIN" : "LOSS";
}

function ratingDeltaFromStatsEntry(entry) {
  if (!Array.isArray(entry?.ratingChanges)) {
    return null;
  }
  const deltas = entry.ratingChanges
    .map(ratingChangeDelta)
    .filter((delta) => delta != null);
  if (!deltas.length) {
    return null;
  }
  return deltas.reduce((sum, delta) => sum + delta, 0);
}

function getTwoPlayerRatingOutcome(selfStats, stats) {
  if (!Array.isArray(stats) || stats.length !== 2) {
    return null;
  }
  const other = stats.find((entry) => entry.player.id !== selfStats.player.id);
  const selfDelta = ratingDeltaFromStatsEntry(selfStats);
  const otherDelta = ratingDeltaFromStatsEntry(other);
  if (!Number.isFinite(selfDelta) || !Number.isFinite(otherDelta)) {
    return null;
  }

  if (selfDelta > 0 && otherDelta < 0) {
    return "WIN";
  }
  if (selfDelta < 0 && otherDelta > 0) {
    return "LOSS";
  }

  return "DRAW";
}

function inferOutcomeFromStats(selfStats, stats, options = {}) {
  const explicit = selfStats.outcome;
  const validity = String(options.validity || "UNKNOWN");
  const queueCategory = normalizeLeaderboardName(options.queueCategory || "unknown");
  const teamCount = new Set(stats.map((entry) => entry.team).filter((team) => team != null)).size;
  const knownOutcomes = stats.map((entry) => entry.outcome).filter((outcome) => outcome && outcome !== "UNKNOWN");
  const allResultsUnknown = stats.length > 0 && stats.every((entry) => !entry.outcome || entry.outcome === "UNKNOWN");
  const hasConflictingOutcome = stats.some((entry) => entry.outcome === "CONFLICTING");

if (
  stats.length === 2 &&
  (validity === "UNKNOWN_RESULT" || hasConflictingOutcome)
) {
  const scoreOutcome = getTwoPlayerScoreOutcome(selfStats, stats);
  if (scoreOutcome) {
    return scoreOutcome;
  }

  const ratingOutcome = getTwoPlayerRatingOutcome(selfStats, stats);
  if (ratingOutcome) {
    return ratingOutcome;
  }
}

  if (queueCategory === "ladder_1v1" && allResultsUnknown) {
    const scoreOutcome = getTwoPlayerScoreOutcome(selfStats, stats);
    if (scoreOutcome) {
      return scoreOutcome;
    }

    const ratingOutcome = getTwoPlayerRatingOutcome(selfStats, stats);
    if (ratingOutcome) {
      return ratingOutcome;
    }
  }

  if (
    queueCategory === "ladder_1v1" &&
    validity === "TOO_MANY_DESYNCS" &&
    allResultsUnknown
  ) {
    const scoreOutcome = getTwoPlayerScoreOutcome(selfStats, stats);
    if (scoreOutcome === "DRAW") {
      return "DRAW";
    }
  }

  if (teamCount >= 2 && knownOutcomes.length >= 2 && knownOutcomes.every((outcome) => outcome === "DEFEAT")) {
    return "DRAW";
  }
  if (explicit === "VICTORY") {
    return "WIN";
  }
  if (explicit === "DEFEAT") {
    return "LOSS";
  }
  if (explicit === "DRAW") {
    return "DRAW";
  }
  if (explicit && explicit !== "UNKNOWN") {
    return explicit;
  }

  if (isLegacyBrokenOneVsOne(stats)) {
    const scoreOutcome = getTwoPlayerScoreOutcome(selfStats, stats);
    if (scoreOutcome && scoreOutcome !== "DRAW") {
      return scoreOutcome;
    }
  }

  const teamScores = new Map();
  for (const entry of stats) {
    const teamKey = entry.team;
    const score = Number(entry.score);
    if (!Number.isFinite(score) || teamKey == null) {
      continue;
    }
    const current = teamScores.get(teamKey);
    if (current == null || score > current) {
      teamScores.set(teamKey, score);
    }
  }

  if (!teamScores.size || selfStats.team == null || !teamScores.has(selfStats.team)) {
    return explicit || "UNKNOWN";
  }

  const sortedScores = [...teamScores.entries()].sort((left, right) => right[1] - left[1]);
  const topScore = sortedScores[0][1];
  const topTeams = sortedScores.filter((entry) => entry[1] === topScore).map((entry) => entry[0]);
  if (topTeams.length !== 1) {
    return topTeams.length > 1 ? "DRAW" : (explicit || "UNKNOWN");
  }

  return topTeams[0] === selfStats.team ? "WIN" : "LOSS";
}

function inferOutcomeFromRatingDelta(ratingDelta) {
  if (ratingDelta > 0) {
    return "WIN";
  }
  if (ratingDelta < 0) {
    return "LOSS";
  }
  return null;
}

function ratingDeltaFromGame(game) {
  if (Number.isFinite(Number(game?.ratingDelta)) && Number(game.ratingDelta) !== 0) {
    return Number(game.ratingDelta);
  }
  if (!Array.isArray(game?.ratingChanges)) {
    return 0;
  }
  return game.ratingChanges.reduce((sum, entry) => {
    const delta = Number(entry.delta);
    return Number.isFinite(delta) ? sum + delta : sum;
  }, 0);
}

function meanDeltaFromGame(game) {
  if (!Array.isArray(game?.ratingChanges)) {
    return null;
  }
  const deltas = game.ratingChanges
    .map((entry) => {
      const before = Number(entry.meanBefore);
      const after = Number(entry.meanAfter);
      return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
    })
    .filter((delta) => delta != null);
  if (!deltas.length) {
    return null;
  }
  return deltas.reduce((sum, delta) => sum + delta, 0);
}

function applyRatingOutcomeOverrides(games) {
  return (games || []).map((game) => {
    if (game.playerOutcome === "DRAW" || game.apiPlayerOutcome === "DRAW") {
      return {
        ...game,
        playerOutcome: "DRAW",
        apiPlayerOutcome: game.apiPlayerOutcome || "DRAW"
      };
    }
    const meanDelta = meanDeltaFromGame(game);
    if (game.playerOutcome === "LOSS" && meanDelta != null && meanDelta > 0) {
      return {
        ...game,
        apiPlayerOutcome: game.apiPlayerOutcome || game.playerOutcome,
        playerOutcome: "DRAW"
      };
    }
    const ratingOutcome = inferOutcomeFromRatingDelta(ratingDeltaFromGame(game));
    if (!ratingOutcome || game.playerOutcome === ratingOutcome) {
      return game;
    }
    return {
      ...game,
      apiPlayerOutcome: game.apiPlayerOutcome || game.playerOutcome,
      playerOutcome: ratingOutcome
    };
  });
}

function normalizeGame(document, playerId) {
  const includedIndex = buildIncludedIndex(document);

  return (document.data || []).map((resource) => {
    const attrs = resource.attributes || {};
    const mapVersion = getRelationshipResource(resource, "mapVersion", includedIndex);
    const map = mapVersion ? getRelationshipResource(mapVersion, "map", includedIndex) : null;
    const featuredMod = getRelationshipResource(resource, "featuredMod", includedIndex);
    const stats = getRelationshipResources(resource, "playerStats", includedIndex)
      .map((statResource) => {
        const player = getRelationshipResource(statResource, "player", includedIndex);
        const ratingChanges = getRelationshipResources(statResource, "ratingChanges", includedIndex).map((ratingResource) => {
          const leaderboard = getRelationshipResource(ratingResource, "leaderboard", includedIndex);
          return {
            leaderboardTechnicalName: normalizeLeaderboardName(leaderboard?.attributes?.technicalName || null),
            meanBefore: ratingResource.attributes?.meanBefore ?? null,
            deviationBefore: ratingResource.attributes?.deviationBefore ?? null,
            meanAfter: ratingResource.attributes?.meanAfter ?? null,
            deviationAfter: ratingResource.attributes?.deviationAfter ?? null
          };
        });

        return {
          id: Number(statResource.id),
          team: statResource.attributes?.team,
          outcome: statResource.attributes?.result || "UNKNOWN",
          score: statResource.attributes?.score ?? null,
          faction: statResource.attributes?.faction || null,
          player: player
            ? {
                id: Number(player.id),
                login: player.attributes?.login || `player-${player.id}`
              }
            : null,
          ratingChanges
        };
      })
      .filter((entry) => entry.player);

    const selfStats = stats.find((entry) => entry.player.id === Number(playerId));
    if (!selfStats) {
      return null;
    }

    const primaryRatingChange = pickPrimaryRatingChange(selfStats.ratingChanges);
    const ratingDelta = selfStats.ratingChanges.reduce((sum, entry) => {
      const delta = ratingChangeDelta(entry);
      if (delta == null) {
        return sum;
      }
      return sum + delta;
    }, 0);
    const queueCategory = inferQueueCategory(featuredMod, primaryRatingChange, stats);
    const inferredOutcome = inferOutcomeFromStats(selfStats, stats, {
      queueCategory,
      validity: attrs.validity || "UNKNOWN"
    });
    const ratingOutcome = inferOutcomeFromRatingDelta(ratingDelta);

    const brokenOneVsOne = isLegacyBrokenOneVsOne(stats);
    const teammates = stats
      .filter((entry) => {
        if (entry.player.id === Number(playerId)) {
          return false;
        }
        if (brokenOneVsOne) {
          return false;
        }
        return entry.team === selfStats.team;
      })
      .map((entry) => ({
        login: entry.player.login,
        rating: entry.ratingChanges[0]?.meanBefore ? Math.round(displayedRating(entry.ratingChanges[0].meanBefore, entry.ratingChanges[0].deviationBefore)) : null
      }));

    const opponents = stats
      .filter((entry) => {
        if (entry.player.id === Number(playerId)) {
          return false;
        }
        if (brokenOneVsOne) {
          return true;
        }
        return entry.team !== selfStats.team;
      })
      .map((entry) => ({
        login: entry.player.login,
        rating: entry.ratingChanges[0]?.meanBefore ? Math.round(displayedRating(entry.ratingChanges[0].meanBefore, entry.ratingChanges[0].deviationBefore)) : null
      }));

    return {
      id: Number(resource.id),
      startedAt: attrs.startTime,
      endedAt: attrs.endTime,
      durationMinutes: attrs.startTime && attrs.endTime
        ? Math.max(1, Math.round((new Date(attrs.endTime) - new Date(attrs.startTime)) / 60000))
        : 0,
      mapName: map?.attributes?.displayName || mapVersion?.attributes?.filename || "Mapgen / generated map",
      queueLabel: featuredMod?.attributes?.displayName || featuredMod?.attributes?.technicalName || "FAF",
      queueCategory,
      validity: attrs.validity || "UNKNOWN",
      ratingType: normalizeLeaderboardName(primaryRatingChange?.leaderboardTechnicalName || "unknown"),
      ratingDelta: Number(ratingDelta.toFixed(2)),
      ratingBefore: displayedRating(primaryRatingChange?.meanBefore, primaryRatingChange?.deviationBefore),
      ratingAfter: displayedRating(primaryRatingChange?.meanAfter, primaryRatingChange?.deviationAfter),
      playerOutcome: inferredOutcome === "DRAW" ? "DRAW" : (ratingOutcome || inferredOutcome),
      apiPlayerOutcome: inferredOutcome,
      replayId: Number(resource.id),
      replayUrl: attrs.replayUrl || `https://replay.faforever.com/${resource.id}`,
      ratingChanges: selfStats.ratingChanges.map((entry) => ({
        ratingType: normalizeLeaderboardName(entry.leaderboardTechnicalName || "unknown"),
        meanBefore: entry.meanBefore,
        meanAfter: entry.meanAfter,
        deviationBefore: entry.deviationBefore,
        deviationAfter: entry.deviationAfter,
        ratingBefore: displayedRating(entry.meanBefore, entry.deviationBefore),
        ratingAfter: displayedRating(entry.meanAfter, entry.deviationAfter),
        delta: ratingChangeDelta(entry)
      })),
      teammates,
      opponents
    };
  }).filter(Boolean);
}

async function fetchAllGames(sessionState, playerId, onProgress) {
  const games = [];
  const include = "featuredMod,mapVersion,mapVersion.map,playerStats,playerStats.player,playerStats.ratingChanges,playerStats.ratingChanges.leaderboard";
  const gamesFilter = encodeURIComponent(`playerStats.player.id==${playerId};endTime=isnull=false`);
  const pageSize = 100;

  const fetchPage = async (pageNumber) => {
    const gamesDoc = await fafRequest(
      sessionState,
      `/data/game?filter=${gamesFilter}&sort=-startTime&include=${include}&page%5Bsize%5D=${pageSize}&page%5Bnumber%5D=${pageNumber}`
    );
    return {
      pageNumber,
      rawCount: (gamesDoc.data || []).length,
      games: normalizeGame(gamesDoc, playerId)
    };
  };

  for (let batchStart = 1; batchStart <= 250; batchStart += GAME_PAGE_CONCURRENCY) {
    const pageNumbers = Array.from(
      { length: Math.min(GAME_PAGE_CONCURRENCY, 251 - batchStart) },
      (_, index) => batchStart + index
    );
    const batchEnd = pageNumbers[pageNumbers.length - 1];
    if (onProgress) {
      onProgress({
        stage: "games",
        percent: Math.min(94, 14 + batchStart * 1.5),
        pageNumber: batchStart,
        fetchedGames: games.length,
        message: batchStart === batchEnd
          ? `Fetching game history page ${batchStart}...`
          : `Fetching game history pages ${batchStart}-${batchEnd}...`
      });
    }

    const pages = await Promise.all(pageNumbers.map(fetchPage));
    pages
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .forEach((page) => games.push(...page.games));

    if (onProgress) {
      onProgress({
        stage: "games",
        percent: Math.min(96, 14 + batchEnd * 1.5),
        pageNumber: batchEnd,
        fetchedGames: games.length,
        message: `Fetched ${games.length} games so far...`
      });
    }

    if (pages.some((page) => page.rawCount < pageSize)) {
      break;
    }
  }
  
  console.log("FETCHED GAME DEBUG", {
    totalFetchedGames: games.length,
    first20Ids: games.slice(0, 20).map((g) => ({
      id: g.id,
      date: g.startedAt,
      outcome: g.playerOutcome,
      queue: g.queueCategory,
    })),
    last50Ids: games.slice(-50).map((g) => ({
      id: g.id,
      date: g.startedAt,
      outcome: g.playerOutcome,
      queue: g.queueCategory,
    })),
  });

  return games;
}

async function fetchLivePlayerReport(playerRef, sessionState, onProgress) {
  onProgress?.({
    stage: "player",
    percent: 4,
    fetchedGames: 0,
    message: `Looking up player ${playerRef}...`
  });

  const playerFilter = encodeURIComponent(`login=="${playerRef}"`);
  const playerDoc = await fafRequest(sessionState, `/data/player?filter=${playerFilter}&page%5Bsize%5D=1`);
  const playerResource = playerDoc.data?.[0];

  if (!playerResource) {
    throw providerError(`No FAF player found for "${playerRef}".`, {
      statusCode: 404
    });
  }

  const playerId = Number(playerResource.id);
  onProgress?.({
    stage: "ratings",
    percent: 10,
    fetchedGames: 0,
    message: "Loading ratings and queue stats..."
  });
  const [ratingsDoc, games] = await Promise.all([
    fafRequest(
      sessionState,
      `/data/leaderboardRating?filter=${encodeURIComponent(`player.id==${playerId}`)}&include=leaderboard&page%5Bsize%5D=50`
    ),
    fetchAllGames(sessionState, playerId, onProgress)
  ]);

  const ratings = parseRatings(ratingsDoc);
  const correctedGames = applyRatingOutcomeOverrides(games);
  onProgress?.({
    stage: "done",
    percent: 100,
    fetchedGames: correctedGames.length,
    message: `Loaded ${correctedGames.length} games. Building report...`
  });

  const payload = {
    player: {
      id: playerId,
      login: playerResource.attributes?.login || playerRef,
      country: null,
      joinedAt: null,
      ratings: Object.fromEntries(
        ratings.map((entry) => [entry.technicalName, Math.round(entry.rating ?? ((entry.mean || 0) - 3 * (entry.deviation || 0)))])
      )
    },
    games: correctedGames,
    meta: {
      source: "official",
      note: "Live data from the authenticated FAF API.",
      ratings,
      historyDepth: correctedGames.length,
      cacheStatus: "live",
      providerCacheVersion: OFFICIAL_CACHE_VERSION,
      lastFetchedAt: new Date().toISOString()
    }
  };

  writeCache(playerRef, {
    fetchedAt: new Date().toISOString(),
    player: payload.player,
    games: payload.games,
    meta: payload.meta
  });

  return payload;
}

function withCachedMeta(payload, cacheStatus, ageMs) {
  const noteByCacheStatus = {
    fresh: "Loaded instantly from local cache.",
    stale: "Loaded from local cache and refreshed from FAF when possible.",
    "stale-refreshing": "Loaded stale local cache instantly and started a background FAF sync.",
    live: "Live data from the authenticated FAF API."
  };

  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      cacheStatus,
      cacheAgeMinutes: ageMs == null ? null : Math.round(ageMs / 60000),
      lastFetchedAt: payload.meta?.lastFetchedAt || payload.fetchedAt || null,
      note: noteByCacheStatus[cacheStatus] || payload.meta?.note || null
    }
  };
}

function createOfficialProvider() {
  return {
    async getStatus({ sessionState }) {
      if (!sessionState.tokenSet) {
        return {
          ok: false,
          label: "Login required",
          detail: "Sign in with FAF to use the official provider."
        };
      }

      try {
        await fafRequest(sessionState, "/me");
        return {
          ok: true,
          label: "Ready",
          detail: "Authenticated FAF API access is available."
        };
      } catch (error) {
        return {
          ok: false,
          label: `HTTP ${error.statusCode || "error"}`,
          detail: error.payload?.error_description || error.payload?.detail || error.message
        };
      }
    },

    async getPlayerReport(playerRef, { sessionState, onProgress, forceRefresh }) {
      const cacheState = getCacheState(playerRef);
      const cachedPayload = cacheState.payload?.meta?.providerCacheVersion === OFFICIAL_CACHE_VERSION
        ? {
            fetchedAt: cacheState.payload.fetchedAt,
            player: cacheState.payload.player,
            games: applyRatingOutcomeOverrides(cacheState.payload.games),
            meta: cacheState.payload.meta
          }
        : null;

      if (!forceRefresh && cachedPayload) {
        onProgress?.({
          stage: "cache",
          percent: 100,
          fetchedGames: cachedPayload.games.length,
          message: cacheState.stale
            ? `Loaded ${cachedPayload.games.length} cached games. Cache is stale.`
            : `Loaded ${cachedPayload.games.length} cached games instantly.`
        });
        return withCachedMeta(cachedPayload, cacheState.stale ? "stale" : "fresh", cacheState.ageMs);
      }

      if (!sessionState.tokenSet) {
        if (cachedPayload) {
          onProgress?.({
            stage: "cache",
            percent: 100,
            fetchedGames: cachedPayload.games.length,
            message: `Loaded ${cachedPayload.games.length} cached games. Log in with FAF for newest data.`
          });
          return withCachedMeta(cachedPayload, cacheState.stale ? "stale" : "fresh", cacheState.ageMs);
        }
        throw providerError("No current local cache is available, and FAF login is required to fetch this player.", {
          statusCode: 401,
          detail: "Log in with FAF, then try again. Older cached reports are ignored because the legacy Ladder outcome rules changed."
        });
      }

      if (forceRefresh) {
        try {
          return await fetchLivePlayerReport(playerRef, sessionState, onProgress);
        } catch (error) {
          if (!cachedPayload) {
            throw error;
          }
          onProgress?.({
            stage: "cache",
            percent: 100,
            fetchedGames: cachedPayload.games.length,
            message: `FAF refresh failed, loaded ${cachedPayload.games.length} cached games instead.`
          });
          const fallback = withCachedMeta(cachedPayload, cacheState.stale ? "stale" : "fresh", cacheState.ageMs);
          fallback.meta.note = `FAF refresh failed (${error.message}). Showing cached data instead.`;
          fallback.meta.refreshError = error.message;
          return fallback;
        }
      }

      return fetchLivePlayerReport(playerRef, sessionState, onProgress);
    }
  };
}

module.exports = {
  createOfficialProvider
};
