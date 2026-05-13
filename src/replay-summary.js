const { fafRequest } = require("./faf-client");
const { buildIncludedIndex, getRelationshipResource, getRelationshipResources } = require("./jsonapi");

function fail(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function displayedRating(mean, deviation) {
  const m = Number(mean);
  const d = Number(deviation || 0);
  return Number.isFinite(m) ? m - 3 * (Number.isFinite(d) ? d : 0) : null;
}

function normalizeQueue(value) {
  const raw = String(value || "").trim().toLowerCase();
  return {
    ladder1v1: "ladder_1v1",
    tmm2v2: "tmm_2v2",
    tmm3v3: "tmm_3v3",
    tmm4v4: "tmm_4v4_full_share",
    tmm_4v4: "tmm_4v4_full_share"
  }[raw] || raw;
}

function queueLabel(queue, fallback) {
  return {
    ladder_1v1: "Ladder 1v1",
    tmm_2v2: "TMM 2v2",
    tmm_3v3: "TMM 3v3",
    tmm_4v4_full_share: "TMM 4v4",
    global: "Global"
  }[normalizeQueue(queue)] || fallback || "FAF";
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length) : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function mapFolderName(filename) {
  return String(filename || "").replace(/^maps\//i, "").replace(/\.zip$/i, "") || null;
}

function mapPreviewCandidates(mapVersion) {
  const attrs = mapVersion?.attributes || {};
  const folder = mapFolderName(attrs.filename);
  const preview = folder ? `${folder}.png` : null;
  return unique([
    attrs.thumbnailUrlLarge,
    attrs.thumbnailUrlSmall,
    preview ? `https://content.faforever.com/faf/vault/map_previews/large/${encodeURIComponent(preview)}` : null,
    preview ? `https://content.faforever.com/faf/vault/map_previews/small/${encodeURIComponent(preview)}` : null
  ]);
}

function ratingChanges(stat, includedIndex) {
  return getRelationshipResources(stat, "ratingChanges", includedIndex).map((rating) => {
    const leaderboard = getRelationshipResource(rating, "leaderboard", includedIndex);
    const attrs = rating.attributes || {};
    const ratingBefore = displayedRating(attrs.meanBefore, attrs.deviationBefore);
    const ratingAfter = displayedRating(attrs.meanAfter, attrs.deviationAfter);
    return {
      leaderboard: normalizeQueue(leaderboard?.attributes?.technicalName || leaderboard?.attributes?.nameKey || ""),
      ratingBefore,
      ratingAfter,
      rating: ratingBefore == null ? null : Math.round(ratingBefore),
      delta: ratingBefore == null || ratingAfter == null ? null : Number((ratingAfter - ratingBefore).toFixed(2))
    };
  });
}

function inferQueue(featuredMod, stats) {
  const fromRating = stats.flatMap((entry) => entry.ratingChanges).find((entry) => entry.leaderboard)?.leaderboard;
  if (fromRating) return normalizeQueue(fromRating);
  const attrs = featuredMod?.attributes || {};
  const raw = `${attrs.technicalName || ""} ${attrs.displayName || ""}`.toLowerCase();
  if (raw.includes("4v4")) return "tmm_4v4_full_share";
  if (raw.includes("3v3")) return "tmm_3v3";
  if (raw.includes("2v2")) return "tmm_2v2";
  if (raw.includes("ladder") || raw.includes("1v1")) return "ladder_1v1";
  return "global";
}

function parseStats(game, includedIndex) {
  return getRelationshipResources(game, "playerStats", includedIndex).map((stat) => {
    const player = getRelationshipResource(stat, "player", includedIndex);
    if (!player) return null;
    const attrs = stat.attributes || {};
    return {
      player: {
        id: Number(player.id),
        login: player.attributes?.login || `player-${player.id}`
      },
      team: attrs.team ?? null,
      outcome: attrs.result || "UNKNOWN",
      score: attrs.score == null ? null : Number(attrs.score),
      faction: attrs.faction || null,
      ratingChanges: ratingChanges(stat, includedIndex)
    };
  }).filter(Boolean);
}

function teamGroups(stats) {
  const explicit = unique(stats.map((entry) => entry.team));
  if (explicit.length >= 2) {
    return explicit.sort((a, b) => Number(a) - Number(b)).map((team) => stats.filter((entry) => entry.team === team));
  }
  if (stats.length === 2) return stats.map((entry) => [entry]);
  const winners = stats.filter((entry) => ["VICTORY", "WIN"].includes(entry.outcome));
  const others = stats.filter((entry) => !["VICTORY", "WIN"].includes(entry.outcome));
  return winners.length && others.length ? [winners, others] : (stats.length ? [stats] : []);
}

function playerFromStat(stat, queue) {
  const rating = stat.ratingChanges.find((entry) => entry.leaderboard === queue) || stat.ratingChanges[0] || {};
  return {
    id: stat.player.id,
    login: stat.player.login,
    faction: stat.faction,
    outcome: stat.outcome,
    score: stat.score,
    ratingType: rating.leaderboard || queue,
    rating: rating.rating ?? null,
    ratingBefore: rating.ratingBefore == null ? null : Math.round(rating.ratingBefore),
    ratingAfter: rating.ratingAfter == null ? null : Math.round(rating.ratingAfter),
    ratingDelta: rating.delta ?? null
  };
}

function inferWinner(teams) {
  const winners = teams.filter((team) => team.players.some((player) => ["VICTORY", "WIN"].includes(player.outcome)));
  if (winners.length === 1) return winners[0].label;
  const scored = teams.map((team) => ({ team, score: average(team.players.map((player) => player.score)) })).filter((entry) => entry.score != null).sort((a, b) => b.score - a.score);
  if (scored.length >= 2 && scored[0].score > scored[1].score) return scored[0].team.label;
  const deltas = teams.map((team) => ({ team, delta: team.players.reduce((sum, player) => sum + (Number(player.ratingDelta) || 0), 0) })).sort((a, b) => b.delta - a.delta);
  if (deltas.length >= 2 && deltas[0].delta > 0 && deltas[0].delta > deltas[1].delta) return deltas[0].team.label;
  return "Unknown";
}

function buildReplaySummary(document, replayId) {
  const includedIndex = buildIncludedIndex(document);
  const game = Array.isArray(document.data) ? document.data[0] : document.data;
  if (!game) fail(`Replay ${replayId} was not found.`, 404);

  const attrs = game.attributes || {};
  const mapVersion = getRelationshipResource(game, "mapVersion", includedIndex);
  const map = mapVersion ? getRelationshipResource(mapVersion, "map", includedIndex) : null;
  const featuredMod = getRelationshipResource(game, "featuredMod", includedIndex);
  const stats = parseStats(game, includedIndex);
  const queue = inferQueue(featuredMod, stats);
  const teams = teamGroups(stats).map((group, index) => {
    const players = group.map((stat) => playerFromStat(stat, queue)).sort((a, b) => a.login.localeCompare(b.login));
    return { label: `Team ${index + 1}`, averageRating: average(players.map((player) => player.rating)), players };
  });
  const startedAt = attrs.startTime || null;
  const endedAt = attrs.endTime || null;
  const durationSeconds = startedAt && endedAt ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000)) : null;
  const replayUrl = attrs.replayUrl || `https://replay.faforever.com/${game.id}`;

  return {
    replay: { id: Number(game.id), title: attrs.name || `Replay #${game.id}`, replayUrl, validity: attrs.validity || null },
    summary: {
      id: Number(game.id),
      title: attrs.name || `Replay #${game.id}`,
      map: map?.attributes?.displayName || mapVersion?.attributes?.filename || "Unknown map",
      mapFolderName: mapFolderName(mapVersion?.attributes?.filename),
      mapPreviewCandidates: mapPreviewCandidates(mapVersion),
      queueCategory: queue,
      queueLabel: queueLabel(queue, featuredMod?.attributes?.displayName || featuredMod?.attributes?.technicalName),
      averageRating: average(teams.flatMap((team) => team.players.map((player) => player.rating))),
      winner: inferWinner(teams),
      startedAt,
      endedAt,
      durationSeconds,
      durationMinutes: durationSeconds == null ? null : Math.max(1, Math.round(durationSeconds / 60)),
      replayUrl,
      teams
    },
    raw: { validity: attrs.validity || null, playerCount: stats.length }
  };
}

async function fetchReplaySummary(sessionState, replayId) {
  const id = Number(replayId);
  if (!Number.isSafeInteger(id) || id <= 0) fail("Replay id must be a positive integer.", 400);
  const include = "featuredMod,mapVersion,mapVersion.map,playerStats,playerStats.player,playerStats.ratingChanges,playerStats.ratingChanges.leaderboard";
  const document = await fafRequest(sessionState, `/data/game/${id}?include=${encodeURIComponent(include)}`);
  return buildReplaySummary(document, id);
}

module.exports = { buildReplaySummary, fetchReplaySummary };
