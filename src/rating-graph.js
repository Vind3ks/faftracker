
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

function queueLabel(queue) {
  return {
    ladder_1v1: "Ladder 1v1",
    tmm_2v2: "TMM 2v2",
    tmm_3v3: "TMM 3v3",
    tmm_4v4_full_share: "TMM 4v4",
    global: "Global"
  }[normalizeQueue(queue)] || queue || "FAF";
}

function parseDays(value) {
  const days = Number(value || 365);
  if (!Number.isFinite(days)) return 365;
  return Math.max(1, Math.min(3650, Math.round(days)));
}

function cleanPlayers(value) {
  return String(value || "")
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, list) => list.findIndex((x) => x.toLowerCase() === entry.toLowerCase()) === index)
    .slice(0, 5);
}

function getGameQueue(game) {
  return normalizeQueue(game.queueCategory || game.ratingType || "");
}

function getRatingPoint(game, queue) {
  const changes = Array.isArray(game.ratingChanges) ? game.ratingChanges : [];
  const matchingChange = changes.find((entry) => normalizeQueue(entry.ratingType) === queue) || changes[0] || null;

  const ratingAfter = Number(game.ratingAfter ?? matchingChange?.ratingAfter);
  const ratingBefore = Number(game.ratingBefore ?? matchingChange?.ratingBefore);

  if (Number.isFinite(ratingAfter)) return Math.round(ratingAfter);
  if (Number.isFinite(ratingBefore)) return Math.round(ratingBefore);
  return null;
}

function buildSeriesFromGames(playerName, games, options) {
  const queue = normalizeQueue(options.queue || "ladder_1v1");
  const since = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const byDay = new Map();

  for (const game of games || []) {
    const dateValue = game.startedAt || game.endedAt;
    if (!dateValue) continue;

    const time = new Date(dateValue).getTime();
    if (!Number.isFinite(time) || time < since) continue;
    if (getGameQueue(game) !== queue) continue;

    const rating = getRatingPoint(game, queue);
    if (rating == null) continue;

    const day = new Date(time).toISOString().slice(0, 10);
    byDay.set(day, {
      date: day,
      rating,
      replayId: game.replayId || game.id || null
    });
  }

  return {
    player: playerName,
    points: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

async function buildPlayerGraphPayload(provider, sessionState, options) {
  const players = cleanPlayers(options.players);
  const queue = normalizeQueue(options.queue || "ladder_1v1");
  const days = parseDays(options.days);

  if (!players.length) {
    const error = new Error("Provide at least one player.");
    error.statusCode = 400;
    throw error;
  }

  const series = [];
  const errors = [];

  for (const player of players) {
    try {
      const payload = await provider.getPlayerReport(player, {
        sessionState,
        forceRefresh: Boolean(options.forceRefresh)
      });
      const builtSeries = buildSeriesFromGames(payload.player?.login || player, payload.games || [], { queue, days });

      let currentRating = Number(payload.player?.ratings?.[queue]);

      // Fetch only live leaderboard ratings for the final point.
      // This avoids loading a full report just to update the newest graph value.
      if (typeof provider.getPlayerCurrentRatings === "function" && sessionState?.tokenSet) {
        try {
          const currentPayload = await provider.getPlayerCurrentRatings(payload.player?.login || player, {
            sessionState
          });

          const liveRating = Number(currentPayload.player?.ratings?.[queue]);
          if (Number.isFinite(liveRating)) {
            currentRating = liveRating;
          }
        } catch (ratingError) {
          // Keep graph working even if the lightweight live rating call fails.
        }
      }

      const lastPoint = builtSeries.points[builtSeries.points.length - 1];

      if (Number.isFinite(currentRating)) {
        const today = new Date().toISOString().slice(0, 10);
        const lastRating = lastPoint ? Number(lastPoint.rating) : null;

        if (!lastPoint || Math.round(lastRating) !== Math.round(currentRating)) {
          builtSeries.points.push({
            date: today,
            rating: Math.round(currentRating),
            replayId: null,
            source: "current"
          });
        }
      }

      series.push(builtSeries);
    } catch (error) {
      errors.push({
        player,
        error: error.message || String(error)
      });
      series.push({
        player,
        points: [],
        error: error.message || String(error)
      });
    }
  }

  return {
    queue,
    queueLabel: queueLabel(queue),
    days,
    players,
    series,
    errors
  };
}

module.exports = {
  buildPlayerGraphPayload,
  cleanPlayers
};
