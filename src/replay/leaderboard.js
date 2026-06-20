"use strict";

// Kazbek-style "best timing" leaderboard. As replays are parsed we index the
// fastest recorded timing for each notable unit/tech event per map into a JSON
// cache, so "fastest Paragon on Seton's Clutch" type queries don't re-parse
// anything. Scope: replays that have been viewed/indexed through this app.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_ROOT = process.env.FAF_TRACKER_CACHE_DIR
  ? path.dirname(process.env.FAF_TRACKER_CACHE_DIR)
  : path.join(process.env.APPDATA || os.homedir(), "FAF Tracker");
const INDEX_FILE = path.join(CACHE_ROOT, "replay-leaderboard.json");
const MAX_ENTRIES_PER_EVENT = 50;
// Event types that are meaningful "timing" achievements worth ranking.
const RANKED_TYPES = new Set(["experimental", "notable", "first_unit", "tech_upgrade"]);

let index = null; // { version, maps: { key: { displayName, events: { unitId: {...} } } } }

function load() {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (!index || typeof index !== "object" || !index.maps) throw new Error("bad");
  } catch (error) {
    index = { version: 1, maps: {} };
  }
  return index;
}

function save() {
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf8");
  } catch (error) {
    /* best effort */
  }
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapKeyOf(summary) {
  return slug(summary.mapFolderName || summary.map || "unknown");
}

function recordReplay(replayId, summary, analysis) {
  if (!summary || !analysis || !Array.isArray(analysis.timeline)) return;
  load();

  const key = mapKeyOf(summary);
  if (!key) return;
  const mode = summary.queueCategory || null;
  const map = index.maps[key] || (index.maps[key] = { displayName: summary.map || key, events: {} });
  map.displayName = summary.map || map.displayName;

  for (const e of analysis.timeline) {
    if (!RANKED_TYPES.has(e.type) || !e.unit || !e.unit.id) continue;
    const eventId = e.type === "tech_upgrade" ? `tech_${e.unit.id}` : e.unit.id;
    const bucket = map.events[eventId] || (map.events[eventId] = {
      label: e.label,
      type: e.type,
      tier: e.tier,
      unitId: e.unit.id,
      unitLabel: e.unit.label,
      entries: []
    });

    const entry = {
      replayId: Number(replayId),
      player: e.player,
      faction: e.faction || null,
      seconds: e.seconds,
      estimated: !!e.estimated,
      mode
    };

    // De-duplicate by replay+player; keep the faster timing.
    const existingIdx = bucket.entries.findIndex((x) => x.replayId === entry.replayId && x.player === entry.player);
    if (existingIdx >= 0) {
      if (entry.seconds < bucket.entries[existingIdx].seconds) bucket.entries[existingIdx] = entry;
    } else {
      bucket.entries.push(entry);
    }
    bucket.entries.sort((a, b) => a.seconds - b.seconds);
    if (bucket.entries.length > MAX_ENTRIES_PER_EVENT) bucket.entries.length = MAX_ENTRIES_PER_EVENT;
  }

  save();
}

function listIndexedMaps() {
  load();
  return Object.entries(index.maps)
    .map(([key, map]) => {
      const events = Object.values(map.events);
      const replays = new Set();
      for (const ev of events) for (const en of ev.entries) replays.add(en.replayId);
      return { key, displayName: map.displayName, eventCount: events.length, replayCount: replays.size };
    })
    .sort((a, b) => b.replayCount - a.replayCount);
}

function findMapKey(mapQuery) {
  const q = slug(mapQuery);
  if (index.maps[q]) return q;
  // fuzzy: contains
  const keys = Object.keys(index.maps);
  return keys.find((k) => k.includes(q) || index.maps[k].displayName.toLowerCase().includes(mapQuery.toLowerCase())) || null;
}

function queryLeaderboard({ map, event, tier }) {
  load();
  const tierNum = tier ? Number(tier) : null;

  const mapKeys = map ? [findMapKey(map)].filter(Boolean) : Object.keys(index.maps);
  const eventQuery = (event || "").trim().toLowerCase();

  const results = [];
  for (const key of mapKeys) {
    const m = index.maps[key];
    if (!m) continue;
    for (const ev of Object.values(m.events)) {
      if (tierNum && ev.tier !== tierNum) continue;
      if (eventQuery) {
        const hay = `${ev.unitId} ${ev.unitLabel} ${ev.label}`.toLowerCase();
        if (!hay.includes(eventQuery)) continue;
      }
      results.push({
        map: m.displayName,
        mapKey: key,
        eventId: ev.unitId,
        label: ev.label,
        type: ev.type,
        tier: ev.tier,
        unitLabel: ev.unitLabel,
        best: ev.entries[0] || null,
        entries: ev.entries
      });
    }
  }

  // When a specific event is requested, surface the deepest leaderboard first;
  // otherwise list events by their fastest recorded timing.
  results.sort((a, b) => {
    if (eventQuery) return b.entries.length - a.entries.length || (a.best?.seconds ?? 1e9) - (b.best?.seconds ?? 1e9);
    return (a.best?.seconds ?? 1e9) - (b.best?.seconds ?? 1e9);
  });
  return results;
}

module.exports = { recordReplay, queryLeaderboard, listIndexedMaps, INDEX_FILE };
