(() => {
  const q = (s) => document.querySelector(s);
  const API = ""; // same-origin
  let TOKEN = "";
  let ME = null;
  let currentCentresSha = null;
  let currentBinSha = null;
  let binLoaded = false;

  const status = (id, txt, ok=false) => {
    const el = q("#" + id);
    if (!el) return;
    el.textContent = txt || "";
    el.style.color = ok ? "green" : "#666";
  };
  const slug = (s) => s.toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");

  async function api(path, method="GET", body) {
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    const res = await fetch(API + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store"
    });
    if (!res.ok) { let t=""; try{t=await res.text();}catch{} throw new Error(`${method} ${path} ${res.status} ${t}`); }
    return res.json();
  }

  function isMaster() {
    const pages = ME?.pages || [];
    return pages.includes('*') || pages.includes('admins');
  }

  function applyVisibility() {
    if (ME?.name) { 
      q("#userName").textContent = ME.name; 
      q("#userRole").textContent = `(${ME.role || 'booker'})`;
      q("#userBox").hidden = false; 
    }
    const pages = ME?.pages || [];
    const all = pages.includes("*");
    document.querySelectorAll("[data-page]").forEach(sec => {
      const tag = sec.getAttribute("data-page") || "";
      sec.hidden = !all && !pages.includes(tag);
    });
  }

  function showNav() {
    const pages = ME?.pages || [];
    const all = pages.includes("*");
    const nav = document.getElementById("nav");
    if (!nav) return;
    const links = nav.querySelectorAll("a[data-nav]");
    let anyVisible = false;
    links.forEach(a => {
      const tag = a.getAttribute("data-nav");
      const can = all || pages.includes(tag);
      a.style.display = can ? "inline-flex" : "none";
      anyVisible ||= can;
      a.onclick = (e) => {
        e.preventDefault();
        document.querySelectorAll("a[data-nav]").forEach(x => x.classList.remove("active"));
        a.classList.add("active");
        document.querySelectorAll("[data-page]").forEach(sec => {
          sec.hidden = sec.getAttribute("data-page") !== tag;
        });
      };
    });
    nav.hidden = !anyVisible;
    // auto-select first visible link
    const first = Array.from(links).find(a => a.style.display !== "none");
    if (first) first.click();
  }

  async function unlock() {
    TOKEN = q("#token").value.trim();
    if (!TOKEN) return status("authStatus", "Code required");
    try {
      ME = await api("/api/me", "GET");
      sessionStorage.setItem("mrtests_admin_token", TOKEN);
      q("#authGate").hidden = true; q("#app").hidden = false;
      applyVisibility();
      showNav();
      status("authStatus", "Unlocked ✓", true);
      
      // Autoload everything permitted
      loadCentres();
      if (isMaster()) loadBin();
      loadProfile();
      loadProfileCentres();
      loadProfileStats();
      if (typeof loadCodes === 'function' && isMaster()) loadCodes();
      if (typeof loadJobs === 'function') loadJobs();
      if (typeof loadMyJobs === 'function') loadMyJobs();
    } catch (e) {
      console.error(e);
      status("authStatus", "Invalid code");
      TOKEN = ""; ME = null;
      q("#app").hidden = true; q("#authGate").hidden = false;
    }
  }

  // Utility for small icon button
  function iconButton(iconClass, title, onClick, extraClass='') {
    const b = document.createElement('button');
    b.className = `icon-btn ${extraClass}`.trim();
    b.title = title || '';
    b.innerHTML = `<i class="bi ${iconClass}"></i>`;
    b.onclick = onClick;
    return b;
  }

  // Toggle bin panel
  function toggleBin() {
    const panel = q('#binPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden') && !binLoaded && isMaster()) {
      loadBin();
      binLoaded = true;
    }
  }

  // Job row renderer
  function renderJobRow(j, actions=[]) {
    const row = document.createElement('div'); row.className='job-row';
    const title = document.createElement('div'); title.className='title';
    title.textContent = `${j.centre_name || j.centre_id} — ${j.candidate || ''}`;
    const meta = document.createElement('div'); meta.className='meta';
    meta.textContent = `ID:${j.id} · When:${j.when || ''} · Status:${j.status}`;
    row.append(title, meta);
    actions.forEach(btn => row.appendChild(btn));
    return row;
  }

  // Jobs Board
  async function loadJobs() {
    status('jobsStatus','Loading…');
    try {
      const res = await api('/api/jobs/board','GET');
      const list = document.getElementById('jobsList'); list.innerHTML='';
      const jobs = res.jobs || [];
      if (!jobs.length) { list.innerHTML='<div class="placeholder">No open jobs.</div>'; status('jobsStatus','Loaded',true); toggleJobCreate(); return; }
      const q = (document.getElementById('jobsSearch').value||'').toLowerCase();
      jobs.filter(j => (j.centre_name||'').toLowerCase().includes(q) || (j.candidate||'').toLowerCase().includes(q))
          .forEach(j => {
            const claim = document.createElement('button'); claim.textContent='Claim';
            claim.onclick = () => claimJob(j.id);
            const del = document.createElement('button'); del.textContent='Delete'; del.className='danger';
            del.onclick = () => deleteJob(j.id);
            const row = renderJobRow(j, isMaster()? [claim, del] : [claim]);
            list.appendChild(row);
          });
      status('jobsStatus','Loaded',true);
      toggleJobCreate();
    } catch(e){ console.error(e); status('jobsStatus','Failed to load'); }
  }

  function toggleJobCreate(){
    const el = document.getElementById('jobCreate');
    if (el) el.hidden = !isMaster();
  }

  async function claimJob(id){
    if(!confirm('Claim this job?')) return;
    try { await api('/api/jobs/claim','POST',{ job_id:id }); loadJobs(); loadMyJobs(); }
    catch(e){ alert('Failed to claim'); }
  }

  async function deleteJob(id){
    if(!isMaster()) return;
    if(!confirm('Delete this job?')) return;
    try { await api('/api/jobs/delete','POST',{ job_id:id }); loadJobs(); }
    catch(e){ alert('Failed to delete'); }
  }

  // My Jobs
  async function loadMyJobs(){
    status('myJobsStatus','Loading…');
    try{
      const res = await api('/api/jobs/mine','GET');
      const list = document.getElementById('myJobsList'); list.innerHTML='';
      const jobs = res.jobs || [];
      if(!jobs.length){ list.innerHTML='<div class="placeholder">You have no jobs.</div>'; status('myJobsStatus','Loaded',true); document.getElementById('earnings').textContent=''; return; }
      jobs.forEach(j=>{
        const actions=[];
        if(j.status==='claimed'){
          const complete=document.createElement('button'); complete.textContent='Mark completed';
          complete.onclick=()=>completeJob(j.id);
          const release=document.createElement('button'); release.textContent='Release';
          release.onclick=()=>releaseJob(j.id);
          actions.push(complete, release);
        }
        const row = renderJobRow(j, actions);
        list.appendChild(row);
      });
      document.getElementById('earnings').textContent = `£${res.total_due || 0} due (£${res.payout_per_job || 70} per completed)`;
      status('myJobsStatus','Loaded',true);
    }catch(e){ console.error(e); status('myJobsStatus','Failed'); }
  }

  async function completeJob(id){
    if(!confirm('Mark as completed?')) return;
    try{ await api('/api/jobs/complete','POST',{ job_id:id }); loadMyJobs(); }
    catch(e){ alert('Failed to complete'); }
  }
  
  async function releaseJob(id){
    if(!confirm('Release this job?')) return;
    try{ await api('/api/jobs/release','POST',{ job_id:id }); loadMyJobs(); loadJobs(); }
    catch(e){ alert('Failed to release'); }
  }

  async function loadCentres() {
    status("status", "Loading…");
    try {
      const data = await api("/api/test-centres", "GET");
      const centres = data.centres || [];
      currentCentresSha = data.sha;
      const box = q("#centresBox"); box.innerHTML = "";
      if (!centres.length) { box.innerHTML = '<div class="placeholder">No centres yet.</div>'; status("status","Loaded",true); return; }
      centres.forEach(c => {
        const row = document.createElement('div');
        row.className = 'row inline';
        const left = document.createElement('div');
        left.className = 'd-flex align-items-center gap-2';

        const nameEl = document.createElement('div');
        nameEl.textContent = c.name;

        const idBadge = document.createElement('span');
        idBadge.className = 'badge text-bg-light';
        idBadge.textContent = c.id;

        left.append(nameEl, idBadge);

        const right = document.createElement('div');
        right.className = 'd-flex align-items-center gap-2';
        if (isMaster()) {
          right.append(iconButton('bi-trash', 'Delete centre', () => deleteCentre(c.id), 'text-danger'));
        }
        row.append(left, right);
        box.appendChild(row);
      });
      status("status","Loaded",true);
      
      // Build coverage checklist after centres load
      buildCoverageChecklist(centres);
    } catch (e) { console.error(e); status("status","Failed to load"); }
  }

  async function deleteCentre(id) {
    if (!confirm(`Delete centre "${id}"?`)) return;
    status('status','Deleting…');
    try {
      await api('/api/test-centres','PUT',{ mode:'delete', ids:[id], sha: currentCentresSha });
      // remove from UI
      const box = document.getElementById('centresBox');
      [...box.querySelectorAll('.row')].forEach(row => {
        if (row.querySelector('.badge')?.textContent === id) row.remove();
      });
      status('status','Deleted ✓',true);
      // also uncheck/remove from My coverage
      const chk = document.querySelector(`#myCoverageBox input[value="${id}"]`);
      if (chk && chk.closest('.row')) chk.closest('.row').remove();
    } catch (e) { 
      console.error(e); 
      if (e.message.includes('409')) {
        status('status','Data changed—please reload');
      } else {
        status('status','Failed to delete'); 
      }
    }
  }

  async function buildCoverageChecklist(centres) {
    const box = document.getElementById('myCoverageBox');
    box.innerHTML = '<div class="placeholder">Loading my coverage…</div>';
    try {
      const mine = await api('/api/my-centres','GET');
      const selected = new Set((mine?.centres)||[]);
      box.innerHTML = '';
      centres.forEach(c => {
        const row = document.createElement('div');
        row.className = 'coverage-row';
        const left = document.createElement('div'); 
        left.className = 'coverage-name'; 
        left.textContent = c.name;
        const right = document.createElement('div'); 
        right.className = 'coverage-right';
        const chk = document.createElement('input'); 
        chk.type = 'checkbox'; 
        chk.name = 'myCoverage[]'; 
        chk.value = c.id; 
        chk.id = `cov-${c.id}`;
        if (selected.has(c.id)) chk.checked = true;
        const idBadge = document.createElement('span'); 
        idBadge.className = 'badge text-bg-light'; 
        idBadge.textContent = c.id;
        right.append(idBadge, chk);
        row.append(left, right);
        box.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<div class="placeholder">Failed to load coverage.</div>';
    }
  }

  async function saveCoverage() {
    const chosen = [...document.querySelectorAll('#myCoverageBox input[name="myCoverage[]"]:checked')].map(i=>i.value);
    status('coverageStatus','Saving…');
    try {
      await api('/api/my-centres','PUT',{ centres: chosen });
      status('coverageStatus','Saved ✓',true);
    } catch (e) { console.error(e); status('coverageStatus','Failed to save'); }
  }

  async function appendCentre() {
    const nameEl = q("#newName");
    const name = (nameEl.value||"").trim();
    if (!name) return status("appendStatus","Name required");
    const id = slug(name);
    status("appendStatus","Saving…");
    try {
      await api("/api/test-centres","PUT",{ mode:"append", centres:[{ id, name }] });
      const row = document.createElement("div"); row.className="row inline";
      const left = document.createElement("div"); left.className="d-flex align-items-center gap-2";
      const nameDiv = document.createElement("div"); nameDiv.textContent = name;
      const idSpan = document.createElement("span"); idSpan.className="badge text-bg-light"; idSpan.textContent = id;
      left.append(nameDiv, idSpan);
      
      const right = document.createElement('div');
      right.className = 'd-flex align-items-center gap-2';
      if (isMaster()) {
        right.append(iconButton('bi-trash', 'Delete centre', () => deleteCentre(id), 'text-danger'));
      }
      
      row.append(left, right);
      q("#centresBox").appendChild(row);
      nameEl.value=""; status("appendStatus","Appended & committed ✓", true);
      loadCentres(); // reload to reflect
    } catch (e) { console.error(e); status("appendStatus","Failed to append"); }
  }

  // Recycle bin functionality
  async function loadBin() {
    status("binStatus", "Loading…");
    try {
      const data = await api("/api/test-centres-bin", "GET");
      const centres = data.centres || [];
      currentBinSha = data.sha;
      const list = document.getElementById('binList'); list.innerHTML = "";
      if (!centres.length) { list.innerHTML = '<div class="placeholder">No deleted centres.</div>'; status("binStatus","Loaded",true); return; }
      centres.forEach(c => {
        const row = document.createElement('div'); 
        row.className = 'row inline';
        const left = document.createElement('div'); 
        left.className = 'd-flex align-items-center gap-2';
        const nameEl = document.createElement('div'); 
        nameEl.textContent = c.name;
        const idBadge = document.createElement('span'); 
        idBadge.className = 'badge text-bg-light'; 
        idBadge.textContent = c.id;
        left.append(nameEl, idBadge);
        const right = document.createElement('div'); 
        right.className = 'd-flex align-items-center gap-2';
        right.append(iconButton('bi-arrow-counterclockwise', 'Restore centre', () => restoreCentre(c.id), 'text-success'));
        row.append(left, right);
        list.appendChild(row);
      });
      status("binStatus","Loaded",true);
    } catch (e) { console.error(e); status("binStatus","Failed to load"); }
  }

  async function restoreCentre(id) {
    if (!confirm(`Restore centre "${id}"?`)) return;
    status('binStatus','Restoring…');
    try {
      await api('/api/test-centres','PUT',{ mode:'restore', ids:[id], sha: currentBinSha });
      // remove from bin UI
      const list = document.getElementById('binList');
      [...list.querySelectorAll('.row')].forEach(row => {
        if (row.querySelector('.badge')?.textContent === id) row.remove();
      });
      status('binStatus','Restored ✓',true);
    } catch (e) { 
      console.error(e); 
      if (e.message.includes('409')) {
        status('binStatus','Data changed—please reload');
      } else {
        status('binStatus','Failed to restore'); 
      }
    }
  }

  // Profile functionality
  async function loadProfile() {
    try {
      const prof = await api('/api/my-profile','GET').catch(()=>({}));
      // availability pill UI (green/red)
      const available = !!prof.available;
      const pill = document.querySelector('#profileAvailablePill');
      if (!pill) {
        const cont = document.querySelector('.profile-sub');
        const pillEl = document.createElement('span');
        pillEl.id = 'profileAvailablePill';
        pillEl.className = 'av-pill ' + (available ? 'av-on' : 'av-off');
        pillEl.textContent = available ? 'Available' : 'Unavailable';
        cont?.appendChild(pillEl);
      } else {
        pill.className = 'av-pill ' + (available ? 'av-on' : 'av-off');
        pill.textContent = available ? 'Available' : 'Unavailable';
      }
      // Set checkbox (kept for Save)
      const chk = document.getElementById('profileAvailable'); if (chk) chk.checked = available;

      // Name/role from ME
      document.getElementById('profileName').textContent = ME?.name || 'Admin';
      document.getElementById('profileRole').textContent = (ME?.role) || (isMaster()? 'master':'booker');

      // Notes
      const notes = document.getElementById('profileNotes');
      if (notes) notes.value = prof.notes || '';
    } catch (e) {
      console.error(e);
      status("profileStatus", "Failed to load profile");
    }
  }

  async function loadProfileCentres(){
    try{
      const mine = await api('/api/my-centres','GET');
      const ids = new Set(mine?.centres || []);
      const res = await api('/api/test-centres','GET');
      const centres = res?.centres || [];
      const ul = document.getElementById('profileCentres');
      if (!ul) return;
      ul.innerHTML = '';
      centres.forEach(c => { if (ids.has(c.id)) {
        const li = document.createElement('li');
        li.textContent = c.name + ' ';
        const b = document.createElement('span'); b.className='badge text-bg-light'; b.textContent=c.id;
        li.appendChild(b);
        ul.appendChild(li);
      }});
    }catch(e){
      const ul = document.getElementById('profileCentres');
      if (ul) ul.innerHTML = '<li class="placeholder">Could not load preferred centres.</li>';
    }
  }

  async function loadProfileStats() {
    try {
      const stats = await api('/api/jobs/stats','GET');
      q("#profileLifetime").textContent = stats.completed_all_time || 0;
    } catch (e) {
      console.error(e);
      q("#profileLifetime").textContent = "0";
    }
  }

  async function saveMyProfile() {
    const body = {
      notes: (document.getElementById('profileNotes')?.value || '').trim(),
      available: !!document.getElementById('profileAvailable')?.checked
    };
    await api('/api/my-profile','PUT', body);
    // update pill visual
    const available = body.available;
    const pill = document.getElementById('profileAvailablePill');
    if (pill) { pill.className = 'av-pill ' + (available? 'av-on' : 'av-off'); pill.textContent = available ? 'Available' : 'Unavailable'; }
    status("profileStatus", "Saved ✓", true);
  }

  function renderCodesList(map) {
    const list = document.getElementById('codesList'); list.innerHTML='';
    const entries = Object.entries(map);
    if (!entries.length) { list.innerHTML = '<div class="placeholder">No codes yet.</div>'; return; }
    entries.forEach(([code, info])=>{
      const row = document.createElement('div'); row.className = 'code-row';
      const name = document.createElement('div'); name.textContent = info?.name || 'Admin';
      const codeBadge = document.createElement('span'); codeBadge.className='badge text-bg-light'; codeBadge.textContent=code;
      const roleBadge = document.createElement('span'); roleBadge.className='badge text-bg-primary'; roleBadge.textContent = info?.role || ((info?.pages||[]).includes('*') ? 'master' : 'booker');
      const spacer = document.createElement('div'); spacer.className='spacer';
      row.append(name, codeBadge, roleBadge, spacer);
      if (isMaster()) {
        row.append(iconButton('bi-trash', 'Delete admin', ()=>deleteAdminCode(code), 'text-danger'));
      }
      list.appendChild(row);
    });
  }

  async function deleteAdminCode(code) {
    if (!confirm(`Delete admin code "${code}"?`)) return;
    status('codesStatus','Deleting…');
    try {
      await api('/api/admin-codes','PUT',{ mode:'delete', code });
      status('codesStatus','Deleted ✓',true);
      // refresh list
      loadCodes();
    } catch (e) { console.error(e); status('codesStatus','Failed to delete'); }
  }

  async function loadCodes() {
    status("codesStatus","Loading…");
    try {
      const data = await api("/api/admin-codes","GET");
      const map = data.codes || {};
      renderCodesList(map);
      status("codesStatus","Loaded",true);
    } catch (e) { console.error(e); status("codesStatus","Failed to load"); }
  }

  async function addCode() {
    const code = document.getElementById("newCode").value.trim();
    const name = document.getElementById("newAdminName").value.trim();
    const role = document.getElementById("newRole").value;
    if (!code) return status("addCodeStatus","Code required");
    if (!name) return status("addCodeStatus","Name required");
    status("addCodeStatus","Saving…");
    try {
      await api("/api/admin-codes","PUT",{ mode:"append", code, name, role });
      status("addCodeStatus","Added ✓",true);
      document.getElementById("newCode").value = "";
      document.getElementById("newAdminName").value = "";
      document.getElementById("newRole").value = "booker";
      loadCodes();
    } catch (e) { console.error(e); status("addCodeStatus","Failed to add"); }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const saved = sessionStorage.getItem("mrtests_admin_token");
    if (saved) { q("#token").value = saved; }
    q("#unlock").onclick = unlock;
    q("#append").onclick = appendCentre;
    q("#saveProfile").onclick = saveMyProfile;
    document.getElementById("addCode").onclick = addCode;
    document.getElementById('saveCoverage').onclick = saveCoverage;
    
    // Toggle bin
    q("#toggleBin").onclick = toggleBin;
    
    // Jobs Board event handlers
    document.getElementById('jobsSearch').oninput = loadJobs;
    document.getElementById('createJob').onclick = async ()=>{
      const payload = {
        centre_id: document.getElementById('jobCentreId').value.trim(),
        centre_name: document.getElementById('jobCentreName').value.trim(),
        when: document.getElementById('jobWhen').value.trim(),
        candidate: document.getElementById('jobCandidate').value.trim(),
        notes: document.getElementById('jobNotes').value.trim()
      };
      if(!payload.centre_id || !payload.centre_name) return status('createJobStatus','Centre required');
      status('createJobStatus','Creating…');
      try { 
        await api('/api/jobs/create','POST',{ job: payload }); 
        status('createJobStatus','Created ✓',true);
        document.getElementById('jobCentreId').value=''; 
        document.getElementById('jobCentreName').value='';
        document.getElementById('jobWhen').value=''; 
        document.getElementById('jobCandidate').value=''; 
        document.getElementById('jobNotes').value='';
        loadJobs();
      } catch(e){ status('createJobStatus','Failed'); }
    };
    
    if (saved) unlock();
  });
})();
