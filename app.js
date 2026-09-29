const API = {
  geocoder: 'https://photon.komoot.io/api/',
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};
const DEFAULT_VIEW = [20, 0];
const DEFAULT_ZOOM = 2;
const $ = selector => document.querySelector(selector);
const list = $('#cafe-list');
const notice = $('#notice');
const locationStatus = $('#location-status');
const searchButton = $('#search-button');
const radiusControl = $('#radius');
const searchCache = readStorage('nook-geocode-cache', {});
const nearbyCache = readStorage('nook-nearby-cache', {});
const savedPlaces = new Set(readStorage('nook-saved-places', []));
let map;
let markerLayer;
let activeFilter = 'all';
let currentOrigin = null;
let currentPlaces = [];

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function showNotice(message, type = 'info') {
  notice.hidden = !message;
  notice.classList.toggle('error', type === 'error');
  notice.lastElementChild.textContent = message;
}

function initMap() {
  if (!window.L) {
    showNotice('The map library could not load. Cafe search is still available; check your connection and refresh to see the map.', 'error');
    return;
  }
  map = L.map('map', { scrollWheelZoom: false }).setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  L.tileLayer(API.tiles, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map);
  markerLayer = (L.markerClusterGroup
    ? L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 46, spiderfyOnMaxZoom: true })
    : L.layerGroup()).addTo(map);
}

function isWifi(tags) {
  return ['yes', 'wlan', 'customers', 'free', 'paid'].includes((tags.internet_access || '').toLowerCase());
}

function formatDistance(metres) {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

function distanceBetween(lat1, lon1, lat2, lon2) {
  const radians = degree => degree * Math.PI / 180;
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getAmenitySignals(tags) {
  const signals = [];
  if (isWifi(tags)) signals.push({ key: 'wifi', text: '📶 Wi-Fi listed' });
  if (tags.outdoor_seating === 'yes') signals.push({ key: 'outdoor', text: '🌿 Outdoor seats' });
  if (tags.wheelchair === 'yes') signals.push({ key: 'access', text: '♿ Step-free' });
  if (tags.opening_hours) signals.push({ key: 'hours', text: '🕒 Hours listed' });
  if (tags.internet_access === 'customers' || tags.internet_access === 'paid') {
    signals.find(signal => signal.key === 'wifi').text = '📶 Wi-Fi · ask first';
  }
  return signals;
}

function scoreCompleteness(place) {
  // This ranks documented amenities, never review quality or atmosphere.
  return place.signals.reduce((score, signal) => score + ({ wifi: 4, outdoor: 3, access: 1, hours: 1 }[signal.key] || 0), 0);
}

function addressFrom(tags) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  return [street, tags['addr:suburb'] || tags['addr:neighbourhood'] || tags['addr:city']].filter(Boolean).join(' · ') || 'Address not listed';
}

function makeOverpassQuery(lat, lon, radius) {
  return `[out:json][timeout:25];(node["amenity"="cafe"](around:${radius},${lat},${lon});way["amenity"="cafe"](around:${radius},${lat},${lon});relation["amenity"="cafe"](around:${radius},${lat},${lon});node["shop"="coffee"](around:${radius},${lat},${lon});way["shop"="coffee"](around:${radius},${lat},${lon}););out center tags 150;`;
}

async function getNearbyPlaces(origin, radius) {
  const cacheKey = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}:${radius}`;
  const cached = nearbyCache[cacheKey];
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) return cached.places;
  const query = makeOverpassQuery(origin.lat, origin.lon, radius);
  let lastError;
  for (const endpoint of API.overpass) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let data;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Nearby cafe service replied with ${response.status}.`);
        data = await response.json();
      } finally {
        clearTimeout(timeout);
      }
      if (data.remark) throw new Error(data.remark);
      const places = (data.elements || []).map(item => {
        const tags = item.tags || {};
        const coordinates = item.lat !== undefined ? { lat: item.lat, lon: item.lon } : item.center;
        if (!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lon)) return null;
        const name = tags.name || tags.brand || tags.operator;
        if (!name) return null;
        const metres = distanceBetween(origin.lat, origin.lon, coordinates.lat, coordinates.lon);
        return {
          id: `${item.type}/${item.id}`,
          name,
          lat: coordinates.lat,
          lon: coordinates.lon,
          metres,
          distance: formatDistance(metres),
          address: addressFrom(tags),
          tags,
          signals: getAmenitySignals(tags),
          osmUrl: `https://www.openstreetmap.org/${encodeURIComponent(item.type)}/${item.id}`,
        };
      }).filter(place => place && place.metres <= radius);
      nearbyCache[cacheKey] = { timestamp: Date.now(), places };
      for (const [key, value] of Object.entries(nearbyCache)) {
        if (Date.now() - value.timestamp > 10 * 60 * 1000) delete nearbyCache[key];
      }
      try { localStorage.setItem('nook-nearby-cache', JSON.stringify(nearbyCache)); } catch { /* Search remains usable without browser storage. */ }
      return places;
    } catch (error) {
      lastError = error;
    }
  }
  if (cached?.places?.length) return cached.places;
  throw lastError || new Error('Could not reach a nearby cafe service. Please try again.');
}

function visiblePlaces() {
  return currentPlaces.filter(place => {
    if (activeFilter === 'wifi') return place.signals.some(signal => signal.key === 'wifi');
    if (activeFilter === 'outdoor') return place.signals.some(signal => signal.key === 'outdoor');
    return true;
  }).sort((a, b) => scoreCompleteness(b) - scoreCompleteness(a) || a.metres - b.metres);
}

function renderPlaces() {
  const places = visiblePlaces();
  $('#results-meta').textContent = `${places.length} ${places.length === 1 ? 'PLACE' : 'PLACES'} · AMENITY DETAILS FIRST, THEN DISTANCE`;
  if (!places.length) {
    list.innerHTML = `<div class="empty-results">${currentPlaces.length ? 'No cafes nearby have that amenity listed in OpenStreetMap. Try another filter.' : 'No named cafes were found in this radius. Try a larger search radius or another location.'}</div>`;
  } else {
    list.innerHTML = places.map((place, index) => {
      const badges = place.signals.map(signal => `<span class="cafe-badge">${escapeHTML(signal.text)}</span>`);
      if (!badges.length) badges.push('<span class="cafe-badge muted">No amenities listed</span>');
      const saved = savedPlaces.has(place.id);
      return `<article class="cafe-card" data-place="${escapeHTML(place.id)}" tabindex="0" aria-label="${escapeHTML(place.name)}, ${escapeHTML(place.distance)} away">
        <div class="cafe-thumb" aria-hidden="true">☕<span class="cafe-num">${index + 1}</span></div>
        <div class="cafe-content"><div class="cafe-title-row"><h3 class="cafe-title">${escapeHTML(place.name)}</h3><span class="cafe-distance">${escapeHTML(place.distance)}</span></div>
          <p class="cafe-address">${escapeHTML(place.address)}</p><div class="cafe-badges">${badges.join('')}</div>
          <div class="cafe-actions"><button class="save-button ${saved ? 'saved' : ''}" data-save="${escapeHTML(place.id)}" type="button" aria-pressed="${saved}">${saved ? '♥ Saved' : '♡ Save'}</button><a class="map-link" href="${escapeHTML(place.osmUrl)}" target="_blank" rel="noopener noreferrer">OpenStreetMap ↗</a></div>
        </div></article>`;
    }).join('');
  }
  renderMarkers(places);
}

function renderMarkers(places) {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  const bounds = [];
  places.forEach((place, index) => {
    const icon = L.divIcon({ className: 'nook-marker-wrap', html: `<span class="nook-marker">${index + 1}</span>`, iconSize: [30, 36], iconAnchor: [15, 34] });
    const marker = L.marker([place.lat, place.lon], { icon }).bindPopup(`<div class="popup-title">${escapeHTML(place.name)}</div><div class="popup-sub">${escapeHTML(place.distance)} away · ${escapeHTML(place.address)}</div>`);
    marker.on('click', () => selectCard(place.id));
    marker.addTo(markerLayer);
    bounds.push([place.lat, place.lon]);
  });
  if (currentOrigin) {
    L.circleMarker([currentOrigin.lat, currentOrigin.lon], {
      radius: 7, color: '#fffefa', weight: 3, fillColor: '#c66e43', fillOpacity: 1,
    }).bindPopup('<div class="popup-title">Search location</div><div class="popup-sub">Cafe results are measured from here.</div>').addTo(markerLayer);
    bounds.push([currentOrigin.lat, currentOrigin.lon]);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  else if (bounds.length === 1) map.setView(bounds[0], 14);
}

function selectCard(id) {
  document.querySelectorAll('.cafe-card').forEach(card => card.classList.toggle('selected', card.dataset.place === id));
  const place = currentPlaces.find(item => item.id === id);
  if (place && map) map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), 15), { duration: 0.45 });
}

function setBusy(busy, message) {
  searchButton.disabled = busy;
  searchButton.innerHTML = busy ? 'Looking…' : 'Find cafes <span>↗</span>';
  if (busy) {
    $('#results-meta').textContent = 'SEARCHING NEARBY…';
    list.innerHTML = '<div class="empty-results">Finding nearby cafes and checking their listed amenities…</div>';
    showNotice(message || 'Searching OpenStreetMap for real cafes nearby…');
  }
}

async function searchOrigin(origin, radius = Number(radiusControl.value)) {
  currentOrigin = origin;
  activeFilter = 'all';
  document.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  setBusy(true, `Looking for real cafes near ${origin.label}…`);
  locationStatus.textContent = `Searching near ${origin.label}`;
  try {
    currentPlaces = await getNearbyPlaces(origin, radius);
    renderPlaces();
    locationStatus.textContent = `${origin.label} · within ${(radius / 1000).toString().replace('.5', '½')} km`;
    showNotice(currentPlaces.length
      ? `Found ${currentPlaces.length} named cafes near ${origin.label}. Sorted by useful listed amenities, then distance—not review scores.`
      : `No named cafes found near ${origin.label} within ${formatDistance(radius)}. Try a larger radius or search somewhere else.`);
  } catch (error) {
    currentPlaces = [];
    renderPlaces();
    locationStatus.textContent = `Search unavailable near ${origin.label}`;
    showNotice(error.name === 'AbortError' ? 'The cafe search timed out. The community map service may be busy—please try again shortly.' : error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function searchTown(query) {
  const normalized = query.trim().toLocaleLowerCase();
  const cached = searchCache[normalized];
  let candidates;
  if (cached && Date.now() - cached.timestamp < 86400000) {
    candidates = cached.features;
  } else {
    const url = new URL(API.geocoder);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('limit', '5');
    url.searchParams.set('lang', 'en');
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('The place search is unavailable. Try your current location or retry in a moment.');
    const data = await response.json();
    candidates = (data.features || []).filter(feature => {
      const coords = feature.geometry?.coordinates;
      return feature.properties?.name && Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1]);
    }).map(feature => ({
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      name: feature.properties.name,
      detail: [feature.properties.district, feature.properties.city, feature.properties.state, feature.properties.country].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(', '),
    }));
    searchCache[normalized] = { timestamp: Date.now(), features: candidates };
    localStorage.setItem('nook-geocode-cache', JSON.stringify(searchCache));
  }
  if (!candidates.length) throw new Error(`No places found for “${query}”. Try a town name with its country.`);
  const best = candidates[0];
  return { lat: best.lat, lon: best.lon, label: [best.name, best.detail].filter(Boolean).join(', ') };
}

$('#place-form').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('#place-query').value.trim();
  if (!query) return;
  setBusy(true, `Finding “${query}”…`);
  try {
    const origin = await searchTown(query);
    await searchOrigin(origin);
    $('#finder').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setBusy(false);
    currentPlaces = [];
    renderPlaces();
    locationStatus.textContent = 'Place search did not complete';
    showNotice(error.message || 'Could not search for that place. Try again.', 'error');
  }
});

$('#location-button').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showNotice('This browser does not support location access. Search by town instead.', 'error');
    return;
  }
  showNotice('Requesting your browser location. If you allow it, the coordinates are sent to OpenStreetMap only to find nearby cafes.');
  locationStatus.textContent = 'Waiting for location permission…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => searchOrigin({ lat: coords.latitude, lon: coords.longitude, label: 'your location' }),
    error => {
      locationStatus.textContent = 'Location was not shared';
      showNotice(error.code === 1 ? 'Location permission was declined. Search by town instead.' : 'Could not get your location. Search by town or try again.', 'error');
    },
    { timeout: 12000, maximumAge: 120000, enableHighAccuracy: false },
  );
});

document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.filter.active').classList.remove('active');
  button.classList.add('active');
  activeFilter = button.dataset.filter;
  renderPlaces();
}));

radiusControl.addEventListener('change', () => {
  if (currentOrigin) searchOrigin(currentOrigin, Number(radiusControl.value));
});

list.addEventListener('click', event => {
  const saveButton = event.target.closest('[data-save]');
  if (saveButton) {
    event.stopPropagation();
    const id = saveButton.dataset.save;
    if (savedPlaces.has(id)) savedPlaces.delete(id);
    else savedPlaces.add(id);
    localStorage.setItem('nook-saved-places', JSON.stringify([...savedPlaces]));
    renderPlaces();
    return;
  }
  const card = event.target.closest('[data-place]');
  if (card) selectCard(card.dataset.place);
});

list.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-place]');
  if (!card || event.target.closest('button, a')) return;
  event.preventDefault();
  selectCard(card.dataset.place);
});

initMap();
