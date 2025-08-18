// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { Octokit } from "@octokit/rest";

const {
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  BRANCH = "main",
  FILE_PATH = "data/test_centres.json",
  ADMIN_TOKEN,
  ADMIN_TOKENS_JSON,
  CORS_ORIGIN
} = process.env;

// Add a constant for tokens file path (can be overridden by env)
const TOKENS_FILE_PATH = process.env.ADMIN_TOKENS_FILE_PATH || "data/admin_tokens.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : {}));
app.use(express.json({ limit: "256kb" }));

// Static UI
app.use("/admin", express.static(publicDir));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));
app.get("/", (_req, res) => res.redirect("/admin"));

// GitHub helpers (existing getFile/putFile for centres remain)
async function ghGetJson(path) {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER, repo: REPO_NAME, path, ref: BRANCH
  });
  const content = Buffer.from(data.content, data.encoding).toString("utf8");
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutJson(path, json, sha, message) {
  const body = JSON.stringify(json, null, 2) + "\n";
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER, repo: REPO_NAME, path, branch: BRANCH,
    message, content: Buffer.from(body, "utf8").toString("base64"), sha
  });
}

async function loadAdminMap() {
  try {
    const { json } = await ghGetJson(TOKENS_FILE_PATH);
    return json || {};
  } catch (e) {
    // fall back to env JSON if file missing
    if (e.status === 404 && ADMIN_TOKENS_JSON) {
      try { return JSON.parse(ADMIN_TOKENS_JSON) || {}; } catch {}
    }
    return {};
  }
}

async function saveAdminMap(nextMap) {
  try {
    const { sha } = await ghGetJson(TOKENS_FILE_PATH);
    await ghPutJson(TOKENS_FILE_PATH, nextMap, sha, `feat: update admin codes via admin (${new Date().toISOString()})`);
  } catch (e) {
    if (e.status === 404) {
      await ghPutJson(TOKENS_FILE_PATH, nextMap, undefined, `feat: create admin codes file via admin (${new Date().toISOString()})`);
    } else {
      throw e;
    }
  }
}

// Update resolveAdmin to read from file
async function resolveAdminAsync(token) {
  if (!token) return null;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { name: "Admin", pages: ["*"] };
  const map = await loadAdminMap();
  const entry = map[token];
  if (!entry) return null;
  const name = typeof entry === "string" ? entry : (entry.name || "Admin");
  const pages = (entry && Array.isArray(entry.pages)) ? entry.pages : ["*"];
  return { name, pages };
}

// Wrap auth to support async
async function authAsync(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const info = await resolveAdminAsync(token);
    if (!info) return res.status(401).json({ error: "Unauthorized" });
    req.adminInfo = { ...info, token };
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Auth failed" });
  }
}
const auth = authAsync;

function requirePage(tag) {
  return (req, res, next) => {
    const pages = req.adminInfo?.pages || [];
    if (pages.includes("*") || pages.includes(tag)) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Who am I (keep, but uses async auth now)
app.get("/api/me", auth, (req, res) => {
  const { name, pages } = req.adminInfo;
  res.json({ name, pages });
});

// NEW: Admin Codes endpoints
app.get("/api/admin-codes", auth, requirePage("admins"), async (_req, res) => {
  try {
    const map = await loadAdminMap();
    res.json({ codes: map });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load admin codes" });
  }
});

app.put("/api/admin-codes", auth, requirePage("admins"), async (req, res) => {
  try {
    const { mode = "append", code, name, pages } = req.body || {};
    if (mode !== "append") return res.status(400).json({ error: "Only append mode allowed" });
    if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "code required" });
    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name required" });
    if (!Array.isArray(pages) || pages.some(p => typeof p !== "string" || !p.trim())) {
      return res.status(400).json({ error: "pages must be array of strings" });
    }
    const safeCode = code.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(safeCode)) return res.status(400).json({ error: "invalid code format" });

    const map = await loadAdminMap();
    if (map[safeCode]) return res.status(400).json({ error: "code already exists" });
    map[safeCode] = { name: name.trim(), pages: pages.map(p => p.trim()) };

    await saveAdminMap(map);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save admin code" });
  }
});

// GitHub helpers
const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;

async function getFile() {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER, repo: REPO_NAME, path: FILE_PATH, ref: BRANCH
  });
  const content = Buffer.from(data.content, data.encoding).toString("utf8");
  return { sha: data.sha, json: JSON.parse(content) };
}

async function putFile(newJson) {
  const body = JSON.stringify(newJson, null, 2) + "\n";
  const { sha } = await getFile();
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER, repo: REPO_NAME, path: FILE_PATH, branch: BRANCH,
    message: `chore: update test centres via admin (${new Date().toISOString()})`,
    content: Buffer.from(body, "utf8").toString("base64"),
    sha
  });
}

// API
app.get("/api/test-centres", auth, async (_req, res) => {
  try { const { json } = await getFile(); res.json({ centres: json }); }
  catch (e) { console.error(e); res.status(500).json({ error: "Failed to read centres" }); }
});

app.put("/api/test-centres", auth, async (req, res) => {
  try {
    const mode = req.body?.mode || "append";
    if (mode !== "append") return res.status(400).json({ error: "Only append mode allowed" });
    const centres = req.body?.centres;
    if (!Array.isArray(centres) || !centres.length) return res.status(400).json({ error: "centres[] required" });
    const items = centres.map(c => ({ id: String(c.id||"").trim(), name: String(c.name||"").trim() }));
    if (items.some(c => !c.id || !c.name)) return res.status(400).json({ error: "Each centre needs id and name" });
    const { json: existing } = await getFile();
    const ids = new Set(existing.map(c => c.id));
    for (const c of items) { if (ids.has(c.id)) return res.status(400).json({ error: `Duplicate id: ${c.id}` }); ids.add(c.id); }
    await putFile(existing.concat(items));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to append centres" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[admin-api] listening on ${PORT}`));
