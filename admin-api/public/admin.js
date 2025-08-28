const API_BASE = '/api';

function setText(id, msg, cls){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.className = (id === 'unlockStatus' ? (cls || '') : el.className);
}

const AUTH = (() => {
  const K_T='adminToken', K_R='adminRole', K_N='adminName';
  const get = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const set = (k,v) => { try { localStorage.setItem(k, v); } catch {} };
  async function me(){
    const t = get(K_T);
    if (!t) throw new Error('No token');
    const r = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) throw new Error('Unauthorized');
    const j = await r.json();
    if (j?.role) { set(K_R, j.role); if (j.name != null) set(K_N, j.name); }
    return j;
  }
  return {
    saveToken: t => set(K_T, String(t||'')),
    token: () => get(K_T),
    role: () => get(K_R),
    name: () => get(K_N),
    me
  };
})();

async function api(path, method='GET', body){
  const headers = { 'Content-Type':'application/json' };
  const tok = AUTH.token();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(path, { method, headers, body: method==='GET' ? undefined : JSON.stringify(body||{}) });
  const txt = await res.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch {}
  if (!res.ok) {
    const msg = (data?.hint || data?.error || txt || `HTTP ${res.status}`);
    const e = new Error(msg); e.status = res.status; e.payload = data; throw e;
  }
  return data || {};
}

async function onUnlock(){
  const btn = document.getElementById('btnUnlock');
  const inp = document.getElementById('unlockCode');
  const statusId = 'unlockStatus';

  const code = (inp?.value || '').trim();
  if (!code) { setText(statusId, 'Enter your admin code', 'error'); return; }

  btn.disabled = true;
  setText(statusId, 'Checking code…', '');

  AUTH.saveToken(code);

  try {
    const me = await AUTH.me(); // calls /api/me
    setText(statusId, `Welcome ${me?.name || ''} (${me?.role || 'user'})`, 'ok');

    // choose a sane default tab that exists for both roles
    if (typeof setActiveTab === 'function') setActiveTab('jobs');

    // kick initial loads if functions exist
    if (typeof loadJobs === 'function') loadJobs();
    if (typeof loadMyJobs === 'function') loadMyJobs();
    if (typeof loadProfile === 'function') loadProfile();
    if (typeof loadCentres === 'function') loadCentres();
  } catch (e) {
    setText(statusId, e?.message || 'Unlock failed. Check your code.', 'error');
    // keep token so user can correct if they mistyped? If you prefer, clear it:
    // AUTH.saveToken('');
  } finally {
    btn.disabled = false;
  }
}

function wireUnlock(){
  const btn = document.getElementById('btnUnlock');
  const inp = document.getElementById('unlockCode');
  if (btn) btn.onclick = onUnlock;
  if (inp) inp.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onUnlock(); });
}

function boot(){
  wireUnlock();

  // If a token already exists (refresh), attempt auto-login quietly
  if (AUTH.token()) {
    AUTH.me().then((me)=>{
      setText('unlockStatus', `Welcome back ${me?.name || ''}`, 'ok');
      if (typeof setActiveTab === 'function') setActiveTab('jobs');
      if (typeof loadJobs === 'function') loadJobs();
      if (typeof loadMyJobs === 'function') loadMyJobs();
      if (typeof loadProfile === 'function') loadProfile();
      if (typeof loadCentres === 'function') loadCentres();
    }).catch(()=>{
      // leave UI idle; user can re-enter code
    });
  }

  console.log('[admin] unlock boot ok');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}