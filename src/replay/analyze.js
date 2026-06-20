"use strict";

// Turns a parsed replay into the data the Replay Viewer renders:
//   * per-player APM (raw + spam-filtered "effective")
//   * a tech / build event timeline (upgrades, first units of a tier, T4s, notables)
//
// The replay command stream records player *orders*, not the game simulation, so
// completion times and economy income are estimated from build costs/rates and
// clearly labelled as such in the UI. Order ("started") times are exact.

const { parseReplayBuffer, SIM_TICKS_PER_SECOND, ACTION } = require("./scfa-parser");
const { ensureUnitDb, getUnit, unitLabel, tierLabel } = require("./unit-db");

const FACTION_BY_NUMBER = { 1: "UEF", 2: "Aeon", 3: "Cybran", 4: "Seraphim", 5: "Nomad" };

// Reference build rates for turning a blueprint's BuildTime into an estimated
// duration. Real durations vary with assist/eco; these give a sane single-builder
// estimate (an upper bound for heavily-assisted experimentals).
const FACTORY_RATE = { 1: 20, 2: 40, 3: 60, 4: 60 };
const ENGINEER_RATE = { 1: 7, 2: 14, 3: 28, 4: 28 };
// Standard mass-extractor output per tier, used to estimate the delta of a mex upgrade.
const MEX_OUTPUT = { 1: 2, 2: 6, 3: 18 };

function ticksToSeconds(tick) {
  return Math.round(tick / SIM_TICKS_PER_SECOND);
}

function estDurationTicks(unit, rateTable) {
  const tier = unit.tier || 1;
  const rate = rateTable[tier] || rateTable[1];
  if (!unit.buildTime || !rate) return 0;
  return Math.round((unit.buildTime / rate) * SIM_TICKS_PER_SECOND);
}

// Build the source -> player map from the header armies (humans only).
function buildPlayers(header, body) {
  const players = [];
  for (const army of header.armies) {
    if (army.source === 255) continue;
    const data = army.data || {};
    const stats = body.sources.get(army.source) || {};
    const spanTicks = stats.terminatedTick || body.endTick || 0;
    const minutes = Math.max(spanTicks / SIM_TICKS_PER_SECOND / 60, 0.1);
    const raw = stats.raw || 0;
    const effective = stats.effective || 0;
    players.push({
      source: army.source,
      name: data.PlayerName || data.Nickname || `Player ${army.source}`,
      factionNumber: data.Faction ?? null,
      faction: FACTION_BY_NUMBER[data.Faction] || null,
      team: data.Team ?? null,
      rawActions: raw,
      effectiveActions: effective,
      factoryQueuedActions: stats.factoryQueued || 0,
      collapsedChainActions: stats.chained || 0,
      rawApm: Math.round(raw / minutes),
      effectiveApm: Math.round(effective / minutes),
      activeSeconds: ticksToSeconds(spanTicks)
    });
  }
  return players.sort((a, b) => (a.team - b.team) || (a.source - b.source));
}

// Per-source economy estimate: a list of {tick, dMass, dEnergy} contributions
// (eco structures completing), so we can snapshot income at any event tick.
function buildEcoContributions(buildOrders, db) {
  const contributions = new Map(); // source -> [{tick, dMass, dEnergy}]
  function add(source, tick, dMass, dEnergy) {
    if (!dMass && !dEnergy) return;
    if (!contributions.has(source)) contributions.set(source, []);
    contributions.get(source).push({ tick, dMass, dEnergy });
  }

  for (const order of buildOrders) {
    const unit = getUnit(db, order.blueprintId);
    if (!unit) continue;
    const isEcoBuild = unit.isMassExtraction || unit.isEnergyProduction || unit.isMassFabrication;
    if (!isEcoBuild) continue;

    const completion = order.tick + estDurationTicks(unit, ENGINEER_RATE);
    if (order.actionType === ACTION.Upgrade && unit.isMassExtraction) {
      // Mex upgrade: count only the delta over the previous tier's output.
      const prev = MEX_OUTPUT[(unit.tier || 2) - 1] || 0;
      add(order.source, completion, (unit.prodMass || 0) - prev, unit.prodEnergy || 0);
    } else {
      add(order.source, completion, unit.prodMass || 0, unit.prodEnergy || 0);
    }
  }

  for (const list of contributions.values()) list.sort((a, b) => a.tick - b.tick);
  return contributions;
}

function ecoAt(contributions, source, tick) {
  const list = contributions.get(source);
  if (!list) return { mass: 0, energy: 0 };
  let mass = 0;
  let energy = 0;
  for (const c of list) {
    if (c.tick > tick) break;
    mass += c.dMass;
    energy += c.dEnergy;
  }
  return { mass: Math.round(mass * 10) / 10, energy: Math.round(energy) };
}

function iconInfo(unit) {
  return {
    blueprintId: unit.id,
    strategicIcon: unit.strategicIcon || null,
    iconUrl: `/api/unit-icon/${encodeURIComponent(unit.id)}`
  };
}

// Notable non-experimental structures worth a timeline marker.
function notableKind(unit) {
  const c = unit.categories;
  if (c.includes("SILO") && c.includes("NUKE")) return "Strategic Missile Launcher";
  if (c.includes("ANTIMISSILE") && c.includes("STRUCTURE") && unit.tier >= 3) return "Strategic Missile Defense";
  if (c.includes("ARTILLERY") && c.includes("STRUCTURE") && unit.tier >= 3) return "Heavy Artillery";
  return null;
}

// Build/upgrade action semantics (the action names refer to the *builder*):
//   BuildMobile (8)  -> a mobile unit (engineer/ACU) constructs a structure/experimental
//   BuildFactory (7) -> a factory produces a mobile unit
//   Upgrade (27)     -> a structure/unit upgrades to a higher blueprint (factory HQ, mex, ACU enh)

function makeEvent(player, unit, type, label, startTick, etaTick, eco) {
  return {
    type,
    label,
    tier: unit.tier,
    tierLabel: tierLabel(unit.tier),
    source: player.source,
    player: player.name,
    faction: player.faction || unit.faction,
    seconds: ticksToSeconds(etaTick != null ? etaTick : startTick),
    startedSeconds: ticksToSeconds(startTick),
    etaSeconds: etaTick != null ? ticksToSeconds(etaTick) : null,
    estimated: etaTick != null,
    unit: {
      id: unit.id,
      label: unitLabel(unit),
      nickname: unit.nickname,
      role: unit.role
    },
    icon: iconInfo(unit),
    eco: ecoAt(eco, player.source, etaTick != null ? etaTick : startTick)
  };
}

function buildTimeline(body, db, players) {
  const playerBySource = new Map(players.map((p) => [p.source, p]));
  const eco = buildEcoContributions(body.buildOrders, db);
  const events = [];

  // --- Factory HQ upgrades: sequence queued upgrades per factory entity so a
  // T2-then-T3 chain shows realistic completion times, not the queue time. ---
  const upgradeChains = new Map(); // entity -> [{order, unit}]
  for (const order of body.buildOrders) {
    if (order.actionType !== ACTION.Upgrade) continue;
    const unit = getUnit(db, order.blueprintId);
    if (!unit || !unit.isFactory || unit.tier < 2) continue;
    const key = order.entity != null ? `e${order.entity}` : `s${order.source}:${unit.id}`;
    if (!upgradeChains.has(key)) upgradeChains.set(key, []);
    upgradeChains.get(key).push({ order, unit });
  }
  for (const chain of upgradeChains.values()) {
    chain.sort((a, b) => a.order.tick - b.order.tick);
    let prevComplete = 0;
    let seenTarget = null;
    for (const { order, unit } of chain) {
      if (seenTarget === unit.id) continue; // dedupe re-issued identical upgrade
      seenTarget = unit.id;
      const player = playerBySource.get(order.source);
      if (!player) continue;
      const execStart = Math.max(order.tick, prevComplete);
      const complete = execStart + estDurationTicks(unit, FACTORY_RATE);
      prevComplete = complete;
      events.push(makeEvent(player, unit, "tech_upgrade", `${tierLabel(unit.tier)} ${unit.role}`, order.tick, complete, eco));
    }
  }

  // --- Other events in a single pass. ---
  const firstTier = new Map(); // `${source}:${tier}` -> true
  const lastBuilt = new Map(); // `${source}:${bpid}` -> tick (dedupe re-issues)

  for (const order of body.buildOrders) {
    if (order.actionType === ACTION.Upgrade) continue; // handled above / eco below
    const unit = getUnit(db, order.blueprintId);
    if (!unit) continue;
    const player = playerBySource.get(order.source);
    if (!player) continue;

    // T4 / experimental (incl. Paragon, Mavor, Yolona Oss, Czar...). Completion
    // depends heavily on assisting engineers, so we report the (exact) start time.
    if (unit.isExperimental) {
      const key = `${order.source}:${unit.id}`;
      const last = lastBuilt.get(key);
      if (last != null && order.tick - last < 90 * SIM_TICKS_PER_SECOND) continue;
      lastBuilt.set(key, order.tick);
      events.push(makeEvent(player, unit, "experimental", `T4 ${unitLabel(unit)}`, order.tick, null, eco));
      continue;
    }

    // Notable strategic structures (nuke launcher, SMD, heavy artillery).
    const notable = notableKind(unit);
    if (notable) {
      const key = `${order.source}:${unit.id}`;
      const last = lastBuilt.get(key);
      if (last != null && order.tick - last < 90 * SIM_TICKS_PER_SECOND) continue;
      lastBuilt.set(key, order.tick);
      events.push(makeEvent(player, unit, "notable", `${notable} — ${unitLabel(unit)}`, order.tick, null, eco));
      continue;
    }

    // First combat/utility unit of a new tier out of a factory (BuildFactory =
    // factory production). Exclude engineers and the commander.
    if (order.actionType === ACTION.BuildFactory && unit.isMobile && !unit.isEngineer && !unit.isCommander && (unit.tier === 2 || unit.tier === 3)) {
      const key = `${order.source}:${unit.tier}`;
      if (firstTier.has(key)) continue;
      firstTier.set(key, true);
      const eta = order.tick + estDurationTicks(unit, FACTORY_RATE);
      events.push(makeEvent(player, unit, "first_unit", `First ${tierLabel(unit.tier)} unit — ${unitLabel(unit)}`, order.tick, eta, eco));
      continue;
    }
  }

  events.sort((a, b) => a.seconds - b.seconds);
  return events;
}

async function analyzeReplayBuffer(fileBuffer) {
  const { meta, header, body } = parseReplayBuffer(fileBuffer);
  const db = await ensureUnitDb();
  const players = buildPlayers(header, body);
  const timeline = buildTimeline(body, db, players);

  return {
    durationSeconds: ticksToSeconds(body.endTick),
    map: header.mapName,
    unitDbVersion: db.version,
    players,
    timeline
  };
}

module.exports = { analyzeReplayBuffer, buildPlayers, buildTimeline };
