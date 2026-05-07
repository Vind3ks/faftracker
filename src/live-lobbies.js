const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const WebSocket = require("ws");
const { fafRequest } = require("./faf-client");

const LOBBY_TIMEOUT_MS = Number(process.env.FAF_LOBBY_TIMEOUT_MS || 15000);
const LOBBY_COLLECT_MS = Number(process.env.FAF_LOBBY_COLLECT_MS || 2500);
const USER_AGENT = process.env.FAF_LOBBY_USER_AGENT || "faf-client";
const CLIENT_VERSION = process.env.FAF_LOBBY_CLIENT_VERSION || "2024.12.0";
const FALLBACK_LOBBY_URL = process.env.FAF_LOBBY_WS_URL || "wss://lobby.faforever.com/";

function makeError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

function avatarForPlayer(player) {
  const seed = encodeURIComponent(String(player.id || player.login || "player"));
  return `https://api.dicebear.com/7.x/initials/svg?seed=${seed}&radius=50&fontWeight=700`;
}

function normalizeLobbyUrl(value) {
  const raw = String(value || FALLBACK_LOBBY_URL).trim().replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const url = new URL(raw);
  url.pathname = url.searchParams.has("verify") ? "/" : (url.pathname || "/").replace(/\/{2,}/g, "/");
  return url.toString();
}

function safeUrlInfo(value) {
  try {
    const url = new URL(value);
    return { protocol: url.protocol, host: url.host, pathname: url.pathname || "/", hasQuery: Boolean(url.search) };
  } catch {
    return { protocol: "unknown", host: "unknown", pathname: "unknown", hasQuery: false };
  }
}

function getAccessUrl(payload) {
  const candidates = typeof payload === "string" ? [payload] : [
    payload?.accessUrl,
    payload?.access_url,
    payload?.url,
    payload?.data?.accessUrl,
    payload?.data?.access_url,
    payload?.data?.url,
    payload?.data?.attributes?.accessUrl,
    payload?.data?.attributes?.access_url,
    payload?.data?.attributes?.["access-url"]
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^(wss?|https?):\/\//i.test(candidate.trim())) return normalizeLobbyUrl(candidate);
  }
  return null;
}

function safePayloadShape(payload) {
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  return {
    type: "object",
    topLevelKeys: Object.keys(payload).slice(0, 20),
    dataKeys: payload.data && typeof payload.data === "object" ? Object.keys(payload.data).slice(0, 20) : [],
    attributeKeys: payload.data?.attributes && typeof payload.data.attributes === "object" ? Object.keys(payload.data.attributes).slice(0, 20) : []
  };
}

async function fetchLobbyAccess(sessionState) {
  await fafRequest(sessionState, "/me");
  if (process.env.FAF_LOBBY_WS_URL) return normalizeLobbyUrl(process.env.FAF_LOBBY_WS_URL);
  const response = await fetch(`${sessionState.config.userBaseUrl.replace(/\/+$/g, "")}/lobby/access`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${sessionState.tokenSet.accessToken}`,
      ["X-" + "HMAC"]: sessionState.tokenSet.hmac,
      "User-Agent": USER_AGENT
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    throw makeError(`Unable to obtain FAF lobby access (HTTP ${response.status}).`, {
      statusCode: response.status,
      phase: "lobby-access",
      detail: payload?.message || payload?.error || payload?.detail || null,
      hint: "Log in with FAF again or paste a fresh access token from the FAF client."
    });
  }
  const accessUrl = getAccessUrl(payload);
  if (accessUrl) return accessUrl;
  if (process.env.FAF_ALLOW_LOBBY_URL_FALLBACK === "1") return normalizeLobbyUrl(FALLBACK_LOBBY_URL);
  throw makeError("FAF lobby access response did not contain a usable websocket URL.", {
    statusCode: 502,
    phase: "lobby-access-parse",
    detail: JSON.stringify(safePayloadShape(payload))
  });
}

function existingFile(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : null;
}

function fafUidCandidates() {
  const appData = process.env.APPDATA || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  return [
    process.env.FAF_UID_PATH,
    path.join(process.cwd(), "faf-uid.exe"),
    path.join(process.cwd(), "faf-uid"),
    path.join(appData, "Forged Alliance Forever", "faf-uid.exe"),
    path.join(localAppData, "Programs", "Forged Alliance Forever", "faf-uid.exe"),
    path.join(localAppData, "Forged Alliance Forever", "faf-uid.exe"),
    path.join(programFiles, "Forged Alliance Forever", "faf-uid.exe"),
    path.join(programFilesX86, "Forged Alliance Forever", "faf-uid.exe")
  ].filter(Boolean);
}

function makeUniqueId(sessionId) {
  const uidTool = fafUidCandidates().map(existingFile).find(Boolean);
  if (!uidTool) {
    const fallback = process.env.FAF_ALLOW_FAKE_UID === "1"
      ? crypto.createHash("sha256").update(`${os.hostname()}:${os.userInfo().username}:${sessionId}:faftracker`).digest("hex")
      : null;
    if (fallback) return fallback;
    throw makeError("Could not find FAF's faf-uid helper required for lobby auth.", {
      statusCode: 500,
      phase: "auth-uid",
      hint: "Set FAF_UID_PATH to the full path of faf-uid.exe from your FAF client install, or copy faf-uid.exe into this project folder."
    });
  }
  try {
    const output = execFileSync(uidTool, [String(sessionId)], { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim();
    if (!output) throw new Error("faf-uid produced no output");
    return output;
  } catch (error) {
    throw makeError(`faf-uid failed: ${error.message}`, { statusCode: 500, phase: "auth-uid", hint: "Run the FAF client once and make sure Windows Management Instrumentation service is running." });
  }
}

function decodeMessage(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data || "");
}

function connectLobby(rawUrl) {
  const wsUrl = normalizeLobbyUrl(rawUrl);
  const lobbyUrl = safeUrlInfo(wsUrl);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: LOBBY_TIMEOUT_MS, perMessageDeflate: false, headers: { "User-Agent": USER_AGENT } });
    const messages = [];
    const waiters = [];
    let buffer = "";
    let opened = false;
    let closed = false;
    let closeInfo = null;
    const openTimer = setTimeout(() => {
      socket.terminate();
      reject(makeError("Timed out while opening FAF lobby websocket.", { statusCode: 504, phase: "websocket-open", lobbyUrl }));
    }, LOBBY_TIMEOUT_MS);

    function closeError(phase = "read") {
      const suffix = closeInfo ? ` Close code: ${closeInfo.code || "unknown"}${closeInfo.reason ? `, reason: ${closeInfo.reason}` : ""}.` : "";
      return makeError(`FAF lobby connection closed before a response was received.${suffix}`, { statusCode: 502, phase, closeCode: closeInfo?.code || null, closeReason: closeInfo?.reason || null, lobbyUrl });
    }
    function push(line) {
      const trimmed = String(line || "").trim();
      if (!trimmed) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(trimmed); else messages.push(trimmed);
    }
    function pushPayload(data) {
      buffer += decodeMessage(data);
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || "";
      for (const line of lines) push(line);
      const maybeJson = buffer.trim();
      if (maybeJson.startsWith("{") && maybeJson.endsWith("}")) { push(maybeJson); buffer = ""; }
    }

    socket.on("open", () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        sendJson(payload) {
          if (socket.readyState !== WebSocket.OPEN) throw closeError("send");
          socket.send(Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"), { binary: true });
        },
        readText(timeoutMs = LOBBY_TIMEOUT_MS, phase = "read") {
          if (messages.length) return Promise.resolve(messages.shift());
          if (closed) return Promise.reject(closeError(phase));
          return new Promise((resolveRead, rejectRead) => {
            const waiter = { phase, resolve(message) { clearTimeout(timer); resolveRead(message); }, reject(error) { clearTimeout(timer); rejectRead(error); } };
            const timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectRead(makeError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl }));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        drainMessages() {
          return messages.splice(0).map((text) => {
            try { return JSON.parse(text); } catch { return { command: "unknown", raw: text }; }
          });
        },
        close() { try { socket.close(1000, "done"); } catch { socket.terminate(); } },
        lobbyUrl
      });
    });
    socket.on("message", pushPayload);
    socket.on("close", (code, reason) => {
      closed = true;
      clearTimeout(openTimer);
      closeInfo = { code, reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "") };
      if (!opened) return reject(closeError("websocket-open"));
      while (waiters.length) { const waiter = waiters.shift(); waiter.reject(closeError(waiter.phase || "read")); }
    });
    socket.on("error", (error) => {
      clearTimeout(openTimer);
      if (!opened) reject(makeError(`Unable to connect to FAF lobby: ${error.message}`, { statusCode: 502, phase: "websocket-open", lobbyUrl }));
    });
  });
}

async function readJson(connection, phase, timeoutMs = LOBBY_TIMEOUT_MS) {
  const text = await connection.readText(timeoutMs, phase);
  try { return JSON.parse(text); } catch { return { command: "unknown", raw: text }; }
}

function isKick(message) { return message?.command === "notice" && String(message.style || "").toLowerCase() === "kick"; }

async function waitForMessage(connection, phase, predicate, timeoutMs = LOBBY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await readJson(connection, phase, Math.max(250, deadline - Date.now()));
    if (message?.command === "ping") { connection.sendJson({ command: "pong" }); continue; }
    if (isKick(message)) throw makeError("The FAF lobby rejected this session.", { statusCode: 403, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (message?.command === "authentication_failed" || message?.command === "login_failed") throw makeError("FAF lobby login failed.", { statusCode: 401, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (message?.command === "notice" && String(message.style || "").toLowerCase() === "error") throw makeError("FAF lobby returned an error notice.", { statusCode: 502, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (predicate(message)) return message;
  }
  throw makeError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl: connection.lobbyUrl });
}

async function authenticateLobby(sessionState) {
  const lobbyUrl = await fetchLobbyAccess(sessionState);
  const connection = await connectLobby(lobbyUrl);
  connection.sendJson({ command: "ask_session", version: CLIENT_VERSION, user_agent: USER_AGENT });
  const sessionMessage = await waitForMessage(connection, "ask_session", (message) => message?.session != null);
  const sessionId = Number(sessionMessage.session);
  if (!Number.isFinite(sessionId)) throw makeError("FAF lobby returned an invalid session id.", { statusCode: 502, phase: "ask_session", lobbyUrl: connection.lobbyUrl });
  connection.sendJson({ command: "auth", token: sessionState.tokenSet.accessToken, unique_id: makeUniqueId(sessionId) });
  await waitForMessage(connection, "auth", (message) => message?.command === "welcome" || message?.me);
  return connection;
}

function normalizeTeams(game) {
  const teams = game.teams && typeof game.teams === "object" ? game.teams : {};
  const teamsIds = Array.isArray(game.teams_ids) ? game.teams_ids : [];
  const idByLogin = new Map();
  for (const team of teamsIds) {
    const teamId = String(team.team_id ?? "unknown");
    const logins = Array.isArray(teams[teamId]) ? teams[teamId] : [];
    const ids = Array.isArray(team.player_ids) ? team.player_ids : [];
    logins.forEach((login, index) => { if (login && ids[index] != null) idByLogin.set(String(login), Number(ids[index])); });
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

async function collectGameInfo(connection) {
  const games = new Map();
  const deadline = Date.now() + LOBBY_COLLECT_MS;
  while (Date.now() < deadline) {
    let message = null;
    try {
      message = await readJson(connection, "game_info", Math.max(250, deadline - Date.now()));
    } catch (error) {
      if (error.statusCode === 504) break;
      throw error;
    }
    if (message?.command === "ping") {
      connection.sendJson({ command: "pong" });
      continue;
    }
    if (message?.command === "game_info") {
      const game = normalizeLobby(message);
      if (game.id && game.state === "open") games.set(game.id, game);
      if (game.id && game.state !== "open") games.delete(game.id);
    }
  }
  for (const message of connection.drainMessages()) {
    if (message?.command === "game_info") {
      const game = normalizeLobby(message);
      if (game.id && game.state === "open") games.set(game.id, game);
      if (game.id && game.state !== "open") games.delete(game.id);
    }
  }
  return [...games.values()].sort((a, b) => b.numPlayers - a.numPlayers || a.title.localeCompare(b.title));
}

async function getLiveLobbiesSnapshot(sessionState) {
  if (!sessionState.tokenSet?.accessToken) throw makeError("Log in with FAF or paste a fresh FAF access token to inspect live lobbies.", { statusCode: 401, phase: "auth" });
  const connection = await authenticateLobby(sessionState);
  try {
    const lobbies = await collectGameInfo(connection);
    return {
      ok: true,
      source: "faf-lobby-game_info",
      fetchedAt: new Date().toISOString(),
      warning: "This endpoint briefly logs into the FAF lobby as your account to collect open game_info messages. FAF may allow only one active lobby connection per account.",
      lobbies,
      count: lobbies.length
    };
  } finally {
    connection.close();
  }
}

module.exports = { getLiveLobbiesSnapshot, normalizeLobby };
