(() => {
  const q = (s) => document.querySelector(s);
  const API = ""; // same-origin
  let TOKEN = "";
  let ME = null;
  let currentCentresSha = null;
  let currentBinSha = null;

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
    const pages = ME?.pages || ["*"]; const all = pages.includes("*");
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
    } catch (e) {
      console.error(e);
      status("authStatus", "Invalid code");
      TOKEN = ""; ME = null;
      q("#app").hidden = true; q("#authGate").hidden = false;
    }
  }

  // Search and filter functionality
  function filterCentres() {
    const searchTerm = q("#search").value.toLowerCase();
    const rows = q("#centresBox").querySelectorAll(".row");
    
    rows.forEach(row => {
      const name = row.querySelector("div")?.textContent?.toLowerCase() || "";
      const id = row.querySelector(".badge")?.textContent?.toLowerCase() || "";
      const matches = name.includes(searchTerm) || id.includes(searchTerm);
      row.classList.toggle("hidden", !matches);
    });
  }

  function selectAllVisible() {
    const visibleRows = q("#centresBox").querySelectorAll(".row:not(.hidden)");
    visibleRows.forEach(row => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = true;
    });
  }

  function selectNone() {
    const checkboxes = q("#centresBox").querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
  }

  function exportCsv() {
    const rows = q("#centresBox").querySelectorAll(".row");
    let csv = "id,name,selected\n";
    
    rows.forEach(row => {
      const id = row.querySelector(".badge")?.textContent || "";
      const name = row.querySelector("div")?.textContent || "";
      const checkbox = row.querySelector('input[type="checkbox"]');
      const selected = checkbox?.checked ? "true" : "false";
      csv += `"${id}","${name}",${selected}\n`;
    });
    
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "centres-coverage.csv";
    a.click();
    URL.revokeObjectURL(url);
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
        const row = document.createElement("div"); row.className="row";
        const name = document.createElement("div"); name.textContent = c.name;
        const id = document.createElement("span"); id.className = "badge"; id.textContent = c.id;
        row.append(name, id);
        
        // Add delete button for masters
        if (isMaster()) {
          const del = document.createElement('button');
          del.textContent = 'Delete';
          del.className = 'danger';
          del.onclick = () => deleteCentre(c.id);
          row.appendChild(del);
        }
        
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
        const row = document.createElement('div'); row.className='row';
        const input = document.createElement('input'); input.type='checkbox'; input.value=c.id;
        input.name='myCoverage[]'; input.id=`cov-${c.id}`; if (selected.has(c.id)) input.checked = true;
        const label = document.createElement('label'); label.htmlFor=`cov-${c.id}`; label.textContent = ` ${c.name} `;
        const tag = document.createElement('span'); tag.className='badge'; tag.textContent=c.id;
        row.append(input,label,tag);
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
    const nameEl = q("#newName"), idEl = q("#newId");
    const name = (nameEl.value||"").trim(); let id = (idEl.value||"").trim();
    if (!name) return status("appendStatus","Name required");
    if (!id) id = slug(name);
    status("appendStatus","Saving…");
    try {
      await api("/api/test-centres","PUT",{ mode:"append", centres:[{ id, name }] });
      const row = document.createElement("div"); row.className="row";
      const nameDiv = document.createElement("div"); nameDiv.textContent = name;
      const idSpan = document.createElement("span"); idSpan.className="badge"; idSpan.textContent = id;
      row.append(nameDiv, idSpan);
      
      // Add delete button for masters
      if (isMaster()) {
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.className = 'danger';
        del.onclick = () => deleteCentre(id);
        row.appendChild(del);
      }
      
      q("#centresBox").appendChild(row);
      nameEl.value=""; idEl.value=""; status("appendStatus","Appended & committed ✓", true);
    } catch (e) { console.error(e); status("appendStatus","Failed to append"); }
  }

  // Recycle bin functionality
  async function loadBin() {
    status("binStatus", "Loading…");
    try {
      const data = await api("/api/test-centres-bin", "GET");
      const centres = data.centres || [];
      currentBinSha = data.sha;
      const box = q("#binBox"); box.innerHTML = "";
      if (!centres.length) { box.innerHTML = '<div class="placeholder">No deleted centres.</div>'; status("binStatus","Loaded",true); return; }
      centres.forEach(c => {
        const row = document.createElement("div"); row.className="row";
        const name = document.createElement("div"); name.textContent = c.name;
        const id = document.createElement("span"); id.className = "badge"; id.textContent = c.id;
        const restore = document.createElement('button');
        restore.textContent = 'Restore';
        restore.onclick = () => restoreCentre(c.id);
        row.append(name, id, restore);
        box.appendChild(row);
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
      const box = document.getElementById('binBox');
      [...box.querySelectorAll('.row')].forEach(row => {
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
  async function loadMyProfile() {
    try {
      const profile = await api('/api/my-profile','GET');
      q("#profileNotes").value = profile.notes || "";
      q("#profileMaxDaily").value = profile.maxDaily || 0;
      q("#profileAvailable").checked = profile.available !== false;
    } catch (e) {
      console.error(e);
      status("profileStatus", "Failed to load profile");
    }
  }

  async function saveMyProfile() {
    const notes = q("#profileNotes").value.trim();
    const maxDaily = parseInt(q("#profileMaxDaily").value) || 0;
    const available = q("#profileAvailable").checked;
    
    if (maxDaily < 0) return status("profileStatus", "Max daily must be >= 0");
    
    status("profileStatus", "Saving…");
    try {
      await api('/api/my-profile','PUT',{ notes, maxDaily, available });
      status("profileStatus", "Saved ✓", true);
    } catch (e) { 
      console.error(e); 
      status("profileStatus", "Failed to save"); 
    }
  }

  function renderCodesList(map) {
    const list = document.getElementById('codesList');
    list.innerHTML = '';
    const entries = Object.entries(map);
    if (!entries.length) { list.innerHTML = '<div class="placeholder">No codes yet.</div>'; return; }
    entries.forEach(([code, info]) => {
      const row = document.createElement('div'); row.className='row';
      const name = document.createElement('div'); name.textContent = (info?.name || 'Admin');
      const codeBadge = document.createElement('span'); codeBadge.className='badge'; codeBadge.textContent = code;
      const pagesBadge = document.createElement('span'); pagesBadge.className='badge'; pagesBadge.textContent = (info?.pages||[]).join(',');
      const roleBadge = document.createElement('span'); roleBadge.className='badge'; roleBadge.textContent = info?.role || ((info?.pages||[]).includes('*') ? 'master' : 'booker');
      row.append(name, codeBadge, pagesBadge, roleBadge);
      if (isMaster()) {
        const del = document.createElement('button'); del.textContent = 'Delete'; del.className='danger';
        del.onclick = () => deleteAdminCode(code);
        row.append(del);
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
    const pages = document.getElementById("newPages").value.split(",").map(s=>s.trim()).filter(Boolean);
    if (!code) return status("addCodeStatus","Code required");
    if (!name) return status("addCodeStatus","Name required");
    status("addCodeStatus","Saving…");
    try {
      await api("/api/admin-codes","PUT",{ mode:"append", code, name, pages, role });
      status("addCodeStatus","Added ✓",true);
      document.getElementById("newCode").value = "";
      document.getElementById("newAdminName").value = "";
      document.getElementById("newPages").value = "";
      document.getElementById("newRole").value = "booker";
      loadCodes();
    } catch (e) { console.error(e); status("addCodeStatus","Failed to add"); }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const saved = sessionStorage.getItem("mrtests_admin_token");
    if (saved) { q("#token").value = saved; }
    q("#unlock").onclick = unlock;
    q("#load").onclick = loadCentres;
    q("#append").onclick = appendCentre;
    q("#loadBin").onclick = loadBin;
    q("#saveProfile").onclick = saveMyProfile;
    document.getElementById("loadCodes").onclick = loadCodes;
    document.getElementById("addCode").onclick = addCode;
    document.getElementById('saveCoverage').onclick = saveCoverage;
    
    // New event listeners
    q("#search").oninput = filterCentres;
    q("#selectAll").onclick = selectAllVisible;
    q("#selectNone").onclick = selectNone;
    q("#exportCsv").onclick = exportCsv;
    
    if (saved) unlock();
    
    // Load profile when profile tab is shown
    document.querySelector('a[data-nav="profile"]')?.addEventListener('click', () => {
      setTimeout(loadMyProfile, 100);
    });
  });
})();
