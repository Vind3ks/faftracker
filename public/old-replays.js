(() => {
  const searchEl = document.getElementById("oldReplaySearch");
  const tableEl = document.getElementById("oldReplayTable");
  const countEl = document.getElementById("oldReplayCount");
  const moreEl = document.getElementById("oldReplayMore");
  const messageEl = document.getElementById("oldReplayMessage");
  if (!tableEl) return;

  const LIMIT = 50;
  let offset = 0;
  let total = 0;
  let search = "";
  let loading = false;
  let items = [];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function fmtSize(b) {
    if (!b) return "&mdash;";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }
  function fmtDate(ms) {
    if (!ms) return "&mdash;";
    return new Date(ms).toISOString().slice(0, 10);
  }
  function setMessage(text, tone) {
    if (!messageEl) return;
    if (!text) { messageEl.hidden = true; messageEl.textContent = ""; return; }
    messageEl.hidden = false;
    messageEl.textContent = text;
    messageEl.className = `replay-message ${tone || "muted"}`;
  }

  function render() {
    if (items.length === 0) {
      tableEl.innerHTML = `<p class="empty">${search ? "No replays match that search." : "No replays found in the archive."}</p>`;
    } else {
      const rows = items.map((it) => `
        <tr>
          <td class="old-replay-name">${escapeHtml(it.name)}</td>
          <td class="num">${fmtSize(it.size)}</td>
          <td class="num">${fmtDate(it.mtime)}</td>
          <td class="old-replay-actions">
            <button class="secondary old-replay-analyze" type="button" data-path="${escapeHtml(it.name)}">Analyze</button>
            <a class="button-link" href="/api/old-replays/file?path=${encodeURIComponent(it.name)}" download>Download</a>
          </td>
        </tr>`).join("");
      tableEl.innerHTML = `<table class="data-table">
        <thead><tr><th>File</th><th>Size</th><th>Modified</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }
    countEl.textContent = total
      ? `${total.toLocaleString()} ${search ? "matches" : "replays"} · showing ${items.length}`
      : "";
    moreEl.hidden = items.length >= total;
  }

  async function load(reset) {
    if (loading) return;
    loading = true;
    moreEl.disabled = true;
    if (reset) { offset = 0; items = []; }
    try {
      const r = await fetch(`/api/old-replays?search=${encodeURIComponent(search)}&limit=${LIMIT}&offset=${offset}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not load the replay archive.");
      total = data.total || 0;
      items = items.concat(data.items || []);
      offset += (data.items || []).length;
      setMessage("");
      render();
    } catch (error) {
      setMessage(error.message, "bad");
      if (reset) { tableEl.innerHTML = ""; countEl.textContent = ""; moreEl.hidden = true; }
    } finally {
      loading = false;
      moreEl.disabled = false;
    }
  }

  async function analyze(relPath, button) {
    const viewer = window.fafReplayViewer;
    if (button) { button.disabled = true; button.textContent = "Analyzing…"; }
    if (viewer) { viewer.setLoading(true); viewer.setMessage(`Analyzing ${relPath}…`, "muted"); }
    try {
      const r = await fetch(`/api/old-replays/analyze?path=${encodeURIComponent(relPath)}`);
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || "Unable to analyze this replay.");
      if (viewer) viewer.render(payload);
      else setMessage("Replay viewer is unavailable on this page.", "bad");
    } catch (error) {
      if (viewer) viewer.setMessage(`Unable to analyze: ${error.message}`, "bad");
      else setMessage(`Unable to analyze: ${error.message}`, "bad");
    } finally {
      if (viewer) viewer.setLoading(false);
      if (button) { button.disabled = false; button.textContent = "Analyze"; }
    }
  }

  tableEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".old-replay-analyze");
    if (btn) analyze(btn.dataset.path, btn);
  });

  let t;
  searchEl.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { search = searchEl.value.trim(); load(true); }, 250);
  });
  moreEl.addEventListener("click", () => load(false));

  load(true);
})();
