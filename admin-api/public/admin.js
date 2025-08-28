// ====== HARD RESET SAFE BOOT ======

const API_BASE = '/api';

function showErr(msg) {
  const e = document.getElementById('errBar');
  if (!e) return;
  e.textContent = msg || 'Something went wrong';
  e.classList.remove('d-none');
  setTimeout(() => e.classList.add('d-none'), 6000);
}

function showToast(msg) {
  try {
    console.log('[toast]', msg);
  } catch {}
}

const AUTH = (() => {
  const K_T = 'adminToken';
  const K_R = 'adminRole';
  const K_N = 'adminName';
  
  const get = (k) => {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  };
  
  const set = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  
  async function me() {
    const t = get(K_T);
    if (!t) throw new Error('No token');
    const r = await fetch(`${API_BASE}/me`, { 
      headers: { Authorization: `Bearer ${t}` } 
    });
    if (!r.ok) throw new Error('Unauthorized');
    const j = await r.json();
    if (j?.role) {
      set(K_R, j.role);
      if (j.name != null) set(K_N, j.name);
    }
    return j;
  }
  
  return {
    token() { return get(K_T); },
    saveToken(t) { set(K_T, String(t || '')); },
    role() { return get(K_R); },
    name() { return get(K_N); },
    me
  };
})();

async function api(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = AUTH.token();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  
  const res = await fetch(path, { 
    method, 
    headers, 
    body: method === 'GET' ? undefined : JSON.stringify(body || {}) 
  });
  
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {}
  
  if (!res.ok) {
    const msg = (data?.hint || data?.error || txt || `HTTP ${res.status}`);
    const e = new Error(msg);
    e.status = res.status;
    e.payload = data;
    throw e;
  }
  
  return data || {};
}

// NAV helpers
function setActiveTab(key) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('d-none'));
  document.querySelectorAll('#nav .nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(key)?.classList.remove('d-none');
  document.querySelector(`#nav .nav-link[data-nav="${key}"]`)?.classList.add('active');
  try {
    localStorage.setItem('activeTab', key);
  } catch {}
}

function applyVisibility() {
  // HARD RESET: do NOT hide tabs if auth fails; only refine after /api/me
  const isMaster = (AUTH.role() === 'master' || AUTH.token() === '1212');
  document.querySelectorAll('#nav .nav-link').forEach(a => 
    a.closest('li,.nav-item')?.classList.remove('d-none')
  );
  if (!isMaster) {
    // keep "Admins" and "Bookers" visible for now to avoid blank UI during auth flakiness
    // If you want to hide them for bookers later, re-enable this:
    // ['admins','bookers'].forEach(k=>document.querySelector(`[data-nav="${k}"]`)?.closest('li,.nav-item')?.classList.add('d-none'));
  }
}

// Minimal loaders (won't throw if API down)
async function safe(fn) {
  try {
    await fn();
  } catch (e) {
    showErr(e?.message || 'Load failed');
  }
}

async function loadJobs() {
  const page = document.getElementById('jobs');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading jobs...</div>';
  try {
    const data = await api('/api/jobs/board');
    page.innerHTML = `<div class="p-3">Found ${data.jobs?.length || 0} jobs</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load jobs</div>';
  }
}

async function loadMyJobs() {
  const page = document.getElementById('myjobs');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading my jobs...</div>';
  try {
    const data = await api('/api/jobs/mine');
    page.innerHTML = `<div class="p-3">Found ${data.jobs?.length || 0} my jobs</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load my jobs</div>';
  }
}

async function loadCentres() {
  const page = document.getElementById('centres');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading centres...</div>';
  try {
    const data = await api('/api/centres');
    page.innerHTML = `<div class="p-3">Found ${data.centres?.length || 0} centres</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load centres</div>';
  }
}

async function loadProfile() {
  const page = document.getElementById('profile');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading profile...</div>';
  try {
    const me = await AUTH.me();
    page.innerHTML = `<div class="p-3">Welcome ${me.name || 'User'}</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load profile</div>';
  }
}

async function loadAdmins() {
  const page = document.getElementById('admins');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading admin codes...</div>';
  try {
    const data = await api('/api/admin-codes');
    page.innerHTML = `<div class="p-3">Found ${data.codes?.length || 0} admin codes</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load admin codes</div>';
  }
}

async function loadBookers() {
  const page = document.getElementById('bookers');
  if (!page) return;
  page.innerHTML = '<div class="p-3">Loading bookers...</div>';
  try {
    const data = await api('/api/admins/bookers');
    page.innerHTML = `<div class="p-3">Found ${data.bookers?.length || 0} bookers</div>`;
  } catch (e) {
    page.innerHTML = '<div class="p-3 text-danger">Failed to load bookers</div>';
  }
}

// Wire nav clicks
function wireNav() {
  document.querySelectorAll('#nav .nav-link').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const k = a.getAttribute('data-nav');
      setActiveTab(k);
      switch (k) {
        case 'jobs': safe(loadJobs); break;
        case 'myjobs': safe(loadMyJobs); break;
        case 'centres': safe(loadCentres); break;
        case 'profile': safe(loadProfile); break;
        case 'admins': safe(loadAdmins); break;
        case 'bookers': safe(loadBookers); break;
      }
    };
  });
}

// Unlock flow
async function onUnlock() {
  const code = document.getElementById('unlockCode')?.value?.trim();
  if (!code) {
    showErr('Enter your admin code');
    return;
  }
  
  AUTH.saveToken(code);
  
  try {
    const me = await AUTH.me();
    showToast(`Welcome ${me?.name || ''}`);
    applyVisibility();
    setActiveTab(localStorage.getItem('activeTab') || 'jobs');
    safe(loadJobs);
    safe(loadMyJobs);
    safe(loadCentres);
    safe(loadProfile);
  } catch (e) {
    showErr(e?.message || 'Unlock failed. Check your code.');
  }
}

// Theme/help + Unlock button wiring
function wireChrome() {
  const btnU = document.getElementById('btnUnlock');
  if (btnU) btnU.onclick = onUnlock;
  
  const inp = document.getElementById('unlockCode');
  if (inp) {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') onUnlock();
    });
  }
  
  const th = document.getElementById('btnTheme');
  if (th) th.onclick = () => document.body.classList.toggle('theme-dark');
  
  const hp = document.getElementById('btnHelp');
  if (hp) hp.onclick = () => alert('Enter code → Use tabs → Work jobs.');
}

// Boot
function boot() {
  wireChrome();
  wireNav();
  applyVisibility();
  const last = localStorage.getItem('activeTab') || 'centres';
  setActiveTab(last);
  
  // Auto-try profile if token exists
  if (AUTH.token()) {
    AUTH.me()
      .then(() => {
        applyVisibility();
        safe(loadJobs);
        safe(loadMyJobs);
        safe(loadCentres);
        safe(loadProfile);
      })
      .catch(() => {
        // leave UI visible anyway
      });
  }
  
  console.log('[admin] boot ok');
}

// Run after DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Watchdog: if JS didn't bind Unlock, show visible error
setTimeout(() => {
  const b = document.getElementById('btnUnlock');
  if (b && !b.onclick) {
    showErr('UI failed to initialize. Try a hard refresh (Shift+Reload).');
  }
}, 1500);
