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

    // Now it's safe to load protected data:
    if (typeof setActiveTab==='function') setActiveTab('jobs');
    if (typeof loadJobs==='function') loadJobs();
    if (typeof loadMyJobs==='function') loadMyJobs();
    if (typeof loadProfile==='function') loadProfile();
    if (typeof loadCentres==='function') loadCentres();
  } catch(e){
    setText('unlockStatus', e?.message || 'Unlock failed. Check your code.', 'error');
    // Keep the code in the box so user can edit and retry
  } finally {
    btn.disabled = false;
  }
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