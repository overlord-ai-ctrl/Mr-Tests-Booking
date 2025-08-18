(() => {
  const q = (s) => document.querySelector(s);
  const API = ""; // same-origin
  let TOKEN = "";
  let ME = null;

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

  function applyVisibility() {
    if (ME?.name) { q("#userName").textContent = ME.name; q("#userBox").hidden = false; }
    const pages = ME?.pages || ["*"]; const all = pages.includes("*");
    document.querySelectorAll("[data-page]").forEach(sec => {
      const tag = sec.getAttribute("data-page") || "";
      sec.hidden = !all && !pages.includes(tag);
    });
  }

  async function unlock() {
    TOKEN = q("#token").value.trim();
    if (!TOKEN) return status("authStatus", "Code required");
    try {
      ME = await api("/api/me", "GET");
      sessionStorage.setItem("mrtests_admin_token", TOKEN);
      q("#authGate").hidden = true; q("#app").hidden = false;
      applyVisibility();
      status("authStatus", "Unlocked ✓", true);
    } catch (e) {
      console.error(e);
      status("authStatus", "Invalid code");
      TOKEN = ""; ME = null;
      q("#app").hidden = true; q("#authGate").hidden = false;
    }
  }

  async function loadCentres() {
    status("status", "Loading…");
    try {
      const data = await api("/api/test-centres", "GET");
      const centres = data.centres || [];
      const box = q("#centresBox"); box.innerHTML = "";
      if (!centres.length) { box.innerHTML = '<div class="placeholder">No centres yet.</div>'; status("status","Loaded",true); return; }
      centres.forEach(c => {
        const row = document.createElement("div"); row.className="row";
        const name = document.createElement("div"); name.textContent = c.name;
        const id = document.createElement("span"); id.className = "badge"; id.textContent = c.id;
        row.append(name, id); box.appendChild(row);
      });
      status("status","Loaded",true);
    } catch (e) { console.error(e); status("status","Failed to load"); }
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
      row.append(nameDiv, idSpan); q("#centresBox").appendChild(row);
      nameEl.value=""; idEl.value=""; status("appendStatus","Appended & committed ✓", true);
    } catch (e) { console.error(e); status("appendStatus","Failed to append"); }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const saved = sessionStorage.getItem("mrtests_admin_token");
    if (saved) { q("#token").value = saved; }
    q("#unlock").onclick = unlock;
    q("#load").onclick = loadCentres;
    q("#append").onclick = appendCentre;
    if (saved) unlock();
  });
})();
