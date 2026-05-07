const elements = {
  authSummary: document.getElementById("authSummary"),
  loginButton: document.getElementById("loginButton"),
  refreshButton: document.getElementById("refreshButton"),
  autoRefreshInput: document.getElementById("autoRefreshInput"),
  lastUpdated: document.getElementById("lastUpdated"),
  queueMessage: document.getElementById("queueMessage"),
  queueGrid: document.getElementById("queueGrid")
};

let refreshTimer = null;
let loading = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatRange(range) {
  if (!Array.isArray(range) || range.length < 2) {
    return "Unknown";
  }
  return `${Math.round(Number(range[0]))} – ${Math.round(Number(range[1]))}`;
}

function formatPopTime(queue) {
  if (Number.isFinite(Number(queue.secondsUntilPop))) {
    const seconds = Math.max(0, Number(queue.secondsUntilPop));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  if (queue.popTime) {
    const date = new Date(queue.popTime);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
  }
  return "Unknown";
}

function setMessage(text, tone = "muted") {
  elements.queueMessage.className = `panel ${tone}`;
  elements.queueMessage.textContent = text;
}

function setLoading(isLoading) {
  loading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.textContent = isLoading ? "Refreshing..." : "Refresh queues";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function syncAuthStatus() {
  try {
    const status = await fetchJson("/api/auth/status");
    if (status.loggedIn) {
      const login = status.userProfile?.login || status.userProfile?.username || "FAF";
      elements.authSummary.className = "status-pill good";
      elements.authSummary.textContent = `Logged in as ${login}`;
      elements.loginButton.hidden = true;
    } else {
      elements.authSummary.className = "status-pill bad";
      elements.authSummary.textContent = "Login required for live queue data";
      elements.loginButton.hidden = false;
    }
  } catch (error) {
    elements.authSummary.className = "status-pill bad";
    elements.authSummary.textContent = "Could not check FAF session";
  }
}

function renderCandidateList(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return "<span class=\"muted-cell\">No visible band overlap</span>";
  }

  return candidates
    .map((candidate) => `<span class="match-chip ${candidate.confidence === "tight" ? "tight" : "wide"}" title="${escapeHtml(candidate.reason)}">${escapeHtml(candidate.label)}</span>`)
    .join(" ");
}

function renderSearchRows(queue) {
  if (!queue.searches.length) {
    return `<p class="empty">No public searches in ${escapeHtml(queue.shortLabel)} right now.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Search</th>
            <th>Approx. mean</th>
            <th>75% band</th>
            <th>80% band</th>
            <th>Can match</th>
          </tr>
        </thead>
        <tbody>
          ${queue.searches.map((search) => `
            <tr>
              <td><strong>${escapeHtml(search.label)}</strong></td>
              <td>${search.approximateMean == null ? "Unknown" : escapeHtml(search.approximateMean)}</td>
              <td>${escapeHtml(formatRange(search.tightBand))}</td>
              <td>${escapeHtml(formatRange(search.wideBand))}</td>
              <td>${renderCandidateList(search.canMatch)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderQueues(payload) {
  const queues = payload.queues || [];
  elements.queueGrid.innerHTML = queues.map((queue) => `
    <article class="panel queue-card">
      <div class="queue-card-header">
        <div>
          <p class="panel-label">${escapeHtml(queue.rawName)}</p>
          <h2>${escapeHtml(queue.label)}</h2>
        </div>
        <div class="queue-count">
          <strong>${escapeHtml(queue.numberOfPlayers)}</strong>
          <span>players</span>
        </div>
      </div>

      <div class="queue-meta-row">
        <span>Team size: <strong>${escapeHtml(queue.teamSize)}v${escapeHtml(queue.teamSize)}</strong></span>
        <span>Next pop: <strong>${escapeHtml(formatPopTime(queue))}</strong></span>
        <span>Searches: <strong>${escapeHtml(queue.searches.length)}</strong></span>
      </div>

      ${renderSearchRows(queue)}
    </article>
  `).join("");

  elements.lastUpdated.textContent = `Updated ${new Date(payload.fetchedAt || Date.now()).toLocaleTimeString()}`;
  setMessage(payload.privacyNote || "Live queue snapshot loaded.", "muted");
}

async function refreshQueues() {
  if (loading) {
    return;
  }
  setLoading(true);
  try {
    await syncAuthStatus();
    const payload = await fetchJson("/api/queues/live");
    renderQueues(payload);
  } catch (error) {
    const detail = error.payload?.detail ? ` ${error.payload.detail}` : "";
    const hint = error.payload?.hint ? ` ${error.payload.hint}` : "";
    setMessage(`${error.message}.${detail}${hint}`.trim(), "bad");
  } finally {
    setLoading(false);
  }
}

function syncAutoRefresh() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (elements.autoRefreshInput.checked) {
    refreshTimer = window.setInterval(refreshQueues, 15000);
  }
}

elements.refreshButton.addEventListener("click", refreshQueues);
elements.autoRefreshInput.addEventListener("change", syncAutoRefresh);

syncAuthStatus();
refreshQueues();
