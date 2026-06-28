(() => {
  const input = document.getElementById("replayInput");
  const loadButton = document.getElementById("replayLoadButton");
  const messageEl = document.getElementById("replayMessage");
  const resultEl = document.getElementById("replayResult");

  if (!input || !loadButton || !messageEl || !resultEl) {
    return;
  }

  const FACTION_NAMES = { 1: "UEF", 2: "Aeon", 3: "Cybran", 4: "Seraphim", 5: "Nomad" };
  const FACTION_KEYS = {
    uef: "UEF",
    aeon: "Aeon",
    cybran: "Cybran",
    seraphim: "Seraphim",
    nomad: "Nomad",
    random: "Random"
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setMessage(text, tone = "muted") {
    messageEl.textContent = text;
    messageEl.className = `replay-message ${tone}`;
    messageEl.hidden = !text;
  }

  function setLoading(isLoading) {
    loadButton.disabled = isLoading;
    input.disabled = isLoading;
    loadButton.textContent = isLoading ? "Loading..." : "Load replay";
  }

  function factionLabel(faction) {
    if (faction === null || faction === undefined || faction === "") {
      return "&mdash;";
    }
    if (typeof faction === "number" || /^\d+$/.test(String(faction))) {
      return FACTION_NAMES[Number(faction)] || `Faction ${escapeHtml(faction)}`;
    }
    const key = String(faction).toLowerCase();
    return FACTION_KEYS[key] || escapeHtml(faction);
  }

  function outcomeInfo(outcome) {
    const value = String(outcome || "UNKNOWN").toUpperCase();
    if (["VICTORY", "WIN"].includes(value)) {
      return { label: "Victory", tone: "win" };
    }
    if (["DEFEAT", "LOSS", "LOSE"].includes(value)) {
      return { label: "Defeat", tone: "loss" };
    }
    if (value === "DRAW") {
      return { label: "Draw", tone: "draw" };
    }
    return { label: value.charAt(0) + value.slice(1).toLowerCase(), tone: "unknown" };
  }

  function formatDateTime(iso) {
    if (!iso) {
      return "&mdash;";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "&mdash;";
    }
    return escapeHtml(date.toLocaleString());
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) {
      return "&mdash;";
    }
    const total = Number(seconds);
    if (!Number.isFinite(total)) {
      return "&mdash;";
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }

  function ratingCell(player) {
    const before = player.ratingBefore;
    const after = player.ratingAfter;
    if (before !== null && before !== undefined && after !== null && after !== undefined) {
      const delta = Math.round(Number(player.ratingDelta ?? after - before));
      const tone = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      const sign = delta > 0 ? "+" : "";
      return `${before} &rarr; ${after} <span class="replay-delta ${tone}">(${sign}${delta})</span>`;
    }
    if (player.rating !== null && player.rating !== undefined) {
      return String(player.rating);
    }
    return "&mdash;";
  }

  function mapPreviewMarkup(summary) {
    if (!summary.mapFolderName) {
      return "";
    }
    const src = `/api/map-preview?folder=${encodeURIComponent(summary.mapFolderName)}&size=large`;
    return `
      <figure class="replay-map">
        <img src="${src}" alt="Map preview for ${escapeHtml(summary.map)}" loading="lazy" onerror="this.closest('.replay-map').remove()" />
        <figcaption>${escapeHtml(summary.map)}</figcaption>
      </figure>`;
  }

  function teamMarkup(team, winnerLabel) {
    const isWinner = winnerLabel && team.label === winnerLabel;
    const rows = team.players.map((player) => {
      const outcome = outcomeInfo(player.outcome);
      return `
        <tr>
          <td><button type="button" class="replay-player-link" data-player="${escapeHtml(player.login)}" title="Load report for ${escapeHtml(player.login)}">${escapeHtml(player.login)}</button></td>
          <td>${factionLabel(player.faction)}</td>
          <td><span class="replay-outcome ${outcome.tone}">${outcome.label}</span></td>
          <td>${ratingCell(player)}</td>
          <td>${player.score === null || player.score === undefined ? "&mdash;" : escapeHtml(player.score)}</td>
        </tr>`;
    }).join("");

    return `
      <article class="replay-team${isWinner ? " is-winner" : ""}">
        <div class="replay-team-head">
          <h4>${escapeHtml(team.label)}${isWinner ? ' <span class="replay-winner-tag">Winner</span>' : ""}</h4>
          <span class="replay-team-rating">Avg ${team.averageRating === null || team.averageRating === undefined ? "&mdash;" : escapeHtml(team.averageRating)}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Faction</th>
                <th>Result</th>
                <th>Rating</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </article>`;
  }

  const FACTION_COLORS = {
    UEF: "#4ea1ff",
    Aeon: "#6be36b",
    Cybran: "#ff5a5a",
    Seraphim: "#f2c14e",
    Nomad: "#d98c4a"
  };

  // Timeline state lives at module scope so the filter controls can re-render
  // only the timeline body.
  let currentAnalysis = null;
  const timelineFilter = { type: "all", tier: "all", layout: "combined", players: new Set() };

  const EVENT_TYPE_LABELS = {
    tech_upgrade: "Tech upgrade",
    first_unit: "First of tier",
    experimental: "T4 / Experimental",
    notable: "Notable"
  };

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function factionDot(faction) {
    const color = FACTION_COLORS[faction] || "var(--muted)";
    return `<span class="faction-dot" style="background:${color}" title="${escapeHtml(faction || "")}"></span>`;
  }

  function playerLink(name) {
    const safe = escapeHtml(name || "");
    return `<button type="button" class="replay-player-link" data-player="${safe}" title="Load report for ${safe}">${safe}</button>`;
  }

  function apmMarkup(analysis) {
    const players = (analysis.players || []).slice().sort((a, b) => b.effectiveApm - a.effectiveApm);
    if (!players.length) return "";
    const maxApm = Math.max(1, ...players.map((p) => p.rawApm));
    const rows = players.map((p) => {
      const effPct = Math.round((p.effectiveApm / maxApm) * 100);
      const rawPct = Math.round((p.rawApm / maxApm) * 100);
      return `
        <div class="apm-row">
          <div class="apm-name">${factionDot(p.faction)} ${playerLink(p.name)}</div>
          <div class="apm-bar" title="Raw ${p.rawApm} APM · Effective ${p.effectiveApm} APM">
            <div class="apm-bar-raw" style="width:${rawPct}%"></div>
            <div class="apm-bar-eff" style="width:${effPct}%"></div>
          </div>
          <div class="apm-figs"><strong>${p.effectiveApm}</strong><span>eff</span> <em>${p.rawApm} raw</em></div>
        </div>`;
    }).join("");

    return `
      <section class="replay-section">
        <div class="replay-section-head">
          <h4>Effective APM</h4>
          <p class="hint">Effective excludes factory build-queue spam and collapses Shift move/patrol chains, so it reflects meaningful actions rather than raw click count.</p>
        </div>
        <div class="apm-list">${rows}</div>
      </section>`;
  }

  function timelineControlsMarkup(analysis) {
    const typeOptions = ["all", "tech_upgrade", "first_unit", "experimental", "notable"]
      .map((t) => `<option value="${t}">${t === "all" ? "All events" : EVENT_TYPE_LABELS[t]}</option>`)
      .join("");
    const tierOptions = ["all", "1", "2", "3", "4"]
      .map((t) => `<option value="${t}">${t === "all" ? "All tiers" : "T" + t}</option>`)
      .join("");
    const playerChips = (analysis.players || []).map((p) => `
      <label class="tl-chip">
        <input type="checkbox" class="tl-player" value="${escapeHtml(p.name)}" checked />
        ${factionDot(p.faction)} ${escapeHtml(p.name)}
      </label>`).join("");

    return `
      <div class="timeline-controls">
        <label class="field compact"><span>Event</span><select id="tlType">${typeOptions}</select></label>
        <label class="field compact"><span>Tier</span><select id="tlTier">${tierOptions}</select></label>
        <label class="field compact"><span>Layout</span>
          <select id="tlLayout"><option value="combined">Combined</option><option value="columns">Side&#8209;by&#8209;side</option></select>
        </label>
        <div class="tl-players">${playerChips}</div>
      </div>`;
  }

  function eventBadge(type) {
    return `<span class="tl-badge tl-${type}">${escapeHtml(EVENT_TYPE_LABELS[type] || type)}</span>`;
  }

  function eventCardMarkup(e, opts = {}) {
    const eco = e.eco || {};
    const ecoBits = `<span class="tl-eco" title="Estimated income at this point (live economy isn't stored in replays)">M&#8776;${Math.round(eco.mass || 0)} &middot; E&#8776;${Math.round(eco.energy || 0)}</span>`;
    const timeNote = e.etaSeconds != null && e.startedSeconds != null && e.etaSeconds !== e.startedSeconds
      ? `<span class="tl-sub">est. done &middot; started ${formatClock(e.startedSeconds)}</span>`
      : (e.estimated ? `<span class="tl-sub">est. completion</span>` : `<span class="tl-sub">started</span>`);
    const who = opts.hidePlayer ? "" : `<span class="tl-who">${factionDot(e.faction)} ${playerLink(e.player)}</span>`;
    return `
      <article class="tl-card tl-tier-${e.tier || 0}">
        <div class="tl-time">${formatClock(e.seconds)}</div>
        <img class="tl-icon" src="${e.icon ? escapeHtml(e.icon.iconUrl) : ""}" alt="" loading="lazy" onerror="this.classList.add('is-missing')" />
        <div class="tl-body">
          <div class="tl-line1">${eventBadge(e.type)} <strong>${escapeHtml(e.label)}</strong></div>
          <div class="tl-line2">${who} ${ecoBits} ${timeNote}</div>
        </div>
      </article>`;
  }

  function filteredEvents() {
    const events = (currentAnalysis && currentAnalysis.timeline) || [];
    return events.filter((e) => {
      if (timelineFilter.type !== "all" && e.type !== timelineFilter.type) return false;
      if (timelineFilter.tier !== "all" && String(e.tier) !== timelineFilter.tier) return false;
      if (timelineFilter.players.size && !timelineFilter.players.has(e.player)) return false;
      return true;
    });
  }

  function renderTimelineBody() {
    const body = document.getElementById("replayTimelineBody");
    if (!body) return;
    const events = filteredEvents();
    if (!events.length) {
      body.innerHTML = '<p class="empty">No events match these filters.</p>';
      return;
    }

    if (timelineFilter.layout === "columns") {
      const names = (currentAnalysis.players || [])
        .map((p) => p.name)
        .filter((n) => !timelineFilter.players.size || timelineFilter.players.has(n));
      const columns = names.map((name) => {
        const cards = events.filter((e) => e.player === name).map((e) => eventCardMarkup(e, { hidePlayer: true })).join("");
        return `
          <div class="tl-column">
            <div class="tl-column-head">${playerLink(name)}</div>
            ${cards || '<p class="empty">No events.</p>'}
          </div>`;
      }).join("");
      body.innerHTML = `<div class="tl-columns" style="grid-template-columns:repeat(${Math.max(names.length, 1)}, minmax(220px, 1fr))">${columns}</div>`;
      return;
    }

    body.innerHTML = `<div class="tl-list">${events.map((e) => eventCardMarkup(e)).join("")}</div>`;
  }

  function timelineMarkup(analysis) {
    if (!analysis || !Array.isArray(analysis.timeline) || !analysis.timeline.length) {
      return "";
    }
    return `
      <section class="replay-section">
        <div class="replay-section-head">
          <h4>Tech &amp; event timeline</h4>
          <p class="hint">Built from the replay command stream. Order times are exact; upgrade/first-unit completions are estimated from build times, and income is an estimate (live economy isn't recorded in replays).</p>
        </div>
        ${timelineControlsMarkup(analysis)}
        <div id="replayTimelineBody" class="timeline-body"></div>
      </section>`;
  }

  function wireTimelineControls() {
    const type = document.getElementById("tlType");
    const tier = document.getElementById("tlTier");
    const layout = document.getElementById("tlLayout");
    if (type) type.addEventListener("change", () => { timelineFilter.type = type.value; renderTimelineBody(); });
    if (tier) tier.addEventListener("change", () => { timelineFilter.tier = tier.value; renderTimelineBody(); });
    if (layout) layout.addEventListener("change", () => { timelineFilter.layout = layout.value; renderTimelineBody(); });
    document.querySelectorAll(".tl-player").forEach((cb) => {
      cb.addEventListener("change", () => {
        timelineFilter.players = new Set(
          [...document.querySelectorAll(".tl-player")].filter((x) => x.checked).map((x) => x.value)
        );
        renderTimelineBody();
      });
    });
  }

  // When the FAF API summary is unavailable (e.g. not signed in), build a
  // minimal one from the parsed replay file so the viewer still renders.
  function synthesizeSummary(payload) {
    const analysis = payload.analysis;
    if (!analysis) return {};
    const mapSegments = String(analysis.map || "").split("/").filter(Boolean);
    const mapName = mapSegments.length >= 2 ? mapSegments[mapSegments.length - 2] : analysis.map || "Unknown map";
    const teamsMap = new Map();
    for (const p of analysis.players || []) {
      const key = p.team == null ? 0 : p.team;
      if (!teamsMap.has(key)) teamsMap.set(key, []);
      teamsMap.get(key).push({ id: null, login: p.name, faction: p.faction, outcome: "UNKNOWN", score: null, rating: null });
    }
    const teams = [...teamsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, players], i) => ({
      label: `Team ${i + 1}`,
      averageRating: null,
      players
    }));
    return {
      id: payload.replay?.id,
      title: payload.replay?.title || `Replay #${payload.replay?.id ?? ""}`,
      map: mapName,
      mapFolderName: mapName,
      queueLabel: "FAF",
      durationSeconds: analysis.durationSeconds,
      winner: "Unknown",
      averageRating: null,
      replayUrl: payload.replay?.replayUrl,
      teams
    };
  }

  function renderReplay(payload) {
    const summary = payload.summary || synthesizeSummary(payload);
    const teams = Array.isArray(summary.teams) ? summary.teams : [];
    const validity = summary.validity || payload.replay?.validity || payload.raw?.validity || null;
    const playerCount = payload.raw?.playerCount ?? teams.reduce((total, team) => total + team.players.length, 0);
    const replayUrl = summary.replayUrl || payload.replay?.replayUrl || `https://replay.faforever.com/${summary.id}`;

    const stats = [
      ["Map", escapeHtml(summary.map || "Unknown map")],
      ["Queue", escapeHtml(summary.queueLabel || summary.queueCategory || "FAF")],
      ["Played", formatDateTime(summary.startedAt)],
      ["Duration", formatDuration(summary.durationSeconds)],
      ["Winner", escapeHtml(summary.winner || "Unknown")],
      ["Avg rating", summary.averageRating === null || summary.averageRating === undefined ? "&mdash;" : escapeHtml(summary.averageRating)],
      ["Players", escapeHtml(playerCount)],
      ["Validity", validity ? escapeHtml(validity) : "&mdash;"]
    ];

    const statsMarkup = stats
      .map(([label, value]) => `<div class="replay-stat"><span>${label}</span><strong>${value}</strong></div>`)
      .join("");

    resultEl.innerHTML = `
      <div class="replay-head">
        <div>
          <p class="panel-label">Replay #${escapeHtml(summary.id)}</p>
          <h3>${escapeHtml(summary.title || `Replay #${summary.id}`)}</h3>
        </div>
        <a class="button-link replay-open" href="${escapeHtml(replayUrl)}" target="_blank" rel="noopener noreferrer">Open replay &#8599;</a>
      </div>
      <div class="replay-overview">
        ${mapPreviewMarkup(summary)}
        <div class="replay-stats">${statsMarkup}</div>
      </div>
      <div class="replay-teams">
        ${teams.length ? teams.map((team) => teamMarkup(team, summary.winner)).join("") : '<p class="empty">No player data is available for this replay.</p>'}
      </div>
      ${analysisMarkup(payload)}`;

    currentAnalysis = payload.analysis || null;
    timelineFilter.type = "all";
    timelineFilter.tier = "all";
    timelineFilter.layout = "combined";
    timelineFilter.players = new Set();
    if (currentAnalysis) {
      wireTimelineControls();
      renderTimelineBody();
    }
    resultEl.hidden = false;
  }

  function analysisMarkup(payload) {
    const analysis = payload.analysis;
    if (!analysis) {
      const reason = payload.analysisError
        ? `Replay file analysis is unavailable: ${escapeHtml(payload.analysisError)}`
        : "Replay file analysis is unavailable for this game.";
      return `<p class="replay-analysis-note muted">${reason}</p>`;
    }
    return `<div class="replay-analysis">${apmMarkup(analysis)}${timelineMarkup(analysis)}</div>`;
  }

  async function loadReplay(rawValue) {
    const raw = (rawValue ?? input.value).trim();
    if (!raw) {
      setMessage("Enter a replay id or link first.", "bad");
      return;
    }

    input.value = raw;
    setLoading(true);
    setMessage(`Loading replay ${raw}...`, "muted");
    resultEl.hidden = true;

    try {
      const response = await fetch(`/api/replay/${encodeURIComponent(raw)}`);
      const payload = await response.json();
      if (!response.ok) {
        const parts = [payload.error || "Unable to load the replay."];
        if (payload.detail) {
          parts.push(payload.detail);
        }
        if (payload.hint) {
          parts.push(payload.hint);
        }
        setMessage(parts.join(" "), "bad");
        resultEl.hidden = true;
        return;
      }
      renderReplay(payload);
      setMessage(`Loaded replay #${payload.summary?.id ?? raw}.`, "good");
    } catch (error) {
      setMessage(`Unable to load the replay: ${error.message}`, "bad");
    } finally {
      setLoading(false);
    }
  }

  loadButton.addEventListener("click", () => loadReplay());

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadReplay();
    }
  });

  resultEl.addEventListener("click", (event) => {
    const link = event.target.closest(".replay-player-link");
    if (!link) {
      return;
    }
    const login = link.dataset.player;
    const playerInput = document.getElementById("playerInput");
    const playerLoadButton = document.getElementById("loadButton");
    if (login && playerInput && playerLoadButton) {
      playerInput.value = login;
      playerLoadButton.click();
      playerInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  function bootFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = (params.get("replay") || params.get("replayId") || "").trim();
    if (fromUrl) {
      loadReplay(fromUrl);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootFromUrl, { once: true });
  } else {
    bootFromUrl();
  }

  // Let other panels (e.g. Old Replays) render an already-fetched payload into
  // the shared replay-result area instead of duplicating the renderer.
  window.fafReplayViewer = {
    render(payload) {
      renderReplay(payload);
      setMessage(`Loaded ${payload.replay?.title || "replay"} from the archive.`, "good");
      resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    setMessage,
    setLoading
  };
})();
