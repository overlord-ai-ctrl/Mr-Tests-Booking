// admin.js - Safe boot system for Mr Tests Admin
(function() {
  'use strict';

  // --- Error helpers
  function showErr(msg) {
    const e = document.getElementById('errBar');
    if (!e) return;
    e.textContent = msg || 'Something went wrong';
    e.classList.remove('d-none');
    setTimeout(() => e.classList.add('d-none'), 6000);
  }

  function showToast(msg) {
    try {
      console.log('TOAST:', msg);
    } catch {}
  }

  // --- Central AUTH
  const AUTH = (() => {
    const K_T = 'adminToken';
    const K_R = 'adminRole';
    const K_N = 'adminName';
    
    const get = k => {
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
      const r = await fetch('/api/me', { 
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

  // --- API wrapper
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

  // --- UI helpers
  function q(sel) {
    return document.querySelector(sel);
  }

  function setActiveTab(key) {
    // Remove active from all nav links
    document.querySelectorAll('#nav .nav-link').forEach(a => a.classList.remove('active'));
    // Add active to the selected one
    const active = document.querySelector(`[data-nav="${key}"]`);
    if (active) {
      active.classList.add('active');
      // Hide all content panels
      document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('d-none'));
      // Show the selected panel
      const panel = document.querySelector(`[data-panel="${key}"]`);
      if (panel) panel.classList.remove('d-none');
    }
  }

  // --- UI init
  function applyVisibility() {
    const isMaster = (AUTH.role() === 'master' || AUTH.token() === '1212');
    
    // Show/hide nav tabs by data-nav attr
    document.querySelectorAll('#nav .nav-link').forEach(a => 
      a.closest('li,.nav-item')?.classList.remove('d-none')
    );
    
    if (!isMaster) {
      ['admins', 'bookers'].forEach(k => {
        const el = document.querySelector(`[data-nav="${k}"]`);
        el?.closest('li,.nav-item')?.classList.add('d-none');
      });
    }
  }

  // --- Unlock function
  async function onUnlock() {
    const code = document.getElementById('unlockCode')?.value?.trim();
    if (!code) {
      showErr('Enter your admin code');
      return;
    }
    
    AUTH.saveToken(code);
    
    try {
      // Health quick ping (optional)
      await fetch('/health').catch(() => {});
      
      const me = await AUTH.me();
      showToast(`Welcome ${me?.name || ''}`);
      
      // Hide auth gate, show app
      const authGate = document.getElementById('authGate');
      const app = document.getElementById('app');
      if (authGate) authGate.hidden = true;
      if (app) app.hidden = false;
      
      applyVisibility();
      
      // Set default tab
      if (me?.role === 'master' || code === '1212') {
        setActiveTab('admins');
      } else {
        setActiveTab('jobs');
      }
      
      // Kick initial loads (if functions exist)
      if (typeof loadProfile === 'function') loadProfile();
      if (typeof loadJobs === 'function') loadJobs();
      if (typeof loadMyJobs === 'function') loadMyJobs();
      
    } catch (e) {
      showErr(e?.message || 'Unlock failed. Check your code.');
      // Clear bad token to avoid stuck Unauthorized
      AUTH.saveToken('');
    }
  }

  // --- Event wiring
  function wireEvents() {
    const b = document.getElementById('btnUnlock');
    if (b) b.onclick = onUnlock;
    
    const input = document.getElementById('unlockCode');
    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') onUnlock();
      });
    }

    const theme = document.getElementById('btnTheme');
    if (theme) {
      theme.onclick = () => {
        document.body.classList.toggle('theme-dark');
      };
    }

    const help = document.getElementById('btnHelp');
    if (help) {
      help.onclick = () => {
        alert('How it works:\n1) Enter your admin code\n2) Claim/Assign jobs\n3) Offer to client\n4) Complete');
      };
    }
  }

  // --- Boot function
  function boot() {
    wireEvents();
    
    // Show a visible message if JS is alive
    console.log('[admin] booted');
    
    // If a token exists from earlier, try auto-login
    if (AUTH.token()) {
      AUTH.me()
        .then(() => {
          applyVisibility();
          if (typeof loadProfile === 'function') loadProfile();
          if (typeof loadJobs === 'function') loadJobs();
          if (typeof loadMyJobs === 'function') loadMyJobs();
        })
        .catch(() => {
          // Token invalid, clear it
          AUTH.saveToken('');
        });
    }
  }

  // --- Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // --- Watchdog: if JS fails before boot, show an inline message
  setTimeout(() => {
    const unlock = document.getElementById('btnUnlock');
    if (unlock && !unlock.onclick) {
      const eb = document.getElementById('errBar');
      if (eb) {
        eb.textContent = 'UI failed to initialize. Try hard refresh (Shift+Reload).';
        eb.classList.remove('d-none');
      }
    }
  }, 1500);

  // --- Expose functions globally for compatibility
  window.AUTH = AUTH;
  window.api = api;
  window.showErr = showErr;
  window.showToast = showToast;
  window.setActiveTab = setActiveTab;
  window.applyVisibility = applyVisibility;

})();
