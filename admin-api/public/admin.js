const API_BASE = '/api';

function setText(id,msg,cls){
  const el=document.getElementById(id); if(!el) return;
  el.textContent = msg || '';
  if (id==='unlockStatus') el.className = cls || '';
}

// Auth store (no auto calls)
const AUTH = (()=> {
  const K_T='adminToken', K_R='adminRole', K_N='adminName';
  const get=(k)=>{ try{return localStorage.getItem(k)||'';}catch{return '';} };
  const set=(k,v)=>{ try{localStorage.setItem(k,v);}catch{} };
  return {
    saveToken:(t)=>set(K_T,String(t||'')),
    token:()=>get(K_T),
    role:()=>get(K_R),
    setProfile:(p)=>{ if(p?.role) set(K_R,p.role); if(p?.name!=null) set(K_N,p.name); }
  };
})();

// One API wrapper used AFTER unlock
async function api(path, method='GET', body){
  const headers={'Content-Type':'application/json'};
  const tok = AUTH.token();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(path, { method, headers, body: method==='GET'?undefined:JSON.stringify(body||{}) });
  const txt = await res.text(); let data=null; try{ data = txt? JSON.parse(txt):null; }catch{}
  if(!res.ok){ const msg=(data?.hint||data?.error||txt||`HTTP ${res.status}`); const e=new Error(msg); e.status=res.status; e.payload=data; throw e; }
  return data||{};
}

// Unlock: ONLY here we start auth
async function onUnlock(){
  const inp=document.getElementById('unlockCode');
  const btn=document.getElementById('btnUnlock');
  const code=(inp?.value||'').trim();
  if(!code){ setText('unlockStatus','Enter your admin code','error'); return; }

  btn.disabled = true;
  setText('unlockStatus','Checking code…','');

  AUTH.saveToken(code);

  try{
    // verify token AFTER user enters it
    const me = await fetch(`${API_BASE}/me`, { headers:{ Authorization:`Bearer ${code}` } }).then(r=>{
      if(!r.ok) throw new Error('Unauthorized'); return r.json();
    });
    AUTH.setProfile(me);
    setText('unlockStatus', `Welcome ${me?.name||''} (${me?.role||'user'})`, 'ok');

    // Show the main app interface
    console.log('[onUnlock] About to call showApp with:', me);
    showApp(me);
  } catch(e){
    setText('unlockStatus', e?.message || 'Unlock failed. Check your code.', 'error');
    // Keep the code in the box so user can edit and retry
  } finally {
    btn.disabled = false;
  }
}

// Show the main app interface after successful unlock
function showApp(me) {
  console.log('[showApp] Starting showApp with:', me);
  
  // Hide unlock panel
  const unlockPanel = document.getElementById('unlockPanel');
  console.log('[showApp] unlockPanel found:', !!unlockPanel);
  if (unlockPanel) unlockPanel.style.display = 'none';
  
  // Show main app
  const app = document.getElementById('app');
  console.log('[showApp] app found:', !!app);
  if (app) {
    app.hidden = false;
    console.log('[showApp] app hidden set to false');
  }
  
  // Show user info
  const userBox = document.getElementById('userBox');
  const userName = document.getElementById('userName');
  const userRole = document.getElementById('userRole');
  
  console.log('[showApp] userBox found:', !!userBox);
  if (userBox) userBox.hidden = false;
  if (userName) userName.textContent = me?.name || 'User';
  if (userRole) {
    userRole.textContent = me?.role || 'user';
    userRole.removeAttribute('style'); // Remove display:none
  }
  
  // Set up basic tab navigation
  console.log('[showApp] Setting up tabs...');
  setupTabs();
  
  // Load initial data
  console.log('[showApp] Loading initial data...');
  loadInitialData();
}

// Basic tab setup
function setupTabs() {
  const navLinks = document.querySelectorAll('[data-nav]');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = link.getAttribute('data-nav');
      setActiveTab(target);
    });
  });
}

// Set active tab
function setActiveTab(key) {
  console.log('[setActiveTab] Setting active tab to:', key);
  
  // Update nav links
  const navLinks = document.querySelectorAll('[data-nav]');
  console.log('[setActiveTab] Found nav links:', navLinks.length);
  navLinks.forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-nav') === key);
  });
  
  // Show/hide panels
  const panels = document.querySelectorAll('[data-page]');
  console.log('[setActiveTab] Found panels:', panels.length);
  panels.forEach(panel => {
    const panelKey = panel.getAttribute('data-page');
    const shouldShow = panelKey === key;
    panel.hidden = !shouldShow;
    console.log('[setActiveTab] Panel', panelKey, 'hidden:', !shouldShow);
  });
  
  // Load data for the active tab
  switch(key) {
    case 'jobs':
      loadJobs();
      break;
    case 'myjobs':
      loadMyJobs();
      break;
    case 'profile':
      loadProfile();
      break;
    case 'centres':
      loadCentres();
      break;
    case 'admins':
      loadAdmins();
      break;
    case 'bookers':
      loadBookers();
      break;
  }
}

// Load initial data
function loadInitialData() {
  // Start with jobs tab
  setActiveTab('jobs');
}

// Placeholder functions for data loading
async function loadJobs() {
  const list = document.getElementById('jobsList');
  if (list) list.innerHTML = '<div class="placeholder">Loading jobs...</div>';
  // TODO: Implement actual job loading
}

async function loadMyJobs() {
  const list = document.getElementById('myJobsList');
  if (list) list.innerHTML = '<div class="placeholder">Loading your jobs...</div>';
  // TODO: Implement actual my jobs loading
}

async function loadProfile() {
  // TODO: Implement profile loading
}

async function loadCentres() {
  // TODO: Implement centres loading
}

async function loadAdmins() {
  const list = document.getElementById('codesList');
  if (list) list.innerHTML = '<div class="placeholder">Loading admin codes...</div>';
  // TODO: Implement admin codes loading
}

async function loadBookers() {
  // TODO: Implement bookers loading
}

// Wire only Unlock events; NO other loaders at boot
function boot(){
  const btn=document.getElementById('btnUnlock');
  const inp=document.getElementById('unlockCode');
  if (btn) btn.onclick = onUnlock;
  if (inp) inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter') onUnlock(); });

  // Optional: show that JS is alive by pinging public endpoint (no auth)
  fetch(`${API_BASE}/ping`).catch(()=>{});
  console.log('[admin] no-auth landing ready');
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();