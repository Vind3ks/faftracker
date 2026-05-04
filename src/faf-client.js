const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const DEFAULT_CONFIG = {
  apiBaseUrl: process.env.FAF_API_BASE || "https://api.faforever.com",
  userBaseUrl: process.env.FAF_USER_BASE || "https://user.faforever.com",
  oauthBaseUrl: process.env.FAF_OAUTH_BASE || "https://hydra.faforever.com",
  oidcDiscoveryUrl: process.env.FAF_OIDC_DISCOVERY_URL || "https://hydra.faforever.com/.well-known/openid-configuration",
  clientId: process.env.FAF_OAUTH_CLIENT_ID || "2e8808cf-5889-469b-b2c3-01f0cc58c4af",
  scopes: process.env.FAF_OAUTH_SCOPES || "openid offline public_profile upload_map upload_mod lobby",
  authMode: process.env.FAF_AUTH_MODE || "loopback",
  redirectUri: process.env.FAF_OAUTH_REDIRECT_URI || "",
  loopbackHost: process.env.FAF_OAUTH_LOOPBACK_HOST || "127.0.0.1",
  tokenStorePath: process.env.FAF_TOKEN_STORE_PATH || path.join(process.env.APPDATA || os.homedir(), "FAF Scout", "session.json"),
  persistTokens: process.env.FAF_PERSIST_TOKENS === "1",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:4173"
};

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function sha256Base64Url(input) {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT token format.");
  }

  const normalized = parts[1].replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createEmptySessionState(options = {}) {
  const persistTokens = options.persistTokens ?? DEFAULT_CONFIG.persistTokens;
  const tokenStorePath = options.tokenStorePath ?? DEFAULT_CONFIG.tokenStorePath;
  return {
    id: options.id || null,
    config: { ...DEFAULT_CONFIG, persistTokens, tokenStorePath },
    callback: {
      server: null,
      redirectUri: null,
      port: null
    },
    oidc: {
      discovery: null,
      loadedAt: null,
      lastError: null
    },
    pendingAuth: null,
    tokenSet: persistTokens ? loadStoredTokenSet(tokenStorePath) : null,
    userProfile: null
  };
}

function loadStoredTokenSet(tokenStorePath) {
  try {
    if (!fs.existsSync(tokenStorePath)) {
      return null;
    }

    const tokenSet = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
    if (!tokenSet?.accessToken || !tokenSet?.hmac || !Number.isFinite(Number(tokenSet?.expiresAt))) {
      return null;
    }

    return {
      accessToken: String(tokenSet.accessToken),
      refreshToken: tokenSet.refreshToken ? String(tokenSet.refreshToken) : null,
      expiresAt: Number(tokenSet.expiresAt),
      hmac: String(tokenSet.hmac)
    };
  } catch (error) {
    return null;
  }
}

function storeTokenSet(sessionState) {
  if (!sessionState.config.persistTokens || !sessionState.tokenSet?.refreshToken) {
    return;
  }

  fs.mkdirSync(path.dirname(sessionState.config.tokenStorePath), { recursive: true });
  fs.writeFileSync(sessionState.config.tokenStorePath, JSON.stringify(sessionState.tokenSet, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

function deleteStoredTokenSet(sessionState) {
  if (!sessionState.config.persistTokens) {
    return;
  }
  try {
    if (fs.existsSync(sessionState.config.tokenStorePath)) {
      fs.unlinkSync(sessionState.config.tokenStorePath);
    }
  } catch (error) {
    // Logging token-store paths can reveal local account details; failing closed is enough here.
  }
}

function closeCallbackServer(sessionState) {
  const server = sessionState.callback.server;
  sessionState.callback.server = null;
  sessionState.callback.redirectUri = null;
  sessionState.callback.port = null;

  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function normalizeAppBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/g, "");
}

function resolveRedirectUri(sessionState) {
  if (sessionState.config.redirectUri?.trim()) {
    return sessionState.config.redirectUri.trim();
  }

  if (sessionState.config.authMode === "app") {
    return `${normalizeAppBaseUrl(sessionState.config.appBaseUrl)}/api/auth/callback`;
  }

  return sessionState.callback.redirectUri;
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  return {
    verifier,
    challenge: sha256Base64Url(verifier)
  };
}

function getPublicSessionState(sessionState) {
  const resolvedRedirectUri = resolveRedirectUri(sessionState);
  return {
    loggedIn: Boolean(sessionState.tokenSet?.accessToken),
    userProfile: sessionState.userProfile,
    callback: {
      mode: sessionState.config.authMode,
      redirectUri: resolvedRedirectUri,
      loopbackRedirectUri: sessionState.callback.redirectUri,
      appRedirectUri: `${normalizeAppBaseUrl(sessionState.config.appBaseUrl)}/api/auth/callback`
    },
    config: {
      apiBaseUrl: sessionState.config.apiBaseUrl,
      userBaseUrl: sessionState.config.userBaseUrl,
      oauthBaseUrl: sessionState.config.oauthBaseUrl,
      oidcDiscoveryUrl: sessionState.config.oidcDiscoveryUrl,
      clientId: sessionState.config.clientId,
      scopes: sessionState.config.scopes,
      authMode: sessionState.config.authMode,
      appBaseUrl: sessionState.config.appBaseUrl,
      redirectUri: sessionState.config.redirectUri || ""
    },
    oidc: {
      discovered: Boolean(sessionState.oidc.discovery),
      loadedAt: sessionState.oidc.loadedAt,
      authorizationEndpoint: sessionState.oidc.discovery?.authorization_endpoint || null,
      tokenEndpoint: sessionState.oidc.discovery?.token_endpoint || null,
      userinfoEndpoint: sessionState.oidc.discovery?.userinfo_endpoint || null,
      lastError: sessionState.oidc.lastError
    },
    token: sessionState.tokenSet
      ? {
          expiresAt: sessionState.tokenSet.expiresAt,
          hasRefreshToken: Boolean(sessionState.tokenSet.refreshToken)
        }
      : null
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function ensureOidcDiscovery(sessionState) {
  if (sessionState.oidc.discovery) {
    return sessionState.oidc.discovery;
  }

  try {
    const discovery = await fetchJson(sessionState.config.oidcDiscoveryUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "faf-scout/0.3"
      }
    });

    sessionState.oidc.discovery = discovery;
    sessionState.oidc.loadedAt = new Date().toISOString();
    sessionState.oidc.lastError = null;
    return discovery;
  } catch (error) {
    sessionState.oidc.lastError = error.payload?.error_description || error.payload?.detail || error.message;
    const fallback = {
      issuer: sessionState.config.oauthBaseUrl,
      authorization_endpoint: `${sessionState.config.oauthBaseUrl}/oauth2/auth`,
      token_endpoint: `${sessionState.config.oauthBaseUrl}/oauth2/token`,
      userinfo_endpoint: `${sessionState.config.oauthBaseUrl}/userinfo`,
      jwks_uri: `${sessionState.config.oauthBaseUrl}/.well-known/jwks.json`
    };
    sessionState.oidc.discovery = fallback;
    return fallback;
  }
}

async function exchangeOAuthToken(sessionState, params) {
  const discovery = await ensureOidcDiscovery(sessionState);
  const body = new URLSearchParams(params);
  const tokenPayload = await fetchJson(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const accessToken = tokenPayload.access_token;
  const refreshToken = tokenPayload.refresh_token || sessionState.tokenSet?.refreshToken || null;
  const expiresIn = Number(tokenPayload.expires_in || 0);
  const payload = decodeJwtPayload(accessToken);
  const hmac = payload?.ext?.hmac;

  if (!hmac) {
    throw new Error("FAF access token did not contain the expected ext.hmac claim.");
  }

  sessionState.tokenSet = {
    accessToken,
    refreshToken,
    expiresAt: nowSeconds() + expiresIn,
    hmac
  };
  storeTokenSet(sessionState);

  return sessionState.tokenSet;
}

async function ensureFreshToken(sessionState) {
  const tokenSet = sessionState.tokenSet;
  if (!tokenSet) {
    const error = new Error("You need to log in with FAF first.");
    error.statusCode = 401;
    throw error;
  }

  if (tokenSet.expiresAt > nowSeconds() + 60) {
    return tokenSet;
  }

  if (!tokenSet.refreshToken) {
    const error = new Error("The FAF session expired and no refresh token is available.");
    error.statusCode = 401;
    throw error;
  }

  return exchangeOAuthToken(sessionState, {
    grant_type: "refresh_token",
    client_id: sessionState.config.clientId,
    refresh_token: tokenSet.refreshToken
  });
}

function isAuthFailure(error) {
  if (!error) {
    return false;
  }

  if (error.statusCode === 401 || error.statusCode === 403) {
    return true;
  }

  const message = String(
    error.payload?.error_description ||
    error.payload?.error ||
    error.detail ||
    error.message ||
    ""
  ).toLowerCase();

  return message.includes("invalid_grant")
    || message.includes("invalid token")
    || message.includes("token expired")
    || message.includes("jwt")
    || message.includes("unauthorized");
}

async function fetchMe(sessionState) {
  await ensureFreshToken(sessionState);

  const me = await fetchJson(`${sessionState.config.apiBaseUrl}/me`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${sessionState.tokenSet.accessToken}`,
      "X-HMAC": sessionState.tokenSet.hmac,
      "User-Agent": "faf-scout/0.2"
    }
  });

  sessionState.userProfile = me;
  return me;
}

async function fafRequest(sessionState, path, options = {}) {
  await ensureFreshToken(sessionState);

  const headers = {
    Accept: "application/vnd.api+json, application/json;q=0.9, */*;q=0.8",
    Authorization: `Bearer ${sessionState.tokenSet.accessToken}`,
    "X-HMAC": sessionState.tokenSet.hmac,
    "User-Agent": "faf-scout/0.2",
    ...(options.headers || {})
  };

  return fetchJson(`${sessionState.config.apiBaseUrl}${path}`, {
    ...options,
    headers
  });
}

function beginAuth(sessionState) {
  const redirectUri = resolveRedirectUri(sessionState);
  if (!redirectUri) {
    const error = new Error("No FAF OAuth callback URI is available.");
    error.statusCode = 500;
    throw error;
  }

  const state = base64Url(crypto.randomBytes(24));
  const { verifier, challenge } = createPkcePair();

  sessionState.pendingAuth = {
    state,
    verifier,
    startedAt: Date.now()
  };

  return ensureOidcDiscovery(sessionState).then((discovery) => {
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", sessionState.config.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", sessionState.config.scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("code_challenge", challenge);
    return authUrl.toString();
  });
}

async function getAuthPreview(sessionState) {
  const redirectUri = resolveRedirectUri(sessionState);
  const discovery = await ensureOidcDiscovery(sessionState);
  const state = base64Url(crypto.randomBytes(12));
  const { challenge } = createPkcePair();
  const authUrl = new URL(discovery.authorization_endpoint);

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", sessionState.config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri || "");
  authUrl.searchParams.set("scope", sessionState.config.scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);

  return {
    mode: sessionState.config.authMode,
    clientId: sessionState.config.clientId,
    scopes: sessionState.config.scopes,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
    redirectUri,
    appBaseUrl: sessionState.config.appBaseUrl,
    authUrl: authUrl.toString(),
    warning: sessionState.config.authMode === "app" && sessionState.config.clientId === DEFAULT_CONFIG.clientId
      ? "This is still using the FAF desktop Java client ID, so Hydra will likely reject a public web redirect URI until FAF registers a dedicated app client."
      : null
  };
}

function clearSession(sessionState) {
  sessionState.pendingAuth = null;
  sessionState.tokenSet = null;
  sessionState.userProfile = null;
  deleteStoredTokenSet(sessionState);
}

async function importRefreshToken(sessionState, refreshToken) {
  if (!refreshToken || typeof refreshToken !== "string") {
    const error = new Error("A FAF refresh token is required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    await exchangeOAuthToken(sessionState, {
      grant_type: "refresh_token",
      client_id: sessionState.config.clientId,
      refresh_token: refreshToken.trim()
    });
  } catch (error) {
    error.detail = error.payload?.error_description || error.detail || error.message;
    error.hint = "FAF refresh tokens are rotated. Use the latest token from a completed FAF login, or log in through this app so FAF Scout can save its own rotated refresh token.";
    throw error;
  }

  await fetchMe(sessionState);
}

async function importAccessToken(sessionState, accessToken) {
  if (!accessToken || typeof accessToken !== "string") {
    const error = new Error("A FAF access token is required.");
    error.statusCode = 400;
    throw error;
  }

  const payload = decodeJwtPayload(accessToken.trim());
  const hmac = payload?.ext?.hmac;
  if (!hmac) {
    const error = new Error("This FAF access token does not contain ext.hmac.");
    error.statusCode = 400;
    throw error;
  }

  sessionState.tokenSet = {
    accessToken: accessToken.trim(),
    refreshToken: null,
    expiresAt: Number(payload.exp || 0),
    hmac
  };

  await fetchMe(sessionState);
}

async function importClientPrefs(sessionState, prefsPath) {
  const filePath = prefsPath || `${process.env.APPDATA}\\Forged Alliance Forever\\client.prefs`;
  const raw = fs.readFileSync(filePath, "utf8");
  const prefs = JSON.parse(raw);
  const login = prefs?.login || {};

  if (!login.refreshToken) {
    const error = new Error("No refresh token was found in the FAF client prefs file.");
    error.statusCode = 400;
    error.detail = login.rememberMe === false
      ? "The FAF client currently has remember-me disabled, so it did not persist a refresh token."
      : "The prefs file does not contain a saved FAF refresh token.";
    error.hint = "Open the FAF client, enable remember me, log in once, then try importing again.";
    throw error;
  }

  await importRefreshToken(sessionState, login.refreshToken);
}

async function completeAuth(sessionState, code, state) {
  if (!sessionState.pendingAuth || sessionState.pendingAuth.state !== state) {
    const error = new Error("OAuth state did not match the pending FAF login attempt.");
    error.statusCode = 400;
    throw error;
  }

  const verifier = sessionState.pendingAuth.verifier;
  const redirectUri = resolveRedirectUri(sessionState);
  sessionState.pendingAuth = null;

  await exchangeOAuthToken(sessionState, {
    grant_type: "authorization_code",
    client_id: sessionState.config.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  });

  await fetchMe(sessionState);
}

function updateConfig(sessionState, updates) {
  const nextAppBaseUrl = normalizeAppBaseUrl(updates.appBaseUrl ?? sessionState.config.appBaseUrl);
  const nextAuthMode = updates.authMode || sessionState.config.authMode;
  const nextRedirectUri = String(updates.redirectUri ?? sessionState.config.redirectUri ?? "").trim();
  const loopbackConfigChanged = nextAuthMode === "loopback" && (
    sessionState.config.authMode !== nextAuthMode
    || sessionState.config.redirectUri !== nextRedirectUri
  );

  sessionState.config = {
    ...sessionState.config,
    ...updates,
    appBaseUrl: nextAppBaseUrl,
    authMode: nextAuthMode,
    redirectUri: nextRedirectUri
  };
  sessionState.oidc.discovery = null;
  sessionState.oidc.loadedAt = null;
  sessionState.oidc.lastError = null;

  if (loopbackConfigChanged) {
    return closeCallbackServer(sessionState);
  }

  if (sessionState.config.authMode !== "loopback" && sessionState.callback.server) {
    return closeCallbackServer(sessionState);
  }

  return Promise.resolve();
}

async function startCallbackServer(sessionState) {
  if (sessionState.config.authMode !== "loopback") {
    return resolveRedirectUri(sessionState);
  }

  if (sessionState.callback.server) {
    return sessionState.callback.redirectUri;
  }

  const requestedRedirectUri = sessionState.config.redirectUri?.trim();
  const requestedUrl = requestedRedirectUri ? new URL(requestedRedirectUri) : null;

  if (requestedUrl && requestedUrl.protocol !== "http:") {
    throw new Error("Loopback FAF OAuth redirects must use http://.");
  }

  if (requestedUrl && !requestedUrl.port) {
    throw new Error("A manual loopback FAF OAuth redirect URI must include a port.");
  }

  const listenHost = requestedUrl?.hostname || sessionState.config.loopbackHost || "127.0.0.1";
  const listenPort = requestedUrl ? Number(requestedUrl.port) : 0;
  const redirectPath = requestedUrl ? requestedUrl.pathname : "";

  const server = http.createServer(async (req, res) => {
    const redirectBase = sessionState.callback.redirectUri || requestedRedirectUri || `http://${listenHost}`;
    const requestUrl = new URL(req.url, redirectBase);

    if (redirectPath && requestUrl.pathname !== redirectPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found.");
      return;
    }

    if (requestUrl.searchParams.get("error")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<script>location.replace('${sessionState.config.appBaseUrl}/?auth=error')</script>FAF login failed.`);
      return;
    }

    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing OAuth code or state.");
      return;
    }

    try {
      await completeAuth(sessionState, code, state);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<script>location.replace('${sessionState.config.appBaseUrl}/?auth=success')</script>FAF login complete.`);
    } catch (error) {
      clearSession(sessionState);
      res.writeHead(error.statusCode || 500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<script>location.replace('${sessionState.config.appBaseUrl}/?auth=error')</script>${String(error.message || error)}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  const resolvedRedirectUri = requestedRedirectUri || `http://${listenHost}:${actualPort}`;

  sessionState.callback.server = server;
  sessionState.callback.redirectUri = resolvedRedirectUri;
  sessionState.callback.port = actualPort;
  return resolvedRedirectUri;
}

module.exports = {
  beginAuth,
  clearSession,
  closeCallbackServer,
  completeAuth,
  createEmptySessionState,
  ensureOidcDiscovery,
  fafRequest,
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
};
