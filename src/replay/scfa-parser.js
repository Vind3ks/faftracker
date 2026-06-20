"use strict";

// Parser for FAF `.fafreplay` files.
//
// A `.fafreplay` is one line of JSON metadata, a newline, then the compressed
// Supreme Commander: Forged Alliance command stream. Modern replays use raw
// zstd (`compression: "zstd"`); legacy replays use base64(QtCompress) where the
// payload is a 4-byte big-endian length prefix followed by a raw zlib stream.
//
// The binary stream format follows the official FAForever parser
// (github.com/FAForever/faf-scfa-replay-parser). We only deep-parse the commands
// we need (source switches, ticks, build/upgrade orders) and skip the rest using
// each packet's explicit length, which keeps the parser robust against the many
// command variants we don't care about.

const zlib = require("zlib");
const fzstd = require("fzstd");

const SIM_TICKS_PER_SECOND = 10;

// Lua serialization type tags.
const LUA = { NUMBER: 0, STRING: 1, NIL: 2, BOOL: 3, TABLE: 4, END: 5 };

// Command stream op-codes (CommandStates).
const CMD = {
  Advance: 0,
  SetCommandSource: 1,
  CommandSourceTerminated: 2,
  VerifyChecksum: 3,
  RequestPause: 4,
  Resume: 5,
  SingleStep: 6,
  CreateUnit: 7,
  CreateProp: 8,
  DestroyEntity: 9,
  WarpEntity: 10,
  ProcessInfoPair: 11,
  IssueCommand: 12,
  IssueFactoryCommand: 13,
  IncreaseCommandCount: 14,
  DecreaseCommandCount: 15,
  SetCommandTarget: 16,
  SetCommandType: 17,
  SetCommandCells: 18,
  RemoveCommandFromQueue: 19,
  DebugCommand: 20,
  ExecuteLuaInSim: 21,
  LuaSimCallback: 22,
  EndGame: 23
};

// Unit command (action) types. See ActionType in the official parser.
const ACTION = {
  Stop: 1,
  Move: 2,
  Dive: 3,
  FormMove: 4,
  BuildSiloTactical: 5,
  BuildSiloNuke: 6,
  BuildFactory: 7,
  BuildMobile: 8,
  BuildAssist: 9,
  Attack: 10,
  FormAttack: 11,
  Nuke: 12,
  Tactical: 13,
  Teleport: 14,
  Guard: 15,
  Patrol: 16,
  Ferry: 17,
  FormPatrol: 18,
  Reclaim: 19,
  Repair: 20,
  Capture: 21,
  TransportLoadUnits: 22,
  TransportReverseLoadUnits: 23,
  TransportUnloadUnits: 24,
  TransportUnloadSpecificUnits: 25,
  DetachFromTransport: 26,
  Upgrade: 27,
  Script: 28,
  AssistCommander: 29,
  KillSelf: 30,
  DestroySelf: 31,
  Sacrifice: 32,
  Pause: 33,
  OverCharge: 34,
  AggressiveMove: 35,
  FormAggressiveMove: 36,
  AssistMove: 37,
  SpecialAction: 38,
  Dock: 39
};

class BufferReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
  skip(n) {
    this.pos += n;
  }
  readByte() {
    return this.buf[this.pos++];
  }
  readBool() {
    return this.buf[this.pos++] !== 0;
  }
  readInt32() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readUInt32() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readUInt16() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readFloat() {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  readString() {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
    const s = this.buf.toString("utf8", start, this.pos);
    this.pos++; // skip terminating null
    return s;
  }
  // Lua value (recursive). Mirrors read_lua / read_dict from the official parser.
  readLua(type) {
    if (type === undefined) type = this.readByte();
    switch (type) {
      case LUA.NUMBER:
        return this.readFloat();
      case LUA.STRING:
        return this.readString();
      case LUA.NIL:
        this.pos++;
        return null;
      case LUA.BOOL:
        return this.readBool();
      case LUA.TABLE: {
        const out = {};
        for (;;) {
          const t = this.readByte();
          if (t === LUA.END) break;
          const key = this.readLua(t);
          const value = this.readLua();
          out[key] = value;
        }
        return out;
      }
      default:
        throw new Error(`Unknown lua data type ${type} at offset ${this.pos}`);
    }
  }
}

// Split a .fafreplay file into its JSON metadata and the decompressed command stream.
function decodeReplayFile(fileBuffer) {
  const newline = fileBuffer.indexOf(0x0a);
  if (newline < 0) throw new Error("Replay file is missing its metadata header.");

  let meta = {};
  try {
    meta = JSON.parse(fileBuffer.slice(0, newline).toString("utf8"));
  } catch (error) {
    throw new Error("Replay metadata header is not valid JSON.");
  }

  const body = fileBuffer.slice(newline + 1);
  const compression = String(meta.compression || "").toLowerCase();

  let raw;
  if (compression === "zstd" || (body.length >= 4 && body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd)) {
    raw = Buffer.from(fzstd.decompress(new Uint8Array(body)));
  } else {
    // Legacy QtCompress: base64 -> [uint32 BE size][zlib stream].
    const decoded = Buffer.from(body.toString("utf8").trim(), "base64");
    raw = zlib.inflateSync(decoded.slice(4));
  }

  return { meta, raw };
}

function parseHeader(reader) {
  const version = reader.readString(); // e.g. "Supreme Commander v1.50.3809"
  reader.skip(3);
  const [replayVersion, mapName] = reader.readString().split("\r\n", 2);

  reader.skip(4);
  reader.readUInt32(); // mods size
  const mods = reader.readLua();
  reader.readUInt32(); // scenario size
  const scenario = reader.readLua();

  const sourceCount = reader.readByte();
  const players = {}; // sourceId -> name
  for (let i = 0; i < sourceCount; i++) {
    const name = reader.readString();
    const playerId = reader.readUInt32();
    players[playerId] = name;
  }

  const cheatsEnabled = reader.readBool();
  const armyCount = reader.readByte();
  const armies = []; // { source, data }
  for (let i = 0; i < armyCount; i++) {
    reader.readUInt32(); // player data size
    const data = reader.readLua();
    const playerSource = reader.readByte();
    armies.push({ source: playerSource, data });
    if (playerSource !== 255) reader.skip(1);
  }

  const randomSeed = reader.readUInt32();

  return {
    version,
    replayVersion,
    mapName,
    mods,
    scenario,
    players,
    cheatsEnabled,
    armies,
    randomSeed
  };
}

// Parse a target struct (STITarget) and return nothing useful — just advance.
function skipTarget(r) {
  const target = r.readByte();
  if (target === 1) r.readInt32(); // entity
  else if (target === 2) {
    r.readFloat();
    r.readFloat();
    r.readFloat();
  }
}

// Parse CmdData and return { actionType, blueprintId }.
function parseCommandData(r) {
  r.readInt32(); // command id
  r.skip(4); // arg1
  const actionType = r.readByte();
  r.skip(4); // arg2
  skipTarget(r);
  r.skip(1); // arg3
  const formation = r.readInt32();
  if (formation !== -1) {
    r.readFloat(); // w
    r.readFloat();
    r.readFloat();
    r.readFloat(); // position
    r.readFloat(); // scale
  }
  const blueprintId = r.readString();
  // arg4 (12) + cells lua + optional trailing byte follow, but we stop here:
  // the outer packet length tells us where the next command starts.
  return { actionType, blueprintId };
}

function parseIssue(dataBuffer) {
  const r = new BufferReader(dataBuffer);
  const unitCount = r.readUInt32();
  let entity = null;
  for (let i = 0; i < unitCount; i++) {
    const id = r.readUInt32();
    if (i === 0) entity = id; // the primary commanded unit (e.g. the factory being upgraded)
  }
  const cmd = parseCommandData(r);
  cmd.entity = entity;
  return cmd;
}

// Walk the command stream, accumulating per-source command stats and a list of
// build/upgrade orders for the timeline. `onEvent` is not used; we collect arrays.
function parseBody(reader) {
  const sources = new Map(); // sourceId -> stats
  const buildOrders = []; // { tick, source, actionType, blueprintId, fromFactory }

  let tick = 0;
  let currentSource = -1;

  function source(id) {
    let s = sources.get(id);
    if (!s) {
      s = { firstTick: null, lastTick: 0, terminatedTick: null };
      sources.set(id, s);
    }
    return s;
  }

  const BUILD_ACTIONS = new Set([
    ACTION.BuildFactory,
    ACTION.BuildMobile,
    ACTION.BuildSiloTactical,
    ACTION.BuildSiloNuke
  ]);

  while (reader.remaining >= 3) {
    const type = reader.readByte();
    const length = reader.readUInt16();
    const dataLen = length - 3;
    if (dataLen < 0 || dataLen > reader.remaining) break; // corrupt / truncated
    const dataStart = reader.pos;

    if (type === CMD.Advance) {
      tick += reader.readUInt32();
    } else if (type === CMD.SetCommandSource) {
      currentSource = reader.readByte();
    } else if (type === CMD.CommandSourceTerminated) {
      if (currentSource >= 0) source(currentSource).terminatedTick = tick;
    } else if (type === CMD.IssueCommand || type === CMD.IssueFactoryCommand) {
      const fromFactory = type === CMD.IssueFactoryCommand;
      const s = source(currentSource);
      if (s.firstTick === null) s.firstTick = tick;
      s.lastTick = tick;
      let info = null;
      try {
        info = parseIssue(reader.buf.slice(dataStart, dataStart + dataLen));
      } catch (error) {
        info = null;
      }
      if (info) {
        const isBuild = BUILD_ACTIONS.has(info.actionType);
        const isUpgrade = info.actionType === ACTION.Upgrade;
        if ((isBuild || isUpgrade) && info.blueprintId) {
          buildOrders.push({
            tick,
            source: currentSource,
            actionType: info.actionType,
            blueprintId: info.blueprintId.toLowerCase(),
            entity: info.entity ?? null,
            fromFactory
          });
        }
        // Record for APM: every issue command is a player action.
        recordAction(s, tick, info.actionType, fromFactory);
      } else {
        recordAction(s, tick, null, fromFactory);
      }
    } else if (type === CMD.IncreaseCommandCount || type === CMD.DecreaseCommandCount) {
      // Factory queue count adjustments — count as raw but never effective.
      if (currentSource >= 0) {
        const s = source(currentSource);
        if (s.firstTick === null) s.firstTick = tick;
        s.lastTick = tick;
        s.raw = (s.raw || 0) + 1;
      }
    }

    // Always advance by the declared packet length.
    reader.pos = dataStart + dataLen;
  }

  return { sources, buildOrders, endTick: tick };
}

const CHAINABLE = new Set([
  ACTION.Move,
  ACTION.FormMove,
  ACTION.Patrol,
  ACTION.FormPatrol,
  ACTION.AggressiveMove,
  ACTION.FormAggressiveMove
]);
const BUILD_ACTION_SET = new Set([
  ACTION.BuildFactory,
  ACTION.BuildMobile,
  ACTION.BuildSiloTactical,
  ACTION.BuildSiloNuke
]);
const CHAIN_WINDOW_TICKS = 10; // ~1s: rapid repeats of the same order collapse to one

// Update raw + effective action counters for a source as we stream commands.
function recordAction(s, tick, actionType, fromFactory) {
  s.raw = (s.raw || 0) + 1;

  // Queuing units in a factory contributes nothing to effective APM. Factory
  // production is the BuildFactory action (the builder is the factory); engineer
  // construction is BuildMobile and DOES count as a meaningful action.
  if (actionType === ACTION.BuildFactory || (fromFactory && (actionType === null || BUILD_ACTION_SET.has(actionType)))) {
    s.factoryQueued = (s.factoryQueued || 0) + 1;
    return;
  }

  if (actionType !== null && CHAINABLE.has(actionType)) {
    // Collapse shift move/patrol chains: only the first order in a run counts.
    if (s._chainType === actionType && tick - s._chainTick <= CHAIN_WINDOW_TICKS) {
      s._chainTick = tick;
      s.chained = (s.chained || 0) + 1;
      return;
    }
    s._chainType = actionType;
    s._chainTick = tick;
    s.effective = (s.effective || 0) + 1;
    return;
  }

  s._chainType = null;
  s.effective = (s.effective || 0) + 1;
}

// Top-level: turn a downloaded file buffer into parsed structures.
function parseReplayBuffer(fileBuffer) {
  const { meta, raw } = decodeReplayFile(fileBuffer);
  const reader = new BufferReader(raw);
  const header = parseHeader(reader);
  const body = parseBody(reader);
  return { meta, header, body };
}

module.exports = {
  parseReplayBuffer,
  decodeReplayFile,
  parseHeader,
  parseBody,
  BufferReader,
  SIM_TICKS_PER_SECOND,
  CMD,
  ACTION,
  LUA
};
