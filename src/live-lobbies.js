const { getLiveQueueSnapshot } = require("./live-queue");

function makeError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

function avatarForPlayer(player) {
  const seed = encodeURIComponent(String(player.id || player.login || "player"));
  return `https://api.dicebear.com/7.x/initials/svg?seed=${seed}&radius=50&fontWeight=700`;
}

function normalizeTeams(game) {
  const teams = game.teams && typeof game.teams === "object" ? game.teams : {};
  const teamsIds = Array.isArray(game.teams_ids) ? game.teams_ids : [];
  const idByLogin = new Map();

  for (const team of teamsIds) {
    const teamId = String(team.team_id ?? "unknown");
    const logins = Array.isArray(teams[teamId]) ? teams[teamId] : [];
    const ids = Array.isArray(team.player_ids) ? team.player_ids : [];
    logins.forEach((login, index) => {
      if (login && ids[index] != null) idByLogin.set(String(login), Number(ids[index]));
    });
  }

  const normalized = Object.entries(teams).map(([teamId, logins]) => ({
    teamId,
    players: (Array.isArray(logins) ? logins : []).map((login) => {
      const id = idByLogin.get(String(login)) || null;
      const player = { id, login: String(login || "Unknown") };
      return { ...player, avatarUrl: avatarForPlayer(player), trackerUrl: `/?player=${encodeURIComponent(player.login)}` };
    })
  })).filter((team) => team.players.length);

  if (!normalized.length && game.host) {
    const player = { id: null, login: String(game.host) };
    return [{ teamId: "host", players: [{ ...player, avatarUrl: avatarForPlayer(player), trackerUrl: `/?player=${encodeURIComponent(player.login)}` }] }];
  }

  return normalized;
}

function normalizeLobby(game) {
  const teams = normalizeTeams(game);
  const players = teams.flatMap((team) => team.players);
  return {
    id: Number(game.uid || game.id || 0),
    title: String(game.title || game.name || "Untitled lobby"),
    state: String(game.state || "unknown"),
    visibility: String(game.visibility || "public"),
    passwordProtected: Boolean(game.password_protected),
    featuredMod: String(game.featured_mod || game.featuredMod || "faf"),
    gameType: String(game.game_type || game.gameType || "custom"),
    mapName: String(game.mapname || game.map_file_path || "Unknown map"),
    host: String(game.host || "Unknown host"),
    numPlayers: Number(game.num_players || players.length || 0),
    maxPlayers: Number(game.max_players || 0),
    hostedAt: game.hosted_at || null,
    launchedAt: game.launched_at || null,
    ratingType: game.rating_type || null,
    ratingMin: Number.isFinite(Number(game.rating_min)) ? Number(game.rating_min) : null,
    ratingMax: Number.isFinite(Number(game.rating_max)) ? Number(game.rating_max) : null,
    enforceRatingRange: Boolean(game.enforce_rating_range),
    teams,
    players
  };
}

async function getLiveLobbiesSnapshot(sessionState) {
  // Placeholder implementation note:
  // live-queue already authenticates into the lobby, but it only asks for matchmaker_info.
  // This helper is intentionally separate so the server route can be added without changing queue behavior.
  throw makeError("Live open lobbies need a lobby game_info collector. This branch has the UI scaffold, but the collector is not wired yet.", {
    statusCode: 501,
    phase: "not-implemented",
    hint: "The FAF REST API does not expose pre-launch open lobbies; true open lobbies require FAF lobby websocket game_info messages."
  });
}

module.exports = {
  getLiveLobbiesSnapshot,
  normalizeLobby
};
