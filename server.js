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

const SESSION_COOKIE = "faf_tracker_session";
const sessions = new Map();

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

function setSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
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
  if (!session) {
    session = createBrowserSession();
    sessions.set(session.id, session);
    setSessionCookie(res, session.id);
  }
  session.touchedAt = Date.now();
  return session;
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
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  const browserSession = getBrowserSession(req, res);
  const sessionState = browserSession.auth;
  const loadState = browserSession.load;

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
    const payload = browserSession.reportPayload;
    const report = buildPlayerReport(payload.player, payload.games, { queueFilter });
    return sendJson(res, 200, {
      provider: payload.provider || "official",
      providerMeta: payload.meta,
      player: payload.player,
      queueFilter,
      report
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(sessionState);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/import-client") {
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
      const report = buildPlayerReport(payload.player, payload.games, { queueFilter });
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
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      error: "Unexpected server error.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`FAF Scout is running at http://localhost:${PORT}`);
});
