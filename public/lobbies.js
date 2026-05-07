const elements = {
  authSummary: document.getElementById("authSummary"),
  loginButton: document.getElementById("loginButton"),
  refreshButton: document.getElementById("refreshButton"),
  lobbyMessage: document.getElementById("lobbyMessage"),
  lobbyCount: document.getElementById("lobbyCount"),
  playerCount: document.getElementById("playerCount"),
  lastUpdated: document.getElementById("lastUpdated"),
  lobbiesGrid: document.getElementById("lobbiesGrid")
};

let loading = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setMessage(text, tone = "muted") {
  elements.lobbyMessage.className = `panel ${tone}`;
  elements.lobbyMessage.textContent = text;
}

function setLoading(value) {
  loading = value;
  elements.refreshButton.disabled = value;
  elements.refreshButton.textContent = value ? "Refreshing..." : "Refresh lobbies";
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
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
      elements.authSummary.textContent = `Ready as ${login}`;
      elements.loginButton.hidden = true;
    } else {
      elements.authSummary.className = "status-pill bad";
      elements.authSummary.textContent = "Login required";
      elements.loginButton.hidden = false;
    }
  } catch {
    elements.authSummary.className = "status-pill bad";
    elements.authSummary.textContent = "Could not check status";
  }
}

function ratingRange(lobby) {
  if (lobby.ratingMin == null && lobby.ratingMax == null) return "Any rating";
  const min = lobby.ratingMin == null ? "-∞" : Math.round(lobby.ratingMin);
  const max = lobby.ratingMax == null ? "+∞" : Math.round(lobby.ratingMax);
  return `${min} – ${max}`;
}

function renderPlayers(players) {
  if (!players.length) return `<span class="empty tiny">No listed players</span>`;
  return players.map((player) => `
    <a class="player-chip" href="${escapeHtml(player.trackerUrl)}" title="Open ${escapeHtml(player.login)} in tracker">
      <img src="${escapeHtml(player.avatarUrl)}" alt="" loading="lazy">
      <span>${escapeHtml(player.login)}</span>
    </a>
  `).join("");
}

function renderTeams(teams) {
  if (!teams.length) return `<div class="players-row empty">No player data</div>`;
  return teams.map((team) => `
    <div class="team-block">
      <span class="team-label">Team ${escapeHtml(team.teamId)}</span>
      <div class="players-row">${renderPlayers(team.players || [])}</div>
    </div>
  `).join("");
}

function renderLobbies(payload) {
  const lobbies = payload.lobbies || [];
  const totalPlayers = lobbies.reduce((sum, lobby) => sum + Number(lobby.numPlayers || 0), 0);
  elements.lobbyCount.textContent = lobbies.length;
  elements.playerCount.textContent = totalPlayers;
  elements.lastUpdated.textContent = new Date(payload.fetchedAt || Date.now()).toLocaleTimeString();

  if (!lobbies.length) {
    elements.lobbiesGrid.innerHTML = `<section class="panel empty-state">No open lobbies found in this snapshot.</section>`;
  } else {
    elements.lobbiesGrid.innerHTML = lobbies.map((lobby) => `
      <article class="panel lobby-card">
        <div class="lobby-header">
          <div>
            <p class="panel-label">${escapeHtml(lobby.featuredMod)} · ${escapeHtml(lobby.gameType)}</p>
            <h2>${escapeHtml(lobby.title)}</h2>
          </div>
          <div class="lobby-count">
            <strong>${escapeHtml(lobby.numPlayers)}</strong>
            <span>/ ${escapeHtml(lobby.maxPlayers || "?")}</span>
          </div>
        </div>
        <div class="lobby-meta">
          <span>Host: <strong>${escapeHtml(lobby.host)}</strong></span>
          <span>Map: <strong>${escapeHtml(lobby.mapName)}</strong></span>
          <span>Rating: <strong>${escapeHtml(ratingRange(lobby))}</strong></span>
          ${lobby.passwordProtected ? `<span class="locked">Password</span>` : `<span>Open</span>`}
        </div>
        <div class="teams-list">${renderTeams(lobby.teams || [])}</div>
      </article>
    `).join("");
  }
  setMessage(payload.warning || "Live lobbies loaded.", "muted");
}

function renderError(error) {
  const payload = error.payload || {};
  const parts = [error.message];
  if (payload.phase) parts.push(`Phase: ${payload.phase}`);
  if (payload.detail) parts.push(payload.detail);
  if (payload.hint) parts.push(payload.hint);
  setMessage(parts.join(". "), "bad");
}

async function refreshLobbies() {
  if (loading) return;
  setLoading(true);
  try {
    await syncAuthStatus();
    const payload = await fetchJson("/api/lobbies/live");
    renderLobbies(payload);
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false);
  }
}

elements.refreshButton.addEventListener("click", refreshLobbies);
syncAuthStatus();
