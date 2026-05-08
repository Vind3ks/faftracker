const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const { buildPlayerReport } = require("./src/analytics");
const { deleteCache } = require("./src/player-cache");
const {
  beginAuth,
  clearSession,
  completeAuth,
  createEmptySessionState,
  ensureOidcDiscovery,
  fetchMe,
  getAuthPreview,
  getPublicSessionState,
  importAccessToken,
  importClientPrefs,
  importRefreshToken,
  isAuthFailure,
  resolveRedirectUri,
  startCallbackServer,
  updateConfig
} = require("./src/faf-client");
const { createOfficialProvider } = require("./src/providers/official");
const { createSampleProvider } = require("./src/providers/sample");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 32 * 1024);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const ALLOW_AUTH_CONFIG = process.env.FAF_ALLOW_AUTH_CONFIG === "1";
const FORCE_HTTPS = process.env.FORCE_HTTPS === "1" || process.env.NODE_ENV === "production";
const PLAYER_RATE_LIMIT_MAX = Number(process.env.PLAYER_RATE_LIMIT_MAX || 60);
const PLAYER_RATE_LIMIT_WINDOW_MS = Number(process.env.PLAYER_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const BOT_API_SECRET = process.env.BOT_API_SECRET || process.env.FAFTRACKER_BOT_SECRET || "";
const FAF_SERVER_REFRESH_TOKEN = process.env.FAF_SERVER_REFRESH_TOKEN || "";
const FAF_SERVER_TOKEN_STORE_PATH = process.env.FAF_SERVER_TOKEN_STORE_PATH || path.join(__dirname, "data", "faf-server-session.json");

const SESSION_COOKIE = "faf_tracker_session";
const sessions = new Map();
const rateLimits = new Map();
let serverBotSessionState = null;
let serverBotSessionInit = null;

function createLoadState() {
  return {
    active: false,
    percent: 0,
    stage: "idle",
    fetchedGames: 0,
    message: "Idle"
  };
}

const providers = {
  official: createOfficialProvider(),
  sample: createSampleProvider()
};

function isHttps(req) {
  return req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function isLocalHost(host) {
  const hostname = String(host || "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function shouldRedirectToHttps(req) {
  return FORCE_HTTPS && !isHttps(req) && !isLocalHost(req.headers.host);
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: maxRequests - 1, retryAfterSeconds: 0 };
  }

  if (current.count >= maxRequests) {
    return {
      limited: true,
      remaining: 0,
      retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000)
    };
  }

  current.count += 1;
  return {
    limited: false,
    remaining: maxRequests - current.count,
    retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000)
  };
}

function logRequest(req, res) {
  const startedAt = Date.now();
  const originalWriteHead = res.writeHead;

  res.writeHead = function writeHeadWithStatus(statusCode, ...args) {
    res.statusCode = statusCode;
    return originalWriteHead.call(this, statusCode, ...args);
  };

  res.on("finish", () => {
    let pathname = req.url || "/";
    try {
      pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    } catch (error) {}

    console.log(JSON.stringify({
      level: "info",
      event: "request",
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: getClientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 160)
    }));
  });
}

function applySecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  if (isHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function setSessionCookie(req, res, sessionId) {
  const secureFlag = isHttps(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`
  );
}

function createBrowserSession() {
  const id = crypto.randomUUID();
  return {
    id,
    auth: createEmptySessionState({ id, persistTokens: false }),
    load: createLoadState(),
    reportPayload: null,
    createdAt: Date.now(),
    touchedAt: Date.now()
  };
}

function getBrowserSession(req, res) {
  const cookies = parseCookies(req);
  let session = cookies[SESSION_COOKIE] ? sessions.get(cookies[SESSION_COOKIE]) : null;
  if (session && Date.now() - session.touchedAt > SESSION_TTL_MS) {
    clearSession(session.auth);
    sessions.delete(session.id);
    session = null;
  }
  if (!session) {
    session = createBrowserSession();
    sessions.set(session.id, session);
    setSessionCookie(req, res, session.id);
  }
  session.touchedAt = Date.now();
  return session;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.touchedAt > SESSION_TTL_MS) {
      clearSession(session.auth);
      sessions.delete(id);
    }
  }
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendBuffer(res, statusCode, buffer, contentType = "application/octet-stream") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        req.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function timingSafeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedBotRequest(req) {
  if (!BOT_API_SECRET) {
    return false;
  }
  const token = getBearerToken(req) || String(req.headers["x-bot-secret"] || "").trim();
  return timingSafeEquals(token, BOT_API_SECRET);
}

function getServerBotSessionState() {
  if (!serverBotSessionState) {
    serverBotSessionState = createEmptySessionState({
      id: "server-bot",
      persistTokens: true,
      tokenStorePath: FAF_SERVER_TOKEN_STORE_PATH
    });
  }
  return serverBotSessionState;
}

async function ensureServerBotSessionState() {
  const sessionState = getServerBotSessionState();
  if (sessionState.tokenSet?.accessToken) {
    return sessionState;
  }

  if (!FAF_SERVER_REFRESH_TOKEN) {
    const error = new Error("FAF_SERVER_REFRESH_TOKEN is not configured on this server.");
    error.statusCode = 500;
    throw error;
  }

  if (!serverBotSessionInit) {
    serverBotSessionInit = importRefreshToken(sessionState, FAF_SERVER_REFRESH_TOKEN)
      .then(() => sessionState)
      .catch((error) => {
        serverBotSessionInit = null;
        throw error;
      });
  }

  return serverBotSessionInit;
}

async function handleBotPlayerReport(req, res, url) {
  if (!isAuthorizedBotRequest(req)) {
    return sendJson(res, 401, { error: "Unauthorized bot request." });
  }

  const playerRef = decodeURIComponent(url.pathname.replace("/api/bot/player/", "")).trim();
  if (!playerRef) {
    return sendJson(res, 400, { error: "Player reference is required." });
  }

  try {
    const sessionState = await ensureServerBotSessionState();
    const payload = await providers.official.getPlayerReport(playerRef, {
      sessionState,
      forceRefresh: true
    });
    const queueFilter = url.searchParams.get("queue") || "all";
    const gameLimit = url.searchParams.get("gameLimit") || "all";
    const report = buildPlayerReport(payload.player, payload.games, {
      queueFilter,
      gameLimit,
      ratings: payload.meta?.ratings
    });

    return sendJson(res, 200, {
      provider: "official",
      providerMeta: payload.meta,
      player: payload.player,
      queueFilter,
      gameLimit: report.gameLimit,
      report
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 502, {
      provider: "official",
      error: error.message,
      detail: error.detail || error.payload?.error_description || error.payload?.detail || null,
      hint: error.hint || null
    });
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname.startsWith("/api/bot/player/")) {
    return handleBotPlayerReport(req, res, url);
  }

  const browserSession = getBrowserSession(req, res);
  const sessionState = browserSession.auth;
  const loadState = browserSession.load;

  if (req.method === "GET" && url.pathname.startsWith("/api/player/")) {
    const limit = checkRateLimit(`player:${getClientIp(req)}`, PLAYER_RATE_LIMIT_MAX, PLAYER_RATE_LIMIT_WINDOW_MS);
    if (limit.limited) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return sendJson(res, 429, {
        error: "Too many report loads. Please wait a bit before trying again.",
        retryAfterSeconds: limit.retryAfterSeconds
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/callback") {
    if (url.searchParams.get("error")) {
      clearSession(sessionState);
      res.writeHead(302, { Location: "/?auth=error" });
      res.end();
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return sendJson(res, 400, { error: "Missing OAuth code or state." });
    }

    try {
      await completeAuth(sessionState, code, state);
      res.writeHead(302, { Location: "/?auth=success" });
      res.end();
    } catch (error) {
      clearSession(sessionState);
      res.writeHead(302, { Location: "/?auth=error" });
      res.end();
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      nodeEnv: process.env.NODE_ENV || "development",
      forceHttps: FORCE_HTTPS,
      authConfigEnabled: ALLOW_AUTH_CONFIG,
      botApi: {
        configured: Boolean(BOT_API_SECRET),
        serverRefreshTokenConfigured: Boolean(FAF_SERVER_REFRESH_TOKEN),
        tokenStorePathConfigured: Boolean(FAF_SERVER_TOKEN_STORE_PATH)
      },
      rateLimit: {
        max: PLAYER_RATE_LIMIT_MAX,
        windowMs: PLAYER_RATE_LIMIT_WINDOW_MS
      },
      sessions: sessions.size
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/login") {
    try {
      if (sessionState.config.authMode === "loopback") {
        await startCallbackServer(sessionState);
      }

      const authUrl = await beginAuth(sessionState);
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    try {
      await ensureOidcDiscovery(sessionState);
      if (sessionState.tokenSet && !sessionState.userProfile) {
        await fetchMe(sessionState);
      }
    } catch (error) {
      if (sessionState.tokenSet && isAuthFailure(error)) {
        clearSession(sessionState);
      }
    }

    return sendJson(res, 200, getPublicSessionState(sessionState));
  }

  if (req.method === "GET" && url.pathname === "/api/auth/discovery") {
    try {
      const discovery = await ensureOidcDiscovery(sessionState);
      return sendJson(res, 200, discovery);
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/preview") {
    try {
      const preview = await getAuthPreview(sessionState);
      return sendJson(res, 200, preview);
    } catch (error) {
      return sendJson(res, error.statusCode || 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/load-status") {
    return sendJson(res, 200, loadState);
  }

  if (req.method === "GET" && url.pathname === "/api/report/current") {
    if (!browserSession.reportPayload) {
      return sendJson(res, 404, {
        error: "No loaded report is available yet.",
        detail: "Load a player report first, then queue changes can update instantly."
      });
    }

    const queueFilter = url.searchParams.get("queue") || "all";
    const gameLimit = url.searchParams.get("gameLimit") || "all";
    const payload = browserSession.reportPayload;
    const report = buildPlayerReport(payload.player, payload.games, {
      queueFilter,
      gameLimit,
      ratings: payload.meta?.ratings
    });
    return sendJson(res, 200, {
      provider: payload.provider || "official",
      providerMeta: payload.meta,
      player: payload.player,
      queueFilter,
      gameLimit: report.gameLimit,
      report
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(sessionState);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/import-client") {
    if (!ALLOW_AUTH_CONFIG) {
      return sendJson(res, 403, { error: "Local FAF client import is disabled on the public server." });
    }

    try {
      await importClientPrefs(sessionState);
      return sendJson(res, 200, getPublicSessionState(sessionState));
    } catch (error) {
      return sendJson(res, error.statusCode || 500, {
        error: error.message,
        detail: error.detail || null,
        hint: error.hint || null
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/import-token") {
    const raw = await readBody(req);
    let body;

    try {
      body = JSON.parse(raw || "{}");
    } catch (error) {
      return sendJson(res, 400, { error: "Request body must be valid JSON." });
    }

    try {
      if (body.refreshToken) {
        if (!ALLOW_AUTH_CONFIG) {
          return sendJson(res, 403, { error: "Refresh token import is disabled on the public server." });
        }
        await importRefreshToken(sessionState, body.refreshToken);
      } else if (body.accessToken) {
        await importAccessToken(sessionState, body.accessToken);
      } else {
        return sendJson(res, 400, { error: "Provide either refreshToken or accessToken." });
      }

      return sendJson(res, 200, getPublicSessionState(sessionState));
    } catch (error) {
      return sendJson(res, error.statusCode || 500, {
        error: error.message,
        detail: error.detail || null,
        hint: error.hint || null
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/config") {
    if (!ALLOW_AUTH_CONFIG) {
      return sendJson(res, 403, { error: "Runtime FAF auth configuration is disabled on the public server." });
    }

    const raw = await readBody(req);
    let body;

    try {
      body = JSON.parse(raw || "{}");
    } catch (error) {
      return sendJson(res, 400, { error: "Request body must be valid JSON." });
    }

    await updateConfig(sessionState, {
      clientId: typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim() : sessionState.config.clientId,
      oauthBaseUrl: typeof body.oauthBaseUrl === "string" && body.oauthBaseUrl.trim() ? body.oauthBaseUrl.trim() : sessionState.config.oauthBaseUrl,
      oidcDiscoveryUrl: typeof body.oidcDiscoveryUrl === "string" && body.oidcDiscoveryUrl.trim() ? body.oidcDiscoveryUrl.trim() : sessionState.config.oidcDiscoveryUrl,
      apiBaseUrl: typeof body.apiBaseUrl === "string" && body.apiBaseUrl.trim() ? body.apiBaseUrl.trim() : sessionState.config.apiBaseUrl,
      userBaseUrl: typeof body.userBaseUrl === "string" && body.userBaseUrl.trim() ? body.userBaseUrl.trim() : sessionState.config.userBaseUrl,
      scopes: typeof body.scopes === "string" && body.scopes.trim() ? body.scopes.trim() : sessionState.config.scopes,
      authMode: body.authMode === "app" ? "app" : "loopback",
      appBaseUrl: typeof body.appBaseUrl === "string" && body.appBaseUrl.trim() ? body.appBaseUrl.trim() : sessionState.config.appBaseUrl,
      redirectUri: typeof body.redirectUri === "string" ? body.redirectUri.trim() : sessionState.config.redirectUri
    });

    if (sessionState.config.authMode === "loopback") {
      try {
        await startCallbackServer(sessionState);
      } catch (error) {
        return sendJson(res, 500, {
          error: error.message,
          callback: {
            mode: sessionState.config.authMode,
            redirectUri: resolveRedirectUri(sessionState)
          }
        });
      }
    }

    return sendJson(res, 200, getPublicSessionState(sessionState));
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const providerStatuses = {};

    for (const [key, provider] of Object.entries(providers)) {
      providerStatuses[key] = await provider.getStatus({ sessionState });
    }

    return sendJson(res, 200, {
      activeProvider: url.searchParams.get("provider") || "official",
      session: getPublicSessionState(sessionState),
      providers: providerStatuses
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/player/")) {
    const providerKey = url.searchParams.get("provider") || "official";
    const provider = providers[providerKey];

    if (!provider) {
      return sendJson(res, 404, { error: `Unknown provider "${providerKey}".` });
    }

    const playerRef = decodeURIComponent(url.pathname.replace("/api/player/", "")).trim();
    if (!playerRef) {
      return sendJson(res, 400, { error: "Player reference is required." });
    }

    try {
      loadState.active = true;
      loadState.percent = 2;
      loadState.stage = "start";
      loadState.fetchedGames = 0;
      loadState.message = `Starting report for ${playerRef}...`;

      const queueFilter = url.searchParams.get("queue") || "all";
      const gameLimit = url.searchParams.get("gameLimit") || "all";
      const payload = await provider.getPlayerReport(playerRef, {
        sessionState,
        forceRefresh: url.searchParams.get("refresh") === "1",
        onProgress(progress) {
          loadState.active = true;
          loadState.percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
          loadState.stage = progress.stage || "loading";
          loadState.fetchedGames = Number(progress.fetchedGames || 0);
          loadState.message = progress.message || "Loading...";
        }
      });
      const report = buildPlayerReport(payload.player, payload.games, {
        queueFilter,
        gameLimit,
        ratings: payload.meta?.ratings
      });
      browserSession.reportPayload = {
        provider: providerKey,
        meta: payload.meta,
        player: payload.player,
        games: payload.games
      };
      loadState.active = false;
      loadState.percent = 100;
      loadState.stage = "done";
      loadState.fetchedGames = payload.games.length;
      loadState.message = `Loaded ${payload.games.length} games.`;

      return sendJson(res, 200, {
        provider: providerKey,
        providerMeta: payload.meta,
        player: payload.player,
        queueFilter,
        gameLimit: report.gameLimit,
        report
      });
    } catch (error) {
      browserSession.reportPayload = null;
      loadState.active = false;
      loadState.stage = "error";
      loadState.message = error.message;
      return sendJson(res, error.statusCode || 502, {
        provider: providerKey,
        error: error.message,
        detail: error.detail || null,
        hint: error.hint || null
      });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/cache/player/")) {
    const playerRef = decodeURIComponent(url.pathname.replace("/api/cache/player/", "")).trim();
    if (!playerRef) {
      return sendJson(res, 400, { error: "Player reference is required." });
    }
    return sendJson(res, 200, {
      ok: true,
      deleted: deleteCache(playerRef)
    });
  }

  return sendJson(res, 404, { error: "Not found." });
}

function serveStatic(req, res, url) {
  let targetPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, targetPath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(resolvedPath, (error, buffer) => {
    if (error) {
      if (error.code === "ENOENT") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexError, indexBuffer) => {
          if (indexError) {
            return sendText(res, 500, "Unable to load the application.");
          }
          sendText(res, 200, indexBuffer.toString("utf8"), "text/html; charset=utf-8");
        });
        return;
      }

      return sendText(res, 500, "Unable to read static file.");
    }

    sendBuffer(res, 200, buffer, getMimeType(resolvedPath));
  });
}

const server = http.createServer(async (req, res) => {
  logRequest(req, res);
  applySecurityHeaders(req, res);

  if (shouldRedirectToHttps(req)) {
    const host = String(req.headers.host || "");
    if (/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
      res.writeHead(308, { Location: `https://${host}${req.url || "/"}` });
      res.end();
      return;
    }
    return sendText(res, 400, "Invalid Host header.");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode === 413 ? error.message : "Unexpected server error.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`FAF Tracker is running at http://localhost:${PORT}`);
});

setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS).unref();

process.on("unhandledRejection", (error) => {
  console.error(JSON.stringify({
    level: "error",
    event: "unhandledRejection",
    message: error instanceof Error ? error.message : String(error)
  }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    level: "error",
    event: "uncaughtException",
    message: error instanceof Error ? error.message : String(error)
  }));
});
