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

  // Action lock utility to prevent double-clicks
  const ActionLock = (() => {
    const locks = new Map();
    
    const withActionLock = async (key, fn, lockMs = 2000) => {
      if (locks.has(key)) {
        console.log(`Action ${key} already in progress`);
        return;
      }
      
      locks.set(key, true);
      const startTime = Date.now();
      
      try {
        return await fn();
      } finally {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, lockMs - elapsed);
        setTimeout(() => locks.delete(key), remaining);
      }
    };
    
    return { withActionLock };
  })();

  // Busy overlay management
  const BusyOverlay = (() => {
    const overlay = document.getElementById('screenBusy');
    
    const show = (message = 'Processing...') => {
      if (overlay) {
        overlay.querySelector('.busy-message').textContent = message;
        overlay.classList.remove('d-none');
      }
    };
    
    const hide = () => {
      if (overlay) {
        overlay.classList.add('d-none');
      }
    };
    
    return { show, hide };
  })();

  // Offline detection and queue
  const OfflineQueue = (() => {
    let isOffline = false;
    let queuedActions = [];
    
    const addToQueue = (action) => {
      queuedActions.push(action);
      showToast('Action queued - will retry when online', 'warn');
    };
    
    const processQueue = async () => {
      if (queuedActions.length === 0) return;
      
      showToast(`Processing ${queuedActions.length} queued actions...`, 'info');
      
      for (const action of queuedActions) {
        try {
          await action();
        } catch (e) {
          console.error('Queued action failed:', e);
        }
      }
      
      queuedActions = [];
      showToast('All queued actions processed', 'success');
    };
    
    // Listen for online/offline events
    window.addEventListener('online', () => {
      isOffline = false;
      ErrorHandler.hideError();
      processQueue();
    });
    
    window.addEventListener('offline', () => {
      isOffline = true;
      ErrorHandler.showError();
    });
    
    return { isOffline: () => isOffline, addToQueue };
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

  // Enhanced API with error handling, rate limit backoff, and idempotency
  async function api(path, method="GET", body, actionKey = null) {
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    
    // Add idempotency key for mutating operations
    if (method !== "GET" && actionKey) {
      headers["X-Idempotency-Key"] = `${actionKey}:${Date.now()}`;
    }
    
    const makeRequest = async () => {
      const res = await fetch(API + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store"
      });
      
      if (!res.ok) {
        let errorText = "";
        try { errorText = await res.text(); } catch {}
        
        // Handle idempotent replay
        if (res.status === 409) {
          try {
            const data = JSON.parse(errorText);
            if (data.ok && data.replay) {
              return data; // Treat as success
            }
          } catch {}
        }
        
        // Handle rate limiting
        if (res.status === 429) {
          const errorData = JSON.parse(errorText || '{}');
          const retryAfter = errorData.retry_after || 3;
          showToast(`Rate limited, retrying in ${retryAfter}s...`, 'warn');
          
          // Wait and retry once
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return makeRequest();
        }
        
        // Handle validation errors
        if (res.status === 400) {
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error === 'validation_error') {
              showToast(`Validation error: ${errorData.hint || 'Invalid input'}`, 'error');
              return { error: 'validation', details: errorData };
            }
          } catch {}
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
      ErrorHandler.setLastRequest(() => api(path, method, body, actionKey));
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
    else if (s === 'offered') { span.classList.add('badge-offered'); span.textContent = 'Offered'; }
    else if (s === 'offered_expired') { span.classList.add('badge-expired'); span.textContent = 'Expired'; }
    else if (s === 'confirmed_yes') { span.classList.add('badge-confirmed'); span.textContent = 'Confirmed'; }
    else if (s === 'confirmed_no') { span.classList.add('badge-declined'); span.textContent = 'Declined'; }
    else { span.classList.add('badge-open'); span.textContent = 'Open'; }
    return span;
  }

  // Utility: build a job card
  function renderJobCard(j, actions=[], context='board') {
    const card = document.createElement('div'); 
    card.className = 'job-card';
    
    const title = document.createElement('div'); 
    title.className = 'job-title';
    title.textContent = `${j.centre_name || j.centre_id || '—'} — ${j.candidate || ''}`;
    
    const meta = document.createElement('div'); 
    meta.className = 'job-meta';
    const when = j.when ? `· ${j.when}` : '';
    meta.textContent = `ID:${j.id} ${when}`;
    
    const right = document.createElement('div'); 
    right.className = 'job-actions';
    right.append(statusBadge(j.status));
    actions.forEach(a => right.appendChild(a));
    
    card.append(title, right, meta);
    
    // Show offer panel for claimed/offered jobs
    const status = String(j.status||'').toLowerCase();
    const isClaimed = status === 'claimed';
    const isOffered = status === 'offered' || status === 'offered_expired' || status === 'confirmed_yes' || status === 'confirmed_no';
    const isMineView = (context==='myjobs');
    
    // Show offer panel for claimed/offered jobs in My Jobs view
    if ((isClaimed || isOffered) && isMineView) {
      card.appendChild(renderOfferPanel(j));
    }
    
    // Show details for claimed jobs or in My Jobs view
    if (isClaimed || isMineView) {
      card.appendChild(renderJobDetailsSlim(j));
    }
    
    // Wire claim/complete buttons to new functions
    const claimBtn = card.querySelector('[data-action="claim"]') || 
      Array.from(card.querySelectorAll('button')).find(b=>/claim/i.test(b.textContent||''));
    if (claimBtn) {
      claimBtn.onclick = ()=>claimJob(j.id);
    }
    
    const completeBtn = card.querySelector('[data-action="complete"]') || 
      Array.from(card.querySelectorAll('button')).find(b=>/complete/i.test(b.textContent||''));
    if (completeBtn) {
      completeBtn.onclick = ()=>completeJob(j.id);
    }
    
    return card;
  }

  // Small helper: success pulse on a button or card
  function pulse(el) { if (!el) return; el.classList.add('pulse-success'); setTimeout(()=>el.classList.remove('pulse-success'), 1000); }

  // Busy overlay helpers
  function showBusy(msg='Working…'){
    const el = document.getElementById('screenBusy'); 
    if (!el) return;
    document.getElementById('screenBusyText').textContent = msg;
    el.classList.remove('d-none');
  }
  
  function hideBusy(){
    const el = document.getElementById('screenBusy'); 
    if (!el) return;
    el.classList.add('d-none');
  }

  // Pretty range like "25 JAN – 15 FEB" (adds year if years differ)
  function formatRangeNice(raw){
    if (!raw) return '—';
    // supports "YYYY-MM-DD to YYYY-MM-DD" or "YYYY-MM-DD - YYYY-MM-DD"
    const parts = String(raw).split(/\s*(?:to|-|–|—)\s*/i).filter(Boolean);
    if (parts.length < 2) return raw;
    const a = new Date(parts[0]); 
    const b = new Date(parts[1]);
    if (isNaN(a) || isNaN(b)) return raw;
    const dd = (d)=>String(d.getDate()).padStart(2,'0');
    const MMM = (d)=>d.toLocaleString('en-GB',{month:'short'}).toUpperCase();
    const y = (d)=>d.getFullYear();
    const left = `${dd(a)} ${MMM(a)}`;
    const right = `${dd(b)} ${MMM(b)}`;
    if (y(a) !== y(b)) return `${left} ${y(a)} – ${right} ${y(b)}`;
    // same year: omit year
    return `${left} – ${right}`;
  }

  // Countdown timer for offer expiry
  function prettyCountdown(iso){
    const t = new Date(iso).getTime() - Date.now();
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.floor(t/1000));
    const m = Math.floor(s/60), r = s%60;
    return `${m}m ${String(r).padStart(2,'0')}s left`;
  }

  // Check if offer is expired
  function isOfferExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() <= Date.now();
  }

  // Render details block with ONLY the requested fields
  function renderJobDetailsSlim(j){
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'Details';
    det.append(sum);

    const dl = document.createElement('dl');
    dl.className = 'job-dl';

    const add = (label, val)=>{
      const dt = document.createElement('dt'); 
      dt.textContent = label;
      const dd = document.createElement('dd'); 
      dd.textContent = val || '—';
      dl.append(dt, dd);
    };

    add('Student Name', j.candidate);
    add('Licence Number', j.licence_number);
    add('DVSA Ref', j.dvsa_ref);
    add('Notes', j.notes);
    add('Desired Centres', j.desired_centres);
    add('Desired Range', formatRangeNice(j.desired_range));

    det.append(dl);
    return det;
  }

  // Render offer panel for claimed/offered jobs
  function renderOfferPanel(j) {
    const container = document.createElement('div');
    container.className = 'offer-container mt-3';

    const status = String(j.status || '').toLowerCase();
    const isOffered = status === 'offered';
    const isExpired = status === 'offered_expired' || (isOffered && isOfferExpired(j.offer_expires_at));
    const isConfirmed = status === 'confirmed_yes';
    const isDeclined = status === 'confirmed_no';

    // Header with status badge and countdown
    const header = document.createElement('div');
    header.className = 'offer-header';
    
    const statusRow = document.createElement('div');
    statusRow.className = 'd-flex align-items-center gap-2';
    
    let statusBadge;
    if (isConfirmed) {
      statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-status badge-confirmed';
      statusBadge.textContent = 'Client confirmed';
    } else if (isDeclined) {
      statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-status badge-declined';
      statusBadge.textContent = 'Declined';
    } else if (isExpired) {
      statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-status badge-expired';
      statusBadge.textContent = 'Offer expired';
    } else if (isOffered) {
      statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-status badge-offered';
      statusBadge.textContent = 'Offer sent';
    }
    
    if (statusBadge) statusRow.appendChild(statusBadge);

    // Countdown timer
    if (isOffered && j.offer_expires_at) {
      const countdown = document.createElement('span');
      countdown.className = 'pill-countdown';
      countdown.textContent = prettyCountdown(j.offer_expires_at);
      statusRow.appendChild(countdown);
      
      // Update countdown every second
      const updateCountdown = () => {
        countdown.textContent = prettyCountdown(j.offer_expires_at);
        if (isOfferExpired(j.offer_expires_at)) {
          clearInterval(countdownInterval);
          // Trigger a refresh to update status
          setTimeout(() => { loadMyJobs?.(); loadJobs?.(); }, 1000);
        }
      };
      const countdownInterval = setInterval(updateCountdown, 1000);
      updateCountdown();
    }

    header.appendChild(statusRow);
    container.appendChild(header);

    // Content area
    const content = document.createElement('div');
    content.className = 'offer-content';

    // Offer form (only for claimed jobs or expired offers)
    if (status === 'claimed' || isExpired) {
      const form = document.createElement('div');
      form.className = 'offer-grid';
      
      // Centre select
      const centreField = document.createElement('div');
      centreField.className = 'offer-field';
      const centreLabel = document.createElement('label');
      centreLabel.textContent = 'Test Centre';
      const centreSelect = document.createElement('select');
      centreSelect.innerHTML = '<option value="">Select centre...</option>';
      // Populate with centres from coverage
      COVERAGE.forEach(centreId => {
        const option = document.createElement('option');
        option.value = centreId;
        option.textContent = centreId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        centreSelect.appendChild(option);
      });
      centreField.append(centreLabel, centreSelect);
      
      // Date input
      const dateField = document.createElement('div');
      dateField.className = 'offer-field';
      const dateLabel = document.createElement('label');
      dateLabel.textContent = 'Date';
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateField.append(dateLabel, dateInput);
      
      // Time input
      const timeField = document.createElement('div');
      timeField.className = 'offer-field';
      const timeLabel = document.createElement('label');
      timeLabel.textContent = 'Time';
      const timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeField.append(timeLabel, timeInput);
      
      // Note textarea
      const noteField = document.createElement('div');
      noteField.className = 'offer-field';
      noteField.style.gridColumn = '1 / -1';
      const noteLabel = document.createElement('label');
      noteLabel.textContent = 'Note (optional)';
      const noteInput = document.createElement('textarea');
      noteInput.placeholder = 'Add a personal message for the client...';
      noteInput.rows = 3;
      noteField.append(noteLabel, noteInput);
      
      form.append(centreField, dateField, timeField, noteField);
      content.appendChild(form);
    }

    // Manual reply buttons for offered/expired jobs
    if (isOffered || isExpired) {
      const replySection = document.createElement('div');
      replySection.className = 'mb-3';
      
      const replyTitle = document.createElement('h6');
      replyTitle.className = 'mb-2';
      replyTitle.textContent = 'Manual Client Reply';
      replySection.appendChild(replyTitle);
      
      const replyActions = document.createElement('div');
      replyActions.className = 'd-flex gap-2';
      
      const yesBtn = btn('Mark as YES', 'success');
      yesBtn.onclick = () => markClientReply(j.id, 'YES');
      
      const noBtn = btn('Mark as NO', 'outline-danger');
      noBtn.onclick = () => markClientReply(j.id, 'NO');
      
      replyActions.append(yesBtn, noBtn);
      replySection.appendChild(replyActions);
      content.appendChild(replySection);
    }

    container.appendChild(content);

    // Action buttons (pinned to bottom)
    if (status === 'claimed' || isExpired) {
      const actions = document.createElement('div');
      actions.className = 'offer-actions';
      
      if (status === 'claimed') {
        const sendBtn = btn('Send to Client', 'primary');
        sendBtn.onclick = () => {
          const centreSelect = content.querySelector('select');
          const dateInput = content.querySelector('input[type="date"]');
          const timeInput = content.querySelector('input[type="time"]');
          const noteInput = content.querySelector('textarea');
          
          if (!centreSelect.value || !dateInput.value || !timeInput.value) {
            alert('Please fill in centre, date, and time');
            return;
          }
          sendOffer(j.id, centreSelect.value, dateInput.value, timeInput.value, noteInput.value);
        };
        actions.appendChild(sendBtn);
      } else if (isExpired) {
        const nudgeBtn = btn('Nudge', 'secondary');
        nudgeBtn.onclick = () => nudgeOffer(j.id);
        
        const extendBtn = btn('Extend +15m', 'secondary');
        extendBtn.onclick = () => extendOffer(j.id, 15);
        
        const releaseBtn = btn('Move to Next Client', 'outline-danger');
        releaseBtn.onclick = () => {
          if (confirm('Release this job to the next available booker?')) {
            // Use existing release function
            api('/api/jobs/release', 'POST', { job_id: j.id }).then(() => {
              showToast?.('Released ✓', 'success');
              loadMyJobs?.();
              loadJobs?.();
            }).catch(() => alert('Failed to release'));
          }
        };
        
        actions.append(nudgeBtn, extendBtn, releaseBtn);
      }
      
      container.appendChild(actions);
    }

    return container;
  }

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

  // Claim and complete job functions with action locks and enhanced error handling
  async function claimJob(jobId){
    return ActionLock.withActionLock(`claim:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => claimJob(jobId));
        return;
      }
      
      try {
        BusyOverlay.show('Claiming job…');
        const result = await api('/api/jobs/claim', 'POST', { job_id: jobId }, `claim:${jobId}`);
        
        if (result.error === 'validation') {
          showToast('Invalid job ID', 'error');
          return;
        }
        
        BusyOverlay.hide();
        showToast('Claimed ✓', 'success');
        
        // Scroll claimed card into view and pulse green
        const card = document.querySelector(`[data-job-id="${jobId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.transition = 'background-color 0.3s';
          card.style.backgroundColor = '#d4edda';
          setTimeout(() => {
            card.style.backgroundColor = '';
            card.style.transition = '';
          }, 2000);
        }
        
        loadJobs?.(); 
        loadMyJobs?.();
      } catch(e) {
        BusyOverlay.hide();
        showToast('Failed to claim job. Please try again.', 'error');
        console.error('Claim error:', e);
      }
    });
  }

  async function completeJob(jobId){
    return ActionLock.withActionLock(`complete:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => completeJob(jobId));
        return;
      }
      
      try {
        BusyOverlay.show('Completing job…');
        const result = await api('/api/jobs/complete', 'POST', { job_id: jobId }, `complete:${jobId}`);
        
        if (result.error === 'validation') {
          showToast('Invalid job ID', 'error');
          return;
        }
        
        BusyOverlay.hide();
        showToast('Completed ✓', 'success');
        
        // Replace action buttons with completed badge
        const card = document.querySelector(`[data-job-id="${jobId}"]`);
        if (card) {
          const actionsDiv = card.querySelector('.job-actions');
          if (actionsDiv) {
            actionsDiv.innerHTML = '<span class="badge bg-success">Completed ✓</span>';
          }
        }
        
        loadMyJobs?.(); 
        loadJobs?.();
      } catch(e) {
        BusyOverlay.hide();
        showToast('Failed to complete job. Please try again.', 'error');
        console.error('Complete error:', e);
      }
    });
  }

  // Offer confirmation flow functions with action locks and validation
  async function sendOffer(jobId, centre, date, time, note) {
    return ActionLock.withActionLock(`offer:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => sendOffer(jobId, centre, date, time, note));
        return;
      }
      
      // Client-side validation
      const offerDateTime = new Date(`${date} ${time}`);
      if (isNaN(offerDateTime.getTime()) || offerDateTime <= new Date()) {
        showToast('Offer date and time must be in the future', 'error');
        return;
      }
      
      try {
        BusyOverlay.show('Sending to client…');
        const result = await api('/api/jobs/offer', 'POST', { job_id: jobId, centre, date, time, note }, `offer:${jobId}`);
        
        if (result.error === 'validation') {
          showToast(`Validation error: ${result.details?.hint || 'Invalid input'}`, 'error');
          return;
        }
        
        BusyOverlay.hide();
        showToast('Offer sent ✓', 'success');
        loadMyJobs?.();
        loadJobs?.();
      } catch(e) {
        BusyOverlay.hide();
        showToast('Failed to send offer. Please try again.', 'error');
        console.error('Offer error:', e);
      }
    });
  }

  async function nudgeOffer(jobId) {
    return ActionLock.withActionLock(`nudge:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => nudgeOffer(jobId));
        return;
      }
      
      try {
        const result = await api('/api/jobs/offer/nudge', 'POST', { job_id: jobId }, `nudge:${jobId}`);
        
        if (result.error === 'validation') {
          showToast('Invalid job ID', 'error');
          return;
        }
        
        showToast('Nudge sent ✓', 'success');
      } catch(e) {
        showToast('Failed to send nudge. Please try again.', 'error');
        console.error('Nudge error:', e);
      }
    });
  }

  async function extendOffer(jobId, minutes = 15) {
    return ActionLock.withActionLock(`extend:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => extendOffer(jobId, minutes));
        return;
      }
      
      try {
        const result = await api('/api/jobs/offer/extend', 'POST', { job_id: jobId, minutes }, `extend:${jobId}`);
        
        if (result.error === 'validation') {
          showToast('Invalid input - minutes must be 1-240', 'error');
          return;
        }
        
        showToast(`Extended by ${minutes}m ✓`, 'success');
        loadMyJobs?.();
        loadJobs?.();
      } catch(e) {
        showToast('Failed to extend offer. Please try again.', 'error');
        console.error('Extend error:', e);
      }
    });
  }

  async function markClientReply(jobId, reply) {
    return ActionLock.withActionLock(`reply:${jobId}`, async () => {
      // Check if offline
      if (OfflineQueue.isOffline()) {
        OfflineQueue.addToQueue(() => markClientReply(jobId, reply));
        return;
      }
      
      try {
        const result = await api('/api/jobs/mark-client-reply', 'POST', { job_id: jobId, reply }, `reply:${jobId}`);
        
        if (result.error === 'validation') {
          showToast('Invalid reply - must be YES or NO', 'error');
          return;
        }
        
        showToast(`Marked as ${reply} ✓`, 'success');
        loadMyJobs?.();
        loadJobs?.();
      } catch(e) {
        showToast('Failed to mark reply. Please try again.', 'error');
        console.error('Mark reply error:', e);
      }
    });
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
        list.appendChild(renderJobCard?.(j, actions, 'board'));
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
        const status = String(j.status).toLowerCase();
        
        if (status === 'claimed') {
          const complete = btn?.('Complete','success');
          const release = btn?.('Release','secondary');
          if (release) release.onclick = async () => {
            if(!confirm('Release this job?')) return;
            try { await api('/api/jobs/release','POST',{ job_id:j.id }); loadMyJobs(); loadJobs(); }
            catch(e){ alert('Failed to release'); }
          };
          actions.push(complete, release);
        } else if (status === 'confirmed_yes') {
          // Show Complete button for confirmed jobs
          const complete = btn?.('Complete','success');
          actions.push(complete);
        } else if (status === 'confirmed_no') {
          // Show Release button for declined jobs
          const release = btn?.('Release','secondary');
          if (release) release.onclick = async () => {
            if(!confirm('Release this declined job?')) return;
            try { await api('/api/jobs/release','POST',{ job_id:j.id }); loadMyJobs(); loadJobs(); }
            catch(e){ alert('Failed to release'); }
          };
          actions.push(release);
        }
        
        list.appendChild(renderJobCard?.(j, actions, 'myjobs'));
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
