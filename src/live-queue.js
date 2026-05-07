const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { URL } = require("url");

const { fafRequest } = require("./faf-client");

const DEFAULT_LOBBY_URL = process.env.FAF_LOBBY_WS_URL || "wss://lobby.faforever.com/";
const LOBBY_TIMEOUT_MS = Number(process.env.FAF_LOBBY_TIMEOUT_MS || 15000);
const USER_AGENT = "faftracker-live-queue/0.3";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

function encodeWebSocketFrame(input, opcode = 0x1) {
  const payload = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + 4 + length);
  let offset = 0;
  frame[offset++] = 0x80 | opcode;
  if (length < 126) {
    frame[offset++] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[offset++] = 0x80 | 126;
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    frame[offset++] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < length; index += 1) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function parseHeaders(rawHeaders) {
  const lines = rawHeaders.split(/\r?\n/);
  const statusLine = lines.shift() || "";
  const headers = new Map();
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      headers.set(line.slice(0, colonIndex).trim().toLowerCase(), line.slice(colonIndex + 1).trim());
    }
  }
  return { statusLine, headers };
}

function connectWebSocket(rawUrl, timeoutMs = LOBBY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const secure = url.protocol === "wss:";
    if (!secure && url.protocol !== "ws:") {
      reject(createError(`Unsupported lobby URL protocol "${url.protocol}".`, { statusCode: 500 }));
      return;
    }

    const host = url.hostname;
    const port = Number(url.port || (secure ? 443 : 80));
    const requestPath = `${url.pathname || "/"}${url.search || ""}`;
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let handshakeDone = false;
    let handshakeBuffer = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);
    let lineBuffer = "";
    const messages = [];
    const waiters = [];
    let settled = false;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(createError("Timed out while connecting to the FAF lobby.", {
        statusCode: 504,
        hint: "Try again in a moment. If this is self-hosted, set FAF_LOBBY_WS_URL to the lobby websocket URL."
      }));
    }, timeoutMs);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }

    function pushMessage(message) {
      const trimmed = String(message || "").trim();
      if (!trimmed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(trimmed);
      } else {
        messages.push(trimmed);
      }
    }

    function pushTextPayload(text) {
      lineBuffer += text;
      const lines = lineBuffer.split(/\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) pushMessage(line);
      const maybeCompleteJson = lineBuffer.trim();
      if (maybeCompleteJson.startsWith("{") && maybeCompleteJson.endsWith("}")) {
        pushMessage(maybeCompleteJson);
        lineBuffer = "";
      }
    }

    function processFrames() {
      while (frameBuffer.length >= 2) {
        const firstByte = frameBuffer[0];
        const secondByte = frameBuffer[1];
        const opcode = firstByte & 0x0f;
        const masked = Boolean(secondByte & 0x80);
        let payloadLength = secondByte & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (frameBuffer.length < offset + 2) return;
          payloadLength = frameBuffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (frameBuffer.length < offset + 8) return;
          const bigLength = frameBuffer.readBigUInt64BE(offset);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            socket.destroy();
            return;
          }
          payloadLength = Number(bigLength);
          offset += 8;
        }
        let mask = null;
        if (masked) {
          if (frameBuffer.length < offset + 4) return;
          mask = frameBuffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (frameBuffer.length < offset + payloadLength) return;
        let payload = frameBuffer.subarray(offset, offset + payloadLength);
        frameBuffer = frameBuffer.subarray(offset + payloadLength);
        if (mask) {
          const unmasked = Buffer.alloc(payload.length);
          for (let index = 0; index < payload.length; index += 1) {
            unmasked[index] = payload[index] ^ mask[index % 4];
          }
          payload = unmasked;
        }
        if (opcode === 0x8) {
          socket.end(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
        } else if (opcode === 0x9) {
          socket.write(encodeWebSocketFrame(payload, 0xA));
        } else if (opcode === 0x1 || opcode === 0x2) {
          pushTextPayload(payload.toString("utf8"));
        }
      }
    }

    function sendHandshake() {
      const hostHeader = (secure && port === 443) || (!secure && port === 80) ? host : `${host}:${port}`;
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${hostHeader}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `User-Agent: ${USER_AGENT}`,
        "",
        ""
      ].join("\r\n");
      socket.write(request);
    }

    socket.once(secure ? "secureConnect" : "connect", sendHandshake);
    socket.on("error", (error) => fail(createError(`Unable to connect to FAF lobby: ${error.message}`, { statusCode: 502 })));
    socket.on("close", () => {
      if (lineBuffer.trim()) {
        pushMessage(lineBuffer);
        lineBuffer = "";
      }
      while (waiters.length) {
        waiters.shift().reject(createError("FAF lobby connection closed before a response was received.", { statusCode: 502 }));
      }
    });
    socket.on("data", (chunk) => {
      if (!handshakeDone) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const rawHeaders = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
        const remaining = handshakeBuffer.subarray(headerEnd + 4);
        const { statusLine, headers } = parseHeaders(rawHeaders);
        if (!/^HTTP\/1\.1 101\b/i.test(statusLine)) {
          fail(createError(`FAF lobby websocket rejected the connection (${statusLine || "no status"}).`, { statusCode: 502 }));
          return;
        }
        if (headers.get("sec-websocket-accept") !== expectedAccept) {
          fail(createError("FAF lobby websocket returned an invalid handshake.", { statusCode: 502 }));
          return;
        }
        handshakeDone = true;
        settled = true;
        clearTimeout(timeout);
        if (remaining.length) {
          frameBuffer = Buffer.concat([frameBuffer, remaining]);
          processFrames();
        }
        resolve({
          sendJson(payload) {
            socket.write(encodeWebSocketFrame(`${JSON.stringify(payload)}\n`));
          },
          readText(readTimeoutMs = timeoutMs) {
            if (messages.length) return Promise.resolve(messages.shift());
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
                const waiterIndex = waiters.indexOf(waiter);
                if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
                readReject(createError("Timed out waiting for FAF lobby response.", { statusCode: 504 }));
              }, readTimeoutMs);
              waiters.push(waiter);
            });
          },
          close() {
            try {
              socket.end(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
            } catch (error) {
              socket.destroy();
            }
          }
        });
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        processFrames();
      }
    });
  });
}

async function readJson(connection, timeoutMs = LOBBY_TIMEOUT_MS) {
  const text = await connection.readText(timeoutMs);
  try {
    return JSON.parse(text);
  } catch (error) {
    return { command: "unknown", raw: text };
  }
}

function isKickNotice(message) {
  return message?.command === "notice" && String(message.style || "").toLowerCase() === "kick";
}

async function waitForMessage(connection, phase, predicate, timeoutMs = LOBBY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await readJson(connection, Math.max(250, deadline - Date.now()));
    if (message?.command === "ping") {
      connection.sendJson({ command: "pong" });
      continue;
    }
    if (isKickNotice(message)) {
      throw createError("The FAF lobby rejected this session.", { statusCode: 403, phase, detail: message.text || null });
    }
    if (message?.command === "authentication_failed" || message?.command === "login_failed") {
      throw createError("FAF lobby login failed.", { statusCode: 401, phase, detail: message.text || null });
    }
    if (message?.command === "notice" && String(message.style || "").toLowerCase() === "error") {
      throw createError("FAF lobby returned an error notice.", { statusCode: 502, phase, detail: message.text || null });
    }
    if (predicate(message)) return message;
  }
  throw createError(`Timed out waiting for FAF lobby response during ${phase}.`, { statusCode: 504, phase });
}

async function fetchLobbyAccess(sessionState) {
  await fafRequest(sessionState, "/me");
  if (process.env.FAF_LOBBY_WS_URL) return process.env.FAF_LOBBY_WS_URL;
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
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = text;
    }
  }
  if (!response.ok) {
    throw createError(`Unable to obtain FAF lobby access (HTTP ${response.status}).`, {
      statusCode: response.status,
      phase: "lobby-access",
      detail: payload?.message || payload?.error || payload?.detail || null,
      hint: "Log in with FAF again or paste a fresh access token from the FAF client."
    });
  }
  return payload?.accessUrl || payload?.access_url || payload?.url || DEFAULT_LOBBY_URL;
}

function makeUniqueId(sessionId, token) {
  return crypto.createHash("sha256").update(`${sessionId}:${token}:faftracker`).digest("hex");
}

async function requestMatchmakerInfo(sessionState) {
  const lobbyUrl = await fetchLobbyAccess(sessionState);
  const connection = await connectWebSocket(lobbyUrl, LOBBY_TIMEOUT_MS);
  try {
    connection.sendJson({ command: "ask_session", version: "faftracker-queue-inspector", user_agent: USER_AGENT });
    const sessionMessage = await waitForMessage(connection, "ask_session", (message) => message?.session != null, LOBBY_TIMEOUT_MS);
    const sessionId = Number(sessionMessage.session);
    if (!Number.isFinite(sessionId)) {
      throw createError("FAF lobby returned an invalid session id.", { statusCode: 502, phase: "ask_session" });
    }
    connection.sendJson({ command: "auth", token: sessionState.tokenSet.accessToken, session: sessionId, unique_id: makeUniqueId(sessionId, sessionState.tokenSet.accessToken) });
    await waitForMessage(connection, "auth", (message) => message?.me || message?.command === "welcome", LOBBY_TIMEOUT_MS);
    connection.sendJson({ command: "matchmaker_info" });
    return await waitForMessage(connection, "matchmaker_info", (message) => message?.command === "matchmaker_info" && Array.isArray(message.queues), LOBBY_TIMEOUT_MS);
  } finally {
    connection.close();
  }
}

async function getLiveQueueSnapshot(sessionState) {
  if (!sessionState.tokenSet?.accessToken) {
    throw createError("Log in with FAF or paste a fresh FAF access token to inspect live queues.", { statusCode: 401, phase: "auth" });
  }
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

module.exports = {
  getLiveQueueSnapshot,
  summarizeQueues
};
