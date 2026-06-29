"use strict";

// Bridge to the replay-archive API running on the FAFGuessr VM (server B).
// faftracker fetches the listing and individual `.fafreplay` files over HTTPS,
// then reuses the existing analyzer so archived replays open in the normal viewer.

const { analyzeReplayBuffer } = require("./analyze");

const OLD_REPLAYS_BASE = (process.env.REPLAYS_API || "https://replays.doodlepros.com").replace(/\/+$/, "");

// If the replay archive is password-protected, set REPLAYS_PASSWORD (and
// optionally REPLAYS_USER, default "faf") here so server-side fetches authenticate.
const AUTH_HEADER = process.env.REPLAYS_PASSWORD
  ? "Basic " +
    Buffer.from(`${process.env.REPLAYS_USER || "faf"}:${process.env.REPLAYS_PASSWORD}`).toString("base64")
  : null;

function authHeaders() {
  const h = { "User-Agent": "faftracker" };
  if (AUTH_HEADER) h.Authorization = AUTH_HEADER;
  return h;
}

function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

async function listOldReplays({ search = "", limit = "50", offset = "0" } = {}) {
  const u = new URL(`${OLD_REPLAYS_BASE}/api/replays`);
  u.searchParams.set("search", search);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  let response;
  try {
    response = await fetch(u, { headers: { "User-Agent": "faftracker" } });
  } catch (error) {
    const err = new Error("Could not reach the replay archive.");
    err.statusCode = 502;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Replay archive list failed (${response.status}).`);
    err.statusCode = 502;
    throw err;
  }
  return response.json();
}

async function fetchOldReplayBuffer(relPath) {
  let response;
  try {
    response = await fetch(`${OLD_REPLAYS_BASE}/files/${encodePath(relPath)}`, {
      headers: authHeaders()
    });
  } catch (error) {
    const err = new Error("Could not reach the replay archive.");
    err.statusCode = 502;
    throw err;
  }
  if (response.status === 404) {
    const err = new Error("That replay is not in the archive.");
    err.statusCode = 404;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Replay download failed (${response.status}).`);
    err.statusCode = 502;
    throw err;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function analyzeOldReplay(relPath) {
  const buffer = await fetchOldReplayBuffer(relPath);
  return analyzeReplayBuffer(buffer);
}

function fileUrlFor(relPath) {
  return `${OLD_REPLAYS_BASE}/files/${encodePath(relPath)}`;
}

module.exports = { OLD_REPLAYS_BASE, listOldReplays, fetchOldReplayBuffer, analyzeOldReplay, fileUrlFor };
