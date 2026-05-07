const crypto = require("crypto");
const WebSocket = require("ws");
const { fafRequest } = require("./faf-client");

const LOBBY_TIMEOUT_MS = Number(process.env.FAF_LOBBY_TIMEOUT_MS || 15000);
const USER_AGENT = process.env.FAF_LOBBY_USER_AGENT || "faf-client";
const CLIENT_VERSION = process.env.FAF_LOBBY_CLIENT_VERSION || "2024.12.0";
const FALLBACK_LOBBY_URL = process.env.FAF_LOBBY_WS_URL || "wss://lobby.faforever.com/";

const QUEUES = [
  { key: "ladder_1v1", label: "1v1 Ladder", shortLabel: "1v1", aliases: ["ladder1v1", "ladder_1v1"] },
  { key: "tmm_2v2", label: "2v2 TMM", shortLabel: "2v2", aliases: ["tmm2v2", "tmm_2v2"] },
  { key: "tmm_3v3", label: "3v3 TMM", shortLabel: "3v3", aliases: ["tmm3v3", "tmm_3v3"] },
  { key: "tmm_4v4_full_share", label: "4v4 TMM", shortLabel: "4v4", aliases: ["tmm4v4", "tmm_4v4", "tmm_4v4_full_share"] }
];

function makeError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function normalizeRange(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  const a = Number(range[0]);
  const b = Number(range[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a <= b ? [a, b] : [b, a];
}

function rangesOverlap(left, right) {
  const a = normalizeRange(left);
  const b = normalizeRange(right);
  return Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);
}

function midpoint(range) {
  const value = normalizeRange(range);
  return value ? Math.round((value[0] + value[1]) / 2) : null;
}

function seconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function normalizeQueueName(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function queueDef(name) {
  const normalized = normalizeQueueName(name);
  return QUEUES.find((queue) => queue.aliases.includes(normalized));
}

function buildSearches(rawQueue) {
  const tight = Array.isArray(rawQueue.boundary_75s) ? rawQueue.boundary_75s : [];
  const wide = Array.isArray(rawQueue.boundary_80s) ? rawQueue.boundary_80s : [];
  const count = Math.max(tight.length, wide.length);
  const searches = Array.from({ length: count }, (_, index) => {
    const tightBand = normalizeRange(tight[index]);
    const wideBand = normalizeRange(wide[index]);
    return {
      id: index + 1,
      label: `Search #${index + 1}`,
      approximateMean: midpoint(tightBand) ?? midpoint(wideBand),
      tightBand,
      wideBand,
      canMatch: []
    };
  });

  for (const search of searches) {
    search.canMatch = searches
      .filter((candidate) => candidate.id !== search.id)
      .map((candidate) => {
        if (rangesOverlap(search.tightBand, candidate.tightBand)) {
          return { id: candidate.id, label: candidate.label, confidence: "tight", reason: "75% band overlap" };
        }
        if (rangesOverlap(search.wideBand, candidate.wideBand)) {
          return { id: candidate.id, label: candidate.label, confidence: "wide", reason: "80% band overlap" };
        }
        return null;
      })
      .filter(Boolean);
  }

  return searches;
}

function normalizeQueue(rawQueue) {
  const name = rawQueue.queue_name || rawQueue.name || "unknown";
  const def = queueDef(name);
  const key = def?.key || normalizeQueueName(name);
  return {
    key,
    label: def?.label || name,
    shortLabel: def?.shortLabel || name,
    rawName: name,
    ratingType: key,
    teamSize: Number(rawQueue.team_size || rawQueue.teamSize || 1) || 1,
    numberOfPlayers: Number(rawQueue.num_players || rawQueue.numberOfPlayers || 0) || 0,
    secondsUntilPop: seconds(rawQueue.queue_pop_time_delta || rawQueue.secondsUntilPop),
    popTime: rawQueue.queue_pop_time || rawQueue.popTime || null,
    searches: buildSearches(rawQueue)
  };
}

function summarizeQueues(rawQueues) {
  const byKey = new Map();
  for (const rawQueue of rawQueues || []) {
    const queue = normalizeQueue(rawQueue || {});
    byKey.set(queue.key, queue);
  }
  return QUEUES.map((queue) => byKey.get(queue.key) || {
    key: queue.key,
    label: queue.label,
    shortLabel: queue.shortLabel,
    rawName: queue.aliases[0],
    ratingType: queue.key,
    teamSize: Number(queue.shortLabel[0]) || 1,
    numberOfPlayers: 0,
    secondsUntilPop: null,
    popTime: null,
    searches: []
  });
}

function normalizeLobbyUrl(value) {
  const raw = String(value || FALLBACK_LOBBY_URL)
    .trim()
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:");
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
    if (typeof candidate === "string" && /^(wss?|https?):\/\//i.test(candidate.trim())) {
      return normalizeLobbyUrl(candidate);
    }
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

function makeUniqueId(sessionId, token) {
  return crypto.createHash("sha256").update(`${sessionId}:${token}:faftracker`).digest("hex");
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
    const socket = new WebSocket(wsUrl, {
      handshakeTimeout: LOBBY_TIMEOUT_MS,
      perMessageDeflate: false,
      headers: { "User-Agent": USER_AGENT }
    });
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
      return makeError(`FAF lobby connection closed before a response was received.${suffix}`, {
        statusCode: 502,
        phase,
        closeCode: closeInfo?.code || null,
        closeReason: closeInfo?.reason || null,
        lobbyUrl
      });
    }

    function push(line) {
      const trimmed = String(line || "").trim();
      if (!trimmed) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(trimmed);
      else messages.push(trimmed);
    }

    function pushPayload(data) {
      buffer += decodeMessage(data);
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || "";
      for (const line of lines) push(line);
      const maybeJson = buffer.trim();
      if (maybeJson.startsWith("{") && maybeJson.endsWith("}")) {
        push(maybeJson);
        buffer = "";
      }
    }

    socket.on("open", () => {
      opened = true;
      clearTimeout(openTimer);
      resolve({
        sendJson(payload) {
          if (socket.readyState !== WebSocket.OPEN) throw closeError("send");
          socket.send(`${JSON.stringify(payload)}\n`);
        },
        readText(timeoutMs = LOBBY_TIMEOUT_MS, phase = "read") {
          if (messages.length) return Promise.resolve(messages.shift());
          if (closed) return Promise.reject(closeError(phase));
          return new Promise((resolveRead, rejectRead) => {
            const waiter = {
              phase,
              resolve(message) { clearTimeout(timer); resolveRead(message); },
              reject(error) { clearTimeout(timer); rejectRead(error); }
            };
            const timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectRead(makeError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl }));
            }, timeoutMs);
            waiters.push(waiter);
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
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter.reject(closeError(waiter.phase || "read"));
      }
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

function isKick(message) {
  return message?.command === "notice" && String(message.style || "").toLowerCase() === "kick";
}

async function waitForMessage(connection, phase, predicate, timeoutMs = LOBBY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await readJson(connection, phase, Math.max(250, deadline - Date.now()));
    if (message?.command === "ping") {
      connection.sendJson({ command: "pong" });
      continue;
    }
    if (isKick(message)) throw makeError("The FAF lobby rejected this session.", { statusCode: 403, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (message?.command === "authentication_failed" || message?.command === "login_failed") throw makeError("FAF lobby login failed.", { statusCode: 401, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (message?.command === "notice" && String(message.style || "").toLowerCase() === "error") throw makeError("FAF lobby returned an error notice.", { statusCode: 502, phase, detail: message.text || null, lobbyUrl: connection.lobbyUrl });
    if (predicate(message)) return message;
  }
  throw makeError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl: connection.lobbyUrl });
}

async function requestMatchmakerInfo(sessionState) {
  const lobbyUrl = await fetchLobbyAccess(sessionState);
  const connection = await connectLobby(lobbyUrl);
  try {
    connection.sendJson({ command: "ask_session", version: CLIENT_VERSION, user_agent: USER_AGENT });
    const sessionMessage = await waitForMessage(connection, "ask_session", (message) => message?.session != null);
    const sessionId = Number(sessionMessage.session);
    if (!Number.isFinite(sessionId)) throw makeError("FAF lobby returned an invalid session id.", { statusCode: 502, phase: "ask_session", lobbyUrl: connection.lobbyUrl });

    connection.sendJson({
      command: "auth",
      token: sessionState.tokenSet.accessToken,
      session: sessionId,
      unique_id: makeUniqueId(sessionId, sessionState.tokenSet.accessToken)
    });
    await waitForMessage(connection, "auth", (message) => message?.command === "welcome" || message?.me);

    connection.sendJson({ command: "matchmaker_info" });
    return waitForMessage(connection, "matchmaker_info", (message) => message?.command === "matchmaker_info" && Array.isArray(message.queues));
  } finally {
    connection.close();
  }
}

async function getLiveQueueSnapshot(sessionState) {
  if (!sessionState.tokenSet?.accessToken) {
    throw makeError("Log in with FAF or paste a fresh FAF access token to inspect live queues.", { statusCode: 401, phase: "auth" });
  }
  const info = await requestMatchmakerInfo(sessionState);
  const rawQueues = Array.isArray(info.queues) ? info.queues : [];
  return {
    ok: true,
    source: "faf-lobby-matchmaker_info",
    fetchedAt: new Date().toISOString(),
    privacyNote: "FAF's lobby only exposes fuzzy live search bands and player counts. It does not expose player names or IDs for queued searches.",
    matchNote: "Can-match suggestions are approximations based on 75%/80% rating-band overlap. The FAF server still uses its TrueSkill quality calculation when it actually pops the queue.",
    queues: summarizeQueues(rawQueues),
    rawQueueCount: rawQueues.length
  };
}

module.exports = { getLiveQueueSnapshot, summarizeQueues };
