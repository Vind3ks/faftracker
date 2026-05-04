const elements = {
  replayInput: document.getElementById("replayInput"),
  replayFileInput: document.getElementById("replayFileInput"),
  loadReplayButton: document.getElementById("loadReplayButton"),
  fileName: document.getElementById("fileName"),
  message: document.getElementById("message"),
  parserStatus: document.getElementById("parserStatus"),
  summary: document.getElementById("summary"),
  teamsPanel: document.getElementById("teamsPanel"),
  teams: document.getElementById("teams"),
  heatmapPanel: document.getElementById("heatmapPanel"),
  heatmapCanvas: document.getElementById("heatmapCanvas"),
  heatmapNote: document.getElementById("heatmapNote"),
  playButton: document.getElementById("playButton"),
  timeSlider: document.getElementById("timeSlider"),
  timeLabel: document.getElementById("timeLabel"),
  apmPanel: document.getElementById("apmPanel"),
  apmTable: document.getElementById("apmTable")
};

let currentAnalysis = null;
let playTimer = null;

function setMessage(text, tone = "muted") {
  elements.message.className = `panel ${tone}`;
  elements.message.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value) {
  return value === null || value === undefined ? "Pending parser" : Number(value).toLocaleString();
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function requestAnalysis(payload) {
  const response = await fetch("/api/replays/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to analyze replay.");
  }
  return data;
}

function renderSummary(analysis) {
  const replay = analysis.replay;
  const cards = [
    ["Map", replay.map],
    ["Time", replay.durationLabel],
    ["Players", analysis.teams.reduce((sum, team) => sum + team.players.length, 0)],
    ["Replay", replay.id || analysis.source.format]
  ];
  elements.summary.innerHTML = cards.map(([label, value]) => `
    <article class="summary-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join("");
  elements.summary.hidden = false;
}

function renderTeams(teams) {
  elements.teams.innerHTML = teams.length
    ? teams.map((team) => `
      <article class="team-card">
        <h3>${escapeHtml(team.name)}</h3>
        <div>${team.players.map((player) => `<span class="player-pill">${escapeHtml(player.name)}</span>`).join("") || "<p class=\"muted\">No players listed</p>"}</div>
      </article>
    `).join("")
    : "<p class=\"muted\">No team metadata was found in this replay.</p>";
  elements.teamsPanel.hidden = false;
}

function playerColor(index, total) {
  const hue = Math.round((index / Math.max(1, total)) * 300 + 35);
  return `hsl(${hue} 78% 62%)`;
}

function drawHeatmap(frameIndex = 0) {
  const canvas = elements.heatmapCanvas;
  const context = canvas.getContext("2d");
  const analysis = currentAnalysis;
  if (!analysis) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#05090d";
  context.fillRect(0, 0, width, height);

  const timeline = analysis.heatmap.timeline || [];
  const players = analysis.apm || [];
  const pointsByPlayer = analysis.heatmap.points || {};
  const plotX = 44;
  const plotY = 34;
  const plotW = width - 78;
  const plotH = height - 76;

  context.strokeStyle = "rgba(151, 175, 198, 0.18)";
  context.lineWidth = 1;
  for (let i = 0; i <= 8; i += 1) {
    const x = plotX + (plotW / 8) * i;
    context.beginPath();
    context.moveTo(x, plotY);
    context.lineTo(x, plotY + plotH);
    context.stroke();
  }

  if (!players.length) {
    context.fillStyle = "#9dafbf";
    context.font = "24px Segoe UI";
    context.fillText("No player command data yet", plotX + 24, plotY + 74);
    return;
  }

  const allPoints = Object.values(pointsByPlayer).flat();
  const bounds = allPoints.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x),
    maxX: Math.max(acc.maxX, point.x),
    minZ: Math.min(acc.minZ, point.z),
    maxZ: Math.max(acc.maxZ, point.z)
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const hasMapPoints = Number.isFinite(bounds.minX) && bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ;
  const currentBucket = timeline[Math.min(frameIndex, Math.max(0, timeline.length - 1))] || { start: 0, end: 0 };

  if (hasMapPoints) {
    context.fillStyle = "rgba(255,255,255,0.035)";
    context.fillRect(plotX, plotY, plotW, plotH);
    context.strokeStyle = "rgba(151, 175, 198, 0.12)";
    for (let i = 0; i <= 10; i += 1) {
      const x = plotX + (plotW / 10) * i;
      const y = plotY + (plotH / 10) * i;
      context.beginPath();
      context.moveTo(x, plotY);
      context.lineTo(x, plotY + plotH);
      context.moveTo(plotX, y);
      context.lineTo(plotX + plotW, y);
      context.stroke();
    }

    players.forEach((player, playerIndex) => {
      const color = playerColor(playerIndex, players.length);
      const points = pointsByPlayer[player.name] || [];
      for (const point of points) {
        const age = currentBucket.end - point.second;
        if (point.second > currentBucket.end || age > Math.max(25, analysis.heatmap.bucketSeconds * 2.5)) {
          continue;
        }
        const x = plotX + ((point.x - bounds.minX) / (bounds.maxX - bounds.minX)) * plotW;
        const y = plotY + ((point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ)) * plotH;
        const alpha = Math.max(0.08, 1 - age / Math.max(25, analysis.heatmap.bucketSeconds * 2.5));
        context.globalAlpha = alpha;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, 4 + alpha * 7, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      context.fillStyle = color;
      context.font = "15px Segoe UI";
      context.fillText(player.name, plotX + 12, plotY + 24 + playerIndex * 22);
    });
  } else {
    const laneH = plotH / players.length;
  players.forEach((player, playerIndex) => {
    const y = plotY + playerIndex * laneH;
    context.fillStyle = "rgba(255,255,255,0.035)";
    context.fillRect(plotX, y + 8, plotW, Math.max(20, laneH - 14));
    context.fillStyle = playerColor(playerIndex, players.length);
    context.font = "16px Segoe UI";
    context.fillText(player.name, plotX + 10, y + Math.min(laneH - 8, 30));
  });

  timeline.forEach((bucket, bucketIndex) => {
    const x = plotX + (plotW / Math.max(1, timeline.length)) * bucketIndex;
    const w = Math.max(2, plotW / Math.max(1, timeline.length) - 2);
    bucket.players.forEach((player, playerIndex) => {
      const y = plotY + playerIndex * laneH + 8;
      const heat = Number(player.heat || 0);
      if (heat <= 0) {
        return;
      }
      context.fillStyle = playerColor(playerIndex, players.length);
      context.globalAlpha = Math.max(0.12, Math.min(0.92, heat));
      context.fillRect(x, y, w, Math.max(20, laneH - 14));
      context.globalAlpha = 1;
    });
  });
  }

  const cursorX = plotX + (plotW / Math.max(1, timeline.length - 1)) * Math.min(frameIndex, Math.max(0, timeline.length - 1));
  context.strokeStyle = "#edf6fb";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(cursorX, plotY - 10);
  context.lineTo(cursorX, plotY + plotH + 10);
  context.stroke();

  context.fillStyle = "#9dafbf";
  context.font = "13px Segoe UI";
  context.fillText("Replay time", plotX, height - 20);
}

function renderHeatmap(analysis) {
  const timeline = analysis.heatmap.timeline || [];
  elements.timeSlider.max = String(Math.max(0, timeline.length - 1));
  elements.timeSlider.value = "0";
  elements.timeLabel.textContent = timeline[0]?.label || "0:00";
  elements.heatmapNote.textContent = analysis.heatmap.note || "";
  elements.heatmapPanel.hidden = false;
  drawHeatmap(0);
}

function renderApm(analysis) {
  elements.apmTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Team</th>
          <th>Effective APM</th>
          <th>Effective actions</th>
          <th>Raw commands</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        ${analysis.apm.map((row) => `
          <tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.teamId)}</td>
            <td>${escapeHtml(formatNumber(row.apm))}</td>
            <td>${escapeHtml(formatNumber(row.effectiveActions))}</td>
            <td>${escapeHtml(formatNumber(row.rawCommands))}</td>
            <td>${escapeHtml(row.note || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  elements.apmPanel.hidden = false;
}

function renderParserStatus(analysis) {
  const parser = analysis.parser || {};
  const diagnostics = parser.diagnostics || {};
  const status = parser.available ? "Active" : "Unavailable";
  const quality = parser.quality || "unknown";
  const commandCounts = parser.commandCounts
    ? Object.entries(parser.commandCounts).map(([name, count]) => `${name}: ${count}`).join(", ")
    : "";
  elements.parserStatus.innerHTML = `
    <strong>Parser ${escapeHtml(status)} (${escapeHtml(quality)})</strong>
    <div>${escapeHtml(parser.note || parser.error || "No parser detail returned.")}</div>
    ${parser.error ? `<div><strong>Error:</strong> ${escapeHtml(parser.error)}</div>` : ""}
    ${diagnostics.python ? `<div><strong>Python:</strong> <code>${escapeHtml(diagnostics.python)}</code></div>` : ""}
    ${diagnostics.scriptPath ? `<div><strong>Adapter:</strong> <code>${escapeHtml(diagnostics.scriptPath)}</code> (${diagnostics.scriptExists ? "found" : "missing"})</div>` : ""}
    ${commandCounts ? `<div><strong>Commands:</strong> ${escapeHtml(commandCounts)}</div>` : ""}
  `;
  elements.parserStatus.className = `panel parser-status ${parser.available ? "good" : "bad"}`;
  elements.parserStatus.hidden = false;
}

function renderAnalysis(analysis) {
  currentAnalysis = analysis;
  renderParserStatus(analysis);
  renderSummary(analysis);
  renderTeams(analysis.teams);
  renderHeatmap(analysis);
  renderApm(analysis);
  setMessage(analysis.parser.note, analysis.parser.available ? "good" : "muted");
}

async function loadFromInput() {
  const input = elements.replayInput.value.trim();
  setMessage("Loading replay...", "muted");
  elements.loadReplayButton.disabled = true;
  try {
    renderAnalysis(await requestAnalysis({ source: input }));
  } catch (error) {
    setMessage(error.message, "bad");
  } finally {
    elements.loadReplayButton.disabled = false;
  }
}

async function loadFromFile(file) {
  if (!file) {
    return;
  }
  elements.fileName.textContent = file.name;
  setMessage(`Reading ${file.name}...`, "muted");
  try {
    const buffer = await file.arrayBuffer();
    renderAnalysis(await requestAnalysis({
      fileName: file.name,
      replayBase64: arrayBufferToBase64(buffer)
    }));
  } catch (error) {
    setMessage(error.message, "bad");
  }
}

function setFrame(index) {
  const timeline = currentAnalysis?.heatmap?.timeline || [];
  const safeIndex = Math.max(0, Math.min(Number(index || 0), Math.max(0, timeline.length - 1)));
  elements.timeSlider.value = String(safeIndex);
  elements.timeLabel.textContent = timeline[safeIndex]?.label || formatTime(0);
  drawHeatmap(safeIndex);
}

function stopPlayback() {
  if (playTimer) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  elements.playButton.textContent = "Play";
}

function togglePlayback() {
  if (playTimer) {
    stopPlayback();
    return;
  }
  elements.playButton.textContent = "Pause";
  playTimer = window.setInterval(() => {
    const next = Number(elements.timeSlider.value || 0) + 1;
    if (next > Number(elements.timeSlider.max || 0)) {
      stopPlayback();
      return;
    }
    setFrame(next);
  }, 160);
}

elements.loadReplayButton.addEventListener("click", loadFromInput);
elements.replayInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadFromInput();
  }
});
elements.replayFileInput.addEventListener("change", () => loadFromFile(elements.replayFileInput.files?.[0]));
elements.timeSlider.addEventListener("input", () => {
  stopPlayback();
  setFrame(elements.timeSlider.value);
});
elements.playButton.addEventListener("click", togglePlayback);
