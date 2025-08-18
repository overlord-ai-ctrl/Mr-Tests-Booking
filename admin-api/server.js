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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : {}));
app.use(express.json({ limit: "256kb" }));

// Static UI
app.use("/admin", express.static(publicDir));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));
app.get("/", (_req, res) => res.redirect("/admin"));

// Admin mapping
let ADMIN_MAP = {};
try { if (ADMIN_TOKENS_JSON) ADMIN_MAP = JSON.parse(ADMIN_TOKENS_JSON); } catch (e) { console.warn("[admin-api] Bad ADMIN_TOKENS_JSON:", e.message); }

function resolveAdmin(token) {
  if (!token) return null;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { name: "Admin", pages: ["*"] };
  const entry = ADMIN_MAP[token];
  if (!entry) return null;
  const name = typeof entry === "string" ? entry : (entry.name || "Admin");
  const pages = (entry && Array.isArray(entry.pages)) ? entry.pages : ["*"];
  return { name, pages };
}

function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const info = resolveAdmin(token);
  if (!info) return res.status(401).json({ error: "Unauthorized" });
  req.adminInfo = { ...info, token };
  next();
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Who am I
app.get("/api/me", auth, (req, res) => {
  const { name, pages } = req.adminInfo;
  res.json({ name, pages });
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
