// server.js
// Load dotenv only in development or if explicitly requested
if (process.env.NODE_ENV !== 'production' || process.env.LOAD_DOTENV === 'true') {
  try {
    const { config } = await import('dotenv');
    config();
  } catch (e) {
    // dotenv not available, continue without it
    console.log('dotenv not available, using environment variables directly');
  }
}

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { Octokit } from '@octokit/rest';
import compression from 'compression';
import { z } from 'zod';

// Optional dependencies - load conditionally
let createError, morgan, winston, expressStatusMonitor;

try {
  const createErrorModule = await import('http-errors');
  createError = createErrorModule.default;
} catch (e) {
  console.log('http-errors not available, using fallback error handling');
}

try {
  const morganModule = await import('morgan');
  morgan = morganModule.default;
} catch (e) {
  console.log('morgan not available, skipping request logging');
}

try {
  const winstonModule = await import('winston');
  winston = winstonModule.default;
} catch (e) {
  console.log('winston not available, using console logging');
}

try {
  const statusMonitorModule = await import('express-status-monitor');
  expressStatusMonitor = statusMonitorModule.default;
} catch (e) {
  console.log('express-status-monitor not available, skipping status monitor');
}

// ESM-safe path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render disk configuration
const DATA_DIR = process.env.DATA_DIR || '/data';            // Render disk mount
const FALLBACK_DIR = path.resolve(process.cwd(), 'data');    // repo folder (old)
const TOKENS_PATH = path.join(DATA_DIR, 'admin_tokens.json');
const CENTRES_PATH = path.join(DATA_DIR, 'test_centres.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const CHANGELOG_PATH = path.join(LOG_DIR, 'changes.jsonl');

function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    console.warn('[ensureDirs] failed:', e?.message);
  }
}

// one-shot migration from old repo /data to disk /data
function migrateIfNeeded() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const candidates = [
      ['admin_tokens.json', TOKENS_PATH],
      ['test_centres.json', CENTRES_PATH]
    ];
    for (const [name, dest] of candidates) {
      const src = path.join(FALLBACK_DIR, name);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        console.log('[migrate] copied', name, '→', dest);
      }
    }
  } catch (e) {
    console.warn('[migrate] skipped:', e?.message);
  }
}

function readJson(p, fallback = {}) {
  try {
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, 'utf8') || '{}')
      : fallback;
  } catch (e) {
    console.error('readJson error', p, e?.message);
    return fallback;
  }
}

function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('writeJson error', p, e?.message);
    return false;
  }
}

// Initialize data directories and migrate if needed
ensureDirs();
migrateIfNeeded();
console.log('[data]', { DATA_DIR, TOKENS_PATH, CENTRES_PATH, LOG_DIR });

// Configure logger (Winston if available, otherwise console)
let logger;
if (winston) {
  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      }),
    ],
  });
} else {
  // Fallback to console logging
  logger = {
    info: (msg, meta) => console.log('INFO:', msg, meta ? JSON.stringify(meta) : ''),
    error: (msg, meta) => console.error('ERROR:', msg, meta ? JSON.stringify(meta) : ''),
    warn: (msg, meta) => console.warn('WARN:', msg, meta ? JSON.stringify(meta) : ''),
  };
}

function logError(err) {
  logger.error(err);
}

// Validation schemas
const claimSchema = z.object({
  job_id: z.string().min(3),
});

const releaseSchema = z.object({
  job_id: z.string().min(3),
});

const completeSchema = z.object({
  job_id: z.string().min(3),
});

const offerSchema = z.object({
  job_id: z.string().min(3),
  centre: z.string().min(2),
  date: z.string().min(8),
  time: z.string().min(4),
  note: z.string().optional(),
});

const assignSchema = z.object({
  job_id: z.string().min(3),
  to_token: z.string().min(3),
});

const extendSchema = z.object({
  job_id: z.string().min(3),
  minutes: z.number().int().positive().max(240),
});

const replySchema = z.object({
  job_id: z.string().min(3),
  reply: z.enum(['YES', 'NO']),
});

const {
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  BRANCH = 'main',
  FILE_PATH = 'data/test_centres.json',
  ADMIN_TOKEN,
  ADMIN_TOKENS_JSON,
  CORS_ORIGIN,
  JOBS_API_BASE,
  JOBS_API_SECRET,
  JOB_PAYOUT_GBP = 70,
} = process.env;

// Add a constant for tokens file path (can be overridden by env)
const TOKENS_FILE_PATH = process.env.ADMIN_TOKENS_FILE_PATH || 'data/admin_tokens.json';

const publicDir = path.join(__dirname, 'public');

// Jobs caching system
const JobCache = (() => {
  const map = new Map();
  const ttlMs = Number(process.env.JOBS_CACHE_TTL_MS || 15000);
  function key(parts) {
    return JSON.stringify(parts);
  }
  return {
    async getOrSet(parts, fn) {
      const k = key(parts);
      const hit = map.get(k);
      const now = Date.now();
      if (hit && now - hit.t < ttlMs) return hit.v;
      const v = await fn();
      map.set(k, { v, t: now });
      return v;
    },
    bust(prefixParts = null) {
      if (!prefixParts) {
        map.clear();
        return;
      }
      const pfx = key(prefixParts).slice(0, -1); // cheap-ish
      for (const k of map.keys()) if (k.startsWith(pfx)) map.delete(k);
    },
  };
})();

// Helper to read ?limit & ?offset safely
function parsePage(req) {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  return { limit, offset };
}

// Helper to normalize centre IDs
function normCentreId(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Token management helpers - using safe IO functions
function readTokens() {
  return readJson(TOKENS_PATH, {});
}

function writeTokens(obj) {
  return writeJson(TOKENS_PATH, obj);
}

// Change log helper for persistent logging
function appendChangeLog(lineObj) {
  try {
    fs.appendFileSync(CHANGELOG_PATH, JSON.stringify(lineObj) + '\n', 'utf8');
  } catch (e) {
    console.warn('[appendChangeLog] failed:', e?.message);
  }
}

// Helper to check if a token is master
function isMaster(token) {
  try {
    const tokens = readTokens();
    return tokens[token]?.role === 'master';
  } catch {
    return false;
  }
}

// Enhanced master check for requests with fallback
function isMasterReq(req) {
  // prefer token role from file; fallback to hardcoded 1212
  const token = String(req.adminToken || '').trim();
  const tokens = readTokens(); // safely returns {}
  const role = tokens?.[token]?.role || '';
  if (role === 'master') return true;
  if (token === '1212') return true; // safety fallback
  return !!req.adminInfo?.isMaster;
}

// Helper to list all bookers
function listBookers() {
  try {
    const tokens = readTokens();
    return Object.entries(tokens)
      .filter(([token, info]) => info?.role !== 'master')
      .map(([token, info]) => ({
        token,
        name: info?.name || 'Admin',
        coverage: Array.isArray(info?.coverage) ? info.coverage.map(normCentreId) : [],
        availability: typeof info?.availability === 'boolean' ? info.availability : true,
        role: info?.role || 'booker',
      }));
  } catch {
    return [];
  }
}

// Helper to get coverage for a token
async function getCoverageForToken(token) {
  try {
    // First try: data/admin_coverage/<token>.json
    try {
      const { json } = await ghGetJson(`data/admin_coverage/${token}.json`);
      if (json && Array.isArray(json.centres)) {
        return json.centres.map(normCentreId).filter(Boolean);
      }
    } catch (e) {
      if (e.status !== 404) console.warn('Coverage file read error:', e.message);
    }

    // Second try: data/admin_tokens.json with per-token coverage
    try {
      const { json } = await ghGetJson('data/admin_tokens.json');
      const tokenData = json[token];
      if (tokenData && Array.isArray(tokenData.coverage)) {
        return tokenData.coverage.map(normCentreId).filter(Boolean);
      }
      // Also check for 'centres' field (legacy support)
      if (tokenData && Array.isArray(tokenData.centres)) {
        return tokenData.centres.map(normCentreId).filter(Boolean);
      }
    } catch (e) {
      if (e.status !== 404) console.warn('Admin tokens read error:', e.message);
    }

    // Third try: local file system (for Render/production)
    try {
      const tokens = readTokens();
      const tokenData = tokens[token];
      if (tokenData && Array.isArray(tokenData.coverage)) {
        return tokenData.coverage.map(normCentreId).filter(Boolean);
      }
      // Also check for 'centres' field (legacy support)
      if (tokenData && Array.isArray(tokenData.centres)) {
        return tokenData.centres.map(normCentreId).filter(Boolean);
      }
    } catch (e) {
      console.warn('Local tokens read error:', e.message);
    }

    // Default: empty coverage
    console.warn(`No coverage found for token ${token}, defaulting to empty`);
    return [];
  } catch (e) {
    console.error('Coverage lookup failed:', e.message);
    return [];
  }
}

// Rate limiting system for job claims
const RateLimiter = (() => {
  const buckets = new Map();
  const WINDOW_MS = 10000; // 10 seconds
  const MAX_CLAIMS = 5; // 5 claims per window

  return {
    checkLimit(token) {
      const now = Date.now();
      const bucket = buckets.get(token) || {
        claims: 0,
        resetTime: now + WINDOW_MS,
      };

      // Reset bucket if window expired
      if (now > bucket.resetTime) {
        bucket.claims = 0;
        bucket.resetTime = now + WINDOW_MS;
      }

      // Check if limit exceeded
      if (bucket.claims >= MAX_CLAIMS) {
        const retryAfter = Math.ceil((bucket.resetTime - now) / 1000);
        buckets.set(token, bucket);
        return { allowed: false, retryAfter };
      }

      // Allow claim
      bucket.claims++;
      buckets.set(token, bucket);
      return { allowed: true };
    },
  };
})();

// Keep-alive system for Google Apps Script
const KeepAlive = (() => {
  let interval = null;

  return {
    start() {
      if (process.env.WARMUP_ENABLED === '1' && JOBS_API_BASE) {
        console.log('Starting keep-alive for Google Apps Script...');
        interval = setInterval(
          async () => {
            try {
              await fetch(JOBS_API_BASE, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  secret: JOBS_API_SECRET,
                  action: 'ping',
                }),
              });
              console.log('Keep-alive ping sent to Apps Script');
            } catch (e) {
              console.log('Keep-alive ping failed:', e.message);
            }
          },
          5 * 60 * 1000
        ); // 5 minutes
      }
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
})();

// Duplicate schemas removed - using the ones defined at the top

// Idempotency store
const IdemStore = (() => {
  const map = new Map();
  const TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Cleanup expired keys
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (now - entry.timestamp > TTL_MS) {
        map.delete(key);
      }
    }
  }, 60000); // Clean every minute

  return {
    check(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.timestamp > TTL_MS) {
        map.delete(key);
        return null;
      }
      return entry.response;
    },
    store(key, response) {
      map.set(key, { response, timestamp: Date.now() });
    },
  };
})();

// Enhanced rate limiter for all mutating actions
const ActionRateLimiter = (() => {
  const buckets = new Map();
  const WINDOW_MS = 30 * 1000; // 30 seconds
  const MAX_ACTIONS = 10; // 10 actions per window

  return {
    checkLimit(token) {
      const now = Date.now();
      const bucket = buckets.get(token) || {
        actions: 0,
        resetTime: now + WINDOW_MS,
      };

      // Reset bucket if window expired
      if (now > bucket.resetTime) {
        bucket.actions = 0;
        bucket.resetTime = now + WINDOW_MS;
      }

      // Check if limit exceeded
      if (bucket.actions >= MAX_ACTIONS) {
        const retryAfter = Math.ceil((bucket.resetTime - now) / 1000);
        buckets.set(token, bucket);
        return { allowed: false, retryAfter };
      }

      // Allow action
      bucket.actions++;
      buckets.set(token, bucket);
      return { allowed: true };
    },
  };
})();

// Unified error response helper
function sendError(res, status, error, code, hint) {
  const response = { error, code };
  if (hint) response.hint = hint;
  res.status(status).json(response);
}

// Global error handler
function handleError(err, req, res, next) {
  console.error(`Error ${req.method} ${req.path}:`, err.message);

  if (err.name === 'ZodError') {
    return sendError(
      res,
      400,
      'validation_error',
      'VALIDATION_FAILED',
      `Invalid fields: ${err.errors.map((e) => e.path.join('.')).join(', ')}`
    );
  }

  if (err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code || 'UNKNOWN' });
  }

  sendError(res, 500, 'internal_error', 'INTERNAL_ERROR', 'Something went wrong');
}

const app = express();

// Status monitoring dashboard (only in development and if available)
if (process.env.NODE_ENV !== 'production' && expressStatusMonitor) {
  app.use(
    expressStatusMonitor({
      title: 'Mr Tests Admin API Status',
      path: '/status',
      healthChecks: [
        {
          protocol: 'http',
          host: 'localhost',
          path: '/health',
          port: process.env.PORT || 3000,
        },
      ],
    })
  );
}

// Request logging (if morgan is available)
if (morgan) {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Compression middleware
app.use(compression());

// CORS and JSON parsing
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : {}));
app.use(express.json({ limit: '256kb' }));

// Health endpoints
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'mr-tests-admin-api',
    time: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version,
  });
});

// Debug endpoint (only in development)
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug/env', (req, res) => {
    res.json({
      nodeEnv: process.env.NODE_ENV,
      hasJobsApiBase: !!process.env.JOBS_API_BASE,
      hasJobsApiSecret: !!process.env.JOBS_API_SECRET,
      hasGitHubToken: !!process.env.GITHUB_TOKEN,
      port: process.env.PORT,
      dataDir: DATA_DIR,
      tokensPath: TOKENS_PATH,
    });
  });
}

app.get('/health/deps', async (req, res) => {
  const checks = {};

  // Check Apps Script API
  if (process.env.JOBS_API_BASE && process.env.JOBS_API_SECRET) {
    try {
      const url = `${process.env.JOBS_API_BASE}?action=health&secret=${process.env.JOBS_API_SECRET}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      checks.apps_script = response.ok;
    } catch (e) {
      checks.apps_script = false;
      logError({ message: 'Apps Script health check failed', error: e.message });
    }
  } else {
    checks.apps_script = 'not_configured';
  }

  // Check file system
  try {
    checks.file_system = fs.existsSync(DATA_DIR);
  } catch (e) {
    checks.file_system = false;
  }

  const allOk = Object.values(checks).every(
    (status) => status === true || status === 'not_configured'
  );

  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    checks,
    time: new Date().toISOString(),
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      hasJobsApiConfig: !!(process.env.JOBS_API_BASE && process.env.JOBS_API_SECRET),
    },
  });
});

// Static UI with caching
app.use(
  '/admin',
  express.static(publicDir, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=600'); // 10 minutes for static assets
      }
    },
  })
);

app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'admin.html'));
});
app.get('/', (_req, res) => res.redirect('/admin'));

// Health check endpoints
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/health/deps', async (_req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(JOBS_API_BASE, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: JOBS_API_SECRET,
        action: 'ping',
        limit: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    res.json({ apps_script: response.ok ? 'ok' : 'fail' });
  } catch (error) {
    res.json({ apps_script: 'fail' });
  }
});

// GitHub helpers with sha support
async function ghGetJson(path) {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path,
    ref: BRANCH,
  });
  const content = Buffer.from(data.content, data.encoding).toString('utf8');
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutJson(path, json, prevSha, message) {
  const body = JSON.stringify(json, null, 2) + '\n';
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path,
    branch: BRANCH,
    message,
    content: Buffer.from(body, 'utf8').toString('base64'),
    sha: prevSha,
  });
}

// Audit logger
async function audit({ actor, action, target, beforeSha, afterSha, details }) {
  try {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      actor,
      action,
      target,
      beforeSha,
      afterSha,
      details,
    };

    let auditLog = [];
    try {
      const { json } = await ghGetJson('log/audit.jsonl');
      auditLog = Array.isArray(json) ? json : [];
    } catch (e) {
      if (e.status !== 404) throw e;
      // File doesn't exist, start with empty array
    }

    auditLog.push(auditEntry);

    try {
      const { sha } = await ghGetJson('log/audit.jsonl');
      await ghPutJson(
        'log/audit.jsonl',
        auditLog,
        sha,
        `audit: ${action} by ${actor} (${new Date().toISOString()})`
      );
    } catch (e) {
      if (e.status === 404) {
        await ghPutJson(
          'log/audit.jsonl',
          auditLog,
          undefined,
          `audit: ${action} by ${actor} (${new Date().toISOString()})`
        );
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('Audit logging failed:', e);
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
      try {
        return JSON.parse(ADMIN_TOKENS_JSON) || {};
      } catch {}
    }
    return {};
  }
}

async function saveAdminMap(nextMap) {
  try {
    const { sha } = await ghGetJson(TOKENS_FILE_PATH);
    await ghPutJson(
      TOKENS_FILE_PATH,
      nextMap,
      sha,
      `feat: update admin codes via admin (${new Date().toISOString()})`
    );
  } catch (e) {
    if (e.status === 404) {
      await ghPutJson(
        TOKENS_FILE_PATH,
        nextMap,
        undefined,
        `feat: create admin codes file via admin (${new Date().toISOString()})`
      );
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
  return Array.isArray(pages) && pages.includes('*') ? 'master' : 'booker';
}

// Update resolveAdmin to read from file
async function resolveAdminAsync(token) {
  if (!token) return null;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { name: 'Admin', pages: ['*'] };
  
  // Try GitHub first, then fall back to local file
  let map;
  try {
    map = await loadAdminMap();
    // If GitHub returns empty object, fall back to local file
    if (!map || Object.keys(map).length === 0) {
      map = readTokens();
    }
  } catch (e) {
    // Fall back to local file for development
    map = readTokens();
  }
  
  const entry = map[token];
  if (!entry) return null;
  const name = typeof entry === 'string' ? entry : entry.name || 'Admin';
  let pages = entry && Array.isArray(entry.pages) ? entry.pages : undefined;
  const role = entry && typeof entry.role === 'string' ? entry.role : undefined;
  if (!pages) pages = pagesFromRole(role || 'booker');
  return { name, pages, isMaster: role === 'master' };
}

// Wrap auth to support async
async function authAsync(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
    const info = await resolveAdminAsync(token);
    if (!info) return res.status(401).json({ error: 'Unauthorized' });
    req.adminInfo = { ...info, token };
    req.adminToken = token; // Add this for isMasterReq function
    next();
  } catch (e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Auth failed' });
  }
}
const auth = authAsync;

function requirePage(tag) {
  return (req, res, next) => {
    const pages = req.adminInfo?.pages || [];
    if (pages.includes('*') || pages.includes(tag)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Who am I (keep, but uses async auth now)
app.get('/api/me', auth, (req, res) => {
  const { name, pages } = req.adminInfo;
  const role = roleFromPages(pages);
  res.json({ name, pages, role });
});

// NEW: Admin Codes endpoints
app.get('/api/admin-codes', auth, requirePage('admins'), async (_req, res) => {
  try {
    const map = await loadAdminMap();
    const tokens = readTokens(); // Get onboarding status
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      const name = v?.name || 'Admin';
      const pages = Array.isArray(v?.pages) ? v.pages : pagesFromRole(v?.role || 'booker');
      const role = typeof v?.role === 'string' ? v.role : roleFromPages(pages);
      const tokenInfo = tokens[k] || {};
      out[k] = {
        name,
        pages,
        role,
        onboarding_required: !!tokenInfo.onboarding_required,
        onboarded_at: tokenInfo.onboarded_at || '',
      };
    }
    res.json({ codes: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load admin codes' });
  }
});

app.put('/api/admin-codes', auth, requirePage('admins'), async (req, res) => {
  try {
    const { mode = 'append', code, name, role, pages } = req.body || {};
    if (mode === 'append') {
      if (typeof code !== 'string' || !code.trim())
        return res.status(400).json({ error: 'code required' });
      if (typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });

      const safeCode = code.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(safeCode))
        return res.status(400).json({ error: 'invalid code format' });

      let roleNorm = typeof role === 'string' ? role.trim().toLowerCase() : '';
      if (roleNorm && !['master', 'booker'].includes(roleNorm)) {
        return res.status(400).json({ error: 'invalid role' });
      }
      if (!roleNorm) roleNorm = 'booker';

      let pagesArr = Array.isArray(pages) ? pages.map((p) => String(p).trim()).filter(Boolean) : [];
      if (!pagesArr.length) pagesArr = pagesFromRole(roleNorm);

      const map = await loadAdminMap();
      if (map[safeCode]) return res.status(400).json({ error: 'code already exists' });

      map[safeCode] = { name: name.trim(), pages: pagesArr, role: roleNorm };
      await saveAdminMap(map);

      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: 'admins.append',
        target: 'admin_tokens.json',
        beforeSha: null,
        afterSha: null,
        details: { code: safeCode, name: name.trim(), role: roleNorm },
      });

      return res.json({ ok: true });
    }
    if (mode === 'delete') {
      const { code } = req.body || {};
      if (typeof code !== 'string' || !code.trim())
        return res.status(400).json({ error: 'code required' });
      const safe = code.trim();
      const map = await loadAdminMap();
      if (!map[safe]) return res.status(404).json({ error: 'code not found' });

      const deletedEntry = map[safe];
      delete map[safe];
      await saveAdminMap(map);

      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: 'admins.delete',
        target: 'admin_tokens.json',
        beforeSha: null,
        afterSha: null,
        details: { code: safe, deletedEntry },
      });

      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'unsupported mode' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update admin codes' });
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
        JOBS_API_SECRET: !process.env.JOBS_API_SECRET,
      },
      how_to_set:
        'In Render -> admin-api -> Environment, add JOBS_API_BASE (Apps Script Web App URL) and JOBS_API_SECRET (same as Templates!secret).',
    });
    return null;
  }
  return { JOBS_API_BASE, JOBS_API_SECRET };
}

async function jobsGet(params = {}) {
  const { JOBS_API_BASE, JOBS_API_SECRET } = process.env;
  const url = new URL(JOBS_API_BASE); // IMPORTANT: no extra path
  url.searchParams.set('secret', JOBS_API_SECRET);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return fetch(url.toString(), { method: 'GET' }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('jobsGet non-200', r.status, j);
      throw new Error('Jobs GET failed ' + r.status);
    }
    return j;
  });
}

async function jobsPost(payload) {
  const { JOBS_API_BASE, JOBS_API_SECRET } = process.env;
  const r = await fetch(JOBS_API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: JOBS_API_SECRET, ...payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Jobs POST failed: ' + JSON.stringify(j));
  return j;
}

// Legacy function for backward compatibility
async function postJob(payload) {
  return jobsPost(payload);
}

// Legacy audit function for backward compatibility
async function auditJob({ actor, action, job_id, extra }) {
  try {
    await audit({
      actor,
      action,
      target: 'jobs',
      beforeSha: null,
      afterSha: null,
      details: { job_id, ...extra },
    });
  } catch (e) {
    console.error('Job audit failed:', e);
  }
}

// Bust cache after mutations
function bustJobsCacheFor(token) {
  JobCache.bust(['board']);
  JobCache.bust(['mine', token]);
}

// GitHub helpers
const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;

async function getFile() {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: FILE_PATH,
    ref: BRANCH,
  });
  const content = Buffer.from(data.content, data.encoding).toString('utf8');
  return { sha: data.sha, json: JSON.parse(content) };
}

async function putFile(newJson) {
  const body = JSON.stringify(newJson, null, 2) + '\n';
  const { sha } = await getFile();
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: FILE_PATH,
    branch: BRANCH,
    message: `chore: update test centres via admin (${new Date().toISOString()})`,
    content: Buffer.from(body, 'utf8').toString('base64'),
    sha,
  });
}

// API
app.get('/api/test-centres', auth, async (_req, res) => {
  try {
    const { json, sha } = await getFile();
    // Filter out deleted centres for normal view
    const activeCentres = json.filter((c) => !c.deleted);
    res.json({ centres: activeCentres, sha });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read centres' });
  }
});

// NEW: Recycle bin endpoint
app.get('/api/test-centres-bin', auth, requirePage('admins'), async (_req, res) => {
  try {
    const { json, sha } = await getFile();
    // Only show deleted centres
    const deletedCentres = json.filter((c) => c.deleted);
    res.json({ centres: deletedCentres, sha });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read deleted centres' });
  }
});

app.put('/api/test-centres', auth, async (req, res) => {
  try {
    const mode = req.body?.mode || 'append';

    // Concurrency check
    if (req.body?.sha) {
      const { sha: currentSha } = await getFile();
      if (req.body.sha !== currentSha) {
        return res.status(409).json({ error: 'conflict' });
      }
    }

    if (mode === 'delete') {
      // require master
      if (!req.adminInfo?.pages?.includes('*') && !req.adminInfo?.pages?.includes('admins')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !x.trim())) {
        return res.status(400).json({ error: 'ids[] required' });
      }

      const { json: existing, sha: beforeSha } = await getFile();
      const remove = new Set(ids.map((s) => s.trim()));
      const next = existing.map((c) => (remove.has(c.id) ? { ...c, deleted: true } : c));

      // Dependency check: remove from all bookers' coverage
      const adminMap = await loadAdminMap();
      let removedFromBookers = 0;
      for (const [token, entry] of Object.entries(adminMap)) {
        if (entry.centres && Array.isArray(entry.centres)) {
          const originalLength = entry.centres.length;
          entry.centres = entry.centres.filter((id) => !remove.has(id));
          removedFromBookers += originalLength - entry.centres.length;
        }
      }

      await putFile(next);
      await saveAdminMap(adminMap);

      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: 'centres.soft_delete',
        target: 'test_centres.json',
        beforeSha,
        afterSha: null,
        details: { ids: Array.from(remove), removedFromBookers },
      });

      return res.json({
        ok: true,
        count: next.filter((c) => !c.deleted).length,
        removed: ids.length,
      });
    }

    if (mode === 'restore') {
      // require master
      if (!req.adminInfo?.pages?.includes('*') && !req.adminInfo?.pages?.includes('admins')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !x.trim())) {
        return res.status(400).json({ error: 'ids[] required' });
      }

      const { json: existing, sha: beforeSha } = await getFile();
      const restore = new Set(ids.map((s) => s.trim()));
      const next = existing.map((c) => (restore.has(c.id) ? { ...c, deleted: false } : c));

      await putFile(next);

      // Audit log
      await audit({
        actor: req.adminInfo.name,
        action: 'centres.restore',
        target: 'test_centres.json',
        beforeSha,
        afterSha: null,
        details: { ids: Array.from(restore) },
      });

      return res.json({
        ok: true,
        count: next.filter((c) => !c.deleted).length,
        restored: ids.length,
      });
    }

    if (mode !== 'append') return res.status(400).json({ error: 'Only append mode allowed' });
    const centres = req.body?.centres;
    if (!Array.isArray(centres) || !centres.length)
      return res.status(400).json({ error: 'centres[] required' });
    const items = centres.map((c) => ({
      id: String(c.id || '').trim(),
      name: String(c.name || '').trim(),
      deleted: false,
    }));
    if (items.some((c) => !c.id || !c.name))
      return res.status(400).json({ error: 'Each centre needs id and name' });

    const { json: existing, sha: beforeSha } = await getFile();
    const ids = new Set(existing.map((c) => c.id));
    for (const c of items) {
      if (ids.has(c.id)) return res.status(400).json({ error: `Duplicate id: ${c.id}` });
      ids.add(c.id);
    }

    await putFile(existing.concat(items));

    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: 'centres.append',
      target: 'test_centres.json',
      beforeSha,
      afterSha: null,
      details: { centres: items },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to append centres' });
  }
});

// NEW: My coverage endpoints
app.get('/api/my-centres', auth, async (req, res) => {
  try {
    const map = await loadAdminMap();
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const entry = map[token] || {};
    const centres = Array.isArray(entry.centres) ? entry.centres : [];
    res.json({ centres });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});

app.put('/api/my-centres', auth, async (req, res) => {
  try {
    const list = req.body?.centres;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x.trim())) {
      return res.status(400).json({ error: 'centres must be array of ids' });
    }
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const map = await loadAdminMap();
    if (!map[token]) {
      // create minimal entry if missing (rare)
      map[token] = {
        name: req.adminInfo?.name || 'Admin',
        role: req.adminInfo?.role || 'booker',
        pages: req.adminInfo?.pages || ['centres'],
      };
    }
    const beforeCentres = Array.isArray(map[token].centres) ? map[token].centres : [];
    map[token].centres = Array.from(new Set(list.map((s) => s.trim())));
    await saveAdminMap(map);

    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: 'coverage.set',
      target: 'admin_tokens.json',
      beforeSha: null,
      afterSha: null,
      details: { beforeCentres, afterCentres: map[token].centres },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save coverage' });
  }
});

// NEW: Profile endpoints
app.get('/api/my-profile', auth, async (req, res) => {
  try {
    const map = await loadAdminMap();
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const entry = map[token] || {};
    res.json({
      notes: entry.notes || '',
      maxDaily: typeof entry.maxDaily === 'number' ? entry.maxDaily : 0,
      available: typeof entry.available === 'boolean' ? entry.available : true,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

app.put('/api/my-profile', auth, async (req, res) => {
  try {
    const { notes, maxDaily, available } = req.body || {};

    // Validation
    if (notes !== undefined && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be string' });
    }
    if (maxDaily !== undefined) {
      const maxDailyNum = parseInt(maxDaily);
      if (isNaN(maxDailyNum) || maxDailyNum < 0) {
        return res.status(400).json({ error: 'maxDaily must be integer >= 0' });
      }
    }
    if (available !== undefined && typeof available !== 'boolean') {
      return res.status(400).json({ error: 'available must be boolean' });
    }

    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const map = await loadAdminMap();
    if (!map[token]) {
      map[token] = {
        name: req.adminInfo?.name || 'Admin',
        role: req.adminInfo?.role || 'booker',
        pages: req.adminInfo?.pages || ['centres'],
      };
    }

    const beforeProfile = {
      notes: map[token].notes || '',
      maxDaily: typeof map[token].maxDaily === 'number' ? map[token].maxDaily : 0,
      available: typeof map[token].available === 'boolean' ? map[token].available : true,
    };

    if (notes !== undefined) map[token].notes = notes;
    if (maxDaily !== undefined) map[token].maxDaily = parseInt(maxDaily);
    if (available !== undefined) map[token].available = available;

    await saveAdminMap(map);

    // Audit log
    await audit({
      actor: req.adminInfo.name,
      action: 'profile.update',
      target: 'admin_tokens.json',
      beforeSha: null,
      afterSha: null,
      details: {
        beforeProfile,
        afterProfile: {
          notes: map[token].notes,
          maxDaily: map[token].maxDaily,
          available: map[token].available,
        },
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ---- Jobs board (open jobs filtered by booker coverage) ----
app.get('/api/jobs/board', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const { limit, offset } = parsePage(req);
    const q = String(req.query.q || '');

    // Get coverage for this token
    const coverageArr = await getCoverageForToken(token);
    const coverage = new Set(coverageArr);

    const data = await JobCache.getOrSet(['board', 'open', token, q, limit, offset], () =>
      jobsGet({ status: 'open', assigned_to: '', q, limit, offset })
    );

    // Filter jobs by coverage with fallback logic
    const raw = Array.isArray(data.jobs) ? data.jobs : [];
    const filtered =
      coverage.size === 0
        ? []
        : raw.filter((job) => {
            // Prefer explicit centre_id; else centre_name; else first desired
            const rawCid =
              job.centre_id ||
              job.centre_name ||
              (job.desired_centres ? String(job.desired_centres).split(',')[0] : '');
            const cid = normCentreId(rawCid);
            return coverage.has(cid);
          });

    res.json({
      jobs: filtered,
      _meta: {
        raw: raw.length,
        after_filter: filtered.length,
        coverage: coverageArr,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Failed to load jobs' });
  }
});

// ---- My jobs (assigned_to = token) ----
app.get('/api/jobs/mine', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const { limit, offset } = parsePage(req);
    const data = await JobCache.getOrSet(['mine', token, limit, offset], () =>
      jobsGet({ assigned_to: token, limit, offset })
    );
    const payout = Number(process.env.JOB_PAYOUT_GBP || 70);
    const completed = (data.jobs || []).filter(
      (j) => String(j.status).toLowerCase() === 'completed'
    ).length;
    res.json({
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      payout_per_job: payout,
      total_due: completed * payout,
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Failed to load my jobs' });
  }
});

// ---- Claim / Release / Complete ----
app.post('/api/jobs/claim', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = claimSchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id } = validation.data;
    const out = await jobsPost({ action: 'claim', booking_id: job_id, token });
    bustJobsCacheFor(token);

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, out);
    }

    res.json(out);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return sendError(res, 400, 'validation_error', 'VALIDATION_FAILED', 'Invalid request data');
    }
    logError({ message: 'Claim error', error: e.message, stack: e.stack });
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Claim operation failed');
  }
});
app.post('/api/jobs/release', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = releaseSchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id } = validation.data;
    const out = await jobsPost({
      action: 'release',
      booking_id: job_id,
      token,
    });
    bustJobsCacheFor(token);

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, out);
    }

    res.json(out);
  } catch (e) {
    console.error('Release error:', e);
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Release operation failed');
  }
});
app.post('/api/jobs/complete', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = completeSchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id } = validation.data;
    const out = await jobsPost({
      action: 'complete',
      booking_id: job_id,
      token,
    });
    bustJobsCacheFor(token);

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, out);
    }

    res.json(out);
  } catch (e) {
    console.error('Complete error:', e);
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Complete operation failed');
  }
});

// ---- Optional admin-only: create/delete job entries ----
app.post('/api/jobs/create', auth, requirePage('admins'), async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const { job } = req.body || {};
    if (!job || !job.centre_id || !job.centre_name)
      return res.status(400).json({ error: 'centre_id and centre_name required' });
    const out = await jobsPost({
      action: 'create_booking',
      booking: {
        'Booking ID': job.id,
        'Matched Centre': job.centre_id,
        'Student Name': job.candidate || '',
        Notes: job.notes || '',
        Tier: job.tier || '',
        'Partner ID': job.partner_id || '',
      },
    });
    JobCache.bust(); // global
    res.json({ ok: true, job_id: out.booking_id });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'create failed' });
  }
});
app.post('/api/jobs/delete', auth, requirePage('admins'), async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    const actor = req.adminInfo?.name || 'admin';
    const out = await jobsPost({
      action: 'delete_soft',
      booking_id: job_id,
      actor,
    });
    JobCache.bust(); // global
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'delete failed' });
  }
});

// ---- Offer confirmation flow ----
app.post('/api/jobs/offer', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = offerSchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id, centre, date, time, note } = validation.data;

    // Validate date/time is in the future
    const offerDateTime = new Date(`${date} ${time}`);
    if (isNaN(offerDateTime.getTime()) || offerDateTime <= new Date()) {
      return sendError(
        res,
        400,
        'validation_error',
        'INVALID_DATETIME',
        'Offer date and time must be in the future'
      );
    }

    const r = await jobsPost({
      action: 'propose_offer',
      booking_id: job_id,
      token,
      offer: { centre, date, time, note: note || '' },
    });

    // optional WhatsApp automation if configured
    try {
      await fetch('/api/notify/whatsapp/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          booking_id: job_id,
          centre,
          when: `${date} ${time}`,
        }),
      });
    } catch (_) {}

    try {
      JobCache?.bust?.();
    } catch (_) {}

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, { ok: true });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Offer error:', e);
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Offer operation failed');
  }
});

app.post('/api/jobs/offer/nudge', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const { job_id } = req.body || {};
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    // (Optional) send WA again
    try {
      await fetch('/api/notify/whatsapp/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ booking_id: job_id }),
      });
      await jobsPost({
        action: 'log_event',
        booking_id: job_id,
        actor: token,
        notes: 'whatsapp_nudge',
      });
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'nudge failed' });
  }
});

app.post('/api/jobs/offer/extend', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = extendSchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id, minutes } = validation.data;
    await jobsPost({
      action: 'extend_offer',
      booking_id: job_id,
      token,
      minutes,
    });
    try {
      JobCache?.bust?.();
    } catch (_) {}

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, { ok: true });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Extend error:', e);
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Extend operation failed');
  }
});

app.post('/api/jobs/mark-client-reply', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const idemKey = req.headers['x-idempotency-key'];

    // Check idempotency
    if (idemKey) {
      const cached = IdemStore.check(idemKey);
      if (cached) {
        return res.status(409).json({ ok: true, replay: true });
      }
    }

    // Check rate limit
    const rateLimit = ActionRateLimiter.checkLimit(token);
    if (!rateLimit.allowed) {
      return sendError(
        res,
        429,
        'rate_limited',
        'RATE_LIMIT_EXCEEDED',
        `Try again in ${rateLimit.retryAfter} seconds`
      );
    }

    // Validate input
    const validation = replySchema.safeParse(req.body);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'validation_error',
        'VALIDATION_FAILED',
        `Invalid fields: ${validation.error.errors.map((e) => e.path.join('.')).join(', ')}`
      );
    }

    const { job_id, reply } = validation.data;
    await jobsPost({
      action: 'record_client_reply',
      booking_id: job_id,
      token,
      reply,
    });
    try {
      JobCache?.bust?.();
    } catch (_) {}

    // Store idempotency response
    if (idemKey) {
      IdemStore.store(idemKey, { ok: true });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Mark reply error:', e);
    sendError(res, 502, 'upstream_failed', 'UPSTREAM_ERROR', 'Mark reply operation failed');
  }
});

// ---- Stats (lifetime completed for current token) ----
app.get('/api/jobs/stats', auth, async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return res.json({ completed_all_time: 0 });
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const data = await jobsGet({ status: 'completed', assigned_to: token });
    res.json({
      completed_all_time: Array.isArray(data.jobs) ? data.jobs.length : 0,
    });
  } catch (e) {
    console.error(e);
    res.json({ completed_all_time: 0 });
  }
});

// ---- Public intake for the static booking form ----
app.post('/api/public/booking-request', async (req, res) => {
  const env = requireJobsEnv(res);
  if (!env) return;
  try {
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';
    const booking = req.body || {};
    const required = ['Student Name', 'Phone'];
    const missing = required.filter((k) => !String(booking[k] || '').trim());
    if (missing.length) return res.status(400).json({ error: 'Missing fields', missing });
    const data = await jobsPost({ action: 'create_booking', booking, ip });
    if (!data.ok) return res.status(502).json({ error: 'Failed to create booking', detail: data });

    // Bust jobs cache so new booking appears immediately
    try {
      JobCache?.bust?.();
    } catch (_) {}

    res.json({ ok: true, booking_id: data.booking_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Booker management endpoints
app.get('/api/admins/bookers', auth, async (req, res) => {
  try {
    if (!isMasterReq(req)) {
      return res.status(403).json({ 
        error: 'forbidden', 
        code: 'MASTER_REQUIRED', 
        hint: 'Only master admins can view bookers' 
      });
    }

    const bookers = listBookers();
    res.json({ bookers });
  } catch (e) {
    console.error('Get bookers error:', e);
    res.status(502).json({ 
      error: 'upstream_failed', 
      code: 'BOOKERS_ERROR', 
      hint: 'Failed to get bookers' 
    });
  }
});

app.get('/api/admins/bookers/:token/jobs', auth, async (req, res) => {
  try {
    if (!isMasterReq(req)) {
      return res.status(403).json({ 
        error: 'forbidden', 
        code: 'MASTER_REQUIRED', 
        hint: 'Only master admins can view booker jobs' 
      });
    }

    const env = requireJobsEnv(res);
    if (!env) return;

    const targetToken = req.params.token;
    if (!targetToken) {
      return res.status(400).json({ 
        error: 'validation_error', 
        code: 'TOKEN_REQUIRED', 
        hint: 'Booker token is required' 
      });
    }

    // Fetch jobs for this specific booker
    const params = {
      action: 'get_jobs',
      assigned_to: targetToken,
      limit: 100,
    };

    const data = await jobsGet(params);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];

    res.json({ jobs });
  } catch (e) {
    console.error('Get booker jobs error:', e);
    res.status(502).json({ 
      error: 'upstream_failed', 
      code: 'BOOKER_JOBS_ERROR', 
      hint: 'Failed to get booker jobs' 
    });
  }
});

app.post('/api/jobs/assign', auth, async (req, res) => {
  try {
    const authToken = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!isMaster(authToken)) {
      return sendError(
        res,
        403,
        'forbidden',
        'MASTER_REQUIRED',
        'Only master admins can assign jobs'
      );
    }

    const env = requireJobsEnv(res);
    if (!env) return;

    const { job_id, to_token } = req.body || {};
    if (!job_id || !to_token) {
      return sendError(
        res,
        400,
        'validation_error',
        'REQUIRED_FIELDS',
        'job_id and to_token are required'
      );
    }

    // Validate the target booker exists and get their coverage
    const bookers = listBookers();
    const targetBooker = bookers.find((b) => b.token === to_token);
    if (!targetBooker) {
      return sendError(res, 404, 'not_found', 'BOOKER_NOT_FOUND', 'Target booker not found');
    }

    // Fetch the job to validate its status and centre
    const jobData = await jobsGet({
      action: 'get_jobs',
      booking_id: job_id,
      limit: 1,
    });
    const job = Array.isArray(jobData.jobs) && jobData.jobs.length > 0 ? jobData.jobs[0] : null;

    if (!job) {
      return sendError(res, 404, 'not_found', 'JOB_NOT_FOUND', 'Job not found');
    }

    if (job.status !== 'open') {
      return sendError(res, 400, 'invalid_state', 'JOB_NOT_OPEN', 'Job is not open for assignment');
    }

    // Check coverage match
    const cidRaw =
      job.centre_id ||
      job.centre_name ||
      (job.desired_centres ? String(job.desired_centres).split(',')[0] : '');
    const jobCentreId = normCentreId(cidRaw);

    if (jobCentreId && !targetBooker.coverage.includes(jobCentreId)) {
      return sendError(
        res,
        400,
        'coverage_mismatch',
        'COVERAGE_MISMATCH',
        `Booker does not cover centre: ${jobCentreId}`
      );
    }

    // Perform the assignment
    const assignData = await jobsPost({
      action: 'assign_to',
      booking_id: job_id,
      to_token,
      actor: authToken,
    });

    if (!assignData.ok) {
      return sendError(
        res,
        502,
        'upstream_failed',
        'ASSIGN_FAILED',
        assignData.error || 'Assignment failed'
      );
    }

    // Bust caches
    try {
      JobCache?.bust?.();
    } catch {}

    res.json({ ok: true, assigned_to: to_token });
  } catch (e) {
    console.error('Job assignment error:', e);
    sendError(res, 502, 'upstream_failed', 'ASSIGN_ERROR', 'Failed to assign job');
  }
});

// Debug endpoint for configuration checks
app.get('/api/debug/env-lite', (req, res) => {
  res.json({
    ok: true,
    has_JOBS_API_BASE: !!process.env.JOBS_API_BASE,
    has_JOBS_API_SECRET: !!process.env.JOBS_API_SECRET,
    data_dir: DATA_DIR,
    tokens_path: TOKENS_PATH,
    tokens_exists: fs.existsSync(TOKENS_PATH),
    node_env: process.env.NODE_ENV || 'development',
  });
});

// Onboarding endpoints
app.post('/api/admins/force-onboard', auth, async (req, res) => {
  try {
    const authToken = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!isMaster(authToken)) {
      return sendError(
        res,
        403,
        'forbidden',
        'MASTER_REQUIRED',
        'Only master admins can force onboarding'
      );
    }

    const { token } = req.body || {};
    if (!token) {
      return sendError(res, 400, 'validation_error', 'TOKEN_REQUIRED', 'Token is required');
    }

    const tokens = readTokens();
    if (!tokens[token]) {
      return sendError(res, 404, 'not_found', 'UNKNOWN_TOKEN', 'Token not found');
    }

    tokens[token].onboarding_required = true;
    tokens[token].onboarded_at = '';

    if (!writeTokens(tokens)) {
      return sendError(res, 502, 'write_failed', 'TOKEN_WRITE_ERROR', 'Failed to save token data');
    }

    // Bust cache
    try {
      JobCache?.bust?.();
    } catch {}

    res.json({ ok: true });
  } catch (e) {
    console.error('Force onboard error:', e);
    sendError(res, 502, 'upstream_failed', 'FORCE_ONBOARD_ERROR', 'Failed to force onboarding');
  }
});

app.get('/api/my-onboarding', auth, (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const tokens = readTokens();
    const me = tokens[token] || {};

    res.json({
      onboarding_required: !!me.onboarding_required,
      name: me.name || '',
      coverage: Array.isArray(me.coverage) ? me.coverage : [],
      availability: typeof me.availability === 'boolean' ? me.availability : true,
    });
  } catch (e) {
    console.error('Get onboarding error:', e);
    sendError(res, 502, 'upstream_failed', 'ONBOARDING_ERROR', 'Failed to get onboarding status');
  }
});

app.post('/api/my-onboarding/complete', auth, async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const { name, coverage, availability } = req.body || {};

    if (!name || !Array.isArray(coverage) || coverage.length === 0) {
      return sendError(
        res,
        400,
        'validation_error',
        'REQUIRED_FIELDS',
        'Name and coverage are required'
      );
    }

    const tokens = readTokens();
    tokens[token] = tokens[token] || {};
    tokens[token].name = String(name).trim();
    tokens[token].coverage = coverage.map((c) => normCentreId(c)).filter(Boolean);
    tokens[token].availability = !!availability;
    tokens[token].onboarding_required = false;
    tokens[token].onboarded_at = new Date().toISOString();

    if (!writeTokens(tokens)) {
      return sendError(res, 502, 'write_failed', 'TOKEN_WRITE_ERROR', 'Failed to save token data');
    }

    // Bust cache
    try {
      JobCache?.bust?.();
    } catch {}

    res.json({ ok: true });
  } catch (e) {
    console.error('Complete onboarding error:', e);
    sendError(
      res,
      502,
      'upstream_failed',
      'COMPLETE_ONBOARD_ERROR',
      'Failed to complete onboarding'
    );
  }
});

// Enhanced global error handler (must be last)
app.use((err, req, res, next) => {
  // Log the error
  logError({
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });

  // Handle different error types
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation error',
      code: 'validation_failed',
      details: err.errors,
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      code: 'unauthorized',
    });
  }

  // Default error response
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'server_error';
  const message =
    process.env.NODE_ENV === 'production'
      ? status === 500
        ? 'Internal server error'
        : err.message
      : err.message;

  res.status(status).json({
    error: message,
    code: code,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// Fallback error handler
app.use(handleError);

const PORT = process.env.PORT || 3000;

// Log startup information
logger.info('Starting Mr Tests Admin API', {
  port: PORT,
  nodeEnv: process.env.NODE_ENV || 'development',
  hasJobsApi: !!(process.env.JOBS_API_BASE && process.env.JOBS_API_SECRET),
  hasGitHubToken: !!process.env.GITHUB_TOKEN,
  dataDir: DATA_DIR,
});

app.listen(PORT, () => {
  logger.info(`[admin-api] listening on ${PORT}`);
  KeepAlive.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  KeepAlive.stop();
  process.exit(0);
});
