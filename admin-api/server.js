// server.js
import express from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';

const {
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  BRANCH = 'main',
  FILE_PATH = 'data/test_centres.json',
  ADMIN_TOKEN,
  CORS_ORIGIN
} = process.env;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !ADMIN_TOKEN) {
  console.warn('[admin-api] Missing envs: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, ADMIN_TOKEN are required.');
}

const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;
const app = express();

// CORS
if (CORS_ORIGIN) app.use(cors({ origin: CORS_ORIGIN }));
else app.use(cors());

// Body
app.use(express.json({ limit: '256kb' }));

// Serve admin UI
app.use('/admin', express.static(new URL('./public', import.meta.url).pathname));

// Auth
function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ') && hdr.slice(7) === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Helpers
async function getFile() {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER, repo: REPO_NAME, path: FILE_PATH, ref: BRANCH
  });
  const content = Buffer.from(data.content, data.encoding).toString('utf8');
  return { sha: data.sha, json: JSON.parse(content) };
}
async function putFile(newJson) {
  const body = JSON.stringify(newJson, null, 2) + '\n';
  const { sha } = await getFile();
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER, repo: REPO_NAME, path: FILE_PATH, branch: BRANCH,
    message: `chore: update test centres via admin (${new Date().toISOString()})`,
    content: Buffer.from(body, 'utf8').toString('base64'),
    sha
  });
}

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// API
app.get('/api/test-centres', auth, async (_req, res) => {
  try {
    const { json } = await getFile();
    res.json({ centres: json });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to read centres' }); }
});

app.put('/api/test-centres', auth, async (req, res) => {
  try {
    const mode = (req.body && req.body.mode) || 'append';
    const centres = req.body.centres;
    if (mode !== 'append') return res.status(400).json({ error: 'Only append mode allowed' });
    if (!Array.isArray(centres) || centres.length === 0) return res.status(400).json({ error: 'centres[] required' });

    // Validate payload entries
    const newOnes = centres.map(c => ({
      id: String(c.id || '').trim(),
      name: String(c.name || '').trim()
    }));
    if (newOnes.some(c => !c.id || !c.name)) return res.status(400).json({ error: 'Each centre needs id and name' });

    // Merge: read existing, ensure unique IDs
    const { json: existing } = await getFile();
    const ids = new Set(existing.map(c => c.id));
    for (const c of newOnes) {
      if (ids.has(c.id)) return res.status(400).json({ error: `Duplicate id: ${c.id}` });
      ids.add(c.id);
    }
    const merged = existing.concat(newOnes);

    await putFile(merged);
    res.json({ ok: true, count: merged.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to append centres' }); }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[admin-api] listening on ${PORT}`));
