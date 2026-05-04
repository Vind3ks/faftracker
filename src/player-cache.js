const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_DIR = process.env.FAF_TRACKER_CACHE_DIR || path.join(process.env.APPDATA || os.homedir(), "FAF Tracker", "players");
const CACHE_TTL_MS = Number(process.env.FAF_TRACKER_CACHE_TTL_MS || 6 * 60 * 60 * 1000);

const refreshLocks = new Map();

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(playerRef) {
  const safeName = String(playerRef || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "player";
  return path.join(CACHE_DIR, `${safeName}.json`);
}

function normalizePlayerRef(value) {
  return String(value || "").trim().toLowerCase();
}

function readCache(playerRef) {
  try {
    const filePath = cachePathFor(playerRef);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!payload?.player || !Array.isArray(payload?.games)) {
      return null;
    }

    const requested = normalizePlayerRef(playerRef);
    const cachedLogin = normalizePlayerRef(payload.player.login);
    const cachedId = normalizePlayerRef(payload.player.id);
    if (requested && requested !== cachedLogin && requested !== cachedId) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

function writeCache(playerRef, payload) {
  ensureCacheDir();
  const filePath = cachePathFor(playerRef);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function deleteCache(playerRef) {
  const filePath = cachePathFor(playerRef);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

function getCacheState(playerRef) {
  const payload = readCache(playerRef);
  if (!payload) {
    return {
      payload: null,
      exists: false,
      stale: true,
      ageMs: null
    };
  }

  const fetchedAt = new Date(payload.fetchedAt || 0).getTime();
  const ageMs = Date.now() - fetchedAt;
  return {
    payload,
    exists: true,
    stale: !Number.isFinite(fetchedAt) || ageMs > CACHE_TTL_MS,
    ageMs
  };
}

async function refreshInBackground(playerRef, refreshFn) {
  if (refreshLocks.has(playerRef)) {
    return refreshLocks.get(playerRef);
  }

  const promise = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(playerRef);
    });

  refreshLocks.set(playerRef, promise);
  return promise;
}

module.exports = {
  CACHE_TTL_MS,
  deleteCache,
  getCacheState,
  normalizePlayerRef,
  readCache,
  refreshInBackground,
  writeCache
};
