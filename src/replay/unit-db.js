"use strict";

// Unit database backed by the ETFreeman unit DB (faforever.github.io/etfreeman-db).
// Its `data/index.json` lists every blueprint with build costs, tech tier
// (via Categories), faction, economy output and a strategic icon name. We fetch
// it once, cache to disk, and expose normalized lookups by blueprint id.

const fs = require("fs");
const os = require("os");
const path = require("path");

const INDEX_URL = "https://faforever.github.io/etfreeman-db/data/index.json";
const CACHE_ROOT = process.env.FAF_TRACKER_CACHE_DIR
  ? path.dirname(process.env.FAF_TRACKER_CACHE_DIR)
  : path.join(process.env.APPDATA || os.homedir(), "FAF Tracker");
const CACHE_FILE = path.join(CACHE_ROOT, "unit-db.json");
const CACHE_TTL_MS = Number(process.env.FAF_UNITDB_TTL_MS || 14 * 24 * 60 * 60 * 1000); // 14 days

let cached = null; // { fetchedAt, version, units: Map }
let loadPromise = null;

function has(categories, name) {
  return categories.includes(name);
}

function tierFromCategories(categories) {
  if (has(categories, "EXPERIMENTAL")) return 4;
  if (has(categories, "TECH3") || has(categories, "SUBCOMMANDER")) return 3;
  if (has(categories, "TECH2")) return 2;
  if (has(categories, "TECH1") || has(categories, "COMMAND")) return 1;
  return 0;
}

function normalizeUnit(raw) {
  const categories = Array.isArray(raw.Categories) ? raw.Categories : [];
  const general = raw.General || {};
  const economy = raw.Economy || {};
  const tier = tierFromCategories(categories);
  const nickname = general.UnitName || "";
  const role = raw.Description || "";

  return {
    id: String(raw.Id || "").toLowerCase(),
    nickname,
    role,
    faction: general.FactionName || "",
    tier,
    categories,
    isExperimental: tier === 4,
    isEngineer: has(categories, "ENGINEER"),
    isFactory: has(categories, "FACTORY"),
    isStructure: has(categories, "STRUCTURE"),
    isMobile: has(categories, "MOBILE"),
    isCommander: has(categories, "COMMAND"),
    isSubCommander: has(categories, "SUBCOMMANDER"),
    isMassExtraction: has(categories, "MASSEXTRACTION"),
    isMassFabrication: has(categories, "MASSFABRICATION"),
    isEnergyProduction: has(categories, "ENERGYPRODUCTION"),
    isShield: has(categories, "SHIELD"),
    isAir: has(categories, "AIR"),
    isLand: has(categories, "LAND"),
    isNaval: has(categories, "NAVAL"),
    buildTime: Number(economy.BuildTime) || 0,
    buildRate: Number(economy.BuildRate) || 0,
    costMass: Number(economy.BuildCostMass) || 0,
    costEnergy: Number(economy.BuildCostEnergy) || 0,
    prodMass: Number(economy.ProductionPerSecondMass) || 0,
    prodEnergy: Number(economy.ProductionPerSecondEnergy) || 0,
    strategicIcon: raw.StrategicIconName || ""
  };
}

function buildIndex(json) {
  const units = new Map();
  for (const raw of json.units || []) {
    const unit = normalizeUnit(raw);
    if (unit.id) units.set(unit.id, unit);
  }
  return { fetchedAt: Date.now(), version: json.version || null, units };
}

function readDiskCache() {
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!json || !Array.isArray(json.units)) return null;
    return json;
  } catch (error) {
    return null;
  }
}

function writeDiskCache(json) {
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(json), "utf8");
  } catch (error) {
    /* cache is best-effort */
  }
}

async function fetchIndex() {
  const response = await fetch(INDEX_URL, { headers: { "User-Agent": "faf-scout/0.2" } });
  if (!response.ok) throw new Error(`Unit DB fetch failed (${response.status}).`);
  return response.json();
}

async function ensureUnitDb() {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let json = readDiskCache();
    if (!json) {
      json = await fetchIndex();
      writeDiskCache(json);
    }
    cached = buildIndex(json);
    return cached;
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

function getUnit(db, blueprintId) {
  if (!db || !blueprintId) return null;
  return db.units.get(String(blueprintId).toLowerCase()) || null;
}

// Human label like "Emissary — Destroyer" or "Land Factory".
function unitLabel(unit) {
  if (!unit) return null;
  if (unit.nickname && unit.role && unit.nickname !== unit.role) {
    return `${unit.nickname} — ${unit.role}`;
  }
  return unit.nickname || unit.role || unit.id;
}

const TIER_LABEL = { 1: "T1", 2: "T2", 3: "T3", 4: "T4" };
function tierLabel(tier) {
  return TIER_LABEL[tier] || "";
}

module.exports = {
  ensureUnitDb,
  getUnit,
  unitLabel,
  tierLabel,
  CACHE_FILE
};
