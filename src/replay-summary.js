const { fafRequest } = require("./faf-client");

async function fetchReplaySummary(sessionState, replayId) {
  const id = Number(replayId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("Replay id must be a positive integer.");
    error.statusCode = 400;
    throw error;
  }

  const document = await fafRequest(sessionState, `/data/game/${id}`);
  return {
    replay: {
      id,
      title: `Replay #${id}`,
      replayUrl: `https://replay.faforever.com/${id}`
    },
    summary: {
      id,
      title: `Replay #${id}`,
      map: "Unknown map",
      mapPreviewCandidates: [],
      queueLabel: "FAF",
      averageRating: null,
      winner: "Unknown",
      teams: [],
      replayUrl: `https://replay.faforever.com/${id}`
    },
    raw: {
      playerCount: 0,
      hasGame: Boolean(document?.data)
    }
  };
}

module.exports = {
  fetchReplaySummary
};
