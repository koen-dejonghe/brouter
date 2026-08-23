import { state } from './state.js';
import { addWaypoint } from './waypoints.js';

export function initGeocoder() {
  const input     = document.getElementById('search-input');
  const dropdown  = document.getElementById('search-dropdown');
  const btnSearch = document.getElementById('btn-search');

  let searchTimer  = null;
  let activeIdx    = -1;
  let lastResults  = [];
  let searchMarker = null;
  let searchSeq = 0;
  let searchAbortController = null;

  function invalidateSearch() {
    searchSeq += 1;
    clearTimeout(searchTimer);
    searchAbortController?.abort();
    searchAbortController = null;
  }

  function openDropdown()  { dropdown.classList.add('open'); input.setAttribute('aria-expanded', 'true'); }
  function closeDropdown() {
    dropdown.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIdx = -1;
  }

  function renderResults(features) {
    lastResults = features;
    activeIdx   = -1;
    dropdown.innerHTML = '';

    if (!features.length) {
      const none = document.createElement('div');
      none.className = 'search-none';
      none.textContent = 'No results found.';
      dropdown.appendChild(none);
      openDropdown();
      return;
    }

    features.forEach((f, i) => {
      const p    = f.properties;
      const name = p.name || p.street || p.city || 'Unknown';
      const parts = [p.city, p.state, p.country].filter(Boolean);
      const sub  = parts.join(', ');

      const item = document.createElement('div');
      item.className = 'search-item';
      item.id = `search-option-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const title = document.createElement('div');
      title.textContent = name;
      item.appendChild(title);
      if (sub) {
        const detail = document.createElement('div');
        detail.className = 'search-item-sub';
        detail.textContent = sub;
        item.appendChild(detail);
      }
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        selectResult(i);
      });
      dropdown.appendChild(item);
    });

    openDropdown();
  }

  function highlightItem(idx) {
    const items = dropdown.querySelectorAll('.search-item');
    items.forEach((el, i) => {
      const active = i === idx;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
      if (active) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function selectResult(idx) {
    invalidateSearch();
    const f   = lastResults[idx];
    const [lon, lat] = f.geometry.coordinates;
    const p   = f.properties;
    const name = [p.name || p.street, p.city, p.country].filter(Boolean).join(', ');

    input.value = p.name || p.street || p.city || '';
    closeDropdown();

    if (searchMarker) { state.map.removeLayer(searchMarker); searchMarker = null; }

    state.map.flyTo([lat, lon], Math.max(state.map.getZoom(), 14), { duration: 1 });

    searchMarker = L.marker([lat, lon]).addTo(state.map);
    const popup = L.popup({ closeButton: true, className: 'search-popup' })
      .setContent(() => {
        const div = document.createElement('div');
        div.style.cssText = 'font-size:0.82rem; color:#1e293b; min-width:160px;';
        const title = document.createElement('strong');
        title.style.cssText = 'display:block;margin-bottom:6px;';
        title.textContent = name;
        div.appendChild(title);
        const btn = document.createElement('button');
        btn.className   = 'popup-add-btn';
        btn.textContent = '+ Add as waypoint';
        btn.addEventListener('click', () => {
          addWaypoint(lat, lon);
          searchMarker.closePopup();
          state.map.removeLayer(searchMarker);
          searchMarker = null;
          input.value  = '';
        });
        div.appendChild(btn);
        return div;
      });

    searchMarker.bindPopup(popup).openPopup();
    searchMarker.on('popupclose', () => {
      if (searchMarker) { state.map.removeLayer(searchMarker); searchMarker = null; }
    });
  }

  async function doSearch(q) {
    if (q.length < 3) { closeDropdown(); return; }
    invalidateSearch();
    const seq = searchSeq;
    const controller = new AbortController();
    searchAbortController = controller;
    try {
      const url  = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`;
      const resp = await fetch(url, { signal: controller.signal });
      const data = await resp.json();
      if (!resp.ok) throw new Error('Search failed');
      if (seq !== searchSeq || controller.signal.aborted || input.value.trim() !== q) return;
      renderResults(data.features || []);
    } catch (err) {
      if (err.name !== 'AbortError' && seq === searchSeq) closeDropdown();
    }
  }

  // Debounced input
  input.addEventListener('input', () => {
    invalidateSearch();
    const q = input.value.trim();
    if (!q) { closeDropdown(); return; }
    searchTimer = setTimeout(() => doSearch(q), 300);
  });

  // Keyboard navigation
  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('.search-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      highlightItem(activeIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      highlightItem(activeIdx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < lastResults.length) {
        selectResult(activeIdx);
      } else if (lastResults.length > 0) {
        selectResult(0);
      } else {
        doSearch(input.value.trim());
      }
    } else if (e.key === 'Escape') {
      invalidateSearch();
      closeDropdown();
    }
  });

  // Search button
  btnSearch.addEventListener('click', () => doSearch(input.value.trim()));

  // Close dropdown on outside click
  document.addEventListener('mousedown', e => {
    if (!document.getElementById('search-wrap').contains(e.target)) { invalidateSearch(); closeDropdown(); }
  });
}
