// assets/js/centres.js
(async () => {
  const container = document.querySelector('[data-centres-container]');
  if (!container) return;
  try {
    const url = `/data/test_centres.json?v=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load');
    const centres = await res.json();
    // parse any preset selection from URL (?preferredTestCentres=a,b,c)
    const params = new URLSearchParams(window.location.search);
    const preset = new Set((params.get('preferredTestCentres') || '')
      .split(',').map(s => s.trim()).filter(Boolean));
    container.innerHTML = '';
    centres.forEach(c => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'preferredTestCentres[]';
      input.value = c.id;
      if (preset.has(c.id)) input.checked = true;
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + c.name));
      container.appendChild(label);
    });
    if (!centres.length) {
      container.innerHTML = '<p>No centres available right now.</p>';
    }
  } catch (e) {
    console.error(e);
    container.innerHTML = '<p>Could not load test centres. Please refresh.</p>';
  }
})();
