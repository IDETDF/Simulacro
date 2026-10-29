/*************************************************************************
 * 1. CONFIGURACIÓN GENERAL Y VENTANA DE 20 DÍAS DE LA OLA
 *************************************************************************/
const DRILL_START_ISO = '2026-11-11T09:00:00-03:00';
const DRILL_END_ISO   = '2026-11-11T10:30:00-03:00';
const DRILL_START_MS  = new Date(DRILL_START_ISO).getTime();
const DRILL_END_MS    = new Date(DRILL_END_ISO).getTime();

const WAVE_WINDOW_MS  = 20 * 24 * 60 * 60 * 1000;
const WAVE_START_MS   = DRILL_START_MS - WAVE_WINDOW_MS;

const DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyRtYzkaQ0r-6t49qGba-nDhpu5P8X5AzQgw8GaNSjtDQQZkPSKiQ6TQi3ZDKBHl8br/exec';

const USHUAIA_CONFIG = {
  center: [-68.3190, -54.8160],
  zoom: 12.8,
  minZoom: 11,
  maxZoom: 19,
  maxBounds: [[-68.3800, -54.8550], [-68.2400, -54.7700]]
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getOrCreateSessionId() {
  let sid = localStorage.getItem('dgot_session_id');
  if (!sid) {
    sid = 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    localStorage.setItem('dgot_session_id', sid);
  }
  return sid;
}

const appState = {
  simulateClickGps: false,
  gpsPausedForInspection: false,
  sessionId: getOrCreateSessionId(),
  webhookUrl: localStorage.getItem('dgot_webhook_url') || DEFAULT_WEBHOOK_URL,
  serverMode: 'AUTO',
  serverStage: null,
  serverStartedAt: null,
  serverOffsetMs: 0,
  currentStage: 'PRE_SIMULACRO',
  // Las 3 situaciones espaciales: 'ZONA_EVACUAR' | 'ZONA_SEGURA' | 'FUERA_SIMULACRO'
  initialZoneState: null,
  currentZoneState: null,
  cameFromEvacZone: localStorage.getItem('dgot_came_from_evac') === 'true',
  privacyAccepted: localStorage.getItem('dgot_privacy_gps_ok') === 'true',
  // GPS, Brújula y Recorrido
  gpsWatchId: null,
  autoFollowUser: true,
  compassActive: false,
  currentHeading: 0,
  lastCoords: null,
  trackCoords: [],             // Array de [lng, lat, timestamp]
  distanceWalkedMeters: 0,
  // Cronómetro
  stopwatchRunning: false,
  stopwatchStartMs: null,
  stopwatchCompletedMs: null,
  // Caché Espacial en RAM
  evacPolygonsRAM: [],
  safePolygonsRAM: [],
  streetsIndexRAM: [],
  // Emergencia
  wakeLockSentinel: null,
  alarmIntervalId: null,
  audioCtx: null,
  alarmTriggeredOnce: false,
  userHasInteracted: false
};

localStorage.removeItem('dgot_stage_override');
try {
  const cached = JSON.parse(localStorage.getItem('dgot_server_status') || 'null');
  if (cached && typeof cached === 'object') {
    if (cached.serverMode === 'AUTO' || cached.serverMode === 'MANUAL') appState.serverMode = cached.serverMode;
    if (cached.serverStage) appState.serverStage = cached.serverStage;
    if (cached.serverStartedAt) appState.serverStartedAt = cached.serverStartedAt;
    if (typeof cached.serverOffsetMs === 'number') appState.serverOffsetMs = cached.serverOffsetMs;
  }
} catch (_) {}

window.addEventListener('pointerdown', () => { appState.userHasInteracted = true; }, { once: true });
window.addEventListener('keydown', () => { appState.userHasInteracted = true; }, { once: true });

try {
  const savedStart = localStorage.getItem('dgot_evac_start_ms');
  const savedDone  = localStorage.getItem('dgot_evac_completed_ms');
  const savedDist  = localStorage.getItem('dgot_evac_dist_m');
  const savedTrack = localStorage.getItem('dgot_evac_track');
  if (savedStart) appState.stopwatchStartMs = parseInt(savedStart, 10);
  if (savedDone)  appState.stopwatchCompletedMs = parseInt(savedDone, 10);
  if (savedDist)  appState.distanceWalkedMeters = parseInt(savedDist, 10);
  if (savedTrack) appState.trackCoords = JSON.parse(savedTrack);

  const cEvac = localStorage.getItem('dgot_ram_evac');
  const cSafeQgis = localStorage.getItem('dgot_ram_zona_segura_qgis');
  if (cEvac) appState.evacPolygonsRAM = JSON.parse(cEvac);
  if (cSafeQgis) appState.safePolygonsRAM = JSON.parse(cSafeQgis);
} catch (e) {
  console.warn('Error restaurando caché local:', e);
}

/**
 * Regla de negocio: El certificado SOLO se habilita si la persona fue desde
 * la Zona a Evacuar hacia la Zona Segura registrando recorrido (m > 0) y tiempo (> 0).
 */
function isCertificateUnlocked() {
  return Boolean(
    appState.cameFromEvacZone &&
    appState.stopwatchCompletedMs &&
    appState.stopwatchCompletedMs > 0 &&
    appState.distanceWalkedMeters > 0
  );
}

function updateCertificateButtonStateUI() {
  const btnCert   = document.getElementById('btnOpenCert');
  const titleCert = document.getElementById('certBtnTitle');
  const subCert   = document.getElementById('certBtnSub');
  const unlocked  = isCertificateUnlocked();

  if (unlocked) {
    btnCert.classList.remove('is-locked');
    titleCert.textContent = '🏅 Certificado';
    subCert.textContent   = 'Descargar ahora';
  } else {
    btnCert.classList.add('is-locked');
    titleCert.textContent = '🔒 Certificado';
    subCert.textContent   = 'Al llegar a meta';
  }
}

/*************************************************************************
 * 2. ESTILO MAPLIBRE (CON ./zona_segura.geojson Y CAPA DE RECORRIDO REAL)
 *************************************************************************/
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const mapStyle = {
  version: 8,
  glyphs: "./fonts/{fontstack}/{range}.pbf",
  sprite: "./sprite/sprite",
  sources: {
    satelite_source: {
      type: "raster",
      url: "pmtiles://./fondo_satelital.pmtiles",
      tileSize: 256
    },
    operativas_source: {
      type: "vector",
      url: "pmtiles://./capas_operativas.pmtiles"
    },
    zona_segura_source: {
      type: "geojson",
      data: "./zona_segura.geojson"
    },
    recorrido_usuario_source: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    }
  },
  layers: [
    {
      id: "lyr-satelite",
      type: "raster",
      source: "satelite_source",
      paint: {
        "raster-saturation": -1,
        "raster-contrast": 0.15,
        "raster-brightness-max": 0.95
      }
    },
    {
      id: "zona-evacuacion-fill",
      type: "fill",
      source: "operativas_source",
      "source-layer": "poligono_simulacrogeojson",
      paint: { "fill-color": "rgba(230, 0, 0, 0.28)" }
    },
    {
      id: "calles-borde",
      type: "line",
      source: "operativas_source",
      "source-layer": "callesgeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#0f172a",
        "line-width": [
          "match",
          ["get", "gna"],
          ["Ruta Nacional", "Ruta Provincial", "Avenida"], 5.5,
          3.5
        ],
        "line-opacity": 0.85
      }
    },
    {
      id: "calles-blanco",
      type: "line",
      source: "operativas_source",
      "source-layer": "callesgeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "gna"],
          ["Ruta Nacional", "Ruta Provincial", "Avenida"], "#fef08a",
          "#ffffff"
        ],
        "line-width": [
          "match",
          ["get", "gna"],
          ["Ruta Nacional", "Ruta Provincial", "Avenida"], 3.2,
          1.8
        ],
        "line-opacity": 0.9
      }
    },
    {
      id: "zona-evacuacion-borde-negro",
      type: "line",
      source: "operativas_source",
      "source-layer": "poligono_simulacrogeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#000000", "line-width": 6 }
    },
    {
      id: "zona-evacuacion-borde-blanco",
      type: "line",
      source: "operativas_source",
      "source-layer": "poligono_simulacrogeojson",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 3.2, "line-dasharray": [2, 2] }
    },
    {
      id: "zona-evacuacion-borde-fino",
      type: "line",
      source: "operativas_source",
      "source-layer": "poligono_simulacrogeojson",
      paint: { "line-color": "rgb(230, 0, 0)", "line-width": 1.2 }
    },
    {
      id: "vias-evacuacion-borde",
      type: "line",
      source: "operativas_source",
      "source-layer": "vias_evacuaciongeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#e0f2fe", "line-width": 6.5 }
    },
    {
      id: "vias-evacuacion",
      type: "line",
      source: "operativas_source",
      "source-layer": "vias_evacuaciongeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgb(26, 35, 222)", "line-width": 4.2 }
    },
    {
      id: "vias-evacuacion-flechas",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "vias_evacuaciongeojson",
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 75,
        "icon-image": "flecha_azul",
        "icon-size": 0.85,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    },
    {
      id: "escaleras-base",
      type: "line",
      source: "operativas_source",
      "source-layer": "escalerasgeojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 5.0 }
    },
    {
      id: "escaleras-trazo",
      type: "line",
      source: "operativas_source",
      "source-layer": "escalerasgeojson",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#1d4ed8", "line-width": 3.0, "line-dasharray": [1.5, 1.5] }
    },
    {
      id: "seguridad-puntos",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "seguridadgeojson",
      layout: { "icon-image": "seguridad", "icon-size": 0.3, "icon-allow-overlap": true }
    },
    {
      id: "bomberos-puntos",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "bomberosgeojson",
      layout: { "icon-image": "bomberos", "icon-size": 0.3, "icon-allow-overlap": true }
    },
    {
      id: "salud-privada-puntos",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "salud_privadageojson",
      layout: { "icon-image": "salud_priv", "icon-size": 0.3, "icon-allow-overlap": true }
    },
    {
      id: "salud-publica-puntos",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "salud_publicageojson",
      layout: { "icon-image": "salud_pub", "icon-size": 0.3, "icon-allow-overlap": true }
    },
    {
      id: "zona-recorte-mascara",
      type: "fill",
      source: "operativas_source",
      "source-layer": "mascara_recortegeojson",
      paint: {
        "fill-color": "#383838",
        "fill-opacity": 0.68
      }
    },
    {
      id: "zona-segura-fill",
      type: "fill",
      source: "zona_segura_source",
      paint: { "fill-color": "rgba(11, 167, 41, 0.28)" }
    },
    {
      id: "zona-segura-borde-negro",
      type: "line",
      source: "zona_segura_source",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#000000", "line-width": 6 }
    },
    {
      id: "zona-segura-borde-blanco",
      type: "line",
      source: "zona_segura_source",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 3.2, "line-dasharray": [2, 2] }
    },
    {
      id: "zona-segura-borde-fino",
      type: "line",
      source: "zona_segura_source",
      paint: { "line-color": "rgb(11, 167, 41)", "line-width": 1.2 }
    },
    {
      id: "recorrido-real-halo",
      type: "line",
      source: "recorrido_usuario_source",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 8.0,
        "line-opacity": 0.9
      }
    },
    {
      id: "recorrido-real-linea",
      type: "line",
      source: "recorrido_usuario_source",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#00e676",
        "line-width": 4.5
      }
    },
    {
      id: "cota-segura",
      type: "line",
      source: "operativas_source",
      "source-layer": "cota_segurageojson",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgb(11, 167, 41)",
        "line-width": 5.5
      }
    },
    {
      id: "lbl-calles",
      type: "symbol",
      source: "operativas_source",
      "source-layer": "callesgeojson",
      minzoom: 14.0,
      layout: {
        "symbol-placement": "line",
        "text-field": ["coalesce", ["get", "nam"], ["get", "fna"], ""],
        "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
        "text-size": 11.5
      },
      paint: {
        "text-color": "#0f172a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2.2
      }
    }
  ]
};

const map = new maplibregl.Map({
  container: 'map',
  style: mapStyle,
  center: USHUAIA_CONFIG.center,
  zoom: USHUAIA_CONFIG.zoom,
  minZoom: USHUAIA_CONFIG.minZoom,
  maxZoom: USHUAIA_CONFIG.maxZoom,
  maxBounds: USHUAIA_CONFIG.maxBounds,
  attributionControl: false
});

map.on('dragstart', () => {
  appState.autoFollowUser = false;
});

/*************************************************************************
 * 3. PRECARGA OPTIMIZADA EN RAM
 *************************************************************************/
async function loadZonaSeguraGeoJsonIntoRAM() {
  try {
    const resp = await fetch('./zona_segura.geojson');
    if (!resp.ok) return;
    const geojson = await resp.json();

    let features = [];
    if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
      features = geojson.features.filter(f => f && f.geometry);
    } else if (geojson.type === 'Feature' && geojson.geometry) {
      features = [geojson];
    } else if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
      features = [{ type: 'Feature', geometry: geojson, properties: {} }];
    }

    if (features.length > 0) {
      appState.safePolygonsRAM = features;
      try {
        localStorage.setItem('dgot_ram_zona_segura_qgis', JSON.stringify(features));
      } catch (_) {}
    }
  } catch (err) {
    console.warn('Error cargando ./zona_segura.geojson en RAM:', err);
  }
}

let idleCaptureTimeout = null;

function captureVectorFeaturesIntoRAM() {
  if (!map.isStyleLoaded()) return;

  if (appState.evacPolygonsRAM.length === 0) {
    const rawEvac = map.querySourceFeatures('operativas_source', { sourceLayer: 'poligono_simulacrogeojson' }) || [];
    if (rawEvac.length > 0) {
      appState.evacPolygonsRAM = rawEvac
        .filter(f => f.geometry)
        .map(f => ({ type: 'Feature', geometry: f.geometry, properties: f.properties || {} }));
      try { localStorage.setItem('dgot_ram_evac', JSON.stringify(appState.evacPolygonsRAM)); } catch (_) {}
    }
  }

  const rawStreets = map.querySourceFeatures('operativas_source', { sourceLayer: 'callesgeojson' }) || [];
  if (rawStreets.length > 0 && appState.streetsIndexRAM.length < 150) {
    const byName = new Map();
    for (const st of rawStreets) {
      const name = (st.properties?.nam || st.properties?.fna || '').trim();
      if (!name || byName.has(name.toUpperCase())) continue;
      let samplePt = null;
      if (st.geometry?.type === 'LineString' && st.geometry.coordinates.length > 0) {
        samplePt = st.geometry.coordinates[Math.floor(st.geometry.coordinates.length / 2)];
      } else if (st.geometry?.type === 'MultiLineString' && st.geometry.coordinates[0]?.length > 0) {
        const seg = st.geometry.coordinates[0];
        samplePt = seg[Math.floor(seg.length / 2)];
      }
      if (samplePt) {
        byName.set(name.toUpperCase(), { name, coords: [Number(samplePt[0].toFixed(5)), Number(samplePt[1].toFixed(5))] });
      }
    }
    appState.streetsIndexRAM = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (
    appState.evacPolygonsRAM.length > 0 &&
    appState.streetsIndexRAM.length > 20
  ) {
    map.off('idle', debouncedCaptureRAM);
  }
}

function debouncedCaptureRAM() {
  clearTimeout(idleCaptureTimeout);
  idleCaptureTimeout = setTimeout(captureVectorFeaturesIntoRAM, 600);
}

loadZonaSeguraGeoJsonIntoRAM();

map.on('load', () => {
  loadZonaSeguraGeoJsonIntoRAM();
  captureVectorFeaturesIntoRAM();
  renderUserWalkedTrackOnMap();
  updateCertificateButtonStateUI();
});

map.on('idle', debouncedCaptureRAM);

const interactiveLayers = [
  'salud-publica-puntos',
  'salud-privada-puntos',
  'bomberos-puntos',
  'seguridad-puntos'
];

map.on('click', (e) => {
  if (appState.simulateClickGps) {
    appState.gpsPausedForInspection = true;
    document.getElementById('gpsDot').classList.remove('active');
    document.getElementById('gpsBtnLabel').textContent = '📡 Volver a mi GPS en vivo';
    handleGpsUpdate([e.lngLat.lng, e.lngLat.lat], true);
    return;
  }

  const features = map.queryRenderedFeatures(e.point, { layers: interactiveLayers });
  if (!features.length) return;

  const f = features[0];
  const props = f.properties || {};
  const title = escapeHtml(props.nombre || props.nam || props.fna || props.institucion || 'Servicio de Emergencia');
  const subtitle = escapeHtml(props.direccion || props.domicilio || '');

  new maplibregl.Popup({ closeButton: true, maxWidth: '240px' })
    .setLngLat(e.lngLat)
    .setHTML(`
      <div style="color:#062338; font-size:0.82rem; line-height:1.35; font-family:sans-serif;">
        <strong style="display:block; margin-bottom:3px; color:#ea5b1b;">${title}</strong>
        <span>${subtitle}</span>
      </div>
    `)
    .addTo(map);
});

/*************************************************************************
 * 4. EVALUACIÓN DE LAS 3 SITUACIONES ESPACIALES
 *************************************************************************/
function isPointInsideEvacPolygon(pt) {
  let list = appState.evacPolygonsRAM;
  if (!list || list.length === 0) {
    list = map.querySourceFeatures('operativas_source', { sourceLayer: 'poligono_simulacrogeojson' }) || [];
  }
  for (const poly of list) {
    if (!poly || !poly.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, poly)) return true;
    } catch (_) {}
  }
  return false;
}

function isPointInsideZonaSeguraGeoJson(pt) {
  let list = appState.safePolygonsRAM;
  if (!list || list.length === 0) {
    list = map.querySourceFeatures('zona_segura_source') || [];
  }
  for (const poly of list) {
    if (!poly || !poly.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, poly)) return true;
    } catch (_) {}
  }
  return false;
}

function evaluateThreeSituations(lngLat) {
  const pt = turf.point(lngLat);

  if (isPointInsideEvacPolygon(pt)) {
    if (appState.currentStage === 'DURANTE_SIMULACRO') {
      appState.cameFromEvacZone = true;
      localStorage.setItem('dgot_came_from_evac', 'true');
    }
    return 'ZONA_EVACUAR';
  }

  if (isPointInsideZonaSeguraGeoJson(pt)) {
    return 'ZONA_SEGURA';
  }

  return 'FUERA_SIMULACRO';
}

/*************************************************************************
 * 5. MARCADOR GPS, BRÚJULA (ORIENTAR MAPA) Y RECORRIDO REAL EN EL MAPA
 *************************************************************************/
let userMarker = null;
let userMarkerEl = null;

function ensureUserMarker(lngLat, situation) {
  if (!userMarker) {
    userMarkerEl = document.createElement('div');
    userMarkerEl.className = 'user-gps-marker';
    const cone = document.createElement('div');
    cone.className = 'user-heading-cone';
    userMarkerEl.appendChild(cone);

    userMarker = new maplibregl.Marker({ element: userMarkerEl })
      .setLngLat(lngLat)
      .addTo(map);
  } else {
    userMarker.setLngLat(lngLat);
  }

  userMarkerEl.classList.remove('level-evac', 'level-safe', 'level-outside');
  if (situation === 'ZONA_EVACUAR') userMarkerEl.classList.add('level-evac');
  else if (situation === 'ZONA_SEGURA') userMarkerEl.classList.add('level-safe');
  else userMarkerEl.classList.add('level-outside');

  userMarkerEl.classList.toggle('compass-on', appState.compassActive);
}

function renderUserWalkedTrackOnMap() {
  const source = map.getSource('recorrido_usuario_source');
  if (!source) return;

  const track = appState.trackCoords;
  if (!track || track.length < 2) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const coords = track.map(pt => [pt[0], pt[1]]);
  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: coords
      }
    }]
  });
}

function recordBreadcrumbPoint(lngLat) {
  const now = Date.now();
  const track = appState.trackCoords;

  if (track.length === 0) {
    track.push([ Number(lngLat[0].toFixed(6)), Number(lngLat[1].toFixed(6)), now ]);
    localStorage.setItem('dgot_evac_track', JSON.stringify(track));
    return;
  }

  const prev = track[track.length - 1];
  const stepMeters = Math.round(
    turf.distance(turf.point([prev[0], prev[1]]), turf.point(lngLat), { units: 'kilometers' }) * 1000
  );

  if (stepMeters >= 6 && stepMeters <= 2500) {
    appState.distanceWalkedMeters += stepMeters;
    track.push([ Number(lngLat[0].toFixed(6)), Number(lngLat[1].toFixed(6)), now ]);
    localStorage.setItem('dgot_evac_dist_m', appState.distanceWalkedMeters.toString());
    localStorage.setItem('dgot_evac_track', JSON.stringify(track));
    renderUserWalkedTrackOnMap();
  }
}

function handleGpsUpdate(coords) {
  appState.lastCoords = coords;

  const sheet = document.getElementById('citizenSheet');
  if (sheet.classList.contains('collapsed')) {
    sheet.classList.remove('collapsed');
    document.getElementById('sheetToggleText').textContent = 'Minimizar panel ▼';
  }

  const situation = evaluateThreeSituations(coords);
  const prevSituation = appState.currentZoneState;
  appState.currentZoneState = situation;

  if (!appState.initialZoneState) {
    appState.initialZoneState = situation;
    enqueueTelemetrySilent('GPS_INITIAL_FIX');
  }

  ensureUserMarker(coords, situation);

  const isDrillActive = appState.currentStage === 'DURANTE_SIMULACRO';

  if (isDrillActive && (situation === 'ZONA_EVACUAR' ||
      (appState.cameFromEvacZone && !appState.stopwatchCompletedMs))) {
    recordBreadcrumbPoint(coords);
  }

  const [[w, s], [e, n]] = USHUAIA_CONFIG.maxBounds;
  const isInsideMapBounds = (coords[0] >= w && coords[0] <= e && coords[1] >= s && coords[1] <= n);

  if ((appState.autoFollowUser || appState.stopwatchRunning) && isInsideMapBounds) {
    map.easeTo({
      center: coords,
      zoom: Math.max(map.getZoom(), 15.6),
      bearing: appState.compassActive ? appState.currentHeading : map.getBearing(),
      duration: 550
    });
  }

  const statusBox  = document.getElementById('statusBox');
  const statusIcon = document.getElementById('statusIcon');
  const titleEl    = document.getElementById('statusTitle');
  const pillEl     = document.getElementById('statusDistancePill');
  const descEl     = document.getElementById('statusDescription');

  if (situation === 'ZONA_EVACUAR') {
    statusBox.className = 'status-banner status-evac';
    statusIcon.textContent = '🚨';

    if (isDrillActive && !appState.stopwatchRunning && !appState.stopwatchCompletedMs) {
      startEvacuationStopwatch();
    }

    pillEl.style.display = 'none';
    titleEl.textContent = isDrillActive ? '¡Estás en Zona a Evacuar!' : 'Estás en Zona a Evacuar';
    descEl.innerHTML =
      'Dirigite hacia la <strong>Zona Segura (verde)</strong> subiendo por las <strong>vías de evacuación</strong> señalizadas (flechas azules) y escaleras peatonales.';

  } else if (situation === 'ZONA_SEGURA') {
    statusBox.className = 'status-banner status-safe';
    statusIcon.textContent = '✅';

    if (appState.cameFromEvacZone) {
      if (appState.stopwatchRunning && !appState.stopwatchCompletedMs) {
        stopEvacuationStopwatchOnSafeZone();
        enqueueTelemetrySilent('SAFE_ZONE_REACHED_FROM_EVAC');
      }
      renderUserWalkedTrackOnMap();

      const finalTime = appState.stopwatchCompletedMs
        ? formatStopwatch(appState.stopwatchCompletedMs)
        : null;

      pillEl.style.display = 'inline-block';
      pillEl.textContent = finalTime ? `Tiempo: ${finalTime}` : 'A salvo';
      titleEl.textContent = '¡Llegaste a la Zona Segura!';
      descEl.innerHTML = finalTime
        ? `Completaste la evacuación desde el área roja. Tiempo: <strong>${finalTime}</strong> | Recorrido trazado en el mapa: <strong>${appState.distanceWalkedMeters} m</strong>.`
        : `Ingresaste correctamente a la Zona Segura verde.`;
    } else {
      pillEl.style.display = 'inline-block';
      pillEl.textContent = 'Ubicación segura';
      titleEl.textContent = 'Estás en Zona Segura';
      descEl.textContent =
        'Ya te encontrás dentro de la Zona Segura (franja verde) del simulacro. No necesitás evacuar.';
    }

  } else {
    statusBox.className = 'status-banner status-outside';
    statusIcon.textContent = 'ℹ️';
    pillEl.style.display = 'inline-block';
    pillEl.textContent = 'Fuera del sector';
    titleEl.textContent = 'Estás fuera de la zona del simulacro';
    descEl.textContent =
      'Te encontrás fuera de la zona a evacuar y de la zona segura de este simulacro. No se asegura estar en zona segura (todavía no existe información en el sistema al respecto).';
  }

  if (prevSituation && prevSituation !== situation) {
    enqueueTelemetrySilent(`SITUATION_CHANGE_TO_${situation}`);
  }

  updateCertificateButtonStateUI();
  refreshPostStatsUI();
}

function requestGpsWithPrivacyCheck() {
  if (!appState.privacyAccepted) {
    openModal('modalPrivacyConsent');
    return;
  }
  startGpsTracking();
}

document.getElementById('btnAcceptPrivacyGps').addEventListener('click', () => {
  appState.privacyAccepted = true;
  localStorage.setItem('dgot_privacy_gps_ok', 'true');
  closeModal('modalPrivacyConsent');
  startGpsTracking();
});

function startGpsTracking() {
  if (!('geolocation' in navigator)) {
    alert('Tu teléfono no tiene soporte de ubicación GPS.');
    return;
  }

  appState.gpsPausedForInspection = false;
  appState.autoFollowUser = true;
  document.getElementById('gpsDot').classList.add('active');
  document.getElementById('gpsBtnLabel').textContent = 'Ubicación activa (Centrar en mí)';

  if (appState.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(appState.gpsWatchId);
  }

  appState.gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (appState.gpsPausedForInspection) return;
      handleGpsUpdate([pos.coords.longitude, pos.coords.latitude]);
    },
    (err) => {
      const statusBox = document.getElementById('statusBox');
      statusBox.className = 'status-banner status-outside';
      document.getElementById('statusIcon').textContent = '📡';
      document.getElementById('statusTitle').textContent = 'Permiso de GPS desactivado';
      if (err && err.code === 1) {
        document.getElementById('statusDescription').textContent =
          'Habilitá el permiso de ubicación tocando el ícono de ajustes junto a la barra de dirección del navegador.';
      } else {
        document.getElementById('statusDescription').textContent =
          'Verificá que la ubicación de tu teléfono esté encendida.';
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
  );
}

/*************************************************************************
 * 6. BOTÓN DE BRÚJULA / ORIENTAR MAPA HACIA DONDE APUNTA EL CELULAR
 *************************************************************************/
function handleDeviceOrientation(event) {
  if (!appState.compassActive) return;

  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading;
  } else if (typeof event.alpha === 'number') {
    heading = (360 - event.alpha) % 360;
  }

  if (heading === null || isNaN(heading)) return;

  const diff = Math.abs(heading - appState.currentHeading);
  if (diff < 3) return;

  appState.currentHeading = heading;

  map.easeTo({
    center: appState.lastCoords || map.getCenter(),
    bearing: heading,
    duration: 200
  });
}

async function toggleCompassOrientation() {
  const btn = document.getElementById('btnCompassOrient');

  if (appState.compassActive) {
    appState.compassActive = false;
    btn.classList.remove('compass-active');
    btn.textContent = '🧭 Orientar';
    window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
    if (userMarkerEl) userMarkerEl.classList.remove('compass-on');
    map.easeTo({ bearing: 0, duration: 400 });
    return;
  }

  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        alert('Se requiere permiso de sensores de orientación para girar el mapa con la brújula.');
        return;
      }
    } catch (err) {
      console.warn('Error solicitando permiso de brújula:', err);
    }
  }

  appState.compassActive = true;
  appState.autoFollowUser = true;
  btn.classList.add('compass-active');
  btn.textContent = '🧭 Activa';

  if (userMarkerEl) userMarkerEl.classList.add('compass-on');

  if (appState.lastCoords) {
    map.easeTo({ center: appState.lastCoords, zoom: Math.max(map.getZoom(), 16), duration: 450 });
  } else {
    requestGpsWithPrivacyCheck();
  }

  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
  } else {
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
  }
}

document.getElementById('btnCompassOrient').addEventListener('click', toggleCompassOrientation);

/*************************************************************************
 * 7. BUSCADOR RÁPIDO DE CALLES OFFLINE
 *************************************************************************/
document.getElementById('streetSearchInput').addEventListener('input', (e) => {
  const query = e.target.value.trim().toUpperCase();
  const container = document.getElementById('streetSearchResults');

  if (query.length < 2) {
    container.innerHTML = '<p class="modal-helper">Ingresá al menos 2 letras para buscar en la red vial de Ushuaia.</p>';
    return;
  }

  if (appState.streetsIndexRAM.length === 0) {
    captureVectorFeaturesIntoRAM();
  }

  const matches = appState.streetsIndexRAM
    .filter(item => item.name.toUpperCase().includes(query))
    .slice(0, 8);

  if (matches.length === 0) {
    container.innerHTML = '<p class="modal-helper">No se encontraron calles con ese nombre en el encuadre actual.</p>';
    return;
  }

  container.innerHTML = '';
  matches.forEach((st) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-result-btn';
    btn.innerHTML = `<span>📍 ${escapeHtml(st.name)}</span><small>Ver en mapa →</small>`;
    btn.addEventListener('click', () => {
      closeModal('modalSearchStreet');
      appState.gpsPausedForInspection = true;
      appState.autoFollowUser = true;
      document.getElementById('gpsDot').classList.remove('active');
      document.getElementById('gpsBtnLabel').textContent = '📡 Volver a mi ubicación GPS actual';
      handleGpsUpdate(st.coords, true);
    });
    container.appendChild(btn);
  });
});

/*************************************************************************
 * 8. WAKE LOCK + ALERTA MULTIMODAL
 *************************************************************************/
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator && !appState.wakeLockSentinel) {
    try {
      appState.wakeLockSentinel = await navigator.wakeLock.request('screen');
      appState.wakeLockSentinel.addEventListener('release', () => {
        appState.wakeLockSentinel = null;
      });
    } catch (_) {}
  }
}

function releaseScreenWakeLock() {
  if (appState.wakeLockSentinel) {
    appState.wakeLockSentinel.release().catch(() => {});
    appState.wakeLockSentinel = null;
  }
}

function safeVibrate(pattern) {
  const canVibrate =
    'vibrate' in navigator &&
    (appState.userHasInteracted || (navigator.userActivation && navigator.userActivation.hasBeenActive));
  if (canVibrate) {
    try { navigator.vibrate(pattern); } catch (_) {}
  }
}

function triggerEmergencyAlarm() {
  if (appState.alarmTriggeredOnce) return;
  appState.alarmTriggeredOnce = true;

  document.getElementById('btnMuteAlarm').classList.add('visible');
  safeVibrate([500, 250, 500, 250, 800]);

  if (!appState.userHasInteracted && !(navigator.userActivation && navigator.userActivation.hasBeenActive)) {
    return;
  }

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    appState.audioCtx = new AudioContextClass();

    const playBeepPair = () => {
      if (!appState.audioCtx) return;
      const now = appState.audioCtx.currentTime;
      const osc = appState.audioCtx.createOscillator();
      const gain = appState.audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(660, now + 0.25);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

      osc.connect(gain);
      gain.connect(appState.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.56);
    };

    playBeepPair();
    let cycles = 0;
    appState.alarmIntervalId = setInterval(() => {
      cycles++;
      if (cycles > 8) {
        stopEmergencyAlarm();
        return;
      }
      playBeepPair();
      safeVibrate([350, 150, 350]);
    }, 1200);
  } catch (_) {}
}

function stopEmergencyAlarm() {
  if (appState.alarmIntervalId) {
    clearInterval(appState.alarmIntervalId);
    appState.alarmIntervalId = null;
  }
  safeVibrate(0);
  if (appState.audioCtx) {
    appState.audioCtx.close().catch(() => {});
    appState.audioCtx = null;
  }
  document.getElementById('btnMuteAlarm').classList.remove('visible');
}

document.getElementById('btnMuteAlarm').addEventListener('click', stopEmergencyAlarm);

/*************************************************************************
 * 9. RELOJ DE 3 ETAPAS Y AVANCE DE LA OLA
 *************************************************************************/
function startEvacuationStopwatch() {
  if (appState.stopwatchCompletedMs) return;
  if (!appState.stopwatchStartMs) {
    appState.stopwatchStartMs = computeEvacStartMs(Date.now());
    localStorage.setItem('dgot_evac_start_ms', appState.stopwatchStartMs.toString());
    enqueueTelemetrySilent('EVACUATION_STARTED');
  }
  appState.stopwatchRunning = true;
}

function computeEvacStartMs(now) {
  if (appState.serverMode === 'MANUAL' && appState.serverStartedAt) {
    return appState.serverStartedAt - appState.serverOffsetMs;
  }
  return (now >= DRILL_START_MS && now - DRILL_START_MS < 3600000) ? DRILL_START_MS : now;
}

function stopEvacuationStopwatchOnSafeZone() {
  if (!appState.stopwatchStartMs) appState.stopwatchStartMs = Date.now();
  const elapsed = Math.max(1000, Date.now() - appState.stopwatchStartMs);
  appState.stopwatchCompletedMs = elapsed;
  appState.stopwatchRunning = false;

  localStorage.setItem('dgot_evac_completed_ms', elapsed.toString());
  updateCertificateButtonStateUI();
  refreshPostStatsUI();
}

function resetStopwatch() {
  appState.stopwatchRunning = false;
  appState.stopwatchStartMs = null;
  appState.stopwatchCompletedMs = null;
  appState.distanceWalkedMeters = 0;
  appState.trackCoords = [];
  appState.cameFromEvacZone = false;
  localStorage.removeItem('dgot_evac_start_ms');
  localStorage.removeItem('dgot_evac_completed_ms');
  localStorage.removeItem('dgot_evac_dist_m');
  localStorage.removeItem('dgot_evac_track');
  localStorage.removeItem('dgot_came_from_evac');
  renderUserWalkedTrackOnMap();
  updateCertificateButtonStateUI();
  refreshPostStatsUI();
}

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d)}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

function formatStopwatch(msElapsed) {
  const totalSeconds = Math.max(0, Math.floor(msElapsed / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function resolveCurrentStage(nowMs) {
  if (appState.serverMode === 'MANUAL' && appState.serverStage) return appState.serverStage;
  if (nowMs < DRILL_START_MS) return 'PRE_SIMULACRO';
  if (nowMs < DRILL_END_MS) return 'DURANTE_SIMULACRO';
  return 'POST_SIMULACRO';
}

function updateWaveProgress20Days(nowMs) {
  const waveTrack = document.getElementById('waveProgressTrack');
  if (!waveTrack) return;

  if (appState.currentStage !== 'PRE_SIMULACRO') {
    waveTrack.style.width = '100%';
    return;
  }

  const elapsedFrom20Days = nowMs - WAVE_START_MS;
  const rawRatio = elapsedFrom20Days / WAVE_WINDOW_MS;
  const clampedPct = Math.min(100, Math.max(8, rawRatio * 100));
  waveTrack.style.width = `${clampedPct.toFixed(2)}%`;
}

function refreshPostStatsUI() {
  const timeStr = appState.stopwatchCompletedMs
    ? formatStopwatch(appState.stopwatchCompletedMs)
    : (appState.stopwatchStartMs ? formatStopwatch(Date.now() - appState.stopwatchStartMs) : '00:00:00');

  document.getElementById('postSummaryStats').textContent =
    `Tiempo: ${timeStr} | Recorrido: ${appState.distanceWalkedMeters} m`;
}

function tickApplicationClock() {
  const now = Date.now();
  const prevStage = appState.currentStage;
  const stage = resolveCurrentStage(now);
  appState.currentStage = stage;

  updateWaveProgress20Days(now);

  const banner     = document.getElementById('timerBanner');
  const label      = document.getElementById('timerLabel');
  const subtext    = document.getElementById('timerSubtext');
  const digits     = document.getElementById('timerDigits');
  const postBanner = document.getElementById('postDrillBanner');

  if (stage === 'PRE_SIMULACRO') {
    if (appState.stopwatchStartMs || appState.stopwatchCompletedMs || appState.cameFromEvacZone) {
      resetStopwatch();
    }
    releaseScreenWakeLock();
    postBanner.style.display = 'none';
    banner.className = 'stage-pill';
    label.textContent = '11 NOV · 09:00 H · USHUAIA';
    subtext.textContent = 'Tiempo restante para el simulacro';
    digits.textContent = formatCountdown(Math.max(0, DRILL_START_MS - now));

  } else if (stage === 'DURANTE_SIMULACRO') {
    if (prevStage !== 'DURANTE_SIMULACRO') {
      appState.alarmTriggeredOnce = false;
      requestScreenWakeLock();
      triggerEmergencyAlarm();
      showDrillAlertModal();
      if (appState.currentZoneState === 'ZONA_EVACUAR' && !appState.stopwatchCompletedMs) {
        startEvacuationStopwatch();
      }
      if (appState.lastCoords) handleGpsUpdate(appState.lastCoords);
    }

    if (isCertificateUnlocked()) {
      banner.className = 'stage-pill stage-safe';
      label.textContent = 'EVACUACIÓN COMPLETADA';
      subtext.textContent = 'Llegaste a la Zona Segura';
      digits.textContent = formatStopwatch(appState.stopwatchCompletedMs);
      postBanner.style.display = 'flex';
      document.getElementById('postSummaryTitle').textContent = '¡Llegaste a Zona Segura!';
      refreshPostStatsUI();
    } else {
      postBanner.style.display = 'none';
      banner.className = 'stage-pill stage-during';
      label.textContent = 'SIMULACRO ACTIVO EN CURSO';
      subtext.textContent = appState.stopwatchRunning
        ? 'Tiempo de evacuación corriendo'
        : 'Verificá tu ubicación GPS';
      const elapsed = appState.stopwatchStartMs ? (now - appState.stopwatchStartMs) : 0;
      digits.textContent = formatStopwatch(elapsed);
    }

  } else if (stage === 'POST_SIMULACRO') {
    releaseScreenWakeLock();
    stopEmergencyAlarm();
    document.getElementById('modalDrillAlert').classList.remove('open');
    if (prevStage !== 'POST_SIMULACRO') {
      enqueueTelemetrySilent('DRILL_FINISHED_SUMMARY');
    }

    banner.className = 'stage-pill stage-post';
    label.textContent = 'SIMULACRO FINALIZADO';
    subtext.textContent = 'Ya podés regresar al punto de partida';
    digits.textContent = appState.stopwatchCompletedMs
      ? formatStopwatch(appState.stopwatchCompletedMs)
      : 'CONCLUIDO';

    postBanner.style.display = isCertificateUnlocked() ? 'flex' : 'none';
    document.getElementById('postSummaryTitle').textContent = '¡Evacuación Completada!';
    refreshPostStatsUI();
  }
}

function showDrillAlertModal() {
  document.getElementById('modalDrillAlert').classList.add('open');
}

document.getElementById('btnDrillAlertOk').addEventListener('click', () => {
  document.getElementById('modalDrillAlert').classList.remove('open');
});

setInterval(tickApplicationClock, 1000);
tickApplicationClock();

document.getElementById('btnNotifySafeWa').addEventListener('click', () => {
  const timeStr = appState.stopwatchCompletedMs
    ? formatStopwatch(appState.stopwatchCompletedMs)
    : 'a salvo';
  const msg = encodeURIComponent(
    `✅ Ya llegué a la Zona Segura en el Simulacro de Evacuación de Ushuaia (Tiempo: ${timeStr} | Recorrido: ${appState.distanceWalkedMeters} m).`
  );
  window.open(`https://wa.me/?text=${msg}`, '_blank');
});

/*************************************************************************
 * 10. CONSTANCIA DE PARTICIPACIÓN EN CANVAS
 *************************************************************************/
function tryOpenCertificateModal() {
  if (!isCertificateUnlocked()) {
    alert(
      '🔒 La Constancia de Participación se habilita únicamente durante el simulacro al evacuar desde la Zona a Evacuar (roja) hasta la Zona Segura (verde), registrando tu tiempo y recorrido en metros.'
    );
    return;
  }
  openModal('modalCert');
}

function renderCertificateCanvas() {
  const canvas = document.getElementById('certCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = 1080;
  const H = 1920;

  const userName = (document.getElementById('certName').value || 'Vecino/a de Ushuaia').trim();
  const userZone = (document.getElementById('certNeighborhood').value || 'Ushuaia, Tierra del Fuego').trim();
  const timeStr  = formatStopwatch(appState.stopwatchCompletedMs || 0);

  ctx.fillStyle = '#062338';
  ctx.fillRect(0, 0, W, H);

  const alertCenterX = 820;
  const alertCenterY = 580;
  for (let r = 90; r <= 420; r += 65) {
    ctx.beginPath();
    ctx.arc(alertCenterX, alertCenterY, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(234, 91, 27, 0.32)';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  ctx.fillStyle = '#0066aa';
  ctx.beginPath();
  ctx.moveTo(0, 780);
  ctx.bezierCurveTo(280, 520, 620, 560, 740, 820);
  ctx.lineTo(0, 980);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#0088ff';
  ctx.beginPath();
  ctx.moveTo(0, 860);
  ctx.bezierCurveTo(320, 640, 580, 690, 690, 920);
  ctx.lineTo(0, 1050);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ea5b1b';
  ctx.beginPath();
  ctx.moveTo(820, 440);
  ctx.lineTo(960, 690);
  ctx.lineTo(680, 690);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '900 130px Montserrat, sans-serif';
  ctx.fillText('!', 820, 650);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ea5b1b';
  ctx.font = '900 72px Montserrat, sans-serif';
  ctx.fillText('SIMULACRO', 90, 200);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 54px Montserrat, sans-serif';
  ctx.fillText('ANTE TSUNAMI', 90, 270);

  ctx.fillStyle = '#4ade80';
  ctx.font = '800 32px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('✓ CONSTANCIA DE PARTICIPACIÓN CIUDADANA', 90, 335);

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(70, 880, W - 140, 740, 48);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#546e7a';
  ctx.font = '800 30px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('PARTICIPANTE:', W / 2, 975);

  ctx.fillStyle = '#062338';
  ctx.font = '900 62px Montserrat, sans-serif';
  ctx.fillText(userName.toUpperCase(), W / 2, 1060);

  ctx.fillStyle = '#ea5b1b';
  ctx.font = '700 34px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(userZone, W / 2, 1120);

  ctx.fillStyle = '#f4f7f9';
  ctx.beginPath();
  ctx.roundRect(140, 1170, W - 280, 310, 28);
  ctx.fill();

  ctx.fillStyle = '#263238';
  ctx.font = '800 30px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('TIEMPO HASTA ZONA SEGURA', W / 2, 1240);

  ctx.fillStyle = '#00a83f';
  ctx.font = '900 78px Montserrat, sans-serif';
  ctx.fillText(timeStr, W / 2, 1335);

  ctx.fillStyle = '#263238';
  ctx.font = '700 30px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`Recorrido registrado: ${appState.distanceWalkedMeters} metros`, W / 2, 1420);

  ctx.fillStyle = '#546e7a';
  ctx.font = '700 28px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('📅 11 de Noviembre de 2026 | Ushuaia', W / 2, 1555);

  const rainbowGrad = ctx.createLinearGradient(0, 0, W, 0);
  rainbowGrad.addColorStop(0, '#ea5b1b');
  rainbowGrad.addColorStop(0.35, '#f5820b');
  rainbowGrad.addColorStop(0.7, '#00a83f');
  rainbowGrad.addColorStop(1, '#0088ff');

  ctx.fillStyle = rainbowGrad;
  ctx.fillRect(0, 1690, W, 14);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 1704, W, H - 1704);

  ctx.fillStyle = '#263238';
  ctx.font = '700 30px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('Ejercicio Preventivo de Evacuación • Ushuaia, Tierra del Fuego', W / 2, 1775);

  ctx.fillStyle = '#64748b';
  ctx.font = '600 22px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('Constancia generada localmente para difusión comunitaria (Sin valor administrativo oficial)', W / 2, 1830);
}

document.getElementById('certName').addEventListener('input', renderCertificateCanvas);
document.getElementById('certNeighborhood').addEventListener('input', renderCertificateCanvas);

document.getElementById('btnDownloadCert').addEventListener('click', () => {
  if (!isCertificateUnlocked()) return;
  renderCertificateCanvas();
  const canvas = document.getElementById('certCanvas');
  const link = document.createElement('a');
  link.download = `Constancia_Simulacro_Ushuaia_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

document.getElementById('btnShareCert').addEventListener('click', async () => {
  if (!isCertificateUnlocked()) return;
  renderCertificateCanvas();
  const canvas = document.getElementById('certCanvas');
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], 'Constancia_Simulacro_Ushuaia_2026.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: 'Constancia Simulacro ante Tsunami - Ushuaia',
          text: 'Participé en el Simulacro ante Tsunami en Ushuaia. #UshuaiaPreparada #TierraDelFuego',
          files: [file]
        });
      } catch (_) {}
    } else {
      const link = document.createElement('a');
      link.download = 'Constancia_Simulacro_Ushuaia_2026.png';
      link.href = URL.createObjectURL(blob);
      link.click();
    }
  }, 'image/png');
});

/*************************************************************************
 * 11. TELEMETRÍA Y REPORTES SIN CONDICIÓN DE CARRERA NI EXCESO DE WKT
 *************************************************************************/
const SYNC_QUEUE_KEY = 'dgot_unified_sync_queue';
let isFlushingQueue = false;

function getSyncQueue() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
  } catch (_) {
    return [];
  }
}

function saveSyncQueue(q) {
  try {
    const trimmed = q.filter(i => !i.synced).slice(-40);
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(trimmed));
  } catch (_) {}
}

function buildWktLineString(track) {
  if (!track || track.length === 0) return '';
  if (track.length === 1) {
    return `POINT(${track[0][0]} ${track[0][1]})`;
  }
  const pairs = track.map(pt => `${pt[0]} ${pt[1]}`).join(', ');
  return `LINESTRING(${pairs})`;
}

function enqueueTelemetrySilent(milestoneName) {
  const queue = getSyncQueue();
  const timeFormatted = appState.stopwatchCompletedMs
    ? formatStopwatch(appState.stopwatchCompletedMs)
    : (appState.stopwatchStartMs ? formatStopwatch(Date.now() - appState.stopwatchStartMs) : '00:00:00');

  const includeFullWkt =
    milestoneName === 'SAFE_ZONE_REACHED_FROM_EVAC' ||
    milestoneName === 'DRILL_FINISHED_SUMMARY';

  queue.push({
    queueType: 'TELEMETRY',
    id: `tel_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    sessionId: appState.sessionId,
    timestamp: new Date().toISOString(),
    milestone: milestoneName,
    drillStage: appState.currentStage,
    initialZoneState: appState.initialZoneState || '',
    currentZoneState: appState.currentZoneState || '',
    evacuationTimeMs: appState.stopwatchCompletedMs || (appState.stopwatchStartMs ? Date.now() - appState.stopwatchStartMs : 0),
    evacuationTimeFormatted: timeFormatted,
    distanceWalkedMeters: appState.distanceWalkedMeters,
    verticesCount: appState.trackCoords.length,
    distToSafeLineMeters: '',
    lat: appState.lastCoords ? appState.lastCoords[1] : '',
    lng: appState.lastCoords ? appState.lastCoords[0] : '',
    wktTrack: includeFullWkt ? buildWktLineString(appState.trackCoords) : '',
    userAgent: navigator.userAgent,
    synced: false
  });

  saveSyncQueue(queue);
  flushSyncQueueSilent();
}

async function flushSyncQueueSilent() {
  if (isFlushingQueue || !navigator.onLine || !appState.webhookUrl) return;
  const snapshot = getSyncQueue();
  const pending = snapshot.filter(i => !i.synced);
  if (pending.length === 0) return;

  const sentIds = new Set(pending.map(i => i.id));
  isFlushingQueue = true;

  try {
    const resp = await fetch(appState.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ items: pending }),
      keepalive: true
    });

    if (resp.ok) {
      const freshQueue = getSyncQueue().filter(item => !sentIds.has(item.id));
      saveSyncQueue(freshQueue);
    }
  } catch (_) {
  } finally {
    isFlushingQueue = false;
  }
}

document.getElementById('reportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const category = document.getElementById('repCategory').value;
  const comment  = document.getElementById('repComment').value.trim();
  if (!comment) return;

  const timeFormatted = appState.stopwatchCompletedMs
    ? formatStopwatch(appState.stopwatchCompletedMs)
    : (appState.stopwatchStartMs ? formatStopwatch(Date.now() - appState.stopwatchStartMs) : '00:00:00');

  const queue = getSyncQueue();
  queue.push({
    queueType: 'REPORT',
    id: `rep_${Date.now()}`,
    sessionId: appState.sessionId,
    timestamp: new Date().toISOString(),
    category,
    comment,
    zoneState: appState.currentZoneState || 'SIN_GPS',
    evacuationTimeFormatted: timeFormatted,
    distanceWalkedMeters: appState.distanceWalkedMeters,
    lat: appState.lastCoords ? appState.lastCoords[1] : '',
    lng: appState.lastCoords ? appState.lastCoords[0] : '',
    synced: false
  });

  saveSyncQueue(queue);
  document.getElementById('repComment').value = '';
  closeModal('modalReport');
  flushSyncQueueSilent();
  alert('¡Muchas gracias! Tu reporte fue enviado.');
});

window.addEventListener('load', () => {
  enqueueTelemetrySilent('APP_OPEN');
});

window.addEventListener('online', () => {
  updateNetworkUI();
  flushSyncQueueSilent();
});

window.addEventListener('offline', updateNetworkUI);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushSyncQueueSilent();
  }
});

setInterval(flushSyncQueueSilent, 30000);

function updateNetworkUI() {
  const badge = document.getElementById('networkStatus');
  if (navigator.onLine) {
    badge.classList.remove('offline');
    badge.textContent = 'Online';
  } else {
    badge.classList.add('offline');
    badge.textContent = 'Offline';
  }
}
updateNetworkUI();

async function syncServerStatus() {
  if (!navigator.onLine || !appState.webhookUrl) return;
  try {
    const resp = await fetch(`${appState.webhookUrl}?action=status`, { cache: 'no-store' });
    const data = await resp.json();
    if (!data || data.status !== 'ok') return;

    const validModes = ['AUTO', 'MANUAL'];
    const validStages = ['PRE_SIMULACRO', 'DURANTE_SIMULACRO', 'POST_SIMULACRO'];
    if (!validModes.includes(data.mode)) return;

    appState.serverMode = data.mode;
    appState.serverStage = validStages.includes(data.stage) ? data.stage : null;
    appState.serverStartedAt = typeof data.startedAt === 'number' ? data.startedAt : null;
    if (typeof data.serverNow === 'number') {
      appState.serverOffsetMs = data.serverNow - Date.now();
    }

    localStorage.setItem('dgot_server_status', JSON.stringify({
      serverMode: appState.serverMode,
      serverStage: appState.serverStage,
      serverStartedAt: appState.serverStartedAt,
      serverOffsetMs: appState.serverOffsetMs
    }));

    tickApplicationClock();
  } catch (_) {}
}

setInterval(syncServerStatus, 10000);
window.addEventListener('online', syncServerStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncServerStatus();
});
syncServerStatus();

/*************************************************************************
 * 12. EVENTOS DE INTERFAZ Y PANEL ADMIN (GOOGLE IDENTITY SERVICES)
 *************************************************************************/
document.getElementById('btnToggleSheet').addEventListener('click', () => {
  const sheet = document.getElementById('citizenSheet');
  const isCollapsed = sheet.classList.toggle('collapsed');
  document.getElementById('sheetToggleText').textContent = isCollapsed
    ? 'Expandir panel ▲'
    : 'Minimizar panel ▼';
});

let adminTapCount = 0;
let adminTapTimer = null;

document.getElementById('btnAdminUnlock').addEventListener('click', () => {
  adminTapCount++;
  clearTimeout(adminTapTimer);
  adminTapTimer = setTimeout(() => { adminTapCount = 0; }, 1800);

  if (adminTapCount >= 5) {
    adminTapCount = 0;
    const panel = document.getElementById('adminPanel');
    panel.classList.toggle('active');
    if (panel.classList.contains('active')) initAdminLogin();
  }
});

const GOOGLE_CLIENT_ID = '128796826701-821tj6ra3rgc3p7qp8lflf055b13hv66.apps.googleusercontent.com';
let adminIdToken = sessionStorage.getItem('dgot_admin_token');
let gisReady = false;

function initAdminLogin() {
  if (!window.google || !google.accounts || !google.accounts.id) return;

  if (!gisReady) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: onAdminCredential
    });
    gisReady = true;
  }

  const container = document.getElementById('googleSignInBtn');
  if (adminIdToken) {
    container.innerHTML = '';
  } else {
    google.accounts.id.renderButton(container, {
      theme: 'outline', size: 'large', text: 'signin_with', locale: 'es', width: 260
    });
  }
  refreshAdminUI();
}

function onAdminCredential(resp) {
  adminIdToken = resp.credential;
  sessionStorage.setItem('dgot_admin_token', adminIdToken);
  refreshAdminUI();
}

function refreshAdminUI() {
  const logged = Boolean(adminIdToken);
  document.getElementById('googleSignInBtn').style.display = logged ? 'none' : 'block';
  document.getElementById('adminControls').style.display = logged ? 'flex' : 'none';
  const modo = appState.serverMode === 'MANUAL'
    ? `MANUAL: ${appState.serverStage}`
    : 'AUTOMÁTICO (por horario)';
  document.getElementById('adminStatusText').textContent = `Estado en servidor: ${modo}`;
}

async function adminSend(action, extra, confirmMsg) {
  if (!adminIdToken) return;
  if (confirmMsg && !confirm(confirmMsg)) return;

  try {
    const resp = await fetch(appState.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, idToken: adminIdToken, ...(extra || {}) })
    });
    const data = await resp.json();

    if (data.status !== 'ok') {
      if (data.code === 'AUTH') {
        adminIdToken = null;
        sessionStorage.removeItem('dgot_admin_token');
        initAdminLogin();
      }
      alert(data.message || 'Error en el servidor.');
      return;
    }

    await syncServerStatus();
    refreshAdminUI();
  } catch (_) {
    alert('No se pudo contactar al servidor. Verificá la conexión y volvé a intentar.');
  }
}

document.getElementById('btnAdminPre').addEventListener('click', () =>
  adminSend('setStage', { stage: 'PRE_SIMULACRO' }, '¿Pasar a PRE-SIMULACRO en todos los celulares?'));

document.getElementById('btnAdminStart').addEventListener('click', () =>
  adminSend('setStage', { stage: 'DURANTE_SIMULACRO' },
    '¿INICIAR el simulacro ahora? Los celulares con la app abierta van a mostrar la alerta y sonar.'));

document.getElementById('btnAdminEnd').addEventListener('click', () =>
  adminSend('setStage', { stage: 'POST_SIMULACRO' }, '¿FINALIZAR el simulacro?'));

document.getElementById('btnAdminAuto').addEventListener('click', () =>
  adminSend('setAuto', {}, '¿Volver al modo automático por horario?'));

document.getElementById('btnAdminLogout').addEventListener('click', () => {
  adminIdToken = null;
  sessionStorage.removeItem('dgot_admin_token');
  initAdminLogin();
});

document.getElementById('btnCloseAdmin').addEventListener('click', () => {
  document.getElementById('adminPanel').classList.remove('active');
});

function openModal(id) {
  if (id === 'modalCert') renderCertificateCanvas();
  if (id === 'modalSearchStreet') {
    captureVectorFeaturesIntoRAM();
    setTimeout(() => document.getElementById('streetSearchInput').focus(), 100);
  }
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
});

document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.classList.remove('open');
  });
});

document.getElementById('btnOpenSearchStreet').addEventListener('click', () => openModal('modalSearchStreet'));
document.getElementById('btnOpenLegend').addEventListener('click', () => openModal('modalLegend'));
document.getElementById('btnOpenCert').addEventListener('click', tryOpenCertificateModal);
document.getElementById('btnBannerCert').addEventListener('click', tryOpenCertificateModal);
document.getElementById('btnOpenReport').addEventListener('click', () => openModal('modalReport'));
document.getElementById('btnOpenSos').addEventListener('click', () => openModal('modalSos'));

document.getElementById('btnVerifyGps').addEventListener('click', () => {
  appState.autoFollowUser = true;
  if (appState.lastCoords) {
    const [[w, s], [e, n]] = USHUAIA_CONFIG.maxBounds;
    const isInsideMapBounds = (
      appState.lastCoords[0] >= w && appState.lastCoords[0] <= e &&
      appState.lastCoords[1] >= s && appState.lastCoords[1] <= n
    );

    if (isInsideMapBounds) {
      map.easeTo({ center: appState.lastCoords, zoom: 15.8 });
    } else {
      alert('Tu ubicación GPS actual se encuentra fuera del área delimitada para el simulacro de Ushuaia.');
    }
  }
  requestGpsWithPrivacyCheck();
});

// Controles de Simulación Local en el Panel Admin
document.getElementById('btnSimClickMap').addEventListener('click', (e) => {
  appState.simulateClickGps = !appState.simulateClickGps;
  e.target.classList.toggle('active', appState.simulateClickGps);
  e.target.textContent = appState.simulateClickGps
    ? '📍 Tocar Mapa = GPS: ON'
    : '📍 Tocar Mapa = GPS: OFF';
  if (appState.simulateClickGps) {
    document.getElementById('adminPanel').classList.remove('active');
  }
});

document.getElementById('btnSimEvacZone').addEventListener('click', () => {
  appState.gpsPausedForInspection = true;
  appState.autoFollowUser = true;
  handleGpsUpdate([-68.3045, -54.8072], true);
});

document.getElementById('btnSimSafeZone').addEventListener('click', () => {
  appState.gpsPausedForInspection = true;
  appState.autoFollowUser = true;
  if (appState.safePolygonsRAM.length > 0) {
    try {
      const ptInside = turf.pointOnFeature(appState.safePolygonsRAM[0]);
      if (ptInside?.geometry?.coordinates) {
        handleGpsUpdate(ptInside.geometry.coordinates, true);
        return;
      }
    } catch (_) {}
  }
  handleGpsUpdate([-68.3065, -54.8038], true);
});

document.getElementById('btnSimOutside').addEventListener('click', () => {
  appState.gpsPausedForInspection = true;
  appState.autoFollowUser = true;
  handleGpsUpdate([-68.3385, -54.8195], true);
});

document.getElementById('btnResetLocalSim').addEventListener('click', () => {
  appState.simulateClickGps = false;
  appState.gpsPausedForInspection = false;
  const btnSim = document.getElementById('btnSimClickMap');
  if (btnSim) {
    btnSim.classList.remove('active');
    btnSim.textContent = '📍 Tocar Mapa = GPS: OFF';
  }
  resetStopwatch();
  tickApplicationClock();
  document.getElementById('gpsDot').classList.add('active');
  document.getElementById('gpsBtnLabel').textContent = 'Ubicación activa (Centrar en mí)';
});

// Botón Pre-Simulacro: Agendar recordatorio .ics para el 11 de Noviembre 09:00 h
document.getElementById('btnAddCalendar').addEventListener('click', () => {
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gobierno TDF//Simulacro Tsunami Ushuaia//ES',
    'BEGIN:VEVENT',
    'UID:simulacro-ushuaia-2026@tierradelfuego.gob.ar',
    'DTSTAMP:20261028T120000Z',
    'DTSTART:20261111T120000Z',
    'DTEND:20261111T133000Z',
    'SUMMARY:🚨 Simulacro ante Sismo/Tsunami - Ushuaia',
    'DESCRIPTION:Ejercicio preventivo de evacuación hacia Zona Segura (Cota 30m). Abrí la aplicación para verificar tu vía de escape.',
    'LOCATION:Ushuaia, Tierra del Fuego',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:En 15 minutos inicia el Simulacro ante Tsunami en Ushuaia',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'simulacro-tsunami-ushuaia.ics';
  a.click();
  URL.revokeObjectURL(url);
});

/*************************************************************************
 * 13. REGISTRO DEL SERVICE WORKER
 *************************************************************************/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update();
    }).catch((err) => {
      console.warn('Error registrando SW:', err);
    });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (appState.currentStage === 'DURANTE_SIMULACRO') return;
    refreshing = true;
    window.location.reload();
  });
}