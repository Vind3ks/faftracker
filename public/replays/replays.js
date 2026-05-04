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
  speedSelect: document.getElementById("speedSelect"),
  timeSlider: document.getElementById("timeSlider"),
  timeLabel: document.getElementById("timeLabel")
};

let currentAnalysis = null;
let playAnimation = null;
let playbackSecond = 0;
let lastFrameTime = 0;
let mapImage = null;
let mapImageSource = "";
let canvasCssWidth = 0;
let canvasCssHeight = 0;

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

function statsByPlayer(analysis) {
  return new Map((analysis.apm || []).map((player) => [player.name, player]));
}

function formatTechTime(entry) {
  return entry?.second === undefined ? "n/a" : formatTime(entry.second);
}

function statusLabel(status) {
  if (!status?.type) {
    return "No death or exit found";
  }
  const time = formatTechTime(status);
  if (status.type === "left") {
    return `${time}: player disconnected or left`;
  }
  if (status.type === "ended") {
    return `${time}: game ended`;
  }
  return `${time}: replay event recorded`;
}

function unitIcon(entry) {
  const kind = entry?.kind || "";
  if (kind === "structure") {
    return "HQ";
  }
  if (kind === "air") {
    return "AIR";
  }
  if (kind === "naval") {
    return "SEA";
  }
  if (kind === "land") {
    return "BOT";
  }
  return "U";
}

function blueprintIcon(entry, fallback) {
  if (entry?.iconDataUrl) {
    return `<img class="blueprint-icon" src="${entry.iconDataUrl}" alt="" loading="lazy">`;
  }
  return `<span class="tech-icon">${escapeHtml(fallback)}</span>`;
}

function milestoneDetail(entry, emptyText) {
  return entry?.label || emptyText;
}

function eventFallbackIcon(event) {
  if (event?.iconText) {
    return event.iconText;
  }
  if (event?.type === "acu") {
    return "ACU";
  }
  if (event?.type === "tech") {
    return "HQ";
  }
  return unitIcon(event);
}

function milestoneRow(event) {
  const title = event?.eventType || event?.label || "Milestone";
  const unitName = event?.unitName || event?.label || "";
  const subtitle = unitName || event?.unitDescription || event?.detail || milestoneDetail(event, "Important replay event");
  return `
    <div class="tech-row">
      ${blueprintIcon(event, eventFallbackIcon(event))}
      <div class="tech-copy">
        <div class="tech-title">${escapeHtml(title)}</div>
        <span class="tech-detail">${escapeHtml(subtitle)}</span>
      </div>
      <span class="time-pill">${escapeHtml(formatTechTime(event))}</span>
    </div>
  `;
}

function detailRow(event) {
  return `
    <div class="tech-row">
      ${blueprintIcon(event, eventFallbackIcon(event))}
      <div class="tech-copy">
        <div class="tech-title">${escapeHtml(event?.label || "Unit")}</div>
        <span class="tech-detail">${escapeHtml(event?.detail || "First order seen")}</span>
      </div>
      <span class="time-pill">${escapeHtml(formatTechTime(event))}</span>
    </div>
  `;
}

function statusBadge(status) {
  return `
    <div class="tech-row">
      <span class="tech-icon status-icon">X</span>
      <div class="tech-copy">
        <div class="tech-title">Status</div>
        <span class="tech-detail">${escapeHtml(statusLabel(status))}</span>
      </div>
      <span class="time-pill">${escapeHtml(status?.second === undefined ? "n/a" : formatTechTime(status))}</span>
    </div>
  `;
}

function renderPlayerMilestones(stats) {
  const milestones = stats.milestones || [];
  const details = stats.details || [];
  const defaultRows = milestones.length
    ? milestones.map(milestoneRow).join("")
    : `<div class="empty-milestone">No completed HQ tech, engineer, power, nuke, SMD, or experimental event detected.</div>`;
  const detailRows = details.length
    ? details.map(detailRow).join("")
    : `<div class="empty-milestone">No detailed build-order data was found.</div>`;

  return `
    <div class="tech-stats">
      ${defaultRows}
      ${statusBadge(stats.status)}
      <details class="detail-toggle">
        <summary>Show detailed first orders</summary>
        <div class="detail-rows">${detailRows}</div>
      </details>
    </div>
  `;
}

function renderTeams(analysis) {
  const teams = analysis.teams || [];
  const apmByPlayer = statsByPlayer(analysis);
  elements.teams.innerHTML = teams.length
    ? teams.map((team) => `
      <article class="team-card">
        <h3>${escapeHtml(team.name)}</h3>
        <div>${team.players.map((player) => {
          const stats = apmByPlayer.get(player.name) || {};
          return `
            <div class="player-pill">
              <span>${escapeHtml(player.name)}</span>
              <div class="player-stats">
                <span><strong>${escapeHtml(formatNumber(stats.apm))}</strong>Eff. APM</span>
                <span><strong>${escapeHtml(formatNumber(stats.effectiveActions))}</strong>Actions</span>
                <span><strong>${escapeHtml(formatNumber(stats.rawCommands))}</strong>Raw</span>
              </div>
              ${renderPlayerMilestones(stats)}
            </div>
          `;
        }).join("") || "<p class=\"muted\">No players listed</p>"}</div>
      </article>
    `).join("")
    : "<p class=\"muted\">No team metadata was found in this replay.</p>";
  elements.teamsPanel.hidden = false;
}

function playerColor(index, total) {
  const hue = Math.round((index / Math.max(1, total)) * 300 + 35);
  return `hsl(${hue} 78% 62%)`;
}

function loadMapImage(analysis) {
  const source = analysis.mapPreview?.dataUrl || "";
  if (!source || source === mapImageSource) {
    return;
  }
  mapImageSource = source;
  mapImage = new Image();
  mapImage.onload = () => drawHeatmap(Number(elements.timeSlider.value || 0));
  mapImage.src = source;
}

function syncCanvasResolution(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const targetWidth = Math.max(1, Math.round(rect.width * ratio));
  const targetHeight = Math.max(1, Math.round(rect.height * ratio));
  canvasCssWidth = rect.width || canvas.width;
  canvasCssHeight = rect.height || canvas.height;
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { width: canvasCssWidth, height: canvasCssHeight };
}

function drawHeatmap(playheadSecond = 0) {
  const canvas = elements.heatmapCanvas;
  const context = canvas.getContext("2d");
  const analysis = currentAnalysis;
  if (!analysis) {
    return;
  }

  const { width, height } = syncCanvasResolution(canvas, context);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#05090d";
  context.fillRect(0, 0, width, height);

  const timeline = analysis.heatmap.timeline || [];
  const players = analysis.apm || [];
  const pointsByPlayer = analysis.heatmap.points || {};
  const plotX = 8;
  const plotY = 8;
  const plotW = width - 16;
  const plotH = height - 34;

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
  const currentBucket = timeline.find((bucket) => playheadSecond >= bucket.start && playheadSecond <= bucket.end)
    || timeline[Math.min(timeline.length - 1, Math.max(0, Math.floor(playheadSecond / Math.max(1, analysis.heatmap.bucketSeconds || 1))))] 
    || { start: 0, end: 0 };
  const mapSize = analysis.mapPreview?.size;
  const mapBounds = mapSize
    ? { minX: 0, maxX: mapSize.x, minZ: 0, maxZ: mapSize.z }
    : bounds;
  const canUseMapBounds = Number.isFinite(mapBounds.minX) && mapBounds.maxX > mapBounds.minX && mapBounds.maxZ > mapBounds.minZ;

  if (hasMapPoints || mapImage) {
    if (mapImage) {
      context.drawImage(mapImage, plotX, plotY, plotW, plotH);
      context.fillStyle = "rgba(5, 9, 13, 0.05)";
      context.fillRect(plotX, plotY, plotW, plotH);
    } else {
      context.fillStyle = "rgba(255,255,255,0.035)";
      context.fillRect(plotX, plotY, plotW, plotH);
    }
    players.forEach((player, playerIndex) => {
      const color = playerColor(playerIndex, players.length);
      const points = pointsByPlayer[player.name] || [];
      for (const point of points) {
        const age = playheadSecond - point.second;
        if (point.second > playheadSecond || age > Math.max(18, analysis.heatmap.bucketSeconds * 3)) {
          continue;
        }
        if (!canUseMapBounds) {
          continue;
        }
        const x = plotX + ((point.x - mapBounds.minX) / (mapBounds.maxX - mapBounds.minX)) * plotW;
        const y = plotY + ((point.z - mapBounds.minZ) / (mapBounds.maxZ - mapBounds.minZ)) * plotH;
        const alpha = Math.max(0.12, 1 - age / Math.max(14, analysis.heatmap.bucketSeconds * 2.4));
        context.globalAlpha = alpha;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, 2.5 + alpha * 4.5, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(255,255,255,0.62)";
        context.lineWidth = 1;
        context.stroke();
      }
      context.globalAlpha = 1;
      context.fillStyle = color;
      context.font = "13px Segoe UI";
      context.fillRect(plotX + 10, plotY + 10 + playerIndex * 20, 10, 10);
      context.fillStyle = "#edf6fb";
      context.fillText(player.name, plotX + 28, plotY + 20 + playerIndex * 20);
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

  context.fillStyle = "#9dafbf";
  context.font = "13px Segoe UI";
  context.fillText(`${formatTime(playheadSecond)} / ${currentAnalysis?.replay?.durationLabel || "0:00"}`, plotX, height - 20);
}

function renderHeatmap(analysis) {
  loadMapImage(analysis);
  const timeline = analysis.heatmap.timeline || [];
  const duration = Math.max(1, analysis.replay.durationSeconds || timeline[timeline.length - 1]?.end || 1);
  elements.timeSlider.max = String(Math.round(duration));
  elements.timeSlider.value = "0";
  playbackSecond = 0;
  elements.timeLabel.textContent = `0:00 / ${analysis.replay.durationLabel || formatTime(duration)}`;
  const mapNote = analysis.mapPreview?.error ? ` Map preview unavailable: ${analysis.mapPreview.error}` : "";
  elements.heatmapNote.textContent = `${analysis.heatmap.note || ""}${mapNote}`;
  elements.heatmapPanel.hidden = false;
  drawHeatmap(0);
}

function renderParserStatus(analysis) {
  const parser = analysis.parser || {};
  const status = parser.available ? "Active" : "Unavailable";
  const quality = parser.quality || "unknown";
  const commandCounts = parser.commandCounts
    ? Object.entries(parser.commandCounts).map(([name, count]) => `${name}: ${count}`).join(", ")
    : "";
  elements.parserStatus.innerHTML = `
    <strong>Parser ${escapeHtml(status)} (${escapeHtml(quality)})</strong>
    <div>${escapeHtml(parser.note || parser.error || "No parser detail returned.")}</div>
    ${parser.error ? `<div><strong>Error:</strong> ${escapeHtml(parser.error)}</div>` : ""}
    ${commandCounts ? `<div><strong>Commands:</strong> ${escapeHtml(commandCounts)}</div>` : ""}
  `;
  elements.parserStatus.className = `panel parser-status ${parser.available ? "good" : "bad"}`;
  elements.parserStatus.hidden = false;
}

function renderAnalysis(analysis) {
  currentAnalysis = analysis;
  renderParserStatus(analysis);
  renderSummary(analysis);
  renderTeams(analysis);
  renderHeatmap(analysis);
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
  const duration = Math.max(1, currentAnalysis?.replay?.durationSeconds || 1);
  playbackSecond = Math.max(0, Math.min(Number(index || 0), duration));
  elements.timeSlider.value = String(Math.round(playbackSecond));
  elements.timeLabel.textContent = `${formatTime(playbackSecond)} / ${currentAnalysis?.replay?.durationLabel || formatTime(duration)}`;
  drawHeatmap(playbackSecond);
}

function stopPlayback() {
  if (playAnimation) {
    window.cancelAnimationFrame(playAnimation);
    playAnimation = null;
  }
  lastFrameTime = 0;
  elements.playButton.textContent = "Play";
}

function playbackStep(timestamp) {
  if (!currentAnalysis) {
    stopPlayback();
    return;
  }
  if (!lastFrameTime) {
    lastFrameTime = timestamp;
  }
  const elapsed = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;
  const speed = Number(elements.speedSelect.value || 2);
  const duration = Math.max(1, currentAnalysis.replay.durationSeconds || 1);
  setFrame(playbackSecond + elapsed * speed);
  if (playbackSecond >= duration) {
    stopPlayback();
    return;
  }
  playAnimation = window.requestAnimationFrame(playbackStep);
}

function togglePlayback() {
  if (playAnimation) {
    stopPlayback();
    return;
  }
  elements.playButton.textContent = "Pause";
  lastFrameTime = 0;
  playAnimation = window.requestAnimationFrame(playbackStep);
}

elements.loadReplayButton.addEventListener("click", loadFromInput);
elements.replayInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadFromInput();
  }
});
elements.replayFileInput.addEventListener("change", () => loadFromFile(elements.replayFileInput.files?.[0]));
elements.timeSlider.addEventListener("input", () => {
  setFrame(elements.timeSlider.value);
});
elements.playButton.addEventListener("click", togglePlayback);
window.addEventListener("resize", () => {
  if (currentAnalysis) {
    drawHeatmap(playbackSecond);
  }
});
