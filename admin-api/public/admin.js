(() => {
  const q = (s) => document.querySelector(s);
  const API = ""; // same-origin
  let TOKEN = "";
  let ME = null;
  let currentCentresSha = null;
  let currentBinSha = null;
  let binLoaded = false;
  let COVERAGE = new Set(); // Coverage centre IDs for filtering
  
  // Helper to normalize centre IDs (same as server)
  function normCentreId(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  const status = (id, txt, ok=false) => {
    const el = q("#" + id);
    if (!el) return;
    el.textContent = txt || "";
    el.style.color = ok ? "green" : "#666";
  };
  const slug = (s) => s.toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");

  // --- Toast helper ---
  function showToast(msg, type='info', timeout=1200) {
    const box = document.getElementById('toasty'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'toasty-item' + (type==='success'?' success': type==='warn'?' warn': type==='error'?' error':'');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(()=>{ el.remove(); }, timeout);
  }

  // --- Debounce utility ---
  function debounce(fn, wait=300) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(()=>fn(...args), wait); };
  }

  // Keep one AbortController per loader to cancel in-flight fetches
  let _jobsAC = null;
  let _myJobsAC = null;

  // Wrap fetch with abort support
  async function fetchWithAbort(url, options, controllerRefSetter) {
    if (controllerRefSetter && typeof controllerRefSetter === 'function') {
      // Cancel previous
      controllerRefSetter('cancel');
    }
    const ac = new AbortController();
    if (controllerRefSetter) controllerRefSetter(ac);
    const res = await fetch(url, { ...(options||{}), signal: ac.signal });
    return res;
  }

  // Controller setters
  function setJobsAC(x){ if (x==='cancel' && _jobsAC) { try{_jobsAC.abort();}catch{} } else { _jobsAC = x; } }
  function setMyJobsAC(x){ if (x==='cancel' && _myJobsAC) { try{_myJobsAC.abort();}catch{} } else { _myJobsAC = x; } }

  // Dark mode management
  const DarkMode = (() => {
    const toggle = document.getElementById('darkModeToggle');
    const isDark = () => document.body.classList.contains('dark');
    
    const updateToggle = () => {
      toggle.textContent = isDark() ? '☀️' : '🌙';
      toggle.title = isDark() ? 'Switch to light mode' : 'Switch to dark mode';
    };
    
    const toggleMode = () => {
      document.body.classList.toggle('dark');
      localStorage.setItem('mrtests_dark_mode', isDark());
      updateToggle();
    };
    
    // Initialize
    if (localStorage.getItem('mrtests_dark_mode') === 'true') {
      document.body.classList.add('dark');
    }
    updateToggle();
    
    return { toggleMode, updateToggle };
  })();

  // Error handling system
  const ErrorHandler = (() => {
    const errorBanner = document.getElementById('netErr');
    const retryBtn = document.getElementById('retryBtn');
    let lastFailedRequest = null;
    
    const showError = () => {
      errorBanner.classList.remove('d-none');
    };
    
    const hideError = () => {
      errorBanner.classList.add('d-none');
    };
    
    const setLastRequest = (fn) => {
      lastFailedRequest = fn;
    };
    
    const retry = () => {
      if (lastFailedRequest) {
        hideError();
        lastFailedRequest();
      }
    };
    
    retryBtn.onclick = retry;
    
    return { showError, hideError, setLastRequest };
  })();

  // Enhanced API with error handling and rate limit backoff
  async function api(path, method="GET", body) {
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    
    const makeRequest = async () => {
      const res = await fetch(API + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store"
      });
      
      if (!res.ok) {
        let errorText = "";
        try { errorText = await res.text(); } catch {}
        
        // Handle rate limiting
        if (res.status === 429) {
          const errorData = JSON.parse(errorText || '{}');
          const retryAfter = errorData.retry_after || 3;
          showToast(`Rate limited, retrying in ${retryAfter}s...`, 'warn');
          
          // Wait and retry once
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return makeRequest();
        }
        
        throw new Error(`${method} ${path} ${res.status} ${errorText}`);
      }
      
      ErrorHandler.hideError();
      return res.json();
    };
    
    try {
      return await makeRequest();
    } catch (e) {
      console.error('API error:', e);
      ErrorHandler.showError();
      ErrorHandler.setLastRequest(() => api(path, method, body));
      throw e;
    }
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
      let can = all || pages.includes(tag);
      
      // Hide Admin Codes for non-master users
      if (tag === 'admins' && !isMaster()) {
        can = false;
      }
      
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
      
      // Defer jobs loads to active tab only
      const firstTab = document.querySelector('#nav .nav-link.active')?.dataset?.nav || 'centres';
      if (firstTab === 'jobs') loadJobs?.();
      if (firstTab === 'myjobs') loadMyJobs?.();
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

  // Utility: status badge
  function statusBadge(st) {
    const s = String(st||'').toLowerCase();
    const span = document.createElement('span');
    span.className = 'badge';
    if (s === 'completed') { span.classList.add('badge-completed'); span.textContent = 'Completed'; }
    else if (s === 'claimed') { span.classList.add('badge-claimed'); span.textContent = 'Claimed'; }
    else { span.classList.add('badge-open'); span.textContent = 'Open'; }
    return span;
  }

  // Utility: build a job card
  function renderJobCard(j, actions=[]) {
    const card = document.createElement('div'); card.className = 'job-card';
    const title = document.createElement('div'); title.className = 'job-title';
    title.textContent = `${j.centre_name || j.centre_id || '—'} — ${j.candidate || ''}`;
    const meta = document.createElement('div'); meta.className = 'job-meta';
    const when = j.when ? `· ${j.when}` : '';
    meta.textContent = `ID:${j.id} ${when}`;
    const right = document.createElement('div'); right.className = 'job-actions';
    right.append(statusBadge(j.status));
    actions.forEach(a => right.appendChild(a));
    
    // Add details section
    const details = document.createElement('details');
    details.className = 'job-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    details.appendChild(summary);
    
    const dl = document.createElement('dl');
    const fields = [
      ['Student Name', j.candidate],
      ['Phone', j.phone],
      ['Licence Number', j.licence_number],
      ['DVSA Ref', j.dvsa_ref],
      ['Theory Expiry', j.theory_expiry],
      ['Desired Centres', j.desired_centres],
      ['Desired Range', j.desired_range],
      ['Notes', j.notes]
    ];
    
    fields.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    
    details.appendChild(dl);
    card.append(title, right, meta, details);
    return card;
  }

  // Small helper: success pulse on a button or card
  function pulse(el) { if (!el) return; el.classList.add('pulse-success'); setTimeout(()=>el.classList.remove('pulse-success'), 1000); }

  // Show tiny skeletons while loading
  function renderSkeletonList(container, rows=3) {
    container.innerHTML = '';
    for (let i=0;i<rows;i++){
      const c = document.createElement('div'); c.className='job-card';
      const s1=document.createElement('div'); s1.className='skel'; s1.style.width='40%';
      const s2=document.createElement('div'); s2.className='skel'; s2.style.width='25%';
      c.append(s1, document.createElement('div'), s2);
      container.appendChild(c);
    }
  }

  // BUTTON FACTORIES
  function btn(label, variant='primary') {
    const b=document.createElement('button'); b.className=`btn btn-slim btn-${variant}`; b.textContent=label; return b;
  }

  // JOBS BOARD
  const _doLoadJobs = async (prefetch = false) => {
    const list = document.getElementById('jobsList');
    const q = (document.getElementById('jobsSearch')?.value || '').toLowerCase();
    
    if (!prefetch && list) renderSkeletonList?.(list, 3);
    if (!prefetch) status?.('jobsStatus','Loading…');
    
    try {
      const headers = { "Content-Type": "application/json" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      const res = await fetchWithAbort(`/api/jobs/board?q=${encodeURIComponent(q)}&limit=50&offset=0`, { method:'GET', headers }, setJobsAC);
      const data = await res.json();
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      
      if (prefetch) return; // Don't render if prefetching
      
      list.innerHTML = '';
      
      // Client-side coverage filtering (belt-and-braces)
      const filteredJobs = jobs.filter(job => {
        if (COVERAGE.size === 0) return false; // No coverage = no jobs
        // Prefer explicit centre_id; else centre_name; else first desired
        const cidRaw = job.centre_id || job.centre_name || 
          (job.desired_centres ? String(job.desired_centres).split(',')[0] : '');
        const cid = normCentreId(cidRaw);
        return COVERAGE.has(cid);
      });
      
      if (!filteredJobs.length) {
        if (COVERAGE.size === 0) {
          list.innerHTML = '<div class="placeholder">Set your preferred centres in Profile to see matching jobs.</div>';
        } else {
          list.innerHTML = '<div class="placeholder">No open jobs in your coverage area.</div>';
        }
        status?.('jobsStatus','Loaded',true);
        return;
      }
      filteredJobs.forEach(j=>{
        const claim = btn?.('Claim','success');
        if (claim) claim.onclick = async () => {
          try { await api('/api/jobs/claim','POST',{ job_id:j.id }); pulse?.(claim); loadJobs(); loadMyJobs?.(); }
          catch(e){ alert('Failed to claim'); }
        };
        const del = btn?.('Delete','outline-danger');
        if (del) del.onclick = async () => {
          if (!isMaster?.()) return;
          if (!confirm('Delete this job?')) return;
          try { await api('/api/jobs/delete','POST',{ job_id:j.id }); loadJobs(); }
          catch(e){ alert('Failed to delete'); }
        };
        const actions = (isMaster?.()) ? [claim, del] : [claim].filter(Boolean);
        list.appendChild(renderJobCard?.(j, actions));
      });
      status?.('jobsStatus','Loaded',true);
    } catch(e) {
      if (e.name === 'AbortError') return; // expected on new search
      console.error(e);
      if (!prefetch) {
        list.innerHTML = '<div class="placeholder">Failed to load jobs.</div>';
        status?.('jobsStatus','Failed');
      }
    }
  };

  async function loadJobs(prefetch = false) {
    if (!prefetch) showToast('Refreshing jobs…');
    await _doLoadJobs(prefetch);
  }

  // MY JOBS
  async function loadMyJobs(prefetch = false) {
    if (!prefetch) showToast('Refreshing your jobs…');
    const list = document.getElementById('myJobsList');
    if (!prefetch && list) renderSkeletonList?.(list, 2);
    if (!prefetch) status?.('myJobsStatus','Loading…');
    try {
      const headers = { "Content-Type": "application/json" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      const res = await fetchWithAbort(`/api/jobs/mine?limit=50&offset=0`, { method:'GET', headers }, setMyJobsAC);
      const data = await res.json();
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      
      if (prefetch) return; // Don't render if prefetching
      
      list.innerHTML = '';
      if (!jobs.length) {
        list.innerHTML = '<div class="placeholder">You have no jobs.</div>';
        document.getElementById('earnings').textContent = '';
        status?.('myJobsStatus','Loaded',true); return;
      }
      jobs.forEach(j=>{
        const actions=[];
        if (String(j.status).toLowerCase()==='claimed') {
          const complete = btn?.('Complete','success');
          if (complete) complete.onclick = async () => {
            try { await api('/api/jobs/complete','POST',{ job_id:j.id }); pulse?.(complete); loadMyJobs(); }
            catch(e){ alert('Failed to complete'); }
          };
          const release = btn?.('Release','secondary');
          if (release) release.onclick = async () => {
            if(!confirm('Release this job?')) return;
            try { await api('/api/jobs/release','POST',{ job_id:j.id }); loadMyJobs(); loadJobs(); }
            catch(e){ alert('Failed to release'); }
          };
          actions.push(complete, release);
        }
        list.appendChild(renderJobCard?.(j, actions));
      });
      const per = data.payout_per_job || 70;
      const due = data.total_due || 0;
      document.getElementById('earnings').textContent = `£${due} due (£${per} per completed)`;
      status?.('myJobsStatus','Loaded',true);
    } catch(e) {
      if (e.name === 'AbortError') return;
      console.error(e);
      if (!prefetch) {
        list.innerHTML = '<div class="placeholder">Failed to load your jobs.</div>';
        status?.('myJobsStatus','Failed');
      }
    }
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
      
      // Update global coverage Set for filtering
      COVERAGE.clear();
      ids.forEach(id => COVERAGE.add(normCentreId(id)));
      
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
    
    // Dark mode toggle
    document.getElementById('darkModeToggle').onclick = DarkMode.toggleMode;
    
    // Toggle bin
    q("#toggleBin").onclick = toggleBin;
    
    // Jobs Board event handlers
    // Debounce the search input (300ms)
    (() => {
      const inp = document.getElementById('jobsSearch');
      if (inp) {
        const handler = debounce(() => loadJobs(), 300);
        inp.addEventListener('input', handler);
      }
    })();
    
    // Autoload when switching tabs + prefetch on hover
    document.querySelectorAll('#nav a[data-nav="jobs"]')?.forEach(a => {
      a.addEventListener('click', ()=>loadJobs());
      a.addEventListener('mouseenter', ()=>loadJobs(true)); // prefetch
    });
    document.querySelectorAll('#nav a[data-nav="myjobs"]')?.forEach(a => {
      a.addEventListener('click', ()=>loadMyJobs());
      a.addEventListener('mouseenter', ()=>loadMyJobs(true)); // prefetch
    });
    
    if (saved) unlock();
  });
})();
