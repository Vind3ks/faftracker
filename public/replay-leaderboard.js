(() => {
  const mapInput = document.getElementById("lbMap");
  const eventInput = document.getElementById("lbEvent");
  const tierInput = document.getElementById("lbTier");
  const searchButton = document.getElementById("lbSearchButton");
  const mapList = document.getElementById("lbMapList");
  const messageEl = document.getElementById("lbMessage");
  const resultsEl = document.getElementById("lbResults");

  if (!mapInput || !searchButton || !resultsEl) {
    return;
  }

  const FACTION_COLORS = { UEF: "#4ea1ff", Aeon: "#6be36b", Cybran: "#ff5a5a", Seraphim: "#f2c14e", Nomad: "#d98c4a" };

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

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function factionDot(faction) {
    const color = FACTION_COLORS[faction] || "var(--muted)";
    return `<span class="faction-dot" style="background:${color}" title="${escapeHtml(faction || "")}"></span>`;
  }

  async function loadMaps() {
    try {
      const response = await fetch("/api/replay-leaderboard");
      if (!response.ok) return;
      const payload = await response.json();
      const maps = payload.maps || [];
      mapList.innerHTML = maps
        .map((m) => `<option value="${escapeHtml(m.displayName)}">${escapeHtml(m.displayName)} &middot; ${m.eventCount} events / ${m.replayCount} replays</option>`)
        .join("");
      if (!maps.length) {
        setMessage("No replays indexed yet. Load a replay above to start filling the leaderboard.", "muted");
      }
    } catch (error) {
      /* non-fatal */
    }
  }

  function rankMarkup(entry, position) {
    const replayUrl = `https://replay.faforever.com/${entry.replayId}`;
    return `
      <div class="lb-rank">
        <span class="lb-pos">#${position}</span>
        <span class="lb-player">${factionDot(entry.faction)} <button type="button" class="replay-player-link" data-player="${escapeHtml(entry.player)}">${escapeHtml(entry.player)}</button></span>
        <span class="lb-time">${formatClock(entry.seconds)}${entry.estimated ? " ~" : ""}</span>
        <span class="lb-faction">${escapeHtml(entry.faction || "")}</span>
        <span class="lb-replay"><button type="button" class="replay-open-link" data-replay="${entry.replayId}" title="Open in replay viewer">#${entry.replayId}</button> <a href="${replayUrl}" target="_blank" rel="noopener noreferrer" title="Download replay">&#8599;</a></span>
      </div>`;
  }

  function eventMarkup(group) {
    const ranks = group.entries.map((e, i) => rankMarkup(e, i + 1)).join("");
    const iconUrl = `/api/unit-icon/${encodeURIComponent(group.eventId.replace(/^tech_/, ""))}`;
    return `
      <article class="lb-event">
        <div class="lb-event-head">
          <img src="${iconUrl}" alt="" onerror="this.style.display='none'" />
          <strong>${escapeHtml(group.unitLabel || group.label)}</strong>
          <span class="muted">&middot; ${escapeHtml(group.map)} &middot; ${escapeHtml(group.label)}</span>
        </div>
        ${ranks}
      </article>`;
  }

  async function search() {
    const map = mapInput.value.trim();
    const event = eventInput.value.trim();
    const tier = tierInput.value;
    if (!map && !event) {
      setMessage("Enter a map or a unit/event to search.", "bad");
      return;
    }

    setMessage("Searching the leaderboard...", "muted");
    resultsEl.innerHTML = "";
    const params = new URLSearchParams();
    if (map) params.set("map", map);
    if (event) params.set("event", event);
    if (tier) params.set("tier", tier);

    try {
      const response = await fetch(`/api/replay-leaderboard?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Leaderboard query failed.", "bad");
        return;
      }
      const results = payload.results || [];
      if (!results.length) {
        setMessage("No indexed timings match. Load some replays on this map first.", "muted");
        return;
      }
      setMessage(`${results.length} event${results.length === 1 ? "" : "s"} found.`, "good");
      resultsEl.innerHTML = results.slice(0, 40).map(eventMarkup).join("");
    } catch (error) {
      setMessage(`Leaderboard query failed: ${error.message}`, "bad");
    }
  }

  searchButton.addEventListener("click", search);
  [mapInput, eventInput].forEach((el) =>
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search();
      }
    })
  );

  resultsEl.addEventListener("click", (event) => {
    const replayBtn = event.target.closest(".replay-open-link");
    if (replayBtn) {
      const replayInput = document.getElementById("replayInput");
      const replayLoad = document.getElementById("replayLoadButton");
      if (replayInput && replayLoad) {
        replayInput.value = replayBtn.dataset.replay;
        replayLoad.click();
        replayInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    const playerBtn = event.target.closest(".replay-player-link");
    if (playerBtn) {
      const playerInput = document.getElementById("playerInput");
      const playerLoad = document.getElementById("loadButton");
      if (playerInput && playerLoad) {
        playerInput.value = playerBtn.dataset.player;
        playerLoad.click();
        playerInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  });

  loadMaps();
})();
