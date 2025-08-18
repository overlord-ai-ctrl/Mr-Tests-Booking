(() => {
  const qs = s => document.querySelector(s);
  const API_BASE = window.__ADMIN_API__ || ''; // same-origin by default
  const endpoints = {
    get: API_BASE + '/api/test-centres',
    put: API_BASE + '/api/test-centres'
  };
  let ADMIN_TOKEN = '';
  let cached = [];

  const status = (txt, ok=false) => {
    const el = qs('#status');
    el.textContent = txt || '';
    el.style.color = ok ? 'green' : '#666';
  };
  const appendStatus = (txt, ok=false) => {
    const el = qs('#appendStatus');
    el.textContent = txt || '';
    el.style.color = ok ? 'green' : '#666';
  };
  const renderList = () => {
    const box = qs('#centresBox');
    box.innerHTML = '';
    if (!cached.length) {
      const d = document.createElement('div');
      d.className = 'placeholder';
      d.textContent = 'No centres yet.';
      box.appendChild(d);
      return;
    }
    cached.forEach(c => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('div'); name.textContent = c.name;
      const id = document.createElement('span'); id.className = 'badge'; id.textContent = c.id;
      row.appendChild(name); row.appendChild(id);
      box.appendChild(row);
    });
  };

  async function api(method, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (ADMIN_TOKEN) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
    const res = await fetch(method === 'GET' ? endpoints.get : endpoints.put, {
      method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store'
    });
    if (!res.ok) {
      const text = await res.text().catch(()=> '');
      throw new Error(`${method} ${res.status}: ${text}`);
    }
    return res.json();
  }

  window.addEventListener('DOMContentLoaded', () => {
    qs('#load').onclick = async () => {
      try {
        ADMIN_TOKEN = qs('#token').value.trim();
        status('Loading…');
        const data = await api('GET');
        cached = data.centres || [];
        renderList();
        status('Loaded', true);
      } catch (e) { console.error(e); status(e.message); }
    };

    qs('#append').onclick = async () => {
      try {
        const nameEl = qs('#newName');
        const idEl = qs('#newId');
        const name = nameEl.value.trim();
        let id = idEl.value.trim();
        if (!name) return appendStatus('Name required');
        if (!id) {
          id = name.toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
        }
        // local duplicate guard
        if (cached.some(c => c.id === id)) return appendStatus('ID already exists');
        appendStatus('Saving…');
        const payload = { mode: 'append', centres: [{ id, name }] };
        const resp = await api('PUT', payload);
        // optimistic update
        cached.push({ id, name });
        renderList();
        nameEl.value = ''; idEl.value = '';
        appendStatus('Appended & committed ✔', true);
      } catch (e) { console.error(e); appendStatus(e.message); }
    };
  });
})();
