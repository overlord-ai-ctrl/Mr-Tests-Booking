const API_BASE = '/api';

function setText(id,msg,cls){ 
  const el=document.getElementById(id); 
  if(!el) return; 
  el.textContent = msg||''; 
  if(id==='unlockStatus') el.className = cls||''; 
}

const AUTH = (()=> {
  const K_T='adminToken', K_R='adminRole', K_N='adminName';
  const get=(k)=>{ try{return localStorage.getItem(k)||'';}catch{return '';} };
  const set=(k,v)=>{ try{localStorage.setItem(k,v);}catch{} };
  async function me(){
    const t = get(K_T); if(!t) throw new Error('No token');
    const r = await fetch(`${API_BASE}/me`,{ headers:{ Authorization:`Bearer ${t}` }});
    if(!r.ok) throw new Error('Unauthorized');
    const j = await r.json(); if(j?.role){ set(K_R,j.role); if(j.name!=null) set(K_N,j.name); }
    return j;
  }
  return { saveToken:(t)=>set(K_T,String(t||'')), token:()=>get(K_T), role:()=>get(K_R), name:()=>get(K_N), me };
})();

async function api(path, method='GET', body){
  const headers={'Content-Type':'application/json'};
  const tok = AUTH.token(); if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(path,{ method, headers, body: method==='GET'?undefined:JSON.stringify(body||{}) });
  const txt = await res.text(); let data=null; try{ data = txt? JSON.parse(txt):null; }catch{}
  if(!res.ok){ const msg=(data?.hint||data?.error||txt||`HTTP ${res.status}`); const e=new Error(msg); e.status=res.status; e.payload=data; throw e; }
  return data||{};
}

function isMaster(){ return (AUTH.role()==='master' || AUTH.token()==='1212'); }

function applyVisibility(){
  // Restore tabs first; then hide master-only AFTER successful unlock.
  document.querySelectorAll('#nav .nav-link').forEach(a=>a.closest('li,.nav-item')?.classList.remove('d-none'));
  if (!isMaster()){
    ['admins','bookers'].forEach(k=>{
      const el = document.querySelector(`[data-nav="${k}"]`)?.closest('li,.nav-item') || document.querySelector(`[data-nav="${k}"]`);
      el?.classList.add('d-none');
    });
  }
}

function setActiveTab(key){
  console.log('[tab]', key);
  // Hide all pages using [data-page] attribute
  document.querySelectorAll('[data-page]').forEach(p=>p.classList.add('d-none'));
  // Remove active from all nav links
  document.querySelectorAll('#nav .nav-link').forEach(a=>a.classList.remove('active'));
  // Show selected page and activate nav link
  document.querySelector(`[data-page="${key}"]`)?.classList.remove('d-none');
  document.querySelector(`#nav .nav-link[data-nav="${key}"]`)?.classList.add('active');
  try{ localStorage.setItem('activeTab', key); }catch{}
}

/* RESTORE: wire Unlock + Theme + Help */
async function onUnlock(){
  const btn=document.getElementById('btnUnlock');
  const inp=document.getElementById('unlockCode');
  const code=(inp?.value||'').trim();
  if(!code){ setText('unlockStatus','Enter your admin code','error'); return; }
  btn.disabled=true; setText('unlockStatus','Checking code…','');

  AUTH.saveToken(code);
  try{
    const me = await AUTH.me(); // calls /api/me with Bearer token
    setText('unlockStatus', `Welcome ${me?.name||''} (${me?.role||'user'})`,'ok');
    
    // Hide unlock panel and show main app
    const unlockPanel = document.getElementById('unlockPanel');
    if (unlockPanel) unlockPanel.style.display = 'none';
    
    const app = document.getElementById('app');
    if (app) app.hidden = false;
    
    // Show user info
    const userBox = document.getElementById('userBox');
    const userName = document.getElementById('userName');
    const userRole = document.getElementById('userRole');
    if (userBox) userBox.hidden = false;
    if (userName) userName.textContent = me?.name || 'User';
    if (userRole) {
      userRole.textContent = me?.role || 'user';
      userRole.removeAttribute('style');
    }
    
    applyVisibility();
    setActiveTab('jobs');
    // Kick data loads if the functions exist (don't add new features)
    if (typeof loadProfile==='function')  loadProfile();
    if (typeof loadCentres==='function')  loadCentres();
    if (typeof loadJobs==='function')     loadJobs();
    if (typeof loadMyJobs==='function')   loadMyJobs();
  }catch(e){
    setText('unlockStatus', e?.message || 'Unlock failed. Check your code.','error');
  }finally{ btn.disabled=false; }
}

function wireChrome(){
  const btn=document.getElementById('btnUnlock'); if(btn) btn.onclick=onUnlock;
  const inp=document.getElementById('unlockCode'); if(inp) inp.addEventListener('keydown', e=>{ if(e.key==='Enter') onUnlock(); });
  const th=document.getElementById('btnTheme'); if(th) th.onclick=()=>document.body.classList.toggle('theme-dark');  // RESTORED
  const hp=document.getElementById('btnHelp');  if(hp) hp.onclick=()=>alert('Help:\n1) Enter code\n2) Use tabs\n3) Claim/Assign → Offer → Confirm/Complete'); // RESTORED
}

/* RESTORE: wire nav clicks (do not remove existing loaders) */
function wireNav(){
  document.querySelectorAll('#nav .nav-link').forEach(a=>{
    a.onclick=(e)=>{ e.preventDefault(); const k=a.getAttribute('data-nav'); setActiveTab(k);
      if (k==='profile' && typeof loadProfile==='function') loadProfile();
      else if (k==='centres' && typeof loadCentres==='function') loadCentres();
      else if (k==='jobs' && typeof loadJobs==='function') loadJobs();
      else if (k==='myjobs' && typeof loadMyJobs==='function') loadMyJobs();
      else if (k==='admins' && typeof loadAdmins==='function') loadAdmins();
      else if (k==='bookers' && typeof loadBookers==='function') loadBookers();
    };
  });
}

/* Restore boot: NO auth on load; only wire UI */
function boot(){
  wireChrome();
  wireNav();
  // Show unlock panel by default - no auto-unlock
  console.log('[admin] boot complete - unlock required');
}
if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();

/* Watchdog: if unlock isn't bound, show a visible error */
setTimeout(()=>{ const b=document.getElementById('btnUnlock'); if(b && !b.onclick){ setText('unlockStatus','UI failed to initialise. Hard refresh.', 'error'); }}, 1500);

// ===== DATA LOADING FUNCTIONS =====

async function loadJobs() {
  const list = document.getElementById('jobsList');
  if (!list) return;
  
  try {
    list.innerHTML = '<div class="placeholder">Loading jobs...</div>';
    const data = await api('/api/jobs/board');
    
    if (!data.jobs || data.jobs.length === 0) {
      list.innerHTML = '<div class="placeholder">No jobs available</div>';
      return;
    }
    
    list.innerHTML = data.jobs.map(job => `
      <div class="job-card">
        <div>
          <div class="job-title">${job.candidate || 'Unknown Candidate'}</div>
          <div class="job-meta">${job.desired_centres || 'No centres specified'}</div>
        </div>
        <div class="job-actions">
          <span class="badge badge-open">Open</span>
          <button class="btn btn-sm btn-primary" onclick="claimJob('${job.id}')">Claim</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="placeholder">Error loading jobs: ${error.message}</div>`;
  }
}

async function loadMyJobs() {
  const list = document.getElementById('myJobsList');
  if (!list) return;
  
  try {
    list.innerHTML = '<div class="placeholder">Loading your jobs...</div>';
    const data = await api('/api/jobs/mine');
    
    if (!data.jobs || data.jobs.length === 0) {
      list.innerHTML = '<div class="placeholder">No jobs claimed</div>';
      return;
    }
    
    list.innerHTML = data.jobs.map(job => `
      <div class="job-card">
        <div>
          <div class="job-title">${job.candidate || 'Unknown Candidate'}</div>
          <div class="job-meta">Status: ${job.status || 'unknown'}</div>
        </div>
        <div class="job-actions">
          <span class="badge badge-claimed">Claimed</span>
          <button class="btn btn-sm btn-success" onclick="completeJob('${job.id}')">Complete</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="placeholder">Error loading your jobs: ${error.message}</div>`;
  }
}

async function loadProfile() {
  try {
    const data = await api('/api/my-profile');
    
    const profileName = document.getElementById('profileName');
    const profileRole = document.getElementById('profileRole');
    const profileNotes = document.getElementById('profileNotes');
    const profileAvailable = document.getElementById('profileAvailable');
    
    if (profileName) profileName.textContent = data.name || 'Unknown';
    if (profileRole) profileRole.textContent = data.role || 'user';
    if (profileNotes) profileNotes.value = data.notes || '';
    if (profileAvailable) profileAvailable.checked = data.available !== false;
    
    // Load profile centres
    const profileCentres = document.getElementById('profileCentres');
    if (profileCentres && data.centres) {
      profileCentres.innerHTML = data.centres.map(centre => 
        `<li>${centre}</li>`
      ).join('');
    }
  } catch (error) {
    console.error('Error loading profile:', error);
  }
}

async function loadCentres() {
  const list = document.getElementById('centresBox');
  if (!list) return;
  
  try {
    list.innerHTML = '<div class="placeholder">Loading centres...</div>';
    const data = await api('/api/test-centres');
    
    if (!data.centres || data.centres.length === 0) {
      list.innerHTML = '<div class="placeholder">No centres available</div>';
      return;
    }
    
    list.innerHTML = data.centres.map(centre => `
      <div class="row inline">
        <span>${centre.name}</span>
        <div class="coverage-right">
          <input type="checkbox" class="form-check-input" id="centre-${centre.id}" />
          <label for="centre-${centre.id}" class="form-check-label">Coverage</label>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="placeholder">Error loading centres: ${error.message}</div>`;
  }
}

async function loadAdmins() {
  const list = document.getElementById('codesList');
  if (!list) return;
  
  try {
    list.innerHTML = '<div class="placeholder">Loading admin codes...</div>';
    const data = await api('/api/admin-codes');
    
    if (!data.codes || Object.keys(data.codes).length === 0) {
      list.innerHTML = '<div class="placeholder">No admin codes</div>';
      return;
    }
    
    list.innerHTML = Object.entries(data.codes).map(([code, info]) => `
      <div class="code-row">
        <span class="fw-semibold">${code}</span>
        <span>${info.name || 'Unknown'}</span>
        <span class="badge">${info.role || 'user'}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteAdmin('${code}')">Delete</button>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="placeholder">Error loading admin codes: ${error.message}</div>`;
  }
}

async function loadBookers() {
  const picker = document.getElementById('bookerPicker');
  const meta = document.getElementById('bookerMeta');
  const jobs = document.getElementById('bookerJobs');
  
  if (!picker) return;
  
  try {
    const data = await api('/api/admins/bookers');
    
    if (!data.bookers || data.bookers.length === 0) {
      picker.innerHTML = '<option>No bookers available</option>';
      return;
    }
    
    picker.innerHTML = data.bookers.map(booker => 
      `<option value="${booker.token}">${booker.name} (${booker.role})</option>`
    ).join('');
    
    // Wire booker selection
    picker.onchange = async () => {
      const token = picker.value;
      if (!token) return;
      
      try {
        const bookerData = await api(`/api/admins/bookers/${token}/jobs`);
        if (meta) meta.innerHTML = `<div class="badge">${bookerData.jobs?.length || 0} jobs</div>`;
        if (jobs) jobs.innerHTML = bookerData.jobs?.map(job => 
          `<div class="job-card"><div class="job-title">${job.candidate}</div></div>`
        ).join('') || '<div class="placeholder">No jobs</div>';
      } catch (error) {
        console.error('Error loading booker jobs:', error);
      }
    };
  } catch (error) {
    picker.innerHTML = '<option>Error loading bookers</option>';
  }
}

// ===== JOB ACTIONS =====

async function claimJob(jobId) {
  try {
    await api(`/api/jobs/claim`, 'POST', { jobId });
    await loadJobs();
    await loadMyJobs();
  } catch (error) {
    alert(`Error claiming job: ${error.message}`);
  }
}

async function completeJob(jobId) {
  try {
    await api(`/api/jobs/complete`, 'POST', { jobId });
    await loadMyJobs();
  } catch (error) {
    alert(`Error completing job: ${error.message}`);
  }
}

async function deleteAdmin(code) {
  if (!confirm(`Delete admin code ${code}?`)) return;
  try {
    await api('/api/admin-codes', 'PUT', { action: 'delete', code });
    await loadAdmins();
  } catch (error) {
    alert(`Error deleting admin: ${error.message}`);
  }
}