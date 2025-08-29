const API_BASE = '/api';

/* ===== AUTH & API (minimal store) ===== */
const AUTH = (() => {
  let token = null;
  let profile = null;
  
  return {
    saveToken: (t) => { token = t; try { localStorage.setItem('adminToken', t); } catch {} },
    token: () => token || (() => { try { return localStorage.getItem('adminToken'); } catch { return null; } })(),
    setProfile: (p) => { profile = p; try { localStorage.setItem('adminProfile', JSON.stringify(p)); } catch {} },
    role: () => profile?.role,
    name: () => profile?.name,
    me: async () => {
      const t = AUTH.token();
      if (!t) throw new Error('No token');
      const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${t}` } });
      if (!res.ok) throw new Error('Unauthorized');
      const me = await res.json();
      AUTH.setProfile(me);
      return me;
    }
  };
})();

async function api(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = AUTH.token?.();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch {}
  if (!res.ok) {
    const msg = (data?.hint || data?.error || txt || `HTTP ${res.status}`);
    const e = new Error(msg);
    e.status = res.status;
    e.payload = data;
    throw e;
  }
  return data || {};
}

/* ===== TOP CONTROLS (restore) ===== */
function wireTopControls() {
  const th = document.getElementById('btnThemeTop');
  if (th) th.onclick = () => document.body.classList.toggle('theme-dark');
  const hp = document.getElementById('btnHelpTop');
  if (hp) hp.onclick = () => alert('Help:\n1) Unlock with your admin code.\n2) Use tabs to navigate.\n3) Bookers claim/assign jobs, offer, confirm, complete.');
}

/* ===== TABS ===== */
function setActiveTab(key) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('d-none'));
  document.querySelectorAll('#nav .nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(key)?.classList.remove('d-none');
  document.querySelector(`#nav .nav-link[data-nav="${key}"]`)?.classList.add('active');
  try { localStorage.setItem('activeTab', key); } catch {}
}

function wireNav() {
  document.querySelectorAll('#nav .nav-link').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const k = a.getAttribute('data-nav');
      setActiveTab(k);
      if (k === 'jobs') loadJobs?.();
      if (k === 'myjobs') loadMyJobs?.();
      if (k === 'centres') loadCentres?.();
      if (k === 'profile') loadProfile?.();
      if (k === 'admins') loadAdmins?.();
      if (k === 'bookers') loadBookers?.();
    };
  });
}

/* ===== UNLOCK (unchanged minimal) ===== */
function setStatus(msg, cls) {
  const el = document.getElementById('unlockStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = cls || '';
}

async function onUnlock() {
  const code = (document.getElementById('unlockCode')?.value || '').trim();
  const btn = document.getElementById('btnUnlock');
  if (!code) { setStatus('Enter your admin code', 'error'); return; }
  btn.disabled = true;
  setStatus('Checking code…', '');
  try {
    const r = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${code}` } });
    if (!r.ok) throw new Error('Unauthorized');
    const me = await r.json();
    AUTH.saveToken?.(code);
    AUTH.setProfile?.(me);
    setStatus(`Welcome ${me?.name || ''} (${me?.role || 'user'})`, 'ok');
    applyVisibility();
    setActiveTab('jobs');
    loadJobs?.();
    loadMyJobs?.();
    loadProfile?.();
    loadCentres?.(); // restore initial loads
  } catch (e) {
    setStatus(e?.message || 'Unlock failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

function wireUnlock() {
  const b = document.getElementById('btnUnlock');
  if (b) b.onclick = onUnlock;
  const i = document.getElementById('unlockCode');
  if (i) i.addEventListener('keydown', e => { if (e.key === 'Enter') onUnlock(); });
}

/* ===== ROLE-BASED VISIBILITY (unchanged) ===== */
function applyVisibility() {
  const isMaster = (AUTH.role?.() === 'master' || AUTH.token?.() === '1212');
  document.querySelectorAll('#nav .nav-link').forEach(a => a.closest('li,.nav-item')?.classList.remove('d-none'));
  if (!isMaster) {
    ['admins', 'bookers'].forEach(k => {
      const el = document.querySelector(`[data-nav="${k}"]`)?.closest('li,.nav-item') || document.querySelector(`[data-nav="${k}"]`);
      el?.classList.add('d-none');
    });
  }
}

/* ===== RENDER HELPERS ===== */
function field(parent, label, value) {
  const row = document.createElement('div');
  row.className = 'field';
  const l = document.createElement('label');
  l.textContent = label;
  const v = document.createElement('div');
  v.textContent = value || '—';
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}

function formatRangeNice(s) {
  if (!s) return '—';
  const m = String(s).match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (!m) return s;
  const a = new Date(m[1]);
  const b = new Date(m[2]);
  const opts = { day: '2-digit', month: 'short' };
  return `${a.toLocaleDateString('en-GB', opts)} – ${b.toLocaleDateString('en-GB', opts)}`;
}

/* ===== LOADERS (restore expected behavior) ===== */
// Jobs board (data from API; no UI from disk)
async function loadJobs() {
  const el = document.getElementById('jobs');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const data = await api('/api/jobs/board', 'GET');
  const list = data?.jobs || [];
  el.innerHTML = '';
  if (!list.length) { el.textContent = 'No open jobs available.'; return; }
  list.forEach(j => {
    const card = document.createElement('div');
    card.className = 'card p-3 mb-2';
    const title = document.createElement('div');
    title.innerHTML = `<strong>${j.candidate || 'Unnamed'}</strong>`;
    const meta = document.createElement('div');
    meta.textContent = j.centre_name || (j.desired_centres || '').split(',')[0] || '';
    if (j.notes && j.notes.trim()) {
      const n = document.createElement('span');
      n.className = 'badge-notes';
      n.textContent = 'Notes';
      meta.appendChild(n);
    }
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary mt-2';
    btn.textContent = 'Details';
    btn.onclick = () => showJobDetails(j);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(btn);
    el.appendChild(card);
  });
}

// My Jobs — RESTORE client details
async function loadMyJobs() {
  const el = document.getElementById('myjobs');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const data = await api('/api/jobs/mine', 'GET');
  const list = data?.jobs || [];
  el.innerHTML = '';
  if (!list.length) { el.textContent = 'No jobs claimed yet.'; return; }
  list.forEach(j => {
    const card = document.createElement('div');
    card.className = 'card p-3 mb-2';
    const h = document.createElement('div');
    h.innerHTML = `<strong>${j.candidate || 'Unnamed'}</strong>`;
    const d = document.createElement('div');
    d.className = 'mt-2';
    field(d, 'Licence Number', j.licence_number);
    field(d, 'DVSA Ref', j.dvsa_ref);
    field(d, 'Notes', j.notes);
    field(d, 'Desired Centres', j.desired_centres);
    field(d, 'Desired Range', formatRangeNice(j.desired_range));
    card.appendChild(h);
    card.appendChild(d);
    el.appendChild(card);
  });
}

// Preferred Test Centres — RESTORE list + simple add/delete
async function loadCentres() {
  const el = document.getElementById('centres');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const data = await api('/api/test-centres', 'GET');
  const centres = data?.centres || data || [];
  el.innerHTML = '';
  if (!centres.length) { el.textContent = 'No centres defined yet.'; return; }

  const list = document.createElement('div');
  centres.forEach(c => {
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center justify-content-between border rounded p-2 mb-2';
    row.innerHTML = `<div>${c.name || c.id}</div>`;
    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-outline-danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      await api('/api/test-centres', 'POST', { action: 'delete', id: c.id || c.name });
      loadCentres();
    };
    row.appendChild(del);
    list.appendChild(row);
  });

  const ad = document.createElement('div');
  ad.className = 'd-flex gap-2 mt-3';
  ad.innerHTML = `<input id="newCentreName" class="form-control" placeholder="New centre name"><button id="btnAddCentre" class="btn btn-success">Add</button>`;
  el.appendChild(list);
  el.appendChild(ad);
  document.getElementById('btnAddCentre').onclick = async () => {
    const name = document.getElementById('newCentreName').value.trim();
    if (!name) return;
    await api('/api/test-centres', 'POST', { action: 'add', name });
    loadCentres();
  };
}

// Profile — RESTORE minimal profile (name, role, preferred centres list)
async function loadProfile() {
  const el = document.getElementById('profile');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const me = await api('/api/me', 'GET').catch(() => null);
  const data = await api('/api/test-centres', 'GET').catch(() => ({ centres: [] }));
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'card p-3';
  field(box, 'Name', me?.name || '—');
  field(box, 'Role', me?.role || '—');
  const covTitle = document.createElement('div');
  covTitle.className = 'mt-2 mb-1 fw-bold';
  covTitle.textContent = 'Preferred Centres';
  box.appendChild(covTitle);
  const ul = document.createElement('ul');
  (data?.centres || data || []).forEach(c => {
    const li = document.createElement('li');
    li.textContent = c.name || c.id;
    ul.appendChild(li);
  });
  box.appendChild(ul);
  el.appendChild(box);
}

// Bookers — RESTORE selection populates coverage
async function loadBookers() {
  const el = document.getElementById('bookers');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const list = await api('/api/admins/bookers', 'GET').catch(() => []);
  el.innerHTML = '';
  if (!Array.isArray(list) || !list.length) { el.textContent = 'No bookers found.'; return; }

  const sel = document.createElement('select');
  sel.className = 'form-select mb-3';
  sel.innerHTML = '<option value="">Select a booker…</option>' + list.map(b => `<option value="${b.token}">${b.name || b.token}</option>`).join('');
  const info = document.createElement('div');
  info.className = 'card p-3';
  el.appendChild(sel);
  el.appendChild(info);

  sel.onchange = () => {
    const t = sel.value;
    const b = list.find(x => String(x.token) === t);
    info.innerHTML = '';
    if (!b) return;
    field(info, 'Name', b.name || '—');
    field(info, 'Token', b.token || '—');
    const cov = document.createElement('div');
    cov.className = 'mt-2';
    const title = document.createElement('div');
    title.className = 'fw-bold';
    title.textContent = 'Coverage';
    cov.appendChild(title);
    const ul = document.createElement('ul');
    (b.coverage || []).forEach(id => {
      const li = document.createElement('li');
      li.textContent = id;
      ul.appendChild(li);
    });
    cov.appendChild(ul);
    info.appendChild(cov);
  };
}

// Admin Codes — RESTORE simple list
async function loadAdmins() {
  const el = document.getElementById('admins');
  if (!el) return;
  el.innerHTML = 'Loading…';
  const data = await api('/api/admin-codes', 'GET').catch(() => []);
  el.innerHTML = '';
  if (!Array.isArray(data) || !data.length) { el.textContent = 'No admin codes found.'; return; }

  const list = document.createElement('div');
  data.forEach(code => {
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center justify-content-between border rounded p-2 mb-2';
    row.innerHTML = `<div><strong>${code.code}</strong> - ${code.name} (${code.role})</div>`;
    list.appendChild(row);
  });
  el.appendChild(list);
}

/* ===== BOOT ===== */
function boot() {
  wireTopControls();
  wireUnlock();
  wireNav();
  setActiveTab(localStorage.getItem('activeTab') || 'centres'); // safe default
  console.log('[boot] controls+icons+tabs restored');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();