const crypto = require("crypto");
const WebSocket = require("ws");

const { fafRequest } = require("./faf-client");

const DEFAULT_LOBBY_URL = process.env.FAF_LOBBY_WS_URL || "wss://lobby.faforever.com/";
const LOBBY_TIMEOUT_MS = Number(process.env.FAF_LOBBY_TIMEOUT_MS || 15000);
const USER_AGENT = process.env.FAF_LOBBY_USER_AGENT || "faf-client";
const CLIENT_VERSION = process.env.FAF_LOBBY_CLIENT_VERSION || "2024.12.0";

const QUEUE_DEFINITIONS = [
  { key: "ladder_1v1", label: "1v1 Ladder", shortLabel: "1v1", aliases: ["ladder1v1", "ladder_1v1"], ratingType: "ladder_1v1" },
  { key: "tmm_2v2", label: "2v2 TMM", shortLabel: "2v2", aliases: ["tmm2v2", "tmm_2v2"], ratingType: "tmm_2v2" },
  { key: "tmm_3v3", label: "3v3 TMM", shortLabel: "3v3", aliases: ["tmm3v3", "tmm_3v3"], ratingType: "tmm_3v3" },
  { key: "tmm_4v4_full_share", label: "4v4 TMM", shortLabel: "4v4", aliases: ["tmm4v4", "tmm_4v4", "tmm_4v4_full_share"], ratingType: "tmm_4v4_full_share" }
];

function createError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

function normalizeQueueName(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function findQueueDefinition(name) {
  const normalized = normalizeQueueName(name);
  return QUEUE_DEFINITIONS.find((definition) => definition.aliases.includes(normalized)) || null;
}

function normalizeRange(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  const first = Number(range[0]);
  const second = Number(range[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return first <= second ? [first, second] : [second, first];
}

function rangeMidpoint(range) {
  const normalized = normalizeRange(range);
  return normalized ? Math.round((normalized[0] + normalized[1]) / 2) : null;
}

function rangesOverlap(left, right) {
  const leftRange = normalizeRange(left);
  const rightRange = normalizeRange(right);
  return Boolean(leftRange && rightRange && leftRange[0] <= rightRange[1] && rightRange[0] <= leftRange[1]);
}

function roundSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null;
}

function buildSearches(rawQueue) {
  const boundary75s = Array.isArray(rawQueue.boundary_75s) ? rawQueue.boundary_75s : [];
  const boundary80s = Array.isArray(rawQueue.boundary_80s) ? rawQueue.boundary_80s : [];
  const searchCount = Math.max(boundary75s.length, boundary80s.length);
  const searches = Array.from({ length: searchCount }, (_, index) => {
    const tightBand = normalizeRange(boundary75s[index]);
    const wideBand = normalizeRange(boundary80s[index]);
    return {
      id: index + 1,
      label: `Search #${index + 1}`,
      approximateMean: rangeMidpoint(tightBand) ?? rangeMidpoint(wideBand),
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
  const definition = findQueueDefinition(rawQueue.queue_name || rawQueue.name);
  const fallbackName = normalizeQueueName(rawQueue.queue_name || rawQueue.name || "unknown");
  return {
    key: definition?.key || fallbackName,
    label: definition?.label || rawQueue.queue_name || rawQueue.name || "Unknown queue",
    shortLabel: definition?.shortLabel || rawQueue.queue_name || rawQueue.name || "Queue",
    rawName: rawQueue.queue_name || rawQueue.name || fallbackName,
    ratingType: definition?.ratingType || fallbackName,
    teamSize: Number(rawQueue.team_size || rawQueue.teamSize || 1) || 1,
    numberOfPlayers: Number(rawQueue.num_players || rawQueue.numberOfPlayers || 0) || 0,
    secondsUntilPop: roundSeconds(rawQueue.queue_pop_time_delta || rawQueue.secondsUntilPop),
    popTime: rawQueue.queue_pop_time || rawQueue.popTime || null,
    searches: buildSearches(rawQueue)
  };
}

function summarizeQueues(rawQueues) {
  const queuesByKey = new Map();
  for (const rawQueue of rawQueues || []) {
    const normalized = normalizeQueue(rawQueue || {});
    queuesByKey.set(normalized.key, normalized);
  }
  return QUEUE_DEFINITIONS.map((definition) => queuesByKey.get(definition.key) || {
    key: definition.key,
    label: definition.label,
    shortLabel: definition.shortLabel,
    rawName: definition.aliases[0],
    ratingType: definition.ratingType,
    teamSize: Number(definition.shortLabel[0]) || 1,
    numberOfPlayers: 0,
    secondsUntilPop: null,
    popTime: null,
    searches: []
  });
}

function normalizeLobbyUrl(rawUrl) {
  return String(rawUrl || DEFAULT_LOBBY_URL)
    .trim()
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:")
    // FAF Python client workaround for QTBUG-120492: the lobby access URL can be
    // returned as wss://host?verify=..., but the websocket endpoint expects /?verify=...
    .replace("?verify", "/?verify");
}

function safeLobbyUrlInfo(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port || null,
      pathname: url.pathname || "/",
      hasQuery: Boolean(url.search)
    };
  } catch (error) {
    return { protocol: "unknown", host: "unknown", hostname: "unknown", port: null, pathname: "unknown", hasQuery: false };
  }
}

function extractLobbyAccessUrl(payload) {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (/^(wss?|https?):\/\//i.test(trimmed)) return normalizeLobbyUrl(trimmed);
  }

  const candidates = [
    payload?.accessUrl,
    payload?.access_url,
    payload?.url,
    payload?.data?.accessUrl,
    payload?.data?.access_url,
    payload?.data?.url,
    payload?.data?.attributes?.accessUrl,
    payload?.data?.attributes?.access_url,
    payload?.data?.attributes?.["access-url"],
    payload?.attributes?.accessUrl,
    payload?.attributes?.access_url,
    payload?.attributes?.["access-url"]
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^(wss?|https?):\/\//i.test(candidate.trim())) {
      return normalizeLobbyUrl(candidate);
    }
  }

  return null;
}

function sanitizeLobbyAccessPayload(payload) {
  if (typeof payload === "string") {
    return /^(wss?|https?):\/\//i.test(payload.trim()) ? safeLobbyUrlInfo(normalizeLobbyUrl(payload.trim())) : { type: "string", length: payload.length };
  }
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  const topLevelKeys = Object.keys(payload).slice(0, 20);
  const dataKeys = payload.data && typeof payload.data === "object" ? Object.keys(payload.data).slice(0, 20) : [];
  const attributeKeys = payload.data?.attributes && typeof payload.data.attributes === "object" ? Object.keys(payload.data.attributes).slice(0, 20) : [];
  return { type: "object", topLevelKeys, dataKeys, attributeKeys };
}

function decodeLobbyLine(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data || "");
}

async function connectLobby(rawUrl) {
  const wsUrl = normalizeLobbyUrl(rawUrl || DEFAULT_LOBBY_URL);
  const urlInfo = safeLobbyUrlInfo(wsUrl);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      handshakeTimeout: LOBBY_TIMEOUT_MS,
      perMessageDeflate: false,
      headers: { "User-Agent": USER_AGENT }
    });
    const messages = [];
    const waiters = [];
    let lineBuffer = "";
    let opened = false;
    let closed = false;
    let closeInfo = null;

    const startupTimeout = setTimeout(() => {
      socket.terminate();
      reject(createError("Timed out while opening FAF lobby websocket.", { statusCode: 504, phase: "websocket-open", lobbyUrl: urlInfo }));
    }, LOBBY_TIMEOUT_MS);

    function makeCloseError(phase = "websocket") {
      const suffix = closeInfo ? ` Close code: ${closeInfo.code || "unknown"}${closeInfo.reason ? `, reason: ${closeInfo.reason}` : ""}.` : "";
      return createError(`FAF lobby connection closed before a response was received.${suffix}`, {
        statusCode: 502,
        phase,
        closeCode: closeInfo?.code || null,
        closeReason: closeInfo?.reason || null,
        lobbyUrl: urlInfo
      });
    }

    function pushMessage(message) {
      const trimmed = String(message || "").trim();
      if (!trimmed) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(trimmed);
      else messages.push(trimmed);
    }

    function pushPayload(data) {
      lineBuffer += decodeLobbyLine(data);
      const lines = lineBuffer.split(/\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) pushMessage(line);
      const possibleJson = lineBuffer.trim();
      if (possibleJson.startsWith("{") && possibleJson.endsWith("}")) {
        pushMessage(possibleJson);
        lineBuffer = "";
      }
    }

    socket.on("open", () => {
      opened = true;
      clearTimeout(startupTimeout);
      resolve({
        sendJson(payload) {
          if (socket.readyState !== WebSocket.OPEN) throw makeCloseError("send");
          // FAF Python client sends binary websocket messages containing newline JSON.
          socket.send(Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"), { binary: true });
        },
        readText(readTimeoutMs = LOBBY_TIMEOUT_MS, phase = "read") {
          if (messages.length) return Promise.resolve(messages.shift());
          if (closed) return Promise.reject(makeCloseError(phase));
          return new Promise((readResolve, readReject) => {
            const waiter = {
              resolve(message) {
                clearTimeout(readTimeout);
                readResolve(message);
              },
              reject(error) {
                clearTimeout(readTimeout);
                readReject(error);
              }
            };
            const readTimeout = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              readReject(createError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl: urlInfo }));
            }, readTimeoutMs);
            waiters.push(waiter);
          });
        },
        close() {
          try { socket.close(1000, "done"); } catch (error) { socket.terminate(); }
        },
        urlInfo
      });
    });

    socket.on("message", (data) => pushPayload(data));
    socket.on("close", (code, reason) => {
      closed = true;
      clearTimeout(startupTimeout);
      closeInfo = { code, reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "") };
      if (!opened) {
        reject(makeCloseError("websocket-open"));
        return;
      }
      while (waiters.length) waiters.shift().reject(makeCloseError("read"));
    });
    socket.on("error", (error) => {
      clearTimeout(startupTimeout);
      if (!opened) {
        reject(createError(`Unable to connect to FAF lobby: ${error.message}`, { statusCode: 502, phase: "websocket-open", lobbyUrl: urlInfo }));
      }
    });
  });
}

async function readJson(connection, phase, timeoutMs = LOBBY_TIMEOUT_MS) {
  const text = await connection.readText(timeoutMs, phase);
  try { return JSON.parse(text); }
  catch (error) { return { command: "unknown", raw: text }; }
}

function isKickNotice(message) {
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
    if (isKickNotice(message)) throw createError("The FAF lobby rejected this session.", { statusCode: 403, phase, detail: message.text || null, lobbyUrl: connection.urlInfo });
    if (message?.command === "authentication_failed" || message?.command === "login_failed") throw createError("FAF lobby login failed.", { statusCode: 401, phase, detail: message.text || null, lobbyUrl: connection.urlInfo });
    if (message?.command === "notice" && String(message.style || "").toLowerCase() === "error") throw createError("FAF lobby returned an error notice.", { statusCode: 502, phase, detail: message.text || null, lobbyUrl: connection.urlInfo });
    if (predicate(message)) return message;
  }
  throw createError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase, lobbyUrl: connection.urlInfo });
}

async function fetchLobbyAccess(sessionState) {
  await fafRequest(sessionState, "/me");
  if (process.env.FAF_LOBBY_WS_URL) return normalizeLobbyUrl(process.env.FAF_LOBBY_WS_URL);
  const response = await fetch(`${sessionState.config.userBaseUrl.replace(/\/+$/g, "")}/lobby/access`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${sessionState.tokenSet.accessToken}`,
      "User-Agent": USER_AGENT
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch (error) { payload = text; }
  }
  if (!response.ok) {
    throw createError(`Unable to obtain FAF lobby access (HTTP ${response.status}).`, {
      statusCode: response.status,
      phase: "lobby-access",
      detail: payload?.message || payload?.error || payload?.detail || null,
      hint: "Log in with FAF again or paste a fresh access token from the FAF client."
    });
  }

  const accessUrl = extractLobbyAccessUrl(payload);
  if (accessUrl) return accessUrl;

  if (process.env.FAF_ALLOW_LOBBY_URL_FALLBACK === "1") return normalizeLobbyUrl(DEFAULT_LOBBY_URL);

  throw createError("FAF lobby access response did not contain a usable websocket URL.", {
    statusCode: 502,
    phase: "lobby-access-parse",
    detail: JSON.stringify(sanitizeLobbyAccessPayload(payload)),
    hint: "The /lobby/access response shape is different than expected; this diagnostic lists only keys, not token values."
  });
}

function makeUniqueId(sessionId, token) {
  return crypto.createHash("sha256").update(`${sessionId}:${token}:faftracker`).digest("hex");
}

async function requestMatchmakerInfo(sessionState) {
  const lobbyUrl = await fetchLobbyAccess(sessionState);
  const connection = await connectLobby(lobbyUrl);
  try {
    connection.sendJson({ command: "ask_session", version: CLIENT_VERSION, user_agent: USER_AGENT });
    const sessionMessage = await waitForMessage(connection, "ask_session", (message) => message?.session != null, LOBBY_TIMEOUT_MS);
    const sessionId = Number(sessionMessage.session);
    if (!Number.isFinite(sessionId)) throw createError("FAF lobby returned an invalid session id.", { statusCode: 502, phase: "ask_session", lobbyUrl: connection.urlInfo });
    connection.sendJson({ command: "auth", token: sessionState.tokenSet.accessToken, session: sessionId, unique_id: makeUniqueId(sessionId, sessionState.tokenSet.accessToken) });
    await waitForMessage(connection, "auth", (message) => message?.me || message?.command === "welcome", LOBBY_TIMEOUT_MS);
    connection.sendJson({ command: "matchmaker_info" });
    return await waitForMessage(connection, "matchmaker_info", (message) => message?.command === "matchmaker_info" && Array.isArray(message.queues), LOBBY_TIMEOUT_MS);
  } finally {
    connection.close();
  }
}

async function getLiveQueueSnapshot(sessionState) {
  if (!sessionState.tokenSet?.accessToken) throw createError("Log in with FAF or paste a fresh FAF access token to inspect live queues.", { statusCode: 401, phase: "auth" });
  const matchmakerInfo = await requestMatchmakerInfo(sessionState);
  const rawQueues = Array.isArray(matchmakerInfo.queues) ? matchmakerInfo.queues : [];
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
