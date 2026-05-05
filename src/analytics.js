function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function round(value, digits = 1) {
  return Number(Number(value || 0).toFixed(digits));
}

function isRealNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

const QUEUE_ALIASES = new Map([
  ["ladder1v1", "ladder_1v1"],
  ["ladder_1v1", "ladder_1v1"],
  ["tmm2v2", "tmm_2v2"],
  ["tmm_2v2", "tmm_2v2"],
  ["tmm3v3", "tmm_3v3"],
  ["tmm_3v3", "tmm_3v3"],
  ["tmm4v4", "tmm_4v4_full_share"],
  ["tmm_4v4", "tmm_4v4_full_share"],
  ["tmm_4v4_full_share", "tmm_4v4_full_share"],
  ["global", "global"]
]);

const RANKED_QUEUE_TYPES = new Set(["global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share"]);

function normalizeQueueName(value) {
  const raw = String(value || "").trim().toLowerCase();
  return QUEUE_ALIASES.get(raw) || raw;
}

function normalizeQueueFilter(queueFilter) {
  const value = normalizeQueueName(queueFilter);
  if (value === "custom" || value === "unrated" || value === "no_rating_change") {
    return "all";
  }
  const allowed = new Set(["all", "global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share"]);
  return allowed.has(value) ? value : "all";
}

function normalizeGameLimit(value) {
  if (value === null || value === undefined || value === "" || value === "all") {
    return null;
  }
  const limit = Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function getLeaderboardTotalGames(ratings, queueFilter) {
  const filter = normalizeQueueFilter(queueFilter);
  if (!Array.isArray(ratings)) {
    return null;
  }
  if (filter === "all") {
    const total = ratings.reduce((sum, entry) => {
      const ratingType = normalizeQueueName(entry.technicalName || entry.ratingType || entry.name);
      const totalGames = Number(entry.totalGames);
      return RANKED_QUEUE_TYPES.has(ratingType) && Number.isFinite(totalGames) ? sum + totalGames : sum;
    }, 0);
    return Number.isFinite(total) ? total : null;
  }
  const rating = ratings.find((entry) => normalizeQueueName(entry.technicalName || entry.ratingType || entry.name) === filter);
  const totalGames = Number(rating?.totalGames);
  return Number.isFinite(totalGames) ? totalGames : null;
}

function matchesQueueFilter(game, queueFilter) {
  const filter = normalizeQueueFilter(queueFilter);
  if (filter === "all") {
    return true;
  }
  return normalizeQueueName(game.queueCategory) === filter || normalizeQueueName(game.ratingType) === filter;
}

function isDecisiveGame(game) {
  return game.playerOutcome === "WIN" || game.playerOutcome === "LOSS";
}

function isKnownResultGame(game) {
  return game.playerOutcome === "WIN" || game.playerOutcome === "LOSS" || game.playerOutcome === "DRAW";
}

function isDrawGame(game) {
  return game.playerOutcome === "DRAW";
}

function isRankedGame(game) {
  return hasKnownRatingMovement(game);
}

function hasKnownRatingMovement(game) {
  return isKnownResultGame(game)
    && getRatingEntries(game).some((entry) => isRealNumber(entry.delta) && Number(entry.delta) !== 0);
}

function ratingModeName(game, fallback = "unknown") {
  return normalizeQueueName(game.ratingType || game.queueCategory || fallback || "unknown");
}

function displayMapName(name) {
  const value = String(name || "").trim();
  if (!value || value.toLowerCase() === "unknown map") {
    return "Mapgen / generated map";
  }
  return value;
}

function isOneVsOneGame(game) {
  return Array.isArray(game.opponents)
    && game.opponents.length === 1
    && (!Array.isArray(game.teammates) || game.teammates.length === 0);
}

function buildCoverage(sortedGames) {
  const withoutRatingChange = sortedGames.filter((game) => !getRatingEntries(game).length).length;
  const drawGames = sortedGames.filter(isDrawGame).length;
  const withoutKnownResult = sortedGames.filter((game) => !isKnownResultGame(game)).length;
  const withoutRatingMovement = sortedGames.filter((game) => isKnownResultGame(game) && !hasKnownRatingMovement(game)).length;
  const hiddenFromGameHistory = sortedGames.filter((game) => !hasKnownRatingMovement(game)).length;
  const ratingMovementGames = sortedGames.length - hiddenFromGameHistory;
  const ratingMovementGameWord = ratingMovementGames === 1 ? "game" : "games";

  return {
    totalGames: sortedGames.length,
    rankedGames: sortedGames.filter(isRankedGame).length,
    unrankedGames: sortedGames.filter((game) => !isRankedGame(game)).length,
    drawGames,
    withoutRatingChange,
    withoutKnownResult,
    withoutRatingMovement,
    hiddenFromGameHistory,
    notes: [
      `The top W/L, win rate, recent form, and streak cards use only the ${ratingMovementGames} ${ratingMovementGameWord} with actual rating gain or loss.`,
      `${hiddenFromGameHistory} games have no actual rating gain or loss data. They are hidden from Game History and excluded from rating charts, Rating Gain Summary, best/worst days and months, and map rating trends.`,
      `${drawGames} games are draws. Draws are shown in the top cards, and excluded from W/L and streak calculations.`,
      `${withoutKnownResult} games have no known win/loss/draw result. They are excluded from W/L and streak calculations.`
    ].filter((note) => !note.startsWith("0 games"))
  };
}

function getRatingEntries(game) {
  if (Array.isArray(game.ratingChanges) && game.ratingChanges.length) {
    return game.ratingChanges
      .map((entry) => {
        const ratingType = normalizeQueueName(entry.ratingType || entry.leaderboardTechnicalName || "unknown");
        return {
          ratingType,
          delta: isRealNumber(entry.delta) ? Number(entry.delta) : null,
          actualRating: isRealNumber(entry.ratingAfter)
            ? Number(entry.ratingAfter)
            : (isRealNumber(entry.meanAfter) && isRealNumber(entry.deviationAfter)
              ? Number(entry.meanAfter) - 3 * Number(entry.deviationAfter)
              : (isRealNumber(entry.meanAfter) ? Number(entry.meanAfter) : null)),
          ratingSource: isRealNumber(entry.ratingAfter) || (isRealNumber(entry.meanAfter) && isRealNumber(entry.deviationAfter))
            ? "displayed"
            : "trueskill_mean"
        };
      })
      .filter((entry) => entry.ratingType !== "unknown");
  }

  const ratingType = ratingModeName(game);
  if (ratingType === "unknown") {
    return [];
  }

  return [{
    ratingType,
    delta: isRealNumber(game.ratingDelta) ? Number(game.ratingDelta) : null,
    actualRating: isRealNumber(game.ratingAfter) ? Number(game.ratingAfter) : null,
    ratingSource: isRealNumber(game.ratingAfter) ? "displayed" : "unknown"
  }];
}

function ratingMovementTotal(game) {
  return getRatingEntries(game).reduce((sum, entry) => {
    const delta = Number(entry.delta);
    return isRealNumber(entry.delta) ? sum + delta : sum;
  }, 0);
}

function ratingMovementForFilter(game, queueFilter) {
  const filter = normalizeQueueFilter(queueFilter);
  return getRatingEntries(game)
    .filter((entry) => (
      entry.ratingType !== "unknown"
      && isRealNumber(entry.delta)
      && Number(entry.delta) !== 0
      && (filter === "all" || normalizeQueueName(entry.ratingType) === filter)
    ))
    .reduce((sum, entry) => sum + Number(entry.delta), 0);
}

function formatBucket(entries, limit = 8) {
  return entries
    .sort((a, b) => {
      if (b.games !== a.games) {
        return b.games - a.games;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      winRate: round(percent(entry.wins, entry.games)),
      netRatingDelta: round(entry.netRatingDelta || 0, 2),
      ratingGained: round(entry.ratingGained || 0, 2),
      ratingLost: round(entry.ratingLost || 0, 2)
    }));
}

function computeStreak(games) {
  let streak = 0;
  let type = null;

  for (const game of games) {
    if (game.playerOutcome !== "WIN" && game.playerOutcome !== "LOSS") {
      continue;
    }

    const isWin = game.playerOutcome === "WIN";
    if (!type) {
      type = isWin ? "WIN" : "LOSS";
      streak = 1;
      continue;
    }

    if ((type === "WIN" && isWin) || (type === "LOSS" && !isWin)) {
      streak += 1;
      continue;
    }

    break;
  }

  if (!type) {
    return { type: "NONE", size: 0 };
  }

  return { type, size: streak };
}

function monthRangeForGames(games) {
  const monthLabel = (month) => {
    const [year, rawMonth] = String(month || "").split("-");
    const monthIndex = Number(rawMonth) - 1;
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (!year || !names[monthIndex]) {
      return month || "Unknown month";
    }
    return `${names[monthIndex]} ${year}`;
  };
  const months = games
    .map((game) => String(game.startedAt || "").slice(0, 7))
    .filter(Boolean);
  if (!months.length) {
    return "Unknown month";
  }
  const first = months[0];
  const last = months[months.length - 1];
  return first === last ? monthLabel(first) : `${monthLabel(first)} to ${monthLabel(last)}`;
}

function formatStreakRun(type, games) {
  if (!games.length) {
    return {
      type,
      size: 0,
      monthRange: "No games",
      startDate: null,
      endDate: null,
      gameIds: []
    };
  }

  return {
    type,
    size: games.length,
    monthRange: monthRangeForGames(games),
    startDate: String(games[0].startedAt || "").slice(0, 10) || null,
    endDate: String(games[games.length - 1].startedAt || "").slice(0, 10) || null,
    gameIds: games.map((game) => game.id).filter((id) => id != null)
  };
}

function computeMaxStreaks(games) {
  const chronologicalGames = [...games]
    .filter(isDecisiveGame)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  let currentType = null;
  let currentGames = [];
  let bestWinGames = [];
  let bestLossGames = [];

  const commitRun = () => {
    if (currentType === "WIN" && currentGames.length > bestWinGames.length) {
      bestWinGames = [...currentGames];
    }
    if (currentType === "LOSS" && currentGames.length > bestLossGames.length) {
      bestLossGames = [...currentGames];
    }
  };

  for (const game of chronologicalGames) {
    if (game.playerOutcome !== currentType) {
      commitRun();
      currentType = game.playerOutcome;
      currentGames = [game];
    } else {
      currentGames.push(game);
    }
  }
  commitRun();

  return {
    win: formatStreakRun("WIN", bestWinGames),
    loss: formatStreakRun("LOSS", bestLossGames)
  };
}

function buildMonthlyTimeline(sortedGames) {
  const months = new Map();

  for (const game of [...sortedGames].reverse()) {
    if (!hasKnownRatingMovement(game)) {
      continue;
    }

    const key = String(game.startedAt || "").slice(0, 7);
    if (!key) {
      continue;
    }

    const bucket = months.get(key) || { month: key, games: 0, wins: 0, losses: 0, ratingDelta: 0 };
    bucket.games += 1;
    if (game.playerOutcome === "WIN") {
      bucket.wins += 1;
    }
    if (game.playerOutcome === "LOSS") {
      bucket.losses += 1;
    }
    bucket.ratingDelta += ratingMovementTotal(game);
    months.set(key, bucket);
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12)
    .map((entry) => ({
      month: entry.month,
      games: entry.games,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.games - entry.wins - entry.losses,
      winRate: round(percent(entry.wins, entry.wins + entry.losses)),
      ratingDelta: round(entry.ratingDelta, 2)
    }));
}

function buildDailyTimeline(sortedGames) {
  const days = new Map();

  for (const game of [...sortedGames].reverse()) {
    if (!hasKnownRatingMovement(game)) {
      continue;
    }

    const key = String(game.startedAt || "").slice(0, 10);
    if (!key) {
      continue;
    }

    const bucket = days.get(key) || { day: key, games: 0, wins: 0, losses: 0, ratingDelta: 0 };
    bucket.games += 1;
    if (game.playerOutcome === "WIN") {
      bucket.wins += 1;
    }
    if (game.playerOutcome === "LOSS") {
      bucket.losses += 1;
    }
    bucket.ratingDelta += ratingMovementTotal(game);
    days.set(key, bucket);
  }

  return [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((entry) => ({
      day: entry.day,
      games: entry.games,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.games - entry.wins - entry.losses,
      winRate: round(percent(entry.wins, entry.wins + entry.losses)),
      ratingDelta: round(entry.ratingDelta, 2)
    }));
}

function buildRatingTimeline(sortedGames, playerRatings = {}) {
  const points = [...sortedGames]
    .reverse()
    .flatMap((game) => getRatingEntries(game)
      .filter((entry) => isRealNumber(entry.actualRating))
      .map((entry) => ({
        gameId: game.id,
        date: String(game.startedAt || "").slice(0, 10),
        mapName: game.mapName,
        ratingType: entry.ratingType,
        ratingDelta: isRealNumber(entry.delta) ? round(entry.delta, 2) : null,
        actualRating: round(entry.actualRating, 2),
        ratingSource: entry.ratingSource
      })));
  const byType = new Map();
  for (const point of points) {
    const bucket = byType.get(point.ratingType) || [];
    bucket.push(point);
    byType.set(point.ratingType, bucket);
  }
  for (const [ratingType, bucket] of byType.entries()) {
    const currentRating = Number(playerRatings[ratingType]);
    const latestPoint = bucket[bucket.length - 1];
    if (!Number.isFinite(currentRating) || !latestPoint || latestPoint.ratingSource !== "trueskill_mean") {
      continue;
    }
    const offset = currentRating - Number(latestPoint.actualRating || 0);
    for (const point of bucket) {
      point.actualRating = round(Number(point.actualRating || 0) + offset, 2);
      point.ratingSource = "current_rating_adjusted";
    }
  }
  return points;
}

function toHistoryGame(game) {
  return {
    id: game.id,
    startedAt: game.startedAt,
    queueCategory: game.queueCategory,
    ratingType: game.ratingType,
    mapName: game.mapName,
    playerOutcome: game.playerOutcome,
    ratingDelta: round(ratingMovementTotal(game), 2),
    replayId: game.replayId,
    replayUrl: game.replayUrl
  };
}

function toRelationshipGame(game) {
  return {
    id: game.id,
    date: String(game.startedAt || "").slice(0, 10),
    playerOutcome: game.playerOutcome,
    ratingChanges: getRatingEntries(game)
      .filter((entry) => entry.ratingType !== "unknown" && isRealNumber(entry.delta) && Number(entry.delta) !== 0)
      .map((entry) => ({
        ratingType: entry.ratingType,
        delta: round(entry.delta, 2)
      })),
    teammates: (game.teammates || []).map((entry) => entry.login).filter(Boolean),
    opponents: (game.opponents || []).map((entry) => entry.login).filter(Boolean)
  };
}

function buildMonthlyPerformanceByMode(sortedGames) {
  const buckets = new Map();

  for (const game of [...sortedGames].reverse()) {
    if (!hasKnownRatingMovement(game)) {
      continue;
    }

    const key = String(game.startedAt || "").slice(0, 7);
    if (!key) {
      continue;
    }

    const entries = getRatingEntries(game).filter((entry) => (
      entry.ratingType !== "unknown"
      && isRealNumber(entry.delta)
      && Number(entry.delta) !== 0
    ));

    for (const entry of entries) {
      const bucketKey = `${entry.ratingType}:${key}`;
      const bucket = buckets.get(bucketKey) || {
        ratingType: entry.ratingType,
        month: key,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        ratingDelta: 0
      };
      bucket.games += 1;
      if (game.playerOutcome === "WIN") {
        bucket.wins += 1;
      } else if (game.playerOutcome === "LOSS") {
        bucket.losses += 1;
      } else if (game.playerOutcome === "DRAW") {
        bucket.draws += 1;
      }
      bucket.ratingDelta += Number(entry.delta);
      buckets.set(bucketKey, bucket);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || a.ratingType.localeCompare(b.ratingType))
    .slice(-120)
    .map((entry) => ({
      ratingType: entry.ratingType,
      month: entry.month,
      games: entry.games,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      gameScore: entry.wins - entry.losses,
      ratingDelta: round(entry.ratingDelta, 2)
    }));
}

function buildImprovementDetector(sortedGames, monthlyPerformance, dailyPerformance, mapTendencies, allOpponents) {
  const bestMonths = [...monthlyPerformance]
    .filter((entry) => entry.games >= 5)
    .sort((a, b) => b.ratingDelta - a.ratingDelta || b.winRate - a.winRate)
    .slice(0, 12);

  const worstMonths = [...monthlyPerformance]
    .filter((entry) => entry.games >= 5)
    .sort((a, b) => a.ratingDelta - b.ratingDelta || a.winRate - b.winRate)
    .slice(0, 12);

  const bestDays = [...dailyPerformance]
    .filter((entry) => entry.games >= 3)
    .sort((a, b) => b.ratingDelta - a.ratingDelta || b.winRate - a.winRate)
    .slice(0, 12);

  const worstDays = [...dailyPerformance]
    .filter((entry) => entry.games >= 3)
    .sort((a, b) => a.ratingDelta - b.ratingDelta || a.winRate - b.winRate)
    .slice(0, 12);

  let currentLossStreak = 0;
  let worstLossStreak = 0;
  for (const game of [...sortedGames].reverse()) {
    if (game.playerOutcome === "LOSS") {
      currentLossStreak += 1;
      worstLossStreak = Math.max(worstLossStreak, currentLossStreak);
    } else if (game.playerOutcome === "WIN") {
      currentLossStreak = 0;
    }
  }

  const recentWindow = sortedGames.slice(0, 60);
  const recentDates = recentWindow
    .map((game) => String(game.startedAt || "").slice(0, 10))
    .filter(Boolean)
    .sort();
  const recentPeriod = recentDates.length
    ? `${recentDates[0]} to ${recentDates[recentDates.length - 1]}`
    : "recent 60 games";

  const recentMaps = new Map();
  for (const game of recentWindow) {
    if (!hasKnownRatingMovement(game)) {
      continue;
    }
    const key = displayMapName(game.mapName);
    const bucket = recentMaps.get(key) || { name: key, games: 0, ratingDelta: 0 };
    bucket.games += 1;
    bucket.ratingDelta += ratingMovementTotal(game);
    recentMaps.set(key, bucket);
  }
  const recentMapRows = [...recentMaps.values()].filter((entry) => entry.games >= 3);
  const mapsGainingLately = recentMapRows
    .filter((entry) => entry.ratingDelta > 0)
    .sort((a, b) => b.ratingDelta - a.ratingDelta || b.games - a.games)
    .slice(0, 5)
    .map((entry) => ({
      name: entry.name,
      games: entry.games,
      ratingDelta: round(entry.ratingDelta, 2)
    }));
  const mapsLosingLately = recentMapRows
    .filter((entry) => entry.ratingDelta < 0)
    .sort((a, b) => a.ratingDelta - b.ratingDelta || b.games - a.games)
    .slice(0, 5)
    .map((entry) => ({
      name: entry.name,
      games: entry.games,
      ratingDelta: round(entry.ratingDelta, 2)
    }));

  const midpoint = Math.floor(sortedGames.length / 2);
  const earlierGames = sortedGames.slice(midpoint);
  const recentGames = sortedGames.slice(0, midpoint);
  const solvedMap = new Map();

  for (const segment of [
    { label: "early", games: earlierGames },
    { label: "late", games: recentGames }
  ]) {
    for (const game of segment.games) {
      if (!isDecisiveGame(game) || !isOneVsOneGame(game)) {
        continue;
      }
      for (const opponent of game.opponents) {
        const bucket = solvedMap.get(opponent.login) || { name: opponent.login, early: { games: 0, wins: 0 }, late: { games: 0, wins: 0 } };
        bucket[segment.label].games += 1;
        if (game.playerOutcome === "WIN") {
          bucket[segment.label].wins += 1;
        }
        solvedMap.set(opponent.login, bucket);
      }
    }
  }

  const opponentsSolved = [...solvedMap.values()]
    .filter((entry) => entry.early.games >= 3 && entry.late.games >= 3)
    .map((entry) => {
      const earlyWinRate = percent(entry.early.wins, entry.early.games);
      const lateWinRate = percent(entry.late.wins, entry.late.games);
      return {
        name: entry.name,
        earlyWinRate: round(earlyWinRate),
        lateWinRate: round(lateWinRate),
        improvement: round(lateWinRate - earlyWinRate),
        recentGames: entry.late.games
      };
    })
    .filter((entry) => entry.improvement >= 20)
    .sort((a, b) => b.improvement - a.improvement || b.recentGames - a.recentGames)
    .slice(0, 5);

  return {
    bestMonths,
    worstMonths,
    bestDays,
    worstDays,
    worstLossStreak,
    recentMapPeriod: recentPeriod,
    mapsGainingLately,
    mapsLosingLately,
    opponentsSolved,
    bestMapLongTerm: mapTendencies[0] || null,
    hardestOpponentLongTerm: allOpponents[0] || null
  };
}

function buildPlayerReport(player, games, options = {}) {
  const queueFilter = normalizeQueueFilter(options.queueFilter);
  const gameLimit = normalizeGameLimit(options.gameLimit);
  const leaderboardTotalGames = getLeaderboardTotalGames(options.ratings, queueFilter);
  const filteredGames = games.filter((game) => matchesQueueFilter(game, queueFilter));
  const allSortedGames = [...filteredGames].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const sortedGames = gameLimit ? allSortedGames.slice(0, gameLimit) : allSortedGames;
  const rankedGames = sortedGames.filter(isRankedGame);
  const unrankedGames = sortedGames.filter((game) => !isRankedGame(game));
  const ratingMovementGames = sortedGames.filter((game) => hasKnownRatingMovement(game));
  const decisiveGames = sortedGames.filter((game) => game.playerOutcome === "WIN" || game.playerOutcome === "LOSS");
  const rankedDecisiveGames = ratingMovementGames.filter((game) => game.playerOutcome === "WIN" || game.playerOutcome === "LOSS");
  const drawGames = sortedGames.filter(isDrawGame);
  const wins = rankedDecisiveGames.filter((game) => game.playerOutcome === "WIN").length;
  const losses = rankedDecisiveGames.filter((game) => game.playerOutcome === "LOSS").length;
  const recentRankedGames = ratingMovementGames.slice(0, 25);
  const recentRankedDecisiveGames = recentRankedGames.filter((game) => game.playerOutcome === "WIN" || game.playerOutcome === "LOSS");

  const opponents = new Map();
  const teammates = new Map();
  const maps = new Map();
  const ratingTotals = new Map();

  for (const game of sortedGames) {
    const isWin = game.playerOutcome === "WIN";
    const isLoss = game.playerOutcome === "LOSS";
    const mapKey = displayMapName(game.mapName);
    const mapBucket = maps.get(mapKey) || {
      name: mapKey,
      games: 0,
      ratedGames: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      noResultGames: 0,
      noRatingGames: 0,
      ratingDelta: 0,
      opponents: new Map()
    };

    const rated = hasKnownRatingMovement(game);
    mapBucket.games += 1;
    if (rated) {
      mapBucket.ratedGames += 1;
      if (isWin) {
        mapBucket.wins += 1;
      }
      if (isLoss) {
        mapBucket.losses += 1;
        for (const opponent of game.opponents) {
          const value = mapBucket.opponents.get(opponent.login) || 0;
          mapBucket.opponents.set(opponent.login, value + 1);
        }
      }
      if (isDrawGame(game)) {
        mapBucket.draws += 1;
      }
      mapBucket.ratingDelta += ratingMovementTotal(game);
    } else if (!isKnownResultGame(game)) {
      mapBucket.noResultGames += 1;
    } else {
      mapBucket.noRatingGames += 1;
    }
    maps.set(mapKey, mapBucket);

    if (hasKnownRatingMovement(game)) {
      for (const ratingEntry of getRatingEntries(game)) {
        const delta = Number(ratingEntry.delta);
        if (ratingEntry.ratingType === "unknown" || !isRealNumber(ratingEntry.delta) || delta === 0) {
          continue;
        }
        const ratingKey = ratingEntry.ratingType;
        const ratingBucket = ratingTotals.get(ratingKey) || {
          name: ratingKey,
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          totalDelta: 0
        };
        ratingBucket.games += 1;
        if (isWin) {
          ratingBucket.wins += 1;
        }
        if (isLoss) {
          ratingBucket.losses += 1;
        }
        if (isDrawGame(game)) {
          ratingBucket.draws += 1;
        }
        ratingBucket.totalDelta += delta;
        ratingTotals.set(ratingKey, ratingBucket);
      }
    }

    const relationshipRatingDelta = ratingMovementForFilter(game, queueFilter);
    const includeRelationshipGame = relationshipRatingDelta !== 0 && isKnownResultGame(game);

    if (!includeRelationshipGame) {
      continue;
    }

    for (const teammate of game.teammates) {
      const bucket = teammates.get(teammate.login) || {
        name: teammate.login,
        games: 0,
        wins: 0,
        netRatingDelta: 0,
        ratingGained: 0,
        ratingLost: 0
      };
      bucket.games += 1;
      if (isWin) {
        bucket.wins += 1;
      }
      bucket.netRatingDelta += relationshipRatingDelta;
      if (relationshipRatingDelta > 0) {
        bucket.ratingGained += relationshipRatingDelta;
      } else if (relationshipRatingDelta < 0) {
        bucket.ratingLost += Math.abs(relationshipRatingDelta);
      }
      teammates.set(teammate.login, bucket);
    }

    for (const opponent of game.opponents) {
      const bucket = opponents.get(opponent.login) || {
        name: opponent.login,
        games: 0,
        wins: 0,
        netRatingDelta: 0,
        ratingGained: 0,
        ratingLost: 0
      };
      bucket.games += 1;
      if (isWin) {
        bucket.wins += 1;
      }
      bucket.netRatingDelta += relationshipRatingDelta;
      if (relationshipRatingDelta > 0) {
        bucket.ratingGained += relationshipRatingDelta;
      } else if (relationshipRatingDelta < 0) {
        bucket.ratingLost += Math.abs(relationshipRatingDelta);
      }
      opponents.set(opponent.login, bucket);
    }
  }

  const allOpponents = formatBucket([...opponents.values()], 9999);
  const allTeammates = formatBucket([...teammates.values()], 9999);
  const topOpponents = allOpponents.slice(0, 8);
  const topTeammates = allTeammates.slice(0, 8);
  const topMaps = formatBucket([...maps.values()], 8);

  const mapTendencies = [...maps.values()]
    .sort((a, b) => {
      if (b.games !== a.games) {
        return b.games - a.games;
      }
      return a.name.localeCompare(b.name);
    })
    .map((entry) => ({
      name: entry.name,
      games: entry.games,
      ratedGames: entry.ratedGames,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      noResultGames: entry.noResultGames,
      noRatingGames: entry.noRatingGames,
      winRate: round(percent(entry.wins, entry.wins + entry.losses)),
      ratingDelta: round(entry.ratingDelta, 2),
      topLossOpponents: [...entry.opponents.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([name, count]) => ({ name, losses: count }))
    }));

  const ratingSummary = [...ratingTotals.values()]
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      games: entry.games,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      winRate: round(percent(entry.wins, entry.wins + entry.losses)),
      totalDelta: round(entry.totalDelta, 2),
      averageDelta: round(entry.totalDelta / Math.max(entry.games, 1), 2)
    }));

  const overallRatingDelta = round(
    ratingMovementGames.reduce((sum, game) => sum + ratingMovementTotal(game), 0),
    2
  );

  const monthlyPerformance = buildMonthlyTimeline(sortedGames);
  const dailyPerformance = buildDailyTimeline(sortedGames);
  const improvement = buildImprovementDetector(sortedGames, monthlyPerformance, dailyPerformance, mapTendencies, allOpponents);
  const coverage = buildCoverage(sortedGames);
  const rankedGameCount = gameLimit
    ? rankedGames.length
    : (leaderboardTotalGames ?? rankedGames.length);
  const unrankedGameCount = gameLimit
    ? unrankedGames.length
    : Math.max(0, sortedGames.length - rankedGameCount);
  const missingLeaderboardGames = !gameLimit && leaderboardTotalGames != null
    ? Math.max(0, leaderboardTotalGames - rankedGames.length)
    : 0;
  if (missingLeaderboardGames) {
    coverage.notes.push(
      `FAF leaderboard totals include ${leaderboardTotalGames} ${queueFilter} games, but ${missingLeaderboardGames} detailed game-history rows were not returned by the FAF game-history endpoint. Analytics use the ${rankedGames.length} loaded rows.`
    );
  }

  return {
    overview: {
      totalGames: sortedGames.length,
      availableGames: allSortedGames.length,
      gameLimit,
      rankedGames: rankedGameCount,
      missingLeaderboardGames,
      unrankedGames: unrankedGameCount,
      decisiveGames: decisiveGames.length,
      rankedDecisiveGames: rankedDecisiveGames.length,
      draws: drawGames.length,
      wins,
      losses,
      winRate: round(percent(wins, rankedDecisiveGames.length)),
      recentRankedGames: recentRankedGames.length,
      recentWinRate: round(percent(recentRankedDecisiveGames.filter((game) => game.playerOutcome === "WIN").length, recentRankedDecisiveGames.length)),
      averageDurationMinutes: round(average(sortedGames.map((game) => game.durationMinutes))),
      streak: computeStreak(ratingMovementGames),
      maxStreaks: computeMaxStreaks(ratingMovementGames),
      totalRatingDelta: overallRatingDelta
    },
    queueFilter,
    gameLimit,
    topOpponents,
    topTeammates,
    allOpponents,
    allTeammates,
    topMaps,
    mapTendencies,
    ratingSummary,
    coverage,
    allGames: ratingMovementGames.map(toHistoryGame),
    relationshipGames: sortedGames
      .filter((game) => isKnownResultGame(game) && getRatingEntries(game).some((entry) => isRealNumber(entry.delta) && Number(entry.delta) !== 0))
      .map(toRelationshipGame),
    improvement,
    charts: {
      ratingTimeline: buildRatingTimeline(sortedGames, player.ratings || {}),
      monthlyPerformance,
      dailyPerformance,
      monthlyPerformanceByMode: buildMonthlyPerformanceByMode(sortedGames)
    }
  };
}

module.exports = {
  buildPlayerReport,
  isDecisiveGame,
  matchesQueueFilter,
  normalizeQueueFilter
};
