const { URL } = require("url");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const MAX_REPLAY_BYTES = Number(process.env.MAX_REPLAY_BYTES || 32 * 1024 * 1024);
const FAF_REPLAY_ID_PATTERN = /^\d{4,12}$/;
const ALLOWED_REPLAY_HOSTS = new Set([
  "replay.faforever.com",
  "api.faforever.com",
  "content.faforever.com"
]);

function normalizeReplayInput(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error("Enter a replay ID, replay link, or choose a replay file.");
    error.statusCode = 400;
    throw error;
  }

  if (FAF_REPLAY_ID_PATTERN.test(raw)) {
    return {
      replayId: raw,
      url: `https://replay.faforever.com/${raw}`
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    const invalid = new Error("Replay input must be a FAF replay ID or a valid FAF replay URL.");
    invalid.statusCode = 400;
    throw invalid;
  }

  if (parsed.protocol !== "https:" || !ALLOWED_REPLAY_HOSTS.has(parsed.hostname)) {
    const denied = new Error("Only official FAF replay URLs are supported.");
    denied.statusCode = 400;
    throw denied;
  }

  const replayId = parsed.pathname.match(/(\d{4,12})(?:\.fafreplay)?$/)?.[1] || parsed.pathname.match(/game\/(\d{4,12})\/replay/)?.[1] || null;
  return {
    replayId,
    url: parsed.toString()
  };
}

async function fetchReplay(input) {
  const source = normalizeReplayInput(input);
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: {
      "User-Agent": "faftracker-replay-tool/0.1"
    }
  });

  if (!response.ok) {
    const error = new Error(`Unable to download replay (${response.status}).`);
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_REPLAY_BYTES) {
    const error = new Error("Replay is too large to analyze here.");
    error.statusCode = 413;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REPLAY_BYTES) {
    const error = new Error("Replay is too large to analyze here.");
    error.statusCode = 413;
    throw error;
  }

  return {
    ...source,
    finalUrl: response.url,
    buffer
  };
}

function parseFafReplayHeader(buffer) {
  const newlineIndex = buffer.indexOf(10);
  if (newlineIndex <= 0 || newlineIndex > 128 * 1024) {
    return {
      header: null,
      bodyOffset: 0,
      format: "scfareplay"
    };
  }

  const firstLine = buffer.slice(0, newlineIndex).toString("utf8").trim();
  if (!firstLine.startsWith("{")) {
    return {
      header: null,
      bodyOffset: 0,
      format: "scfareplay"
    };
  }

  try {
    return {
      header: JSON.parse(firstLine),
      bodyOffset: newlineIndex + 1,
      format: "fafreplay"
    };
  } catch (error) {
    return {
      header: null,
      bodyOffset: 0,
      format: "unknown"
    };
  }
}

function secondsToLabel(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function teamRowsFromHeader(header) {
  const teams = header?.teams && typeof header.teams === "object" ? header.teams : {};
  return Object.entries(teams)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([teamId, players]) => ({
      id: teamId,
      name: teamId === "1" ? "Civilians" : `Team ${teamId}`,
      players: Array.isArray(players) ? players.map((name) => ({ name: String(name) })) : []
    }));
}

function createTimeline(durationSeconds, players) {
  const bucketCount = Math.max(1, Math.min(120, Math.ceil(Math.max(1, durationSeconds) / 30)));
  const bucketSeconds = Math.max(1, Math.ceil(Math.max(1, durationSeconds) / bucketCount));
  return Array.from({ length: bucketCount }, (_, index) => ({
    index,
    start: index * bucketSeconds,
    end: Math.min(durationSeconds, (index + 1) * bucketSeconds),
    label: `${secondsToLabel(index * bucketSeconds)}-${secondsToLabel(Math.min(durationSeconds, (index + 1) * bucketSeconds))}`,
    players: players.map((player) => ({
      name: player.name,
      apm: null,
      actions: null,
      heat: 0
    }))
  }));
}

function runCommandParser(buffer) {
  const bundledPython = path.join(
    process.env.USERPROFILE || "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  const python = process.env.REPLAY_PYTHON
    || process.env.PYTHON
    || (process.platform === "win32" && fs.existsSync(bundledPython) ? bundledPython : null)
    || (process.platform === "win32" ? "python" : "python3");
  const scriptPath = path.join(__dirname, "..", "..", "scripts", "replay_command_analyzer.py");
  const diagnostics = {
    python,
    scriptPath,
    scriptExists: fs.existsSync(scriptPath),
    bundledPython,
    bundledPythonExists: fs.existsSync(bundledPython),
    cwd: process.cwd()
  };
  const result = spawnSync(python, [scriptPath], {
    input: JSON.stringify({ replayBase64: buffer.toString("base64") }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: Number(process.env.REPLAY_PARSER_TIMEOUT_MS || 30000)
  });

  if (result.error) {
    return {
      available: false,
      error: result.error.message,
      diagnostics
    };
  }

  if (result.status !== 0) {
    return {
      available: false,
      error: (result.stderr || result.stdout || "Replay parser failed.").trim().slice(0, 1200),
      diagnostics: {
        ...diagnostics,
        status: result.status,
        signal: result.signal,
        stderr: (result.stderr || "").trim().slice(0, 1200),
        stdout: (result.stdout || "").trim().slice(0, 1200)
      }
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ...parsed,
      diagnostics: {
        ...diagnostics,
        status: result.status
      }
    };
  } catch (error) {
    return {
      available: false,
      error: "Replay parser returned invalid JSON.",
      diagnostics: {
        ...diagnostics,
        status: result.status,
        stdout: (result.stdout || "").trim().slice(0, 1200),
        stderr: (result.stderr || "").trim().slice(0, 1200)
      }
    };
  }
}

function runMapPreview(mapName) {
  if (!mapName || mapName === "Unknown map") {
    return null;
  }
  const bundledPython = path.join(
    process.env.USERPROFILE || "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  const python = process.env.REPLAY_PYTHON
    || process.env.PYTHON
    || (process.platform === "win32" && fs.existsSync(bundledPython) ? bundledPython : null)
    || (process.platform === "win32" ? "python" : "python3");
  const scriptPath = path.join(__dirname, "..", "..", "scripts", "map_preview.py");
  const result = spawnSync(python, [scriptPath], {
    input: JSON.stringify({ map: mapName }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: Number(process.env.MAP_PREVIEW_TIMEOUT_MS || 30000)
  });

  if (result.status !== 0 || result.error) {
    return {
      error: result.error?.message || (result.stderr || result.stdout || "Map preview unavailable.").trim().slice(0, 500)
    };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { error: "Map preview returned invalid JSON." };
  }
}

function mergeCommandAnalysis(base, commandAnalysis) {
  if (!commandAnalysis?.available) {
    const parserError = commandAnalysis?.error || "Replay command parser did not return command data.";
    const parserNote = `Replay command parser unavailable: ${parserError}`;
    return {
      ...base,
      apm: base.apm.map((player) => ({
        ...player,
        note: parserNote
      })),
      heatmap: {
        ...base.heatmap,
        note: parserNote
      },
      parser: {
        ...base.parser,
        available: false,
        note: parserNote,
        error: parserError,
        diagnostics: commandAnalysis?.diagnostics || null
      }
    };
  }

  const teamByPlayer = new Map();
  for (const team of base.teams) {
    for (const player of team.players) {
      teamByPlayer.set(player.name, team.id);
    }
  }

  const durationSeconds = Math.max(base.replay.durationSeconds || 0, commandAnalysis.durationSeconds || 0);
  const durationLabel = durationSeconds ? secondsToLabel(durationSeconds) : base.replay.durationLabel;
  const players = commandAnalysis.players || [];
  const timeline = (commandAnalysis.timeline || []).map((bucket) => ({
    ...bucket,
    label: `${secondsToLabel(bucket.start)}-${secondsToLabel(bucket.end)}`,
    players: bucket.players || []
  }));

  return {
    ...base,
    replay: {
      ...base.replay,
      durationSeconds,
      durationLabel
    },
    apm: players.map((player) => ({
      name: player.name,
      teamId: teamByPlayer.get(player.name) || String(Number(player.source || 0) + 2),
      apm: player.apm,
      effectiveActions: player.effectiveActions,
      rawCommands: player.rawCommands,
      tech: player.tech || {},
      firstUnits: player.firstUnits || {},
      milestones: player.milestones || [],
      details: player.details || [],
      status: player.status || {},
      note: commandAnalysis.note
    })),
    heatmap: {
      bucketSeconds: commandAnalysis.bucketSeconds || base.heatmap.bucketSeconds,
      timeline,
      points: Object.fromEntries(players.map((player) => [player.name, player.points || []])),
      note: commandAnalysis.note
    },
    parser: {
      available: true,
      quality: "commands",
      commandCounts: commandAnalysis.commandCounts || {},
      diagnostics: commandAnalysis.diagnostics || null,
      note: commandAnalysis.note
    }
  };
}

function analyzeReplayBuffer(buffer, source = {}) {
  const { header, bodyOffset, format } = parseFafReplayHeader(buffer);
  const teams = teamRowsFromHeader(header);
  const players = teams.flatMap((team) => team.players.map((player) => ({ ...player, teamId: team.id })));
  const launchedAt = Number(header?.launched_at || 0);
  const gameEnd = Number(header?.game_end || 0);
  const durationSeconds = gameEnd > launchedAt ? gameEnd - launchedAt : 0;

  const mapName = header?.mapname || "Unknown map";
  const base = {
    source: {
      replayId: source.replayId || header?.uid || null,
      url: source.finalUrl || source.url || null,
      format,
      bytes: buffer.length,
      bodyBytes: Math.max(0, buffer.length - bodyOffset)
    },
    replay: {
      id: header?.uid || source.replayId || null,
      title: header?.title || "FAF replay",
      map: mapName,
      featuredMod: header?.featured_mod || null,
      gameType: header?.game_type || null,
      recorder: header?.recorder || null,
      host: header?.host || null,
      complete: header?.complete ?? null,
      launchedAt: launchedAt ? new Date(launchedAt * 1000).toISOString() : null,
      endedAt: gameEnd ? new Date(gameEnd * 1000).toISOString() : null,
      durationSeconds,
      durationLabel: durationSeconds ? secondsToLabel(durationSeconds) : "Unknown"
    },
    teams,
    apm: players.map((player) => ({
      name: player.name,
      teamId: player.teamId,
      apm: null,
      effectiveActions: null,
      rawCommands: null,
      note: "Command-stream parser is not installed yet, so APM is not calculated."
    })),
    heatmap: {
      bucketSeconds: durationSeconds ? Math.max(1, Math.ceil(durationSeconds / Math.max(1, Math.min(120, Math.ceil(durationSeconds / 30))))) : 30,
      timeline: createTimeline(durationSeconds || 1, players),
      note: "Heatmap timeline is ready for command data, but this replay needs command-stream parsing before it can show real activity."
    },
    parser: {
      available: false,
      quality: header ? "metadata" : "unparsed",
      note: header
        ? "Loaded FAF replay metadata. Full movement/action heatmap and corrected APM require the replay command parser adapter."
        : "Could not read a FAF replay metadata header from this file."
    }
  };
  const merged = mergeCommandAnalysis(base, runCommandParser(buffer));
  return {
    ...merged,
    mapPreview: runMapPreview(mapName)
  };
}

module.exports = {
  MAX_REPLAY_BYTES,
  analyzeReplayBuffer,
  fetchReplay,
  normalizeReplayInput
};
