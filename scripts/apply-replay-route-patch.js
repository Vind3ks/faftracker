const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");
let source = fs.readFileSync(serverPath, "utf8");

if (!source.includes('require("./src/replay-summary")')) {
  source = source.replace(
    'const { buildPlayerReport } = require("./src/analytics");\n',
    'const { buildPlayerReport } = require("./src/analytics");\nconst { fetchReplaySummary } = require("./src/replay-summary");\n'
  );
}

if (!source.includes("async function handleBotReplaySummary")) {
  const marker = "async function handleApi(req, res, url) {\n";
  const handler = `async function handleBotReplaySummary(req, res, url) {\n  if (!isAuthorizedBotRequest(req)) {\n    return sendJson(res, 401, { error: \"Unauthorized bot request.\" });\n  }\n\n  const replayId = decodeURIComponent(url.pathname.replace(\"/api/bot/replay/\", \"\")).trim();\n  if (!replayId) {\n    return sendJson(res, 400, { error: \"Replay id is required.\" });\n  }\n\n  try {\n    const sessionState = await ensureServerBotSessionState();\n    const payload = await fetchReplaySummary(sessionState, replayId);\n    return sendJson(res, 200, {\n      provider: \"official\",\n      ...payload\n    });\n  } catch (error) {\n    return sendJson(res, error.statusCode || 502, {\n      provider: \"official\",\n      error: error.message,\n      detail: error.detail || error.payload?.error_description || error.payload?.detail || null,\n      hint: error.hint || null\n    });\n  }\n}\n\n`;
  source = source.replace(marker, `${handler}${marker}`);
}

if (!source.includes('url.pathname.startsWith("/api/bot/replay/")')) {
  source = source.replace(
    'async function handleApi(req, res, url) {\n',
    'async function handleApi(req, res, url) {\n  if (req.method === "GET" && url.pathname.startsWith("/api/bot/replay/")) {\n    return handleBotReplaySummary(req, res, url);\n  }\n\n'
  );
}

fs.writeFileSync(serverPath, source);
console.log("Applied replay route patch to server.js");
