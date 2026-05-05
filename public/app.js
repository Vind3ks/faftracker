const elements = {
  playerInput: document.getElementById("playerInput"),
  queueFilterSelect: document.getElementById("queueFilterSelect"),
  gameLimitSelect: document.getElementById("gameLimitSelect"),
  customGameLimitField: document.getElementById("customGameLimitField"),
  customGameLimitInput: document.getElementById("customGameLimitInput"),
  loadButton: document.getElementById("loadButton"),
  loginButton: document.getElementById("loginButton"),
  logoutButton: document.getElementById("logoutButton"),
  authSummary: document.getElementById("authSummary"),
  saveAuthConfigButton: document.getElementById("saveAuthConfigButton"),
  authModeInput: document.getElementById("authModeInput"),
  clientIdInput: document.getElementById("clientIdInput"),
  scopesInput: document.getElementById("scopesInput"),
  oauthBaseUrlInput: document.getElementById("oauthBaseUrlInput"),
  oidcDiscoveryUrlInput: document.getElementById("oidcDiscoveryUrlInput"),
  apiBaseUrlInput: document.getElementById("apiBaseUrlInput"),
  userBaseUrlInput: document.getElementById("userBaseUrlInput"),
  appBaseUrlInput: document.getElementById("appBaseUrlInput"),
  redirectUriInput: document.getElementById("redirectUriInput"),
  refreshTokenInput: document.getElementById("refreshTokenInput"),
  accessTokenInput: document.getElementById("accessTokenInput"),
  importRefreshTokenButton: document.getElementById("importRefreshTokenButton"),
  importAccessTokenButton: document.getElementById("importAccessTokenButton"),
  message: document.getElementById("message"),
  loadingPanel: document.getElementById("loadingPanel"),
  loadingText: document.getElementById("loadingText"),
  loadingPercent: document.getElementById("loadingPercent"),
  updateToast: document.getElementById("updateToast"),
  updateToastTitle: document.getElementById("updateToastTitle"),
  updateToastText: document.getElementById("updateToastText"),
  updateToastClose: document.getElementById("updateToastClose"),
  oauthDiagnosticsBody: document.getElementById("oauthDiagnosticsBody"),
  overview: document.getElementById("overview"),
  overviewDisclaimer: document.getElementById("overviewDisclaimer"),
  reportFilterPlayer: document.getElementById("reportFilterPlayer"),
  reportFilters: document.getElementById("reportFilters"),
  collapseFiltersButton: document.getElementById("collapseFiltersButton"),
  showFiltersButton: document.getElementById("showFiltersButton"),
  ratingChart: document.getElementById("ratingChart"),
  monthlyChart: document.getElementById("monthlyChart"),
  graphControls: document.getElementById("graphControls"),
  resetGraphFiltersButton: document.getElementById("resetGraphFiltersButton"),
  opponentsTable: document.getElementById("opponentsTable"),
  opponentSearchInput: document.getElementById("opponentSearchInput"),
  hideSmallOpponentsButton: document.getElementById("hideSmallOpponentsButton"),
  hideOpponentsButton: document.getElementById("hideOpponentsButton"),
  showMoreOpponentsButton: document.getElementById("showMoreOpponentsButton"),
  teammatesTable: document.getElementById("teammatesTable"),
  teammateSearchInput: document.getElementById("teammateSearchInput"),
  hideSmallTeammatesButton: document.getElementById("hideSmallTeammatesButton"),
  hideTeammatesButton: document.getElementById("hideTeammatesButton"),
  showMoreTeammatesButton: document.getElementById("showMoreTeammatesButton"),
  mapTendenciesTable: document.getElementById("mapTendenciesTable"),
  mapSearchInput: document.getElementById("mapSearchInput"),
  hideMapsButton: document.getElementById("hideMapsButton"),
  showMoreMapsButton: document.getElementById("showMoreMapsButton"),
  ratingSummaryTable: document.getElementById("ratingSummaryTable"),
  improvementInsights: document.getElementById("improvementInsights"),
  playerMeta: document.getElementById("playerMeta"),
  gamesTable: document.getElementById("gamesTable"),
  showMoreGamesButton: document.getElementById("showMoreGamesButton"),
  clearHistoryFilterButton: document.getElementById("clearHistoryFilterButton"),
  historyFilterLabel: document.getElementById("historyFilterLabel"),
  officialStatus: document.getElementById("officialStatus"),
  sampleStatus: document.getElementById("sampleStatus"),
  sessionStatus: document.getElementById("sessionStatus"),
  scrollTopButton: document.getElementById("scrollTopButton")
};

const reportSections = [...document.querySelectorAll(".report-section")];
const gameHistoryState = { allGames: [], filteredGames: [], visibleCount: 10, step: 25, filterLabel: "" };
const relationshipState = {
  opponents: { visibleCount: 8, step: 20, query: "", minGames: 0 },
  teammates: { visibleCount: 8, step: 20, query: "", minGames: 0 }
};
const mapTendencyState = { visibleCount: 8, step: 12, query: "" };
const chartVisibilityState = {
  shared: new Set()
};
const chartKnownSeriesState = {
  shared: new Set()
};
const chartPeriodState = {
  shared: { preset: "all", from: "", to: "" }
};
const insightExpandedState = {
  bestMonths: false,
  worstMonths: false,
  bestDays: false,
  worstDays: false
};
const tableSortState = {
  opponents: { key: "games", direction: "desc" },
  teammates: { key: "games", direction: "desc" },
  maps: { key: "games", direction: "desc" }
};

let currentReport = null;
let currentPayload = null;
let loadingPoll = null;
let lastRequest = null;
let updateToastTimeout = null;
let filtersCollapsed = false;
let filtersStuck = false;

function setLoadingState(isLoading, text = "Fetching FAF history...", percent = 0) {
  elements.loadingPanel.hidden = !isLoading;
  elements.loadingText.textContent = text;
  elements.loadingPercent.textContent = `${Math.round(percent)}%`;
  elements.loadButton.disabled = isLoading;
  elements.playerInput.disabled = isLoading;
  elements.queueFilterSelect.disabled = isLoading;
  elements.gameLimitSelect.disabled = isLoading;
  elements.customGameLimitInput.disabled = isLoading;
}

function setMessage(text, tone = "muted") {
  elements.message.className = `panel ${tone}`;
  elements.message.textContent = text;
}

function normalizeReportPlayer(value) {
  return String(value || "").trim().toLowerCase();
}

function getCurrentReportQueue() {
  return currentPayload?.queueFilter || currentReport?.queueFilter || lastRequest?.queue || "all";
}

function getCurrentReportGameLimit() {
  return currentPayload?.gameLimit || currentReport?.gameLimit || lastRequest?.gameLimit || "all";
}

function formatGameLimitLabel(value) {
  return String(value || "all") === "all" ? "all loaded games" : `last ${value} games`;
}

function isCurrentReportRequest(player, queue, gameLimit) {
  if (!currentPayload) {
    return false;
  }
  const requestedPlayer = normalizeReportPlayer(player);
  const currentLogin = normalizeReportPlayer(currentPayload.player?.login);
  const currentId = normalizeReportPlayer(currentPayload.player?.id);
  return Boolean(requestedPlayer)
    && (requestedPlayer === currentLogin || requestedPlayer === currentId)
    && String(queue || "all") === String(getCurrentReportQueue() || "all")
    && String(gameLimit || "all") === String(getCurrentReportGameLimit() || "all");
}

function hideUpdateToast() {
  if (updateToastTimeout) {
    window.clearTimeout(updateToastTimeout);
    updateToastTimeout = null;
  }
  if (elements.updateToast) {
    elements.updateToast.hidden = true;
  }
}

function showUpdateToast(title, text, timeoutMs = 4200) {
  if (!elements.updateToast) {
    return;
  }
  elements.updateToastTitle.textContent = title;
  elements.updateToastText.textContent = text;
  elements.updateToast.hidden = false;
  if (updateToastTimeout) {
    window.clearTimeout(updateToastTimeout);
  }
  updateToastTimeout = window.setTimeout(hideUpdateToast, timeoutMs);
}

function setReportVisible(isVisible) {
  for (const section of reportSections) {
    section.hidden = !isVisible;
  }
  syncFilterToolbarVisibility();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}`;
}

function round(value, digits = 1) {
  return Number(Number(value || 0).toFixed(digits));
}

function renderStatus(el, status) {
  if (!el || !status) {
    return;
  }
  const tone = status.ok ? "good" : "bad";
  el.className = `status-pill ${tone}`;
  el.textContent = `${status.label}: ${status.detail}`;
}

function renderCards(report) {
  const overview = report.overview || {};
  const rankedGames = Number(overview.rankedGames || 0);
  const unrankedGames = Number(overview.unrankedGames || 0);
  const draws = Number(overview.draws || 0);
  const maxWinStreak = overview.maxStreaks?.win || { size: 0, monthRange: "No games", gameIds: [] };
  const maxLossStreak = overview.maxStreaks?.loss || { size: 0, monthRange: "No games", gameIds: [] };
  const streakButton = (streak, label) => streak.gameIds?.length
    ? `<button class="secondary stat-link" type="button" data-streak-filter="${escapeHtml(streak.gameIds.join(","))}" data-streak-label="${escapeHtml(`${label}, ${streak.monthRange}`)}">View replays</button>`
    : "";
  const cards = [
    { label: "Loaded games", value: overview.totalGames },
    { label: "Ranked games", value: rankedGames },
    { label: "Unranked games", value: unrankedGames },
    { label: "Draws", value: draws },
    { label: "Ranked W/L", value: `${overview.wins}-${overview.losses}` },
    { label: "Ranked win rate", value: formatPercent(overview.winRate) },
    { label: "Recent ranked 25", value: formatPercent(overview.recentWinRate) },
    { label: "Avg duration", value: `${overview.averageDurationMinutes} min` },
    {
      label: "Max win streak",
      value: maxWinStreak.size ? `WIN x${maxWinStreak.size}` : "No wins",
      detail: maxWinStreak.monthRange,
      action: streakButton(maxWinStreak, "Max win streak")
    },
    {
      label: "Max loss streak",
      value: maxLossStreak.size ? `LOSS x${maxLossStreak.size}` : "No losses",
      detail: maxLossStreak.monthRange,
      action: streakButton(maxLossStreak, "Max loss streak")
    }
  ];

  elements.overview.innerHTML = cards.map((card) => `
    <article class="card">
      <p class="panel-label">${escapeHtml(card.label)}</p>
      <p class="card-value">${escapeHtml(card.value)}</p>
      ${card.detail ? `<p class="card-detail">${escapeHtml(card.detail)}</p>` : ""}
      ${card.action || ""}
    </article>
  `).join("");
  elements.overviewDisclaimer.innerHTML = `
    <strong>Ranked-only W/L:</strong>
    Win/loss ratio, win rate, recent form, and streak use only wins/losses with actual rating gain or loss.
    ${draws ? `${escapeHtml(draws)} draws are counted in the draw card and excluded from W/L and streaks.` : ""}
    ${escapeHtml(unrankedGames)} loaded games are outside a recognized ranked queue.
  `;
}

function renderReportFilters(payload) {
  const playerName = payload?.player?.login || "Current report";
  elements.reportFilterPlayer.textContent = playerName;
  syncFilterToolbarVisibility();
}

function syncFilterToolbarVisibility() {
  if (!elements.reportFilters || !elements.showFiltersButton) {
    return;
  }
  const hasReport = Boolean(currentReport);
  elements.reportFilters.hidden = !hasReport;
  filtersStuck = hasReport && !filtersCollapsed && window.scrollY > 0 && elements.reportFilters.getBoundingClientRect().top <= 12;
  elements.reportFilters.classList.toggle("is-stuck", filtersStuck);
  elements.reportFilters.classList.toggle("is-collapsed", hasReport && filtersCollapsed);
  elements.showFiltersButton.hidden = !hasReport || !filtersCollapsed;
}

function syncScrollTopButton() {
  if (!elements.scrollTopButton) {
    return;
  }
  elements.scrollTopButton.hidden = window.scrollY < 240;
}

function syncScrollUi() {
  syncScrollTopButton();
  syncFilterToolbarVisibility();
}

function getSelectedGameLimit() {
  if (elements.gameLimitSelect.value !== "custom") {
    return elements.gameLimitSelect.value;
  }
  const value = Number.parseInt(elements.customGameLimitInput.value, 10);
  return Number.isFinite(value) && value > 0 ? String(value) : "all";
}

function syncCustomGameLimitVisibility() {
  elements.customGameLimitField.hidden = elements.gameLimitSelect.value !== "custom";
}

function updateSmallRelationshipButton(tableId) {
  const button = tableId === "opponents" ? elements.hideSmallOpponentsButton : elements.hideSmallTeammatesButton;
  const active = relationshipState[tableId].minGames >= 20;
  button.classList.toggle("active", active);
  button.textContent = active ? "Show all games" : "Hide <20 games";
}

function sortIconFor(tableId, key) {
  const state = tableSortState[tableId];
  if (!state || state.key !== key) {
    return { active: false, icon: "&varr;" };
  }
  return { active: true, icon: state.direction === "asc" ? "&uarr;" : "&darr;" };
}

function renderTable(container, headers, rows, emptyText) {
  if (!rows.length) {
    container.innerHTML = `<p class="empty">${escapeHtml(emptyText)}</p>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>${headers.map((header) => {
          if (!header.sortable) {
            return `<th>${header.label}</th>`;
          }
          return `<th class="sortable"><button class="th-button" type="button" data-sort-key="${escapeHtml(header.sortKey)}" data-table-id="${escapeHtml(header.tableId)}">${header.label}<span class="sort-icon ${header.sortActive ? "active" : ""}">${header.sortIcon}</span></button></th>`;
        }).join("")}</tr>
      </thead>
      <tbody>
        ${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderPlayerMeta(player, providerMeta, report) {
  const ratings = Object.entries(player.ratings || {})
    .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const cacheNote = providerMeta.cacheStatus
    ? `Cache ${providerMeta.cacheStatus}${providerMeta.cacheAgeMinutes != null ? `, ${providerMeta.cacheAgeMinutes} min old` : ""}`
    : null;
  const syncNote = providerMeta.lastFetchedAt
    ? `Last FAF sync: ${new Date(providerMeta.lastFetchedAt).toLocaleString()}`
    : null;
  const coverageNotes = report.coverage?.notes?.length
    ? `<div class="coverage-note"><strong>What is excluded from some sections:</strong>${report.coverage.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</div>`
    : "";

  elements.playerMeta.innerHTML = `
    <div class="meta-grid">
      <div><span>Login</span><strong>${escapeHtml(player.login)}</strong></div>
      <div><span>Player ID</span><strong>${escapeHtml(player.id)}</strong></div>
      <div><span>Games Loaded</span><strong>${escapeHtml(report.overview.totalGames)}</strong></div>
      <div><span>Queue Filter</span><strong>${escapeHtml(report.queueFilter)}</strong></div>
      ${ratings}
      <div><span>Source</span><strong>${escapeHtml(providerMeta.source || "unknown")}</strong></div>
    </div>
    ${providerMeta.note ? `<p class="meta-note"><strong>Source note:</strong> ${escapeHtml(providerMeta.note)}</p>` : ""}
    ${cacheNote ? `<p class="meta-note"><strong>${escapeHtml(cacheNote)}</strong></p>` : ""}
    ${syncNote ? `<p class="meta-note">${escapeHtml(syncNote)}</p>` : ""}
    ${coverageNotes}
  `;
}

function renderAuthDiagnostics(preview) {
  if (!elements.oauthDiagnosticsBody) {
    return;
  }
  const warning = preview.warning ? `<p class="meta-note">${escapeHtml(preview.warning)}</p>` : "";
  elements.oauthDiagnosticsBody.innerHTML = `
    <div class="meta-grid">
      <div><span>Mode</span><strong>${escapeHtml(preview.mode || "unknown")}</strong></div>
      <div><span>Client ID</span><strong>${escapeHtml(preview.clientId || "missing")}</strong></div>
      <div><span>Scopes</span><strong>${escapeHtml(preview.scopes || "missing")}</strong></div>
      <div><span>Redirect URI</span><strong>${escapeHtml(preview.redirectUri || "missing")}</strong></div>
      <div><span>Authorize endpoint</span><strong>${escapeHtml(preview.authorizationEndpoint || "missing")}</strong></div>
      <div><span>Token endpoint</span><strong>${escapeHtml(preview.tokenEndpoint || "missing")}</strong></div>
    </div>
    <p class="meta-note">Authorize URL preview</p>
    <p class="empty">${escapeHtml(preview.authUrl || "Unavailable")}</p>
    ${warning}
  `;
}

function sortRows(rows, state) {
  return [...rows].sort((a, b) => {
    const left = a[state.key];
    const right = b[state.key];
    if (typeof left === "string" || typeof right === "string") {
      const compare = String(left).localeCompare(String(right));
      return state.direction === "asc" ? compare : -compare;
    }
    const compare = Number(left || 0) - Number(right || 0);
    return state.direction === "asc" ? compare : -compare;
  });
}

function textMatchesQuery(value, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return String(value || "").toLowerCase().includes(normalizedQuery);
}

function filterNamedRows(rows, query) {
  return rows.filter((row) => textMatchesQuery(row.name, query));
}

function graphDateInRange(date) {
  const state = chartPeriodState.shared || {};
  const value = String(date || "").slice(0, 10);
  return Boolean(value)
    && (!state.from || value >= state.from)
    && (!state.to || value <= state.to);
}

function selectedGraphDelta(game) {
  const visible = chartVisibilityState.shared;
  if (!visible || !visible.size) {
    return 0;
  }
  return (game.ratingChanges || [])
    .filter((entry) => visible.has(entry.ratingType) && Number.isFinite(Number(entry.delta)) && Number(entry.delta) !== 0)
    .reduce((sum, entry) => sum + Number(entry.delta), 0);
}

function aggregateRelationshipRows(report, kind) {
  const rows = new Map();
  for (const game of report.relationshipGames || []) {
    if (!graphDateInRange(game.date)) {
      continue;
    }
    const delta = selectedGraphDelta(game);
    if (!delta) {
      continue;
    }
    const names = kind === "teammates" ? game.teammates : game.opponents;
    if (!Array.isArray(names) || !names.length) {
      continue;
    }
    for (const name of names) {
      const bucket = rows.get(name) || {
        name,
        games: 0,
        wins: 0,
        netRatingDelta: 0,
        ratingGained: 0,
        ratingLost: 0
      };
      bucket.games += 1;
      if (game.playerOutcome === "WIN") {
        bucket.wins += 1;
      }
      bucket.netRatingDelta += delta;
      if (delta > 0) {
        bucket.ratingGained += delta;
      } else {
        bucket.ratingLost += Math.abs(delta);
      }
      rows.set(name, bucket);
    }
  }
  return [...rows.values()].map((row) => ({
    ...row,
    netRatingDelta: round(row.netRatingDelta, 2),
    ratingGained: round(row.ratingGained, 2),
    ratingLost: round(row.ratingLost, 2),
    winRate: round((row.wins / Math.max(row.games, 1)) * 100)
  }));
}

function updateShowMoreButton() {
  const total = gameHistoryState.filteredGames.length;
  const visible = Math.min(gameHistoryState.visibleCount, total);
  if (!total || visible >= total) {
    elements.showMoreGamesButton.hidden = true;
    elements.showMoreGamesButton.disabled = true;
    elements.showMoreGamesButton.textContent = "Show more";
    return;
  }
  elements.showMoreGamesButton.hidden = false;
  elements.showMoreGamesButton.disabled = false;
  elements.showMoreGamesButton.textContent = `Show more (${visible}/${total})`;
}

function updateHistoryFilterUi() {
  const active = Boolean(gameHistoryState.filterLabel);
  elements.historyFilterLabel.hidden = !active;
  elements.clearHistoryFilterButton.hidden = !active;
  elements.historyFilterLabel.textContent = active ? gameHistoryState.filterLabel : "";
}

function updateShowMoreMapsButton(total) {
  const visible = Math.min(mapTendencyState.visibleCount, total);
  elements.hideMapsButton.hidden = visible <= 8;
  if (!total || visible >= total) {
    elements.showMoreMapsButton.hidden = true;
    elements.showMoreMapsButton.disabled = true;
    elements.showMoreMapsButton.textContent = "Show more maps";
    return;
  }
  elements.showMoreMapsButton.hidden = false;
  elements.showMoreMapsButton.disabled = false;
  elements.showMoreMapsButton.textContent = `Show more maps (${visible}/${total})`;
}

function updateShowMoreRelationshipButton(kind, total) {
  const state = relationshipState[kind];
  const button = kind === "opponents" ? elements.showMoreOpponentsButton : elements.showMoreTeammatesButton;
  const hideButton = kind === "opponents" ? elements.hideOpponentsButton : elements.hideTeammatesButton;
  const visible = Math.min(state.visibleCount, total);
  if (!button) {
    return;
  }
  hideButton.hidden = visible <= 8;
  if (!total || visible >= total) {
    button.hidden = true;
    button.disabled = true;
    button.textContent = kind === "opponents" ? "Show more opponents" : "Show more teammates";
    return;
  }
  button.hidden = false;
  button.disabled = false;
  button.textContent = `${kind === "opponents" ? "Show more opponents" : "Show more teammates"} (${visible}/${total})`;
}

function resetDiscoveryLists(report, options = {}) {
  if (options.clearSearch) {
    relationshipState.opponents.query = "";
    relationshipState.teammates.query = "";
    mapTendencyState.query = "";
    elements.opponentSearchInput.value = "";
    elements.teammateSearchInput.value = "";
    elements.mapSearchInput.value = "";
  }
  relationshipState.opponents.visibleCount = Math.min(8, (report?.allOpponents || report?.topOpponents || []).length);
  relationshipState.teammates.visibleCount = Math.min(8, (report?.allTeammates || report?.topTeammates || []).length);
  mapTendencyState.visibleCount = Math.min(8, report?.mapTendencies?.length || 0);
}

function buildChartPoints(points, width, height, padding, valueKey) {
  const values = points.map((point) => Number(point[valueKey] || 0));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const xStep = points.length === 1 ? 0 : (width - padding * 2) / (points.length - 1);
  return points.map((point, index) => {
    const x = padding + index * xStep;
    const y = height - padding - (((Number(point[valueKey] || 0) - minValue) / range) * (height - padding * 2));
    return { ...point, x, y };
  });
}

function displayModeName(mode) {
  const names = {
    global: "Global",
    ladder_1v1: "Ladder 1v1",
    ladder1v1: "Ladder 1v1",
    tmm_2v2: "TMM 2v2",
    tmm2v2: "TMM 2v2",
    tmm_3v3: "TMM 3v3",
    tmm3v3: "TMM 3v3",
    tmm_4v4_full_share: "TMM 4v4",
    tmm4v4: "TMM 4v4"
  };
  if (!mode || mode === "unknown") {
    return "No rating change";
  }
  return names[mode] || String(mode);
}

function displayMapName(name) {
  const value = String(name || "").trim();
  return !value || value.toLowerCase() === "unknown map" ? "Mapgen / generated map" : value;
}

function displayQueueName(game) {
  if (game.queueCategory) {
    return displayModeName(game.queueCategory);
  }
  if (game.ratingType && game.ratingType !== "unknown") {
    return displayModeName(game.ratingType);
  }
  return "Global";
}

function ratingMovementDelta(game) {
  if (Array.isArray(game.ratingChanges) && game.ratingChanges.length) {
    return game.ratingChanges.reduce((sum, entry) => {
      const delta = entry.delta === null || entry.delta === undefined ? NaN : Number(entry.delta);
      return Number.isFinite(delta) ? sum + delta : sum;
    }, 0);
  }

  const delta = game.ratingDelta === null || game.ratingDelta === undefined ? NaN : Number(game.ratingDelta);
  return Number.isFinite(delta) ? delta : 0;
}

function hasRatingMovement(game) {
  return ratingMovementDelta(game) !== 0;
}

function chartColor(index) {
  return ["#6be3c2", "#8fb7ff", "#f0c46a", "#f08d7f", "#c7a5ff", "#79d67a", "#f49bd4"][index % 7];
}

function groupSeries(points, groupKey, labelKey, valueKey, formatter, detailBuilder) {
  const groups = new Map();
  for (const point of points) {
    const key = String(point[groupKey] || "unknown");
    if (key === "unknown") {
      continue;
    }
    const group = groups.get(key) || [];
    group.push({
      ...point,
      value: Number(point[valueKey] || 0),
      label: String(point[labelKey] || ""),
      displayValue: detailBuilder ? detailBuilder(point) : formatter(point[valueKey])
    });
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort((a, b) => displayModeName(a[0]).localeCompare(displayModeName(b[0])))
    .map(([key, entries]) => ({
      key,
      name: displayModeName(key),
      points: entries.sort((a, b) => a.label.localeCompare(b.label))
    }));
}

function getChartLabels(series) {
  return [...new Set(series.flatMap((item) => item.points.map((point) => point.label)).filter(Boolean))].sort();
}

function shiftDateLabel(label, days) {
  const date = new Date(`${label}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function shiftMonthLabel(label, months) {
  const [year, month] = String(label || "").split("-").map(Number);
  if (!year || !month) {
    return "";
  }
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 7);
}

function chartPresetRange(preset, series) {
  const labels = getChartLabels(series);
  const last = labels[labels.length - 1] || "";
  if (!last || preset === "all") {
    return { from: "", to: "" };
  }
  const days = { last30: 30, last90: 90, last180: 180, last365: 365 }[preset] ?? 0;
  return { from: shiftDateLabel(last, days), to: last };
}

function syncChartPeriod(series) {
  const state = chartPeriodState.shared;
  if (!state || state.preset === "custom") {
    return;
  }
  const range = chartPresetRange(state.preset, series);
  state.from = range.from;
  state.to = range.to;
}

function filterSeriesByPeriod(series) {
  const state = chartPeriodState.shared || {};
  const from = String(state.from || "");
  const to = String(state.to || "");
  if (!from && !to) {
    return series;
  }
  const normalize = (label) => {
    const value = String(label || "");
    return value.length === 7 ? `${value}-01` : value.slice(0, 10);
  };
  return series
    .map((item) => ({
      ...item,
      points: item.points.filter((point) => {
        const rawLabel = String(point.label || "");
        if (rawLabel.length === 7) {
          const monthStart = `${rawLabel}-01`;
          const monthEndDate = new Date(`${monthStart}T00:00:00Z`);
          monthEndDate.setUTCMonth(monthEndDate.getUTCMonth() + 1);
          monthEndDate.setUTCDate(0);
          const monthEnd = monthEndDate.toISOString().slice(0, 10);
          return (!from || monthEnd >= from) && (!to || monthStart <= to);
        }
        const label = normalize(point.label);
        return (!from || label >= from) && (!to || label <= to);
      })
    }))
    .filter((item) => item.points.length);
}

function isGraphPeriodDirty() {
  const state = chartPeriodState.shared;
  return Boolean(state && (state.preset !== "all" || state.from || state.to));
}

function renderGraphControls(series) {
  const state = chartPeriodState.shared;
  const labels = getChartLabels(series);
  const first = labels[0] || "";
  const last = labels[labels.length - 1] || "";
  const presets = [["all", "All"], ["last30", "Last 30 days"], ["last90", "Last 90 days"], ["last180", "Last 180 days"], ["last365", "Last year"], ["custom", "Custom"]];

  return `
    <div class="chart-period">
      <label>
        <span>Period</span>
        <select data-chart-period-preset="shared">
          ${presets.map(([value, label]) => `<option value="${value}" ${state.preset === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>From</span>
        <input type="date" value="${escapeHtml(state.from || "")}" min="${escapeHtml(first)}" max="${escapeHtml(last)}" data-chart-period-from="shared" />
      </label>
      <label>
        <span>To</span>
        <input type="date" value="${escapeHtml(state.to || "")}" min="${escapeHtml(first)}" max="${escapeHtml(last)}" data-chart-period-to="shared" />
      </label>
    </div>
  `;
}

function syncChartVisibility(series) {
  const visible = chartVisibilityState.shared;
  const known = chartKnownSeriesState.shared;
  const keys = new Set(series.map((item) => item.key));
  for (const key of [...visible]) {
    if (!keys.has(key)) {
      visible.delete(key);
    }
  }
  for (const key of [...known]) {
    if (!keys.has(key)) {
      known.delete(key);
    }
  }
  for (const item of series) {
    if (!known.has(item.key)) {
      visible.add(item.key);
      known.add(item.key);
    }
  }
}

function renderChartToggles(chartId, series) {
  if (!series.length) {
    return "";
  }

  const visible = chartVisibilityState.shared;
  return `
    <div class="chart-toggles" aria-label="Visible game modes">
      ${series.map((item, index) => {
        const checked = visible.has(item.key);
        return `
          <button
            class="chart-toggle ${checked ? "active" : ""}"
            type="button"
            data-chart-id="${escapeHtml(chartId)}"
            data-chart-series="${escapeHtml(item.key)}"
            aria-pressed="${checked ? "true" : "false"}"
          >
            <span class="chart-swatch" style="--series-color: ${chartColor(index)}"></span>
            ${escapeHtml(item.name)}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderMultiLineChart(container, title, series, formatter, caption) {
  if (!series.length) {
    container.innerHTML = `<p class="empty">No ${escapeHtml(title.toLowerCase())} data yet.</p>`;
    return;
  }

  const visibleSeries = series.filter((item) => item.points.length);
  if (!visibleSeries.length) {
    container.innerHTML = `<p class="empty">Turn on at least one game mode to see this chart.</p>`;
    return;
  }

  const width = 640;
  const height = 240;
  const padding = 34;
  const labels = [...new Set(visibleSeries.flatMap((item) => item.points.map((point) => point.label)))].sort();
  const values = visibleSeries.flatMap((item) => item.points.map((point) => point.value));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const xStep = labels.length <= 1 ? 0 : (width - padding * 2) / (labels.length - 1);
  const xForLabel = (label) => padding + Math.max(0, labels.indexOf(label)) * xStep;
  const yForValue = (value) => height - padding - (((Number(value || 0) - minValue) / range) * (height - padding * 2));
  const firstLabel = labels[0] || "";
  const lastLabel = labels[labels.length - 1] || "";
  const lastSeries = visibleSeries[visibleSeries.length - 1];
  const lastPoint = lastSeries.points[lastSeries.points.length - 1];
  const defaultValue = lastPoint.displayValue;
  const defaultLabel = `${lastSeries.name} - ${lastPoint.label}`;

  container.innerHTML = `
    <div class="chart-shell">
      <div class="chart-hover">
        <p class="panel-label">Hover a point</p>
        <p class="chart-hover-value">${escapeHtml(defaultValue)}</p>
        <p class="chart-hover-label">${escapeHtml(defaultLabel)}</p>
      </div>
      <div class="chart">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
        <line class="chart-axis" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"></line>
        <line class="chart-axis" x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}"></line>
        <text class="chart-label" x="${padding - 8}" y="${padding + 4}" text-anchor="end">${escapeHtml(formatter(maxValue))}</text>
        <text class="chart-label" x="${padding - 8}" y="${height - padding + 4}" text-anchor="end">${escapeHtml(formatter(minValue))}</text>
        <line class="chart-grid" x1="${padding}" y1="${yForValue(0)}" x2="${width - padding}" y2="${yForValue(0)}"></line>
        <text class="chart-label" x="${padding}" y="${height - 6}" text-anchor="start">${escapeHtml(firstLabel)}</text>
        <text class="chart-label" x="${width - padding}" y="${height - 6}" text-anchor="end">${escapeHtml(lastLabel)}</text>
        ${visibleSeries.map((item, index) => {
          const color = chartColor(index);
          const points = item.points.map((point) => ({ ...point, x: xForLabel(point.label), y: yForValue(point.value) }));
          const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
          return `
            <polyline class="chart-line" style="--series-color: ${color}" points="${polyline}"></polyline>
            ${points.map((point) => `
              <circle
                class="chart-point"
                style="--series-color: ${color}"
                cx="${point.x}"
                cy="${point.y}"
                r="4"
                tabindex="0"
                data-hover-value="${escapeHtml(point.displayValue)}"
                data-hover-label="${escapeHtml(`${item.name} - ${point.label}`)}"
              >
                <title>${escapeHtml(`${item.name}, ${point.label}: ${point.displayValue}`)}</title>
              </circle>
            `).join("")}
          `;
        }).join("")}
      </svg>
    </div>
    </div>
    <p class="chart-caption">
      ${escapeHtml(caption || `${firstLabel} to ${lastLabel} - range ${formatter(minValue)} to ${formatter(maxValue)}`)}
    </p>
  `;
}

function aggregateMonthlySeries(series) {
  const buckets = new Map();

  for (const item of series) {
    for (const point of item.points) {
      const bucket = buckets.get(point.label) || {
        label: point.label,
        wins: 0,
        losses: 0,
        draws: 0,
        games: 0,
        ratingDelta: 0
      };
      bucket.wins += Number(point.wins || 0);
      bucket.losses += Number(point.losses || 0);
      bucket.draws += Number(point.draws || 0);
      bucket.games += Number(point.games || 0);
      bucket.ratingDelta += Number(point.ratingDelta || 0);
      buckets.set(point.label, bucket);
    }
  }

  return [{
    key: "selected",
    name: series.length === 1 ? series[0].name : "Selected modes",
    points: [...buckets.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((point) => ({
        ...point,
        value: point.wins - point.losses,
        displayValue: `${point.wins}-${point.losses}${point.draws ? `, ${point.draws} draws` : ""} over ${point.games} rated games`
      }))
  }];
}

function renderRelationshipTables(report) {
  const allOpponents = aggregateRelationshipRows(report, "opponents");
  const allTeammates = aggregateRelationshipRows(report, "teammates");
  const opponentRows = sortRows(
    filterNamedRows(allOpponents, relationshipState.opponents.query)
      .filter((row) => Number(row.games || 0) >= relationshipState.opponents.minGames),
    tableSortState.opponents
  );
  const teammateRows = sortRows(
    filterNamedRows(allTeammates, relationshipState.teammates.query)
      .filter((row) => Number(row.games || 0) >= relationshipState.teammates.minGames),
    tableSortState.teammates
  );
  const visibleOpponents = opponentRows.slice(0, relationshipState.opponents.visibleCount);
  const visibleTeammates = teammateRows.slice(0, relationshipState.teammates.visibleCount);
  const o = {
    name: sortIconFor("opponents", "name"),
    games: sortIconFor("opponents", "games"),
    winRate: sortIconFor("opponents", "winRate"),
    net: sortIconFor("opponents", "netRatingDelta"),
    gained: sortIconFor("opponents", "ratingGained"),
    lost: sortIconFor("opponents", "ratingLost")
  };
  const t = {
    name: sortIconFor("teammates", "name"),
    games: sortIconFor("teammates", "games"),
    winRate: sortIconFor("teammates", "winRate"),
    net: sortIconFor("teammates", "netRatingDelta"),
    gained: sortIconFor("teammates", "ratingGained"),
    lost: sortIconFor("teammates", "ratingLost")
  };

  renderTable(
    elements.opponentsTable,
    [
      { label: "Opponent", sortable: true, sortKey: "name", tableId: "opponents", sortActive: o.name.active, sortIcon: o.name.icon },
      { label: "Games", sortable: true, sortKey: "games", tableId: "opponents", sortActive: o.games.active, sortIcon: o.games.icon },
      { label: "Win rate", sortable: true, sortKey: "winRate", tableId: "opponents", sortActive: o.winRate.active, sortIcon: o.winRate.icon },
      { label: "Net rating", sortable: true, sortKey: "netRatingDelta", tableId: "opponents", sortActive: o.net.active, sortIcon: o.net.icon },
      { label: "Gained", sortable: true, sortKey: "ratingGained", tableId: "opponents", sortActive: o.gained.active, sortIcon: o.gained.icon },
      { label: "Lost", sortable: true, sortKey: "ratingLost", tableId: "opponents", sortActive: o.lost.active, sortIcon: o.lost.icon }
    ],
    visibleOpponents.map((row) => [
      escapeHtml(row.name),
      escapeHtml(row.games),
      escapeHtml(formatPercent(row.winRate)),
      escapeHtml(formatSigned(row.netRatingDelta)),
      escapeHtml(formatSigned(row.ratingGained)),
      escapeHtml(formatSigned(-row.ratingLost))
    ]),
    relationshipState.opponents.query ? "No opponents match that search." : "No opponent data yet."
  );

  renderTable(
    elements.teammatesTable,
    [
      { label: "Teammate", sortable: true, sortKey: "name", tableId: "teammates", sortActive: t.name.active, sortIcon: t.name.icon },
      { label: "Games", sortable: true, sortKey: "games", tableId: "teammates", sortActive: t.games.active, sortIcon: t.games.icon },
      { label: "Win rate", sortable: true, sortKey: "winRate", tableId: "teammates", sortActive: t.winRate.active, sortIcon: t.winRate.icon },
      { label: "Net rating", sortable: true, sortKey: "netRatingDelta", tableId: "teammates", sortActive: t.net.active, sortIcon: t.net.icon },
      { label: "Gained", sortable: true, sortKey: "ratingGained", tableId: "teammates", sortActive: t.gained.active, sortIcon: t.gained.icon },
      { label: "Lost", sortable: true, sortKey: "ratingLost", tableId: "teammates", sortActive: t.lost.active, sortIcon: t.lost.icon }
    ],
    visibleTeammates.map((row) => [
      escapeHtml(row.name),
      escapeHtml(row.games),
      escapeHtml(formatPercent(row.winRate)),
      escapeHtml(formatSigned(row.netRatingDelta)),
      escapeHtml(formatSigned(row.ratingGained)),
      escapeHtml(formatSigned(-row.ratingLost))
    ]),
    relationshipState.teammates.query ? "No teammates match that search." : "No teammate data yet."
  );

  updateShowMoreRelationshipButton("opponents", opponentRows.length);
  updateShowMoreRelationshipButton("teammates", teammateRows.length);
  updateSmallRelationshipButton("opponents");
  updateSmallRelationshipButton("teammates");
}

function renderMapTendencies(report) {
  const mapRows = sortRows(filterNamedRows(report.mapTendencies, mapTendencyState.query), tableSortState.maps);
  const visibleMaps = mapRows.slice(0, mapTendencyState.visibleCount);
  const m = {
    name: sortIconFor("maps", "name"),
    games: sortIconFor("maps", "games"),
    ratedGames: sortIconFor("maps", "ratedGames"),
    winRate: sortIconFor("maps", "winRate"),
    ratingDelta: sortIconFor("maps", "ratingDelta"),
    noRatingGames: sortIconFor("maps", "noRatingGames"),
    noResultGames: sortIconFor("maps", "noResultGames")
  };

  renderTable(
    elements.mapTendenciesTable,
    [
      { label: "Map", sortable: true, sortKey: "name", tableId: "maps", sortActive: m.name.active, sortIcon: m.name.icon },
      { label: "Total", sortable: true, sortKey: "games", tableId: "maps", sortActive: m.games.active, sortIcon: m.games.icon },
      { label: "Rated", sortable: true, sortKey: "ratedGames", tableId: "maps", sortActive: m.ratedGames.active, sortIcon: m.ratedGames.icon },
      { label: "W-L-D" },
      { label: "Win rate", sortable: true, sortKey: "winRate", tableId: "maps", sortActive: m.winRate.active, sortIcon: m.winRate.icon },
      { label: "Rating delta", sortable: true, sortKey: "ratingDelta", tableId: "maps", sortActive: m.ratingDelta.active, sortIcon: m.ratingDelta.icon },
      { label: "Unranked", sortable: true, sortKey: "noRatingGames", tableId: "maps", sortActive: m.noRatingGames.active, sortIcon: m.noRatingGames.icon },
      { label: "No result", sortable: true, sortKey: "noResultGames", tableId: "maps", sortActive: m.noResultGames.active, sortIcon: m.noResultGames.icon },
      { label: "Most losses to" }
    ],
    visibleMaps.map((row) => [
      escapeHtml(row.name),
      escapeHtml(row.games),
      escapeHtml(row.ratedGames),
      escapeHtml(`${row.wins || 0}-${row.losses || 0}-${row.draws || 0}`),
      escapeHtml(formatPercent(row.winRate)),
      escapeHtml(formatSigned(row.ratingDelta)),
      escapeHtml(row.noRatingGames || 0),
      escapeHtml(row.noResultGames || 0),
      escapeHtml(
        row.topLossOpponents.length
          ? row.topLossOpponents.map((entry) => `${entry.name} (${entry.losses})`).join(", ")
          : "No repeated loss pattern"
      )
    ]),
    mapTendencyState.query ? "No maps match that search." : "No map tendency data yet."
  );
  elements.mapTendenciesTable.insertAdjacentHTML(
    "afterbegin",
    `<p class="history-disclaimer"><strong>Map columns:</strong> Total is every loaded game on that map. Rated is games with actual rating gain/loss, including draws. W-L-D is rated wins/losses/draws. Win rate ignores draws. Unranked means known result but no rating movement; No result means FAF did not give usable win/loss/draw.</p>`
  );

  updateShowMoreMapsButton(mapRows.length);
}

function renderImprovement(report) {
  const { improvement } = report;
  const renderPeriodLinks = (entries, key, emptyText, listId, extraLineForEntry = null) => {
    if (!entries.length) {
      return emptyText;
    }

    const isExpanded = Boolean(insightExpandedState[listId]);
    const visibleEntries = isExpanded ? entries : entries.slice(0, 3);
    const toggle = entries.length > 3
      ? `<button class="secondary insight-more-button" type="button" data-insight-toggle="${escapeHtml(listId)}">${isExpanded ? "Hide" : `Show more (${entries.length - 3})`}</button>`
      : "";

    return `<div class="insight-list">${visibleEntries.map((entry, index) => `
      <div class="insight-line">
        <div>
          <strong>${escapeHtml(entry[key])}</strong><br />
          ${escapeHtml(`${formatSigned(entry.ratingDelta)}, ${formatPercent(entry.winRate)} over ${entry.games} rated games${extraLineForEntry ? extraLineForEntry(entry, index) : ""}`)}
        </div>
        <button class="secondary insight-button" type="button" data-month-filter="${escapeHtml(entry[key])}">View replays</button>
      </div>
    `).join("")}</div>${toggle}`;
  };

  const cards = [
    {
      title: "Best Months",
      body: renderPeriodLinks(improvement.bestMonths, "month", "Not enough monthly volume yet.", "bestMonths")
    },
    {
      title: "The Tilt Zone",
      body: renderPeriodLinks(
        improvement.worstMonths,
        "month",
        "No clear bad run detected yet.",
        "worstMonths",
        (_entry, index) => index === 0 ? `, worst loss streak ${improvement.worstLossStreak}` : ""
      )
    },
    {
      title: "Best Days",
      body: renderPeriodLinks(improvement.bestDays || [], "day", "Not enough daily volume yet.", "bestDays")
    },
    {
      title: "Rough Days",
      body: renderPeriodLinks(improvement.worstDays || [], "day", "No rough rated day stands out yet.", "worstDays")
    },
    {
      title: "Maps Gaining Rating Lately",
      body: improvement.mapsGainingLately.length
        ? `<strong>${escapeHtml(improvement.recentMapPeriod || "recent games")}</strong><br>${improvement.mapsGainingLately.map((entry) => `${escapeHtml(entry.name)}: ${escapeHtml(formatSigned(entry.ratingDelta))} across ${escapeHtml(entry.games)} games`).join("<br>")}`
        : "No recent positive map trend yet."
    },
    {
      title: "Maps Bleeding Rating Lately",
      body: improvement.mapsLosingLately?.length
        ? `<strong>${escapeHtml(improvement.recentMapPeriod || "recent games")}</strong><br>${improvement.mapsLosingLately.map((entry) => `${escapeHtml(entry.name)}: ${escapeHtml(formatSigned(entry.ratingDelta))} across ${escapeHtml(entry.games)} games`).join("<br>")}`
        : "No recent negative map trend yet."
    },
    {
      title: "1v1 Runbacks You Started Winning",
      body: improvement.opponentsSolved.length
        ? `${improvement.opponentsSolved.map((entry) => `${escapeHtml(entry.name)}: earlier ${escapeHtml(formatPercent(entry.earlyWinRate))} -> later ${escapeHtml(formatPercent(entry.lateWinRate))} across ${escapeHtml(entry.recentGames)} recent games`).join("<br>")}<br><br>This compares your earlier head-to-head record versus your later head-to-head record to show which repeat opponents you started beating more often.`
        : "No strong 1v1 repeat-opponent turnaround yet."
    }
  ];

  elements.improvementInsights.innerHTML = cards.map((card) => `
    <article class="insight-card">
      <h3>${escapeHtml(card.title)}</h3>
      <p class="meta-note">${card.body}</p>
    </article>
  `).join("");
}

function renderGameHistory() {
  const ratingGames = gameHistoryState.filteredGames.filter((game) => hasRatingMovement(game));
  const visibleGames = ratingGames.slice(0, gameHistoryState.visibleCount);
  renderTable(
    elements.gamesTable,
    [
      { label: "Date" },
      { label: "Queue" },
      { label: "Map" },
      { label: "Result" },
      { label: "Rating" },
      { label: "Replay" }
    ],
    visibleGames.map((game) => [
      escapeHtml((game.startedAt || "").slice(0, 10)),
      escapeHtml(displayQueueName(game)),
      escapeHtml(displayMapName(game.mapName)),
      `<span class="result ${game.playerOutcome === "WIN" ? "win" : game.playerOutcome === "LOSS" ? "loss" : game.playerOutcome === "DRAW" ? "draw" : ""}">${escapeHtml(game.playerOutcome)}</span>`,
      escapeHtml(formatSigned(game.ratingDelta)),
      `<a href="${escapeHtml(game.replayUrl)}" target="_blank" rel="noreferrer">#${escapeHtml(game.replayId)}</a>`
    ]),
    "No game history yet."
  );
  if (currentReport?.coverage?.hiddenFromGameHistory) {
    elements.gamesTable.insertAdjacentHTML(
      "afterbegin",
      `<p class="history-disclaimer">Game History shows only games with an actual rating gain or loss. ${escapeHtml(currentReport.coverage.hiddenFromGameHistory)} loaded games without rating movement are hidden here.</p>`
    );
  }
  updateHistoryFilterUi();
  updateShowMoreButton();
}

function filterHistoryByMonth(month) {
  gameHistoryState.filteredGames = gameHistoryState.allGames.filter((game) => hasRatingMovement(game) && String(game.startedAt || "").startsWith(month));
  gameHistoryState.visibleCount = Math.min(50, gameHistoryState.filteredGames.length);
  gameHistoryState.filterLabel = `Showing ${gameHistoryState.filteredGames.length} replays from ${month}`;
  renderGameHistory();
  document.getElementById("gamesTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function filterHistoryByGameIds(rawIds, label) {
  const ids = new Set(String(rawIds || "").split(",").filter(Boolean));
  gameHistoryState.filteredGames = gameHistoryState.allGames.filter((game) => ids.has(String(game.id)));
  gameHistoryState.visibleCount = gameHistoryState.filteredGames.length;
  gameHistoryState.filterLabel = `Showing ${gameHistoryState.filteredGames.length} replays: ${label}`;
  renderGameHistory();
  document.getElementById("gamesTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearHistoryFilter() {
  gameHistoryState.filteredGames = gameHistoryState.allGames.filter((game) => hasRatingMovement(game));
  gameHistoryState.visibleCount = Math.min(10, gameHistoryState.filteredGames.length);
  gameHistoryState.filterLabel = "";
  renderGameHistory();
}

function renderReport(payload) {
  setReportVisible(true);
  const { report, player, providerMeta } = payload;
  currentPayload = payload;
  currentReport = report;
  renderCards(report);
  renderReportFilters(payload);
  renderPlayerMeta(player, providerMeta, report);
  const ratingSeries = groupSeries(
    report.charts.ratingTimeline || [],
    "ratingType",
    "date",
    "actualRating",
    (value) => `${Math.round(Number(value || 0))}`,
    (point) => `${Math.round(Number(point.actualRating || 0))} FAF rating${Number.isFinite(Number(point.ratingDelta)) ? ` (${formatSigned(point.ratingDelta)} this game)` : ""}`
  );
  const monthlySeries = groupSeries(
    report.charts.monthlyPerformanceByMode || [],
    "ratingType",
    "month",
    "gameScore",
    (value) => {
      const number = Number(value || 0);
      return `${number > 0 ? "+" : ""}${Math.round(number)} games`;
    },
    (point) => `${point.wins}-${point.losses}${point.draws ? `, ${point.draws} draws` : ""} over ${point.games} rated games`
  );

  syncChartPeriod(ratingSeries.length ? ratingSeries : monthlySeries);
  const periodRatingSeries = filterSeriesByPeriod(ratingSeries);
  const periodMonthlySeries = filterSeriesByPeriod(monthlySeries);
  syncChartVisibility([...periodRatingSeries, ...periodMonthlySeries]);
  const visibleRatingSeries = periodRatingSeries.filter((item) => chartVisibilityState.shared.has(item.key));
  const visibleMonthlySeries = periodMonthlySeries.filter((item) => chartVisibilityState.shared.has(item.key));
  const aggregateMonthly = aggregateMonthlySeries(visibleMonthlySeries);

  if (elements.graphControls) {
    elements.graphControls.innerHTML = renderGraphControls(ratingSeries.length ? ratingSeries : monthlySeries)
      + renderChartToggles("shared", [...periodRatingSeries, ...periodMonthlySeries].filter((item, index, list) => (
        list.findIndex((candidate) => candidate.key === item.key) === index
      )));
  }
  if (elements.resetGraphFiltersButton) {
    elements.resetGraphFiltersButton.hidden = !isGraphPeriodDirty();
  }

  elements.ratingChart.innerHTML = "";
  const ratingSurface = document.createElement("div");
  elements.ratingChart.appendChild(ratingSurface);
  renderMultiLineChart(
    ratingSurface,
    "Rating trend",
    visibleRatingSeries,
    (value) => `${Math.round(Number(value || 0))}`,
    "FAF displayed rating by game mode. Pick any period above, then toggle modes to compare only the lines you care about."
  );

  elements.monthlyChart.innerHTML = "";
  const monthlySurface = document.createElement("div");
  elements.monthlyChart.appendChild(monthlySurface);
  renderMultiLineChart(
    monthlySurface,
    "Monthly performance",
    aggregateMonthly,
    (value) => {
      const number = Number(value || 0);
      return `${number > 0 ? "+" : ""}${Math.round(number)}`;
    },
    "Monthly record combines the visible game modes as wins minus losses. Turn modes off to remove them from the total."
  );
  renderRelationshipTables(report);
  renderMapTendencies(report);
  renderImprovement(report);
  renderTable(
    elements.ratingSummaryTable,
    [{ label: "Queue" }, { label: "Games" }, { label: "Draws" }, { label: "Win %" }, { label: "Net" }, { label: "Avg" }],
    report.ratingSummary
      .filter((row) => row.name && row.name !== "unknown" && row.name !== "no_rating_change" && Number(row.games || 0) > 0)
      .map((row) => [
      escapeHtml(displayModeName(row.name)),
      escapeHtml(row.games),
      escapeHtml(row.draws || 0),
      escapeHtml(formatPercent(row.winRate)),
      escapeHtml(formatSigned(row.totalDelta)),
      escapeHtml(formatSigned(row.averageDelta))
    ]),
    "No rating summary data yet."
  );
  gameHistoryState.allGames = (report.allGames || []).filter((game) => hasRatingMovement(game));
  gameHistoryState.filteredGames = [...gameHistoryState.allGames];
  gameHistoryState.visibleCount = Math.min(10, gameHistoryState.allGames.length);
  gameHistoryState.filterLabel = "";
  renderGameHistory();
}

function updateChartHover(target) {
  const shell = target.closest(".chart-shell");
  if (!shell) {
    return;
  }

  const value = shell.querySelector(".chart-hover-value");
  const label = shell.querySelector(".chart-hover-label");
  if (value) {
    value.textContent = target.dataset.hoverValue || "";
  }
  if (label) {
    label.textContent = target.dataset.hoverLabel || "";
  }
}

async function refreshStatus() {
  const [statusResponse, authResponse, previewResponse] = await Promise.all([
    fetch("/api/status"),
    fetch("/api/auth/status"),
    fetch("/api/auth/preview")
  ]);
  const payload = await statusResponse.json();
  const auth = await authResponse.json();
  const preview = await previewResponse.json();
  renderStatus(elements.officialStatus, payload.providers.official);
  renderStatus(elements.sampleStatus, payload.providers.sample);
  if (elements.authModeInput) elements.authModeInput.value = auth.config.authMode || "loopback";
  if (elements.clientIdInput) elements.clientIdInput.value = auth.config.clientId || "";
  if (elements.scopesInput) elements.scopesInput.value = auth.config.scopes || "";
  if (elements.oauthBaseUrlInput) elements.oauthBaseUrlInput.value = auth.config.oauthBaseUrl || "";
  if (elements.oidcDiscoveryUrlInput) elements.oidcDiscoveryUrlInput.value = auth.config.oidcDiscoveryUrl || "";
  if (elements.apiBaseUrlInput) elements.apiBaseUrlInput.value = auth.config.apiBaseUrl || "";
  if (elements.userBaseUrlInput) elements.userBaseUrlInput.value = auth.config.userBaseUrl || "";
  if (elements.appBaseUrlInput) elements.appBaseUrlInput.value = auth.config.appBaseUrl || "";
  if (elements.redirectUriInput) elements.redirectUriInput.value = auth.config.redirectUri || auth.callback.redirectUri || "";
  elements.authSummary.className = `status-pill ${auth.loggedIn ? "good" : "neutral"}`;
  elements.authSummary.textContent = auth.loggedIn
    ? `Logged in as ${auth.userProfile?.data?.attributes?.userName || auth.userProfile?.userName || auth.userProfile?.username || "FAF user"}`
    : `Not logged in (${auth.callback.mode || "unknown"} mode)`;
  if (elements.sessionStatus) {
    elements.sessionStatus.className = `status-pill ${auth.loggedIn ? "good" : "neutral"}`;
    elements.sessionStatus.textContent = auth.loggedIn
      ? `Refresh token ${auth.token?.hasRefreshToken ? "available" : "missing"}`
      : `Using ${auth.callback.redirectUri || "no redirect URI"}`;
  }
  if (previewResponse.ok) {
    renderAuthDiagnostics(preview);
  } else if (elements.oauthDiagnosticsBody) {
    elements.oauthDiagnosticsBody.innerHTML = `<p class="empty">${escapeHtml(preview.error || "Unable to build OAuth preview.")}</p>`;
  }
}

async function pollLoadStatus() {
  try {
    const response = await fetch("/api/load-status");
    const payload = await response.json();
    if (payload.active) {
      setLoadingState(true, `${payload.message}${payload.fetchedGames ? ` (${payload.fetchedGames} games)` : ""}`, payload.percent || 0);
    }
  } catch (error) {}
}

function startLoadPolling() {
  stopLoadPolling();
  loadingPoll = window.setInterval(pollLoadStatus, 700);
}

function stopLoadPolling() {
  if (loadingPoll) {
    window.clearInterval(loadingPoll);
    loadingPoll = null;
  }
}

async function saveAuthConfig() {
  if (!elements.authModeInput) {
    return;
  }
  const response = await fetch("/api/auth/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authMode: elements.authModeInput.value,
      clientId: elements.clientIdInput.value,
      scopes: elements.scopesInput.value,
      oauthBaseUrl: elements.oauthBaseUrlInput.value,
      oidcDiscoveryUrl: elements.oidcDiscoveryUrlInput.value,
      apiBaseUrl: elements.apiBaseUrlInput.value,
      userBaseUrl: elements.userBaseUrlInput.value,
      appBaseUrl: elements.appBaseUrlInput.value,
      redirectUri: elements.redirectUriInput.value
    })
  });
  if (!response.ok) {
    setMessage("Unable to save FAF auth settings.", "bad");
    return;
  }
  setMessage("FAF auth settings saved for this local process.", "good");
  await refreshStatus();
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  await refreshStatus();
  setMessage("Logged out of the local FAF session.", "muted");
}

async function importToken(kind) {
  if (kind === "refresh" && !elements.refreshTokenInput) {
    return;
  }
  const body = kind === "refresh"
    ? { refreshToken: elements.refreshTokenInput.value.trim() }
    : { accessToken: elements.accessTokenInput.value.trim() };
  const response = await fetch("/api/auth/import-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    setMessage(payload.error || "Unable to import FAF token.", "bad");
    return;
  }
  if (kind === "access") {
    elements.accessTokenInput.value = "";
  }
  await refreshStatus();
  setMessage(kind === "refresh" ? "Imported FAF refresh token." : "Temporary FAF access token active. You can load reports from the official API until it expires.", "good");
}

async function loadReport(options = {}) {
  const player = (options.player ?? elements.playerInput.value).trim();
  const provider = "official";
  const queue = options.queue ?? elements.queueFilterSelect.value;
  const gameLimit = options.gameLimit ?? getSelectedGameLimit();
  const forceRefresh = options.forceRefresh ?? true;
  if (!player) {
    setMessage("Enter a player login first.", "bad");
    return;
  }
  if (!options.skipDuplicateCheck && isCurrentReportRequest(player, queue, gameLimit)) {
    const shouldReload = window.confirm(
      `You are already viewing ${currentPayload.player.login} (${displayModeName(queue)}). Load this report again?`
    );
    if (!shouldReload) {
      setMessage("Reload cancelled. The current report is still open.", "muted");
      return;
    }
  }

  lastRequest = { player, queue, gameLimit };

  setMessage(`Loading ${player} (${displayModeName(queue)}, ${gameLimit === "all" ? "all games" : `last ${gameLimit} games`})...`, "muted");
  setLoadingState(true, `Loading report for ${player}...`, 2);
  startLoadPolling();

  try {
    const response = await fetch(`/api/player/${encodeURIComponent(player)}?provider=${encodeURIComponent(provider)}&queue=${encodeURIComponent(queue)}&gameLimit=${encodeURIComponent(gameLimit)}&refresh=${forceRefresh ? "1" : "0"}`);
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Unable to load the player report.", "bad");
      elements.gamesTable.innerHTML = payload.hint
        ? `<p class="empty">${escapeHtml(payload.detail || "")}<br /><br />${escapeHtml(payload.hint)}</p>`
        : `<p class="empty">${escapeHtml(payload.detail || "No extra detail provided.")}</p>`;
      elements.overview.innerHTML = "";
      elements.overviewDisclaimer.innerHTML = "";
      if (elements.graphControls) {
        elements.graphControls.innerHTML = "";
      }
      elements.ratingChart.innerHTML = "";
      elements.monthlyChart.innerHTML = "";
      elements.opponentsTable.innerHTML = "";
      elements.teammatesTable.innerHTML = "";
      elements.mapTendenciesTable.innerHTML = "";
      elements.ratingSummaryTable.innerHTML = "";
      elements.improvementInsights.innerHTML = "";
      elements.playerMeta.innerHTML = "";
      currentPayload = null;
      currentReport = null;
      setReportVisible(false);
      gameHistoryState.allGames = [];
      gameHistoryState.filteredGames = [];
      gameHistoryState.filterLabel = "";
      updateShowMoreButton();
      updateHistoryFilterUi();
      updateShowMoreRelationshipButton("opponents", 0);
      updateShowMoreRelationshipButton("teammates", 0);
      updateShowMoreMapsButton(0);
      return;
    }
      const cacheMessage = payload.providerMeta?.cacheStatus ? ` (${payload.providerMeta.cacheStatus})` : "";
      setMessage(`Loaded ${payload.player.login} with ${payload.report.overview.totalGames} ${queue === "all" ? "games" : `${displayModeName(queue)} games`} analyzed (${formatGameLimitLabel(gameLimit)})${cacheMessage}.`, "good");
      resetDiscoveryLists(payload.report, { clearSearch: true });
      renderReport(payload);
  } finally {
    stopLoadPolling();
    setLoadingState(false, "Fetching FAF history...", 0);
  }
}

async function updateReportQueue(queue) {
  if (!currentPayload) {
    return;
  }

  const player = currentPayload.player?.login || lastRequest?.player || elements.playerInput.value.trim();
  const previousQueue = getCurrentReportQueue();
  const previousGameLimit = getCurrentReportGameLimit();
  const gameLimit = getSelectedGameLimit();
  setMessage(`Switching ${player} to ${displayModeName(queue)}...`, "muted");

  try {
    const response = await fetch(`/api/report/current?queue=${encodeURIComponent(queue)}&gameLimit=${encodeURIComponent(gameLimit)}`);
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Unable to switch queue.", "bad");
      return;
    }
    lastRequest = { player, queue, gameLimit };
    const cacheMessage = payload.providerMeta?.cacheStatus ? ` (${payload.providerMeta.cacheStatus})` : "";
    setMessage(`Updated ${payload.player.login} to ${queue === "all" ? "all games" : displayModeName(queue)} instantly${cacheMessage}.`, "good");
    resetDiscoveryLists(payload.report);
    renderReport(payload);
    const queueChanged = String(previousQueue || "all") !== String(queue || "all");
    const gameLimitChanged = String(previousGameLimit || "all") !== String(gameLimit || "all");
    const toastTitle = gameLimitChanged && queueChanged
      ? "Report filters updated"
      : (gameLimitChanged ? "Game count changed" : "Queue changed");
    const toastText = gameLimitChanged && queueChanged
      ? `${payload.player.login} is now showing ${queue === "all" ? "all queues" : displayModeName(queue)} from ${formatGameLimitLabel(gameLimit)}.`
      : (gameLimitChanged
        ? `${payload.player.login} is now analyzing ${formatGameLimitLabel(gameLimit)}.`
        : `${payload.player.login} is now showing ${queue === "all" ? "all queues" : displayModeName(queue)}.`);
    showUpdateToast(toastTitle, toastText);
  } catch (error) {
    setMessage(`Unable to switch queue: ${error.message}`, "bad");
  }
}

elements.loadButton.addEventListener("click", loadReport);
elements.updateToastClose?.addEventListener("click", hideUpdateToast);
elements.queueFilterSelect.addEventListener("change", () => {
  const queue = elements.queueFilterSelect.value;
  elements.queueFilterSelect.blur();
  if (currentPayload) {
    updateReportQueue(queue);
  }
});
elements.gameLimitSelect.addEventListener("change", () => {
  syncCustomGameLimitVisibility();
  elements.gameLimitSelect.blur();
  if (currentPayload && elements.gameLimitSelect.value !== "custom") {
    updateReportQueue(elements.queueFilterSelect.value);
  }
});
elements.customGameLimitInput.addEventListener("change", () => {
  if (currentPayload && elements.gameLimitSelect.value === "custom") {
    updateReportQueue(elements.queueFilterSelect.value);
  }
});
elements.saveAuthConfigButton?.addEventListener("click", saveAuthConfig);
elements.importRefreshTokenButton?.addEventListener("click", () => importToken("refresh"));
elements.importAccessTokenButton.addEventListener("click", () => importToken("access"));
elements.logoutButton.addEventListener("click", logout);
elements.collapseFiltersButton.addEventListener("click", () => {
  if (!filtersStuck) {
    return;
  }
  filtersCollapsed = true;
  syncFilterToolbarVisibility();
});
elements.showFiltersButton.addEventListener("click", () => {
  filtersCollapsed = false;
  syncFilterToolbarVisibility();
});
elements.hideSmallOpponentsButton.addEventListener("click", () => {
  relationshipState.opponents.minGames = relationshipState.opponents.minGames >= 20 ? 0 : 20;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.hideSmallTeammatesButton.addEventListener("click", () => {
  relationshipState.teammates.minGames = relationshipState.teammates.minGames >= 20 ? 0 : 20;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.scrollTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
window.addEventListener("scroll", syncScrollUi, { passive: true });
elements.showMoreGamesButton.addEventListener("click", () => {
  gameHistoryState.visibleCount = Math.min(gameHistoryState.visibleCount + gameHistoryState.step, gameHistoryState.filteredGames.length);
  renderGameHistory();
});
elements.clearHistoryFilterButton.addEventListener("click", clearHistoryFilter);
elements.showMoreMapsButton.addEventListener("click", () => {
  mapTendencyState.visibleCount = Math.min(mapTendencyState.visibleCount + mapTendencyState.step, currentReport?.mapTendencies?.length || 0);
  if (currentReport) {
    renderMapTendencies(currentReport);
  }
});
elements.hideMapsButton.addEventListener("click", () => {
  mapTendencyState.visibleCount = 8;
  if (currentReport) {
    renderMapTendencies(currentReport);
  }
});
elements.showMoreOpponentsButton.addEventListener("click", () => {
  relationshipState.opponents.visibleCount += relationshipState.opponents.step;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.hideOpponentsButton.addEventListener("click", () => {
  relationshipState.opponents.visibleCount = 8;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.showMoreTeammatesButton.addEventListener("click", () => {
  relationshipState.teammates.visibleCount += relationshipState.teammates.step;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.hideTeammatesButton.addEventListener("click", () => {
  relationshipState.teammates.visibleCount = 8;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.opponentSearchInput.addEventListener("input", () => {
  relationshipState.opponents.query = elements.opponentSearchInput.value;
  relationshipState.opponents.visibleCount = 8;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.teammateSearchInput.addEventListener("input", () => {
  relationshipState.teammates.query = elements.teammateSearchInput.value;
  relationshipState.teammates.visibleCount = 8;
  if (currentReport) {
    renderRelationshipTables(currentReport);
  }
});
elements.mapSearchInput.addEventListener("input", () => {
  mapTendencyState.query = elements.mapSearchInput.value;
  mapTendencyState.visibleCount = 8;
  if (currentReport) {
    renderMapTendencies(currentReport);
  }
});

document.addEventListener("click", (event) => {
  const chartToggle = event.target.closest("[data-chart-id][data-chart-series]");
  if (chartToggle) {
    const seriesKey = chartToggle.dataset.chartSeries;
    const visible = chartVisibilityState.shared;
    if (visible && seriesKey) {
      if (visible.has(seriesKey)) {
        visible.delete(seriesKey);
      } else {
        visible.add(seriesKey);
      }
      if (currentPayload) {
        renderReport(currentPayload);
        showUpdateToast("Graph filters applied", "Charts, teammates, and opponents now use the selected period and game modes.");
      }
    }
    return;
  }

  if (event.target.closest("#resetGraphFiltersButton")) {
    chartPeriodState.shared = { preset: "all", from: "", to: "" };
    if (currentPayload) {
      renderReport(currentPayload);
      showUpdateToast("Period reset", "Charts, teammates, and opponents are back to the full report period.");
    }
    return;
  }

  const monthFilterButton = event.target.closest("[data-month-filter]");
  if (monthFilterButton) {
    filterHistoryByMonth(monthFilterButton.dataset.monthFilter || "");
    return;
  }

  const streakFilterButton = event.target.closest("[data-streak-filter]");
  if (streakFilterButton) {
    filterHistoryByGameIds(streakFilterButton.dataset.streakFilter || "", streakFilterButton.dataset.streakLabel || "streak");
    return;
  }

  const insightToggleButton = event.target.closest("[data-insight-toggle]");
  if (insightToggleButton) {
    const listId = insightToggleButton.dataset.insightToggle;
    if (Object.prototype.hasOwnProperty.call(insightExpandedState, listId)) {
      insightExpandedState[listId] = !insightExpandedState[listId];
      if (currentReport) {
        renderImprovement(currentReport);
      }
    }
    return;
  }

  const target = event.target.closest(".th-button");
  if (!target || !currentReport) {
    return;
  }
  const tableId = target.dataset.tableId;
  const sortKey = target.dataset.sortKey;
  if (!tableId || !sortKey || !tableSortState[tableId]) {
    return;
  }
  const state = tableSortState[tableId];
  if (state.key === sortKey) {
    state.direction = state.direction === "asc" ? "desc" : "asc";
  } else {
    state.key = sortKey;
    state.direction = sortKey === "name" ? "asc" : "desc";
  }
  if (tableId === "maps") {
    renderMapTendencies(currentReport);
  } else {
    renderRelationshipTables(currentReport);
  }
});

document.addEventListener("change", (event) => {
  const presetSelect = event.target.closest("[data-chart-period-preset]");
  if (presetSelect) {
    if (chartPeriodState.shared) {
      chartPeriodState.shared.preset = presetSelect.value;
      if (currentPayload) {
        renderReport(currentPayload);
        showUpdateToast("Period applied", "Charts, teammates, and opponents now use the selected period.");
      }
    }
    return;
  }

  const fromInput = event.target.closest("[data-chart-period-from]");
  if (fromInput) {
    if (chartPeriodState.shared) {
      chartPeriodState.shared.preset = "custom";
      chartPeriodState.shared.from = fromInput.value;
      if (currentPayload) {
        renderReport(currentPayload);
        showUpdateToast("Period applied", "Charts, teammates, and opponents now use the selected period.");
      }
    }
    return;
  }

  const toInput = event.target.closest("[data-chart-period-to]");
  if (toInput) {
    if (chartPeriodState.shared) {
      chartPeriodState.shared.preset = "custom";
      chartPeriodState.shared.to = toInput.value;
      if (currentPayload) {
        renderReport(currentPayload);
        showUpdateToast("Period applied", "Charts, teammates, and opponents now use the selected period.");
      }
    }
  }
});

document.addEventListener("mouseover", (event) => {
  const target = event.target.closest(".chart-point");
  if (target) {
    updateChartHover(target);
  }
});

document.addEventListener("focusin", (event) => {
  const target = event.target.closest(".chart-point");
  if (target) {
    updateChartHover(target);
  }
});

elements.showMoreGamesButton.hidden = true;
elements.showMoreGamesButton.disabled = true;
elements.hideOpponentsButton.hidden = true;
elements.showMoreOpponentsButton.hidden = true;
elements.showMoreOpponentsButton.disabled = true;
elements.hideTeammatesButton.hidden = true;
elements.showMoreTeammatesButton.hidden = true;
elements.showMoreTeammatesButton.disabled = true;
elements.hideMapsButton.hidden = true;
elements.showMoreMapsButton.hidden = true;
elements.showMoreMapsButton.disabled = true;
syncCustomGameLimitVisibility();
syncFilterToolbarVisibility();
syncScrollTopButton();

const authFlag = new URLSearchParams(window.location.search).get("auth");
if (authFlag === "success") {
  setMessage("FAF login complete. You can load reports from the official API now.", "good");
  window.history.replaceState({}, "", window.location.pathname);
} else if (authFlag === "error") {
  setMessage("FAF login did not complete successfully.", "bad");
  window.history.replaceState({}, "", window.location.pathname);
}

refreshStatus().catch(() => {
  setMessage("Unable to read provider status.", "bad");
});

setLoadingState(false);

