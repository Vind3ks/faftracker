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

const SESSION_COOKIE = "faf_tracker_session";
const sessions = new Map();
const rateLimits = new Map();

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

async function handleApi(req, res, url) {
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
