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
  CORS_ORIGIN,
  JOBS_API_BASE,
  JOBS_API_SECRET,
  JOB_PAYOUT_GBP = 70
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

// GitHub helpers with sha support
async function ghGetJson(path) {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER, repo: REPO_NAME, path, ref: BRANCH
  });
  const content = Buffer.from(data.content, data.encoding).toString("utf8");
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutJson(path, json, prevSha, message) {
  const body = JSON.stringify(json, null, 2) + "\n";
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER, repo: REPO_NAME, path, branch: BRANCH,
    message, content: Buffer.from(body, "utf8").toString("base64"), sha: prevSha
  });
}

// Audit logger
async function audit({actor, action, target, beforeSha, afterSha, details}) {
  try {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      actor,
      action,
      target,
      beforeSha,
      afterSha,
      details
    };
    
    let auditLog = [];
    try {
      const { json } = await ghGetJson("log/audit.jsonl");
      auditLog = Array.isArray(json) ? json : [];
    } catch (e) {
      if (e.status !== 404) throw e;
      // File doesn't exist, start with empty array
    }
    
    auditLog.push(auditEntry);
    
    try {
      const { sha } = await ghGetJson("log/audit.jsonl");
      await ghPutJson("log/audit.jsonl", auditLog, sha, `audit: ${action} by ${actor} (${new Date().toISOString()})`);
    } catch (e) {
      if (e.status === 404) {
        await ghPutJson("log/audit.jsonl", auditLog, undefined, `audit: ${action} by ${actor} (${new Date().toISOString()})`);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error("Audit logging failed:", e);
    // Don't fail the main operation if audit logging fails
  }
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

// Derive pages from role
function pagesFromRole(role) {
  return role === 'master' ? ['*'] : ['centres'];
}
function roleFromPages(pages) {
  return (Array.isArray(pages) && pages.includes('*')) ? 'master' : 'booker';
}

// Update resolveAdmin to read from file
async function resolveAdminAsync(token) {
  if (!token) return null;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { name: "Admin", pages: ["*"] };
  const map = await loadAdminMap();
  const entry = map[token];
  if (!entry) return null;
  const name = typeof entry === "string" ? entry : (entry.name || "Admin");
  let pages = (entry && Array.isArray(entry.pages)) ? entry.pages : undefined;
  const role = (entry && typeof entry.role === "string") ? entry.role : undefined;
  if (!pages) pages = pagesFromRole(role || 'booker');
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
  const role = roleFromPages(pages);
  res.json({ name, pages, role });
});

// NEW: Admin Codes endpoints
app.get("/api/admin-codes", auth, requirePage("admins"), async (_req, res) => {
  try {
    const map = await loadAdminMap();
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      const name = v?.name || 'Admin';
      const pages = Array.isArray(v?.pages) ? v.pages : pagesFromRole(v?.role || 'booker');
      const role = typeof v?.role === 'string' ? v.role : roleFromPages(pages);
      out[k] = { name, pages, role };
    }
    res.json({ codes: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load admin codes" });
  }
});

app.put("/api/admin-codes", auth, requirePage("admins"), async (req, res) => {
  try {
    const { mode = "append", code, name, role, pages } = req.body || {};
    if (mode === "append") {
      if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "code required" });
      if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name required" });

      const safeCode = code.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(safeCode)) return res.status(400).json({ error: "invalid code format" });

      let roleNorm = (typeof role === 'string' ? role.trim().toLowerCase() : '');
      if (roleNorm && !['master','booker'].includes(roleNorm)) {
        return res.status(400).json({ error: "invalid role" });
      }
      if (!roleNorm) roleNorm = 'booker';

      let pagesArr = Array.isArray(pages) ? pages.map(p => String(p).trim()).filter(Boolean) : [];
      if (!pagesArr.length) pagesArr = pagesFromRole(roleNorm);

      const map = await loadAdminMap();
      if (map[safeCode]) return res.status(400).json({ error: "code already exists" });

      map[safeCode] = { name: name.trim(), pages: pagesArr, role: roleNorm };
      await saveAdminMap(map);
      
      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: "admins.append",
        target: "admin_tokens.json",
        beforeSha: null,
        afterSha: null,
        details: { code: safeCode, name: name.trim(), role: roleNorm }
      });
      
      return res.json({ ok: true });
    }
    if (mode === "delete") {
      const { code } = req.body || {};
      if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "code required" });
      const safe = code.trim();
      const map = await loadAdminMap();
      if (!map[safe]) return res.status(404).json({ error: "code not found" });
      
      const deletedEntry = map[safe];
      delete map[safe];
      await saveAdminMap(map);
      
      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: "admins.delete",
        target: "admin_tokens.json",
        beforeSha: null,
        afterSha: null,
        details: { code: safe, deletedEntry }
      });
      
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "unsupported mode" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update admin codes" });
  }
});

// Jobs API helpers
function requireJobsEnv(res) {
  const { JOBS_API_BASE, JOBS_API_SECRET } = process.env;
  if (!JOBS_API_BASE || !JOBS_API_SECRET) {
    res.status(500).json({
      error: 'Jobs API not configured',
      missing: {
        JOBS_API_BASE: !process.env.JOBS_API_BASE,
        JOBS_API_SECRET: !process.env.JOBS_API_SECRET
      },
      how_to_set: 'In Render -> admin-api -> Environment, add JOBS_API_BASE (Apps Script Web App URL) and JOBS_API_SECRET (same as Templates!secret).'
    });
    return null;
  }
  return { JOBS_API_BASE, JOBS_API_SECRET };
}

async function jobsGet(params={}) {
  const { JOBS_API_BASE, JOBS_API_SECRET } = process.env;
  const url = new URL(JOBS_API_BASE + '/jobs');
  url.searchParams.set('secret', JOBS_API_SECRET);
  for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString(), { method: 'GET' });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error('Jobs GET failed');
  return j;
}

async function jobsPost(payload) {
  const { JOBS_API_BASE, JOBS_API_SECRET } = process.env;
  const r = await fetch(JOBS_API_BASE, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ secret: JOBS_API_SECRET, ...payload })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error('Jobs POST failed: '+JSON.stringify(j));
  return j;
}

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
  try { 
    const { json, sha } = await getFile(); 
    // Filter out deleted centres for normal view
    const activeCentres = json.filter(c => !c.deleted);
    res.json({ centres: activeCentres, sha }); 
  }
  catch (e) { console.error(e); res.status(500).json({ error: "Failed to read centres" }); }
});

// NEW: Recycle bin endpoint
app.get("/api/test-centres-bin", auth, requirePage("admins"), async (_req, res) => {
  try { 
    const { json, sha } = await getFile(); 
    // Only show deleted centres
    const deletedCentres = json.filter(c => c.deleted);
    res.json({ centres: deletedCentres, sha }); 
  }
  catch (e) { console.error(e); res.status(500).json({ error: "Failed to read deleted centres" }); }
});

app.put("/api/test-centres", auth, async (req, res) => {
  try {
    const mode = req.body?.mode || "append";
    
    // Concurrency check
    if (req.body?.sha) {
      const { sha: currentSha } = await getFile();
      if (req.body.sha !== currentSha) {
        return res.status(409).json({ error: "conflict" });
      }
    }
    
    if (mode === "delete") {
      // require master
      if (!req.adminInfo?.pages?.includes("*") && !req.adminInfo?.pages?.includes("admins")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.some(x => typeof x !== "string" || !x.trim())) {
        return res.status(400).json({ error: "ids[] required" });
      }
      
      const { json: existing, sha: beforeSha } = await getFile();
      const remove = new Set(ids.map(s => s.trim()));
      const next = existing.map(c => remove.has(c.id) ? { ...c, deleted: true } : c);
      
      // Dependency check: remove from all bookers' coverage
      const adminMap = await loadAdminMap();
      let removedFromBookers = 0;
      for (const [token, entry] of Object.entries(adminMap)) {
        if (entry.centres && Array.isArray(entry.centres)) {
          const originalLength = entry.centres.length;
          entry.centres = entry.centres.filter(id => !remove.has(id));
          removedFromBookers += originalLength - entry.centres.length;
        }
      }
      
      await putFile(next);
      await saveAdminMap(adminMap);
      
      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: "centres.soft_delete",
        target: "test_centres.json",
        beforeSha,
        afterSha: null,
        details: { ids: Array.from(remove), removedFromBookers }
      });
      
      return res.json({ ok: true, count: next.filter(c => !c.deleted).length, removed: ids.length });
    }
    
    if (mode === "restore") {
      // require master
      if (!req.adminInfo?.pages?.includes("*") && !req.adminInfo?.pages?.includes("admins")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.some(x => typeof x !== "string" || !x.trim())) {
        return res.status(400).json({ error: "ids[] required" });
      }
      
      const { json: existing, sha: beforeSha } = await getFile();
      const restore = new Set(ids.map(s => s.trim()));
      const next = existing.map(c => restore.has(c.id) ? { ...c, deleted: false } : c);
      
      await putFile(next);
      
      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: "centres.restore",
        target: "test_centres.json",
        beforeSha,
        afterSha: null,
        details: { ids: Array.from(restore) }
      });
      
      return res.json({ ok: true, count: next.filter(c => !c.deleted).length, restored: ids.length });
    }
    
    if (mode !== "append") return res.status(400).json({ error: "Only append mode allowed" });
    const centres = req.body?.centres;
    if (!Array.isArray(centres) || !centres.length) return res.status(400).json({ error: "centres[] required" });
    const items = centres.map(c => ({ 
      id: String(c.id||"").trim(), 
      name: String(c.name||"").trim(),
      deleted: false 
    }));
    if (items.some(c => !c.id || !c.name)) return res.status(400).json({ error: "Each centre needs id and name" });
    
    const { json: existing, sha: beforeSha } = await getFile();
    const ids = new Set(existing.map(c => c.id));
    for (const c of items) { if (ids.has(c.id)) return res.status(400).json({ error: `Duplicate id: ${c.id}` }); ids.add(c.id); }
    
    await putFile(existing.concat(items));
    
    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: "centres.append",
      target: "test_centres.json",
      beforeSha,
      afterSha: null,
      details: { centres: items }
    });
    
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to append centres" }); }
});

// NEW: My coverage endpoints
app.get("/api/my-centres", auth, async (req, res) => {
  try {
    const map = await loadAdminMap();
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const entry = map[token] || {};
    const centres = Array.isArray(entry.centres) ? entry.centres : [];
    res.json({ centres });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load coverage" });
  }
});

app.put("/api/my-centres", auth, async (req, res) => {
  try {
    const list = req.body?.centres;
    if (!Array.isArray(list) || list.some(x => typeof x !== "string" || !x.trim())) {
      return res.status(400).json({ error: "centres must be array of ids" });
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const map = await loadAdminMap();
    if (!map[token]) {
      // create minimal entry if missing (rare)
      map[token] = { name: req.adminInfo?.name || "Admin", role: req.adminInfo?.role || "booker", pages: req.adminInfo?.pages || ["centres"] };
    }
    const beforeCentres = Array.isArray(map[token].centres) ? map[token].centres : [];
    map[token].centres = Array.from(new Set(list.map(s => s.trim())));
    await saveAdminMap(map);
    
    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: "coverage.set",
      target: "admin_tokens.json",
      beforeSha: null,
      afterSha: null,
      details: { beforeCentres, afterCentres: map[token].centres }
    });
    
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save coverage" });
  }
});

// NEW: Profile endpoints
app.get("/api/my-profile", auth, async (req, res) => {
  try {
    const map = await loadAdminMap();
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const entry = map[token] || {};
    res.json({ 
      notes: entry.notes || "",
      maxDaily: typeof entry.maxDaily === 'number' ? entry.maxDaily : 0,
      available: typeof entry.available === 'boolean' ? entry.available : true
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

app.put("/api/my-profile", auth, async (req, res) => {
  try {
    const { notes, maxDaily, available } = req.body || {};
    
    // Validation
    if (notes !== undefined && typeof notes !== "string") {
      return res.status(400).json({ error: "notes must be string" });
    }
    if (maxDaily !== undefined) {
      const maxDailyNum = parseInt(maxDaily);
      if (isNaN(maxDailyNum) || maxDailyNum < 0) {
        return res.status(400).json({ error: "maxDaily must be integer >= 0" });
      }
    }
    if (available !== undefined && typeof available !== "boolean") {
      return res.status(400).json({ error: "available must be boolean" });
    }
    
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const map = await loadAdminMap();
    if (!map[token]) {
      map[token] = { name: req.adminInfo?.name || "Admin", role: req.adminInfo?.role || "booker", pages: req.adminInfo?.pages || ["centres"] };
    }
    
    const beforeProfile = {
      notes: map[token].notes || "",
      maxDaily: typeof map[token].maxDaily === 'number' ? map[token].maxDaily : 0,
      available: typeof map[token].available === 'boolean' ? map[token].available : true
    };
    
    if (notes !== undefined) map[token].notes = notes;
    if (maxDaily !== undefined) map[token].maxDaily = parseInt(maxDaily);
    if (available !== undefined) map[token].available = available;
    
    await saveAdminMap(map);
    
    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: "profile.update",
      target: "admin_tokens.json",
      beforeSha: null,
      afterSha: null,
      details: { beforeProfile, afterProfile: { notes: map[token].notes, maxDaily: map[token].maxDaily, available: map[token].available } }
    });
    
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

// ---- Jobs board (open jobs filtered by booker coverage) ----
app.get('/api/jobs/board', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    // If you store booker coverage in data/admin_tokens.json, you may already have req.adminInfo + token
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    // We can fetch all open jobs; coverage filtering can be done either here OR already filtered client-side.
    const data = await jobsGet({ status:'open' });
    // Optional: filter by coverage (if known)
    // For now return as-is; UI can filter by centre if needed.
    res.json({ jobs: Array.isArray(data.jobs)? data.jobs : [] });
  } catch(e) { console.error(e); res.status(502).json({ error:'Failed to load jobs' }); }
});

// ---- My jobs (assigned_to = token) ----
app.get('/api/jobs/mine', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    const data = await jobsGet({ assigned_to: token });
    const payout = Number(process.env.JOB_PAYOUT_GBP || 70);
    const completed = (data.jobs||[]).filter(j=>String(j.status).toLowerCase()==='completed').length;
    res.json({ jobs: Array.isArray(data.jobs)? data.jobs : [], payout_per_job: payout, total_due: completed * payout });
  } catch(e) { console.error(e); res.status(502).json({ error:'Failed to load my jobs' }); }
});

// ---- Claim / Release / Complete ----
app.post('/api/jobs/claim', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error:'job_id required' });
    const data = await jobsPost({ action:'claim', booking_id: job_id, token });
    res.json(data);
  } catch(e){ console.error(e); res.status(502).json({ error:'claim failed' }); }
});
app.post('/api/jobs/release', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error:'job_id required' });
    const data = await jobsPost({ action:'release', booking_id: job_id, token });
    res.json(data);
  } catch(e){ console.error(e); res.status(502).json({ error:'release failed' }); }
});
app.post('/api/jobs/complete', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error:'job_id required' });
    const data = await jobsPost({ action:'complete', booking_id: job_id, token });
    res.json(data);
  } catch(e){ console.error(e); res.status(502).json({ error:'complete failed' }); }
});

// ---- Optional admin-only: create/delete job entries ----
app.post('/api/jobs/create', auth, requirePage('admins'), async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const { job } = req.body || {};
    if (!job || !job.centre_id || !job.centre_name) return res.status(400).json({ error:'centre_id and centre_name required' });
    const data = await jobsPost({ action:'create_booking', booking: {
      'Booking ID': job.id, 'Matched Centre': job.centre_id, 'Student Name': job.candidate || '', 'Notes': job.notes || '', 'Tier': job.tier || '', 'Partner ID': job.partner_id || ''
    }});
    res.json({ ok:true, job_id: data.booking_id });
  } catch(e){ console.error(e); res.status(502).json({ error:'create failed' }); }
});
app.post('/api/jobs/delete', auth, requirePage('admins'), async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error:'job_id required' });
    const actor = (req.adminInfo?.name || 'admin');
    const data = await jobsPost({ action:'delete_soft', booking_id: job_id, actor });
    res.json(data);
  } catch(e){ console.error(e); res.status(502).json({ error:'delete failed' }); }
});

// ---- Stats (lifetime completed for current token) ----
app.get('/api/jobs/stats', auth, async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return res.json({ completed_all_time: 0 });
  try{
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
    const data = await jobsGet({ status:'completed', assigned_to: token });
    res.json({ completed_all_time: Array.isArray(data.jobs)? data.jobs.length : 0 });
  } catch(e){ console.error(e); res.json({ completed_all_time: 0 }); }
});

// ---- Public intake for the static booking form ----
app.post('/api/public/booking-request', async (req, res) => {
  const env = requireJobsEnv(res); if (!env) return;
  try {
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress || '';
    const booking = req.body || {};
    const required = ['Student Name','Phone'];
    const missing = required.filter(k => !String(booking[k] || '').trim());
    if (missing.length) return res.status(400).json({ error:'Missing fields', missing });
    const data = await jobsPost({ action:'create_booking', booking, ip });
    if (!data.ok) return res.status(502).json({ error:'Failed to create booking', detail:data });
    res.json({ ok:true, booking_id: data.booking_id });
  } catch(e){ console.error(e); res.status(500).json({ error:'Server error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[admin-api] listening on ${PORT}`));
