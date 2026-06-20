"use strict";

// Downloads a `.fafreplay` file and runs the command-stream analysis.

const { analyzeReplayBuffer } = require("./analyze");

const REPLAY_URL = (id) => `https://replay.faforever.com/${id}`;

async function downloadReplay(replayId) {
  let response;
  try {
    response = await fetch(REPLAY_URL(replayId), { headers: { "User-Agent": "faf-scout/0.2" } });
  } catch (error) {
    const err = new Error("Could not reach the FAF replay server.");
    err.statusCode = 502;
    throw err;
  }
  if (response.status === 404) {
    const err = new Error(`Replay ${replayId} has no downloadable replay file.`);
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

async function analyzeReplayById(replayId) {
  const buffer = await downloadReplay(replayId);
  return analyzeReplayBuffer(buffer);
}

module.exports = { downloadReplay, analyzeReplayById };
