/**
 * SpiderKart — Level Editor
 * Canvas 2D con drag-and-drop de puntos de control,
 * curva CatmullRom en tiempo real, zoom/paneo y guardado via API.
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────────
  //  Estado global
  // ────────────────────────────────────────────────────
  let adminToken = '';
  let controlPoints = [];   // [{ x, z }]
  let editorObstacles = []; // [{ sampleIdx, lane, type }]
  let editorRamps = [];     // [{ sampleIdx, lane, type }]
  let editorPowerups = [];  // [{ sampleIdx, lane, type }]
  let editorShortcuts = []; // [{ startSampleIdx, endSampleIdx, halfWidth, controlPoints: [[x,y,z],...] }]
  let editorTerrainNodes = []; // [{ x, z, height, radius, type, hasHole, holeWidth, holeHeight, holeAngle }]
  let selectedTerrainIdx = -1;
  const MIN_ELEMENT_DIAMETER_PX = 150;
  const MIN_ELEMENT_RADIUS_PX = MIN_ELEMENT_DIAMETER_PX / 2; // 75px (garantiza diametro >= 150px al hacer zoom out)
  let hoverTerrainIdx = -1;
  let isRotatingTunnel = false;
  let mouseScreenPos = { x: 0, y: 0 };
  let mouseInCanvas = false;
  let viewMode = '2d'; // '2d' | '3d' | 'split'
  let editor3D = null;
  let editor3DNeedsSync = false;
  let editorBarriers = []; // [{ start: {x, z}, end: {x, z} }]
  let trackWidth = 14;
  let totalLaps = 3;
  let levelName = 'Circuito Variado Grande';

  // Imagen de fondo
  let bgImage = null;       // HTMLImageElement cargada
  let bgScale = 1.0;        // escala en unidades mundo / px
  let bgOpacity = 0.4;

  // Estado del editor
  let tool = 'move';         // 'add' | 'move' | 'delete' | 'obs-add' | 'obs-move' | 'obs-delete' | 'ramp-add' | 'ramp-move' | 'ramp-delete' | 'pu-add' | 'pu-move' | 'pu-delete'
  let selectedIdx = -1;      // índice en controlPoints
  let selectedObsIdx = -1;   // índice en editorObstacles
  let selectedRampIdx = -1;  // índice en editorRamps
  let selectedPowerupIdx = -1; // índice en editorPowerups
  let selectedShortcutIdx = -1; // índice en editorShortcuts
  let selectedShortcutPoint = null; // { type: 'start' | 'end' | 'cp', cpIdx: 0 }
  let hoverShortcutPoint = null; // { sIdx, type: 'start' | 'end' | 'cp', cpIdx: 0 }
  let dragging = false;
  let dragIdx = -1;
  let dragType = null; // 'point' | 'obs' | 'ramp' | 'pu' | 'terrain' | 'tunnel-rotate' | 'shortcut-cp' | 'shortcut-start' | 'shortcut-end'
  let shortcutDraft = null; // { startSampleIdx, controlPoints: [] }
  let barrierDraft = null; // { x, z } (punto inicial)

  // Historia Deshacer/Rehacer
  const MAX_HISTORY = 60;
  let historyStack = [];
  let historyIdx = -1;

  // Viewport
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let panStart = { mx: 0, my: 0, px: 0, py: 0 };
  let spaceDown = false;

  // Canvas refs
  const canvas = document.getElementById('track-canvas');
  const ctx = canvas.getContext('2d');

  // ────────────────────────────────────────────────────
  //  Default (mismo que el circuito hardcoded en game-engine.js)
  // ────────────────────────────────────────────────────
  const DEFAULT_POINTS = [
    [160,0],[160,-70],[150,-140],[110,-200],[50,-210],
    [0,-180],[-40,-130],[-90,-150],[-140,-130],[-180,-80],
    [-190,0],[-160,60],[-100,80],[-60,40],[-20,90],
    [30,130],[90,140],[140,110],[160,60]
  ].map(([x, z]) => ({ x, z }));

  // ────────────────────────────────────────────────────
  //  Login
  // ────────────────────────────────────────────────────
  const loginScreen     = document.getElementById('login-screen');
  const loginTokenInput = document.getElementById('login-token');
  const loginBtn        = document.getElementById('login-btn');
  const loginError      = document.getElementById('login-error');
  const editorScreen    = document.getElementById('editor-screen');
  const btnLogout       = document.getElementById('btn-logout');

  const STORAGE_KEY = 'spiderkart_admin_token';

  async function doLogin(tokenToTry) {
    const token = (tokenToTry || loginTokenInput.value || '').trim();
    if (!token) { showLoginError('Escribe el token.'); return; }

    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Verificando...';
    loginError.classList.add('hidden');

    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await r.json();
      if (data.ok) {
        adminToken = token;
        sessionStorage.setItem(STORAGE_KEY, token);
        loginScreen.classList.add('hidden');
        editorScreen.classList.remove('hidden');
        await initEditor();
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
        showLoginError(data.error || 'Token incorrecto.');
      }
    } catch (e) {
      showLoginError('Error de conexión con el servidor.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = '<i class="fa fa-right-to-bracket"></i> INGRESAR';
    }
  }

  function doLogout() {
    adminToken = '';
    sessionStorage.removeItem(STORAGE_KEY);
    if (window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    editorScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    loginTokenInput.value = '';
    loginError.classList.add('hidden');
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }

  loginBtn.addEventListener('click', () => doLogin());
  loginTokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (btnLogout) {
    btnLogout.addEventListener('click', doLogout);
  }

  function checkAutoLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    const tokenFromStorage = sessionStorage.getItem(STORAGE_KEY);

    if (tokenFromUrl) {
      loginTokenInput.value = tokenFromUrl;
      doLogin(tokenFromUrl);
    } else if (tokenFromStorage) {
      loginTokenInput.value = tokenFromStorage;
      doLogin(tokenFromStorage);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAutoLogin);
  } else {
    checkAutoLogin();
  }

  // ────────────────────────────────────────────────────
  //  Inicialización del editor
  // ────────────────────────────────────────────────────
  let editorInitialized = false;
  async function initEditor() {
    resizeCanvas();
    resetViewport();
    await loadFromServer();
    pushHistory(); // estado inicial en la pila
    if (!editorInitialized) {
      bindUI();
      editorInitialized = true;
    }
    render();
    setStatus('info', 'Editor listo. Herramienta activa: Mover');
  }

  function resetViewport() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  function centerViewport() {
    // Centra la pista en el canvas
    if (controlPoints.length === 0) { panX = 0; panY = 0; return; }
    const xs = controlPoints.map(p => p.x);
    const zs = controlPoints.map(p => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    panX = -cx * zoom;
    panY = -cz * zoom;
    updateZoomIndicator();
  }

  // ────────────────────────────────────────────────────
  //  API
  // ────────────────────────────────────────────────────
  async function loadFromServer() {
    setStatus('info', 'Cargando nivel desde el servidor...');
    try {
      const r = await fetch('/api/level');
      const data = await r.json();
      applyLevelData(data);
      setStatus('ok', `Nivel "${levelName}" cargado (${controlPoints.length} puntos).`);
    } catch (e) {
      controlPoints = [...DEFAULT_POINTS];
      generateDefaultObjects();
      setStatus('err', 'Error al cargar. Usando circuito por defecto.');
    }
    centerViewport();
    updatePointCount();
    render();
  }

  async function saveToServer(slotOverride) {
    if (controlPoints.length < 3) {
      setStatus('err', 'Necesitas al menos 3 puntos de control.');
      return;
    }
    const slot = slotOverride !== undefined ? slotOverride : (parseInt(document.getElementById('map-slot')?.value) || 1);
    setStatus('info', slot === 1 ? 'Guardando nivel activo...' : `Guardando en slot ${slot}...`);
    const payload = {
      name: levelName,
      trackWidth,
      totalLaps,
      controlPoints: controlPoints.map(p => [p.x, p.y || 0, p.z]), // ahora guarda X, Y, Z
      obstacles: editorObstacles.map(o => ({ sampleIdx: o.sampleIdx, lane: o.lane, type: o.type })),
      ramps:     editorRamps.map(r => ({ sampleIdx: r.sampleIdx, lane: r.lane, type: r.type })),
      powerups:  editorPowerups.map(p => ({ sampleIdx: p.sampleIdx, lane: p.lane, type: p.type })),
      shortcuts: editorShortcuts,
      terrainNodes: editorTerrainNodes
    };
    try {
      const r = await fetch(`/api/level?slot=${slot}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken
        },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setStatus('ok', `Guardado en slot ${data.slot}. ${data.message}`);
        const slotStatusEl = document.getElementById('slot-status');
        if (slotStatusEl) slotStatusEl.textContent = `Slot ${data.slot} guardado.`;
      } else {
        setStatus('err', data.error || 'Error desconocido al guardar.');
      }
    } catch (e) {
      setStatus('err', 'Error de conexión al guardar.');
    }
  }

  function applyLevelData(data) {
    levelName = data.name || 'Sin nombre';
    trackWidth = data.trackWidth || 14;
    totalLaps  = data.totalLaps  || 3;
    controlPoints = (data.controlPoints || []).map(p => {
      if (Array.isArray(p)) {
        return p.length === 3 ? { x: p[0], y: p[1], z: p[2] } : { x: p[0], y: 0, z: p[1] };
      }
      return { x: p.x, y: p.y || 0, z: p.z };
    });
    if (data.obstacles || data.ramps || data.powerups) {
      editorObstacles = (data.obstacles || []).map(o => ({ ...o }));
      editorRamps     = (data.ramps     || []).map(r => ({ ...r }));
      editorPowerups  = (data.powerups  || []).map(p => ({ ...p }));
      editorShortcuts = (data.shortcuts || []).map(s => ({ ...s }));
      editorTerrainNodes = (data.terrainNodes || []).map(t => ({ ...t }));
      editorBarriers = (data.barriers || []).map(b => ({ start: { ...b.start }, end: { ...b.end } }));
    } else {
      generateDefaultObjects();
    }
    document.getElementById('level-name').value = levelName;
    document.getElementById('track-width').value = trackWidth;
    document.getElementById('track-width-val').textContent = trackWidth;
    const tlEl = document.getElementById('total-laps');
    const tlValEl = document.getElementById('total-laps-val');
    if (tlEl) tlEl.value = totalLaps;
    if (tlValEl) tlValEl.textContent = totalLaps;
    updateObstacleCount();
    updateRampCount();
    updatePowerupCount();
  }

  function generateDefaultObjects() {
    editorObstacles = [];
    let currentIdx = 25;
    for (let i = 0; i < 26; i++) {
      currentIdx += Math.floor(16 + Math.random() * 22);
      if (currentIdx >= 565) break;
      const side = (Math.random() < 0.5 ? 1 : -1);
      const laneFrac = 0.15 + Math.random() * 0.65;
      editorObstacles.push({ sampleIdx: currentIdx, lane: side * laneFrac, type: i % 3 });
    }
    editorRamps = [
      { sampleIdx: 45,  lane: 0.0,   type: 'gold' },
      { sampleIdx: 120, lane: 0.45,  type: 'cyan' },
      { sampleIdx: 190, lane: -0.4,  type: 'gold' },
      { sampleIdx: 260, lane: 0.0,   type: 'cyan' },
      { sampleIdx: 330, lane: 0.4,   type: 'gold' },
      { sampleIdx: 400, lane: -0.45, type: 'cyan' },
      { sampleIdx: 475, lane: 0.0,   type: 'gold' },
      { sampleIdx: 545, lane: 0.35,  type: 'cyan' }
    ];
    editorPowerups = [];
    const defaultTypes = ['missile', 'homing', 'boost'];
    for (let i = 0; i < 24; i++) {
      const frac = ((i + 0.18) / 24) % 1;
      const lane = [0, 0.65, -0.65, 0.35, -0.35][i % 5];
      const sampleIdx = Math.floor(frac * 600);
      editorPowerups.push({ sampleIdx, lane, type: defaultTypes[i % 3] });
    }
  }

  // ────────────────────────────────────────────────────
  //  Historia Deshacer/Rehacer
  // ────────────────────────────────────────────────────
  function snapshot() {
    return {
      pts: controlPoints.map(p => ({ ...p })),
      obs: editorObstacles.map(o => ({ ...o })),
      ramps: editorRamps.map(r => ({ ...r })),
      pups: editorPowerups.map(p => ({ ...p })),
      shortcuts: editorShortcuts.map(s => ({ ...s, controlPoints: s.controlPoints ? s.controlPoints.map(cp => [...cp]) : [] })),
      terrain: editorTerrainNodes.map(t => ({ ...t })),
      barriers: editorBarriers.map(b => ({ start: { ...b.start }, end: { ...b.end } }))
    };
  }

  function pushHistory() {
    const newSnap = snapshot();
    if (historyIdx >= 0) {
      const currentSnap = historyStack[historyIdx];
      if (JSON.stringify(newSnap) === JSON.stringify(currentSnap)) return;
    }
    historyStack = historyStack.slice(0, historyIdx + 1);
    historyStack.push(newSnap);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    historyIdx = historyStack.length - 1;
  }

  function restoreSnapshot(snap) {
    controlPoints   = snap.pts.map(p => ({ ...p }));
    editorObstacles = snap.obs.map(o => ({ ...o }));
    editorRamps     = snap.ramps.map(r => ({ ...r }));
    editorPowerups  = snap.pups.map(p => ({ ...p }));
    editorShortcuts = snap.shortcuts ? snap.shortcuts.map(s => ({ ...s, controlPoints: s.controlPoints ? s.controlPoints.map(cp => [...cp]) : [] })) : [];
    editorTerrainNodes = snap.terrain ? snap.terrain.map(t => ({ ...t })) : [];
    editorBarriers = snap.barriers ? snap.barriers.map(b => ({ start: { ...b.start }, end: { ...b.end } })) : [];

    selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
    shortcutDraft = null;
    barrierDraft = null;
    hidePointInfo();
    updatePointCount(); updateObstacleCount(); updateRampCount(); updatePowerupCount();
    render();
  }

  function undo() {
    if (historyIdx <= 0) { setStatus('info', 'No hay más acciones para deshacer.'); return; }
    historyIdx--;
    restoreSnapshot(historyStack[historyIdx]);
    setStatus('info', `Deshacer — paso ${historyIdx + 1}/${historyStack.length}`);
  }

  function redo() {
    if (historyIdx >= historyStack.length - 1) { setStatus('info', 'No hay acciones para rehacer.'); return; }
    historyIdx++;
    restoreSnapshot(historyStack[historyIdx]);
    setStatus('info', `Rehacer — paso ${historyIdx + 1}/${historyStack.length}`);
  }

  // Devuelve el índice del segmento del polígono de control más cercano al punto w.
  // Insertar el nuevo punto DESPUÉS del índice devuelto.
  function closestSegmentIdx(w) {
    const n = controlPoints.length;
    let bestSeg = n - 1; // por defecto: al final
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const a = controlPoints[i];
      const b = controlPoints[(i + 1) % n];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((w.x - a.x) * dx + (w.z - a.z) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + t * dx, cz = a.z + t * dz;
      const d = (w.x - cx) ** 2 + (w.z - cz) ** 2;
      if (d < bestDist) { bestDist = d; bestSeg = i; }
    }
    return bestSeg;
  }

  // ────────────────────────────────────────────────────
  //  UI bindings
  // ────────────────────────────────────────────────────
  function bindUI() {
    // Herramientas de pista
    document.getElementById('tool-add').addEventListener('click', () => setTool('add'));
    document.getElementById('tool-move').addEventListener('click', () => setTool('move'));
    document.getElementById('tool-delete').addEventListener('click', () => setTool('delete'));

    // Herramientas de obstáculos
    document.getElementById('tool-obs-add').addEventListener('click', () => setTool('obs-add'));
    document.getElementById('tool-obs-delete').addEventListener('click', () => setTool('obs-delete'));

    // Herramientas de rampas
    document.getElementById('tool-ramp-add').addEventListener('click', () => setTool('ramp-add'));
    document.getElementById('tool-ramp-delete').addEventListener('click', () => setTool('ramp-delete'));

    // Herramientas de powerups
    document.getElementById('tool-pu-add').addEventListener('click', () => setTool('pu-add'));
    document.getElementById('tool-pu-delete').addEventListener('click', () => setTool('pu-delete'));

    // Herramientas de Atajos y Terreno
    document.getElementById('tool-elevate').addEventListener('click', () => setTool('elevate'));
    document.getElementById('tool-shortcut-add').addEventListener('click', () => setTool('shortcut-add'));
    document.getElementById('tool-shortcut-delete').addEventListener('click', () => setTool('shortcut-delete'));
    document.getElementById('tool-terrain-add').addEventListener('click', () => setTool('terrain-add'));
    document.getElementById('tool-terrain-delete').addEventListener('click', () => setTool('terrain-delete'));

    // Herramientas de Barreras
    document.getElementById('tool-barrier-add').addEventListener('click', () => setTool('barrier-add'));
    document.getElementById('tool-barrier-delete').addEventListener('click', () => setTool('barrier-delete'));

    document.getElementById('btn-clear-barriers').addEventListener('click', () => {
      if (!confirm('¿Eliminar todas las barreras?')) return;
      editorBarriers = [];
      render(); pushHistory();
      setStatus('info', 'Barreras limpiadas.');
    });

    document.getElementById('btn-clear-shortcuts').addEventListener('click', () => {
      if (!confirm('¿Eliminar todos los atajos?')) return;
      editorShortcuts = [];
      render(); pushHistory();
      setStatus('info', 'Atajos limpiados.');
    });
    
    document.getElementById('btn-clear-terrain').addEventListener('click', () => {
      if (!confirm('¿Eliminar todo el terreno?')) return;
      editorTerrainNodes = [];
      updateTerrainCount();
      render(); pushHistory();
      setStatus('info', 'Terreno limpiado.');
    });

    // ── Conmutador de Vistas 2D / 3D / Split ──
    const btnView2d = document.getElementById('btn-view-2d');
    const btnView3d = document.getElementById('btn-view-3d');
    const btnViewSplit = document.getElementById('btn-view-split');
    const btnCamReset = document.getElementById('btn-cam-reset');
    const btnCamTop = document.getElementById('btn-cam-top');
    const btnCamTrack = document.getElementById('btn-cam-track');
    const viewport3d = document.getElementById('viewport-3d');
    const canvasArea = document.getElementById('canvas-area');

    function setViewMode(mode) {
      viewMode = mode;
      if (btnView2d) btnView2d.classList.toggle('active', mode === '2d');
      if (btnView3d) btnView3d.classList.toggle('active', mode === '3d');
      if (btnViewSplit) btnViewSplit.classList.toggle('active', mode === 'split');

      if (mode === '2d') {
        canvasArea.classList.remove('split-view');
        canvas.style.display = 'block';
        if (viewport3d) viewport3d.classList.add('hidden');
        resizeCanvas();
        render();
      } else if (mode === '3d') {
        canvasArea.classList.remove('split-view');
        canvas.style.display = 'none';
        if (viewport3d) viewport3d.classList.remove('hidden');
        initEditor3D();
        if (editor3D) { editor3D.syncFrom2D(); editor3D.resize(); }
      } else if (mode === 'split') {
        canvasArea.classList.add('split-view');
        canvas.style.display = 'block';
        if (viewport3d) viewport3d.classList.remove('hidden');
        resizeCanvas();
        render();
        initEditor3D();
        if (editor3D) { editor3D.syncFrom2D(); editor3D.resize(); }
      }
    }

    if (btnView2d) btnView2d.addEventListener('click', () => setViewMode('2d'));
    if (btnView3d) btnView3d.addEventListener('click', () => setViewMode('3d'));
    if (btnViewSplit) btnViewSplit.addEventListener('click', () => setViewMode('split'));

    if (btnCamReset) btnCamReset.addEventListener('click', () => { if (editor3D) editor3D.resetCamera(); });
    if (btnCamTop) btnCamTop.addEventListener('click', () => { if (editor3D) editor3D.topCamera(); });
    if (btnCamTrack) btnCamTrack.addEventListener('click', () => { if (editor3D) editor3D.trackCamera(); });

    // Tecla V para alternar vistas rápidamente
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'v' || e.key === 'V') {
        if (viewMode === '2d') setViewMode('3d');
        else if (viewMode === '3d') setViewMode('split');
        else setViewMode('2d');
      }
    });

    // ── Controles de Terreno y Túnel ──
    const terrainTypeSelect = document.getElementById('terrain-type');
    const tunnelControls = document.getElementById('tunnel-controls');
    const tunnelWidthInput = document.getElementById('tunnel-width');
    const tunnelWidthVal = document.getElementById('tunnel-width-val');
    const tunnelHeightInput = document.getElementById('tunnel-height');
    const tunnelHeightVal = document.getElementById('tunnel-height-val');
    const tunnelAngleInput = document.getElementById('tunnel-angle');
    const tunnelAngleVal = document.getElementById('tunnel-angle-val');
    const btnAlignTunnel = document.getElementById('btn-align-tunnel');

    function updateTunnelControlsVisibility() {
      const isTunnel = terrainTypeSelect && terrainTypeSelect.value === 'mountain_tunnel';
      if (tunnelControls) tunnelControls.style.display = isTunnel ? 'block' : 'none';
    }

    function syncSidebarFromTerrainNode(node) {
      if (!node) return;
      const type = node.type || (node.hasHole ? 'mountain_tunnel' : 'mountain');
      if (terrainTypeSelect) terrainTypeSelect.value = type;
      updateTunnelControlsVisibility();

      const hInput = document.getElementById('node-height');
      const hVal = document.getElementById('node-height-val');
      const rInput = document.getElementById('node-radius');
      const rVal = document.getElementById('node-radius-val');

      if (hInput) { hInput.value = node.height; if (hVal) hVal.textContent = node.height; }
      if (rInput) { rInput.value = node.radius; if (rVal) rVal.textContent = node.radius; }

      if (tunnelWidthInput && tunnelWidthVal) {
        tunnelWidthInput.value = node.holeWidth || 22;
        tunnelWidthVal.textContent = node.holeWidth || 22;
      }
      if (tunnelHeightInput && tunnelHeightVal) {
        tunnelHeightInput.value = node.holeHeight || 16;
        tunnelHeightVal.textContent = node.holeHeight || 16;
      }
      if (tunnelAngleInput && tunnelAngleVal) {
        tunnelAngleInput.value = node.holeAngle || 0;
        tunnelAngleVal.textContent = (node.holeAngle || 0) + '°';
      }
    }

    if (terrainTypeSelect) {
      terrainTypeSelect.addEventListener('change', () => {
        updateTunnelControlsVisibility();
        const type = terrainTypeSelect.value;
        const hInput = document.getElementById('node-height');
        const hVal = document.getElementById('node-height-val');
        const rInput = document.getElementById('node-radius');
        const rVal = document.getElementById('node-radius-val');

        if (type === 'mountain_tunnel') {
          if (hInput) { hInput.value = 45; if (hVal) hVal.textContent = 45; }
          if (rInput) { rInput.value = 50; if (rVal) rVal.textContent = 50; }
        } else if (type === 'mountain') {
          if (hInput) { hInput.value = 55; if (hVal) hVal.textContent = 55; }
          if (rInput) { rInput.value = 45; if (rVal) rVal.textContent = 45; }
        } else if (type === 'hill') {
          if (hInput) { hInput.value = 20; if (hVal) hVal.textContent = 20; }
          if (rInput) { rInput.value = 40; if (rVal) rVal.textContent = 40; }
        } else if (type === 'crater') {
          if (hInput) { hInput.value = -25; if (hVal) hVal.textContent = -25; }
          if (rInput) { rInput.value = 35; if (rVal) rVal.textContent = 35; }
        }

        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          const node = editorTerrainNodes[selectedTerrainIdx];
          node.type = type;
          node.hasHole = (type === 'mountain_tunnel');
          node.height = parseInt(hInput ? hInput.value : 45) || 45;
          node.radius = parseInt(rInput ? rInput.value : 50) || 50;
          editor3DNeedsSync = true; sync3DIfNeeded();
          render(); pushHistory();
        }
      });
      updateTunnelControlsVisibility();
    }

    if (tunnelWidthInput && tunnelWidthVal) {
      tunnelWidthInput.addEventListener('input', e => {
        tunnelWidthVal.textContent = e.target.value;
        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          editorTerrainNodes[selectedTerrainIdx].holeWidth = parseInt(e.target.value) || 22;
          editor3DNeedsSync = true; sync3DIfNeeded(); render();
        }
      });
      tunnelWidthInput.addEventListener('change', () => { if (selectedTerrainIdx >= 0) pushHistory(); });
    }
    if (tunnelHeightInput && tunnelHeightVal) {
      tunnelHeightInput.addEventListener('input', e => {
        tunnelHeightVal.textContent = e.target.value;
        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          editorTerrainNodes[selectedTerrainIdx].holeHeight = parseInt(e.target.value) || 16;
          editor3DNeedsSync = true; sync3DIfNeeded(); render();
        }
      });
      tunnelHeightInput.addEventListener('change', () => { if (selectedTerrainIdx >= 0) pushHistory(); });
    }
    if (tunnelAngleInput && tunnelAngleVal) {
      tunnelAngleInput.addEventListener('input', e => {
        tunnelAngleVal.textContent = e.target.value + '°';
        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          editorTerrainNodes[selectedTerrainIdx].holeAngle = parseFloat(e.target.value) || 0;
          editor3DNeedsSync = true; sync3DIfNeeded(); render();
        }
      });
      tunnelAngleInput.addEventListener('change', () => { if (selectedTerrainIdx >= 0) pushHistory(); });
    }

    if (btnAlignTunnel) {
      btnAlignTunnel.addEventListener('click', () => {
        let tx = 0, tz = 0;
        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          tx = editorTerrainNodes[selectedTerrainIdx].x;
          tz = editorTerrainNodes[selectedTerrainIdx].z;
        } else if (editorTerrainNodes.length > 0) {
          const last = editorTerrainNodes[editorTerrainNodes.length - 1];
          tx = last.x; tz = last.z;
        }
        const angle = getClosestTrackTangentAngle(tx, tz);
        if (tunnelAngleInput) tunnelAngleInput.value = angle;
        if (tunnelAngleVal) tunnelAngleVal.textContent = angle + '°';
        if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
          editorTerrainNodes[selectedTerrainIdx].holeAngle = angle;
          editor3DNeedsSync = true; sync3DIfNeeded();
          render(); pushHistory();
        }
        setStatus('ok', `Túnel alineado a ${angle}° con la pista más cercana.`);
      });
    }

    document.getElementById('node-height').addEventListener('input', e => {
      const val = parseInt(e.target.value);
      document.getElementById('node-height-val').textContent = val;
      if (tool === 'elevate' && selectedIdx >= 0) {
        controlPoints[selectedIdx].y = val;
        render();
      } else if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
        editorTerrainNodes[selectedTerrainIdx].height = val;
        editor3DNeedsSync = true; sync3DIfNeeded(); render();
      }
    });
    document.getElementById('node-height').addEventListener('change', () => {
      if (tool === 'elevate' && selectedIdx >= 0) pushHistory();
      else if (selectedTerrainIdx >= 0) pushHistory();
    });

    document.getElementById('node-radius').addEventListener('input', e => {
      const val = parseInt(e.target.value) || 50;
      document.getElementById('node-radius-val').textContent = val;
      if (selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
        editorTerrainNodes[selectedTerrainIdx].radius = val;
        editor3DNeedsSync = true; sync3DIfNeeded(); render();
      }
    });
    document.getElementById('node-radius').addEventListener('change', () => {
      if (selectedTerrainIdx >= 0) pushHistory();
    });

    // Acciones
    document.getElementById('btn-save').addEventListener('click', saveToServer);
    document.getElementById('btn-load').addEventListener('click', loadFromServer);
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!confirm('¿Restaurar el circuito por defecto? Se perderán los cambios no guardados.')) return;
      controlPoints = [...DEFAULT_POINTS];
      generateDefaultObjects();
      levelName = 'Circuito Variado Grande'; trackWidth = 14;
      document.getElementById('level-name').value = levelName;
      document.getElementById('track-width').value = 14;
      document.getElementById('track-width-val').textContent = 14;
      selectedIdx = -1; hidePointInfo();
      updateObstacleCount(); updateRampCount(); updatePowerupCount();
      centerViewport(); updatePointCount(); render();
      setStatus('info', 'Circuito reseteado al default.');
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (!confirm('¿Limpiar todos los puntos, obstáculos, rampas y orbes?')) return;
      controlPoints = []; editorObstacles = []; editorRamps = []; editorPowerups = [];
      selectedIdx = -1; hidePointInfo();
      updatePointCount(); updateObstacleCount(); updateRampCount(); updatePowerupCount(); render(); pushHistory();
      setStatus('info', 'Canvas limpiado.');
    });

    document.getElementById('btn-clear-obs').addEventListener('click', () => {
      if (!confirm('¿Eliminar todos los obstáculos de la pista?')) return;
      editorObstacles = []; selectedObsIdx = -1;
      updateObstacleCount(); render(); pushHistory();
      setStatus('info', 'Obstáculos limpiados.');
    });

    document.getElementById('btn-clear-ramps').addEventListener('click', () => {
      if (!confirm('¿Eliminar todas las rampas de la pista?')) return;
      editorRamps = []; selectedRampIdx = -1;
      updateRampCount(); render(); pushHistory();
      setStatus('info', 'Rampas limpiadas.');
    });

    document.getElementById('btn-clear-pu').addEventListener('click', () => {
      if (!confirm('¿Eliminar todos los orbes de la pista?')) return;
      editorPowerups = []; selectedPowerupIdx = -1;
      updatePowerupCount(); render(); pushHistory();
      setStatus('info', 'Orbes limpiados.');
    });

    // Level name
    document.getElementById('level-name').addEventListener('input', e => {
      levelName = e.target.value;
    });

    // Track width
    document.getElementById('track-width').addEventListener('input', e => {
      trackWidth = parseInt(e.target.value, 10);
      document.getElementById('track-width-val').textContent = trackWidth;
      render();
    });

    // Total laps
    const tlEl = document.getElementById('total-laps');
    if (tlEl) {
      tlEl.addEventListener('input', e => {
        totalLaps = parseInt(e.target.value, 10);
        document.getElementById('total-laps-val').textContent = totalLaps;
      });
    }

    // Slots de mapas
    const btnLoadSlot = document.getElementById('btn-load-slot');
    const btnSaveSlot = document.getElementById('btn-save-slot');
    const btnActivateSlot = document.getElementById('btn-activate-slot');
    const slotStatus = document.getElementById('slot-status');

    if (btnLoadSlot) {
      btnLoadSlot.addEventListener('click', async () => {
        const slot = parseInt(document.getElementById('map-slot').value) || 1;
        setStatus('info', `Cargando slot ${slot}...`);
        try {
          const r = await fetch(`/api/level?slot=${slot}`);
          const data = await r.json();
          applyLevelData(data);
          pushHistory();
          centerViewport();
          updatePointCount();
          render();
          setStatus('ok', `Slot ${slot} cargado: "${data.name || 'Sin nombre'}".`);
          if (slotStatus) slotStatus.textContent = `Slot ${slot} — ${data.name || 'vacío'}`;
        } catch(e) {
          setStatus('err', `Error cargando slot ${slot}.`);
        }
      });
    }

    if (btnSaveSlot) {
      btnSaveSlot.addEventListener('click', () => {
        const slot = parseInt(document.getElementById('map-slot').value) || 1;
        saveToServer(slot);
      });
    }

    if (btnActivateSlot) {
      btnActivateSlot.addEventListener('click', async () => {
        const slot = parseInt(document.getElementById('map-slot').value) || 1;
        if (!confirm(`¿Activar el slot ${slot} como nivel activo para todos los jugadores?`)) return;
        try {
          const r = await fetch('/api/level/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
            body: JSON.stringify({ slot })
          });
          const data = await r.json();
          if (r.ok && data.ok) {
            setStatus('ok', data.message);
            if (slotStatus) slotStatus.textContent = `¡Slot ${slot} activado!`;
          } else {
            setStatus('err', data.error || 'Error activando slot.');
          }
        } catch(e) {
          setStatus('err', 'Error de conexión al activar slot.');
        }
      });
    }

    // Imagen de fondo
    const btnLoadBg = document.getElementById('btn-load-bg');
    const btnClearBg = document.getElementById('btn-clear-bg');
    const bgScaleEl = document.getElementById('bg-scale');
    const bgOpacityEl = document.getElementById('bg-opacity');

    if (btnLoadBg) {
      btnLoadBg.addEventListener('click', () => {
        const url = document.getElementById('bg-image-url').value.trim();
        if (!url) { setStatus('err', 'Ingresá una URL de imagen.'); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { bgImage = img; render(); setStatus('ok', 'Imagen de fondo cargada.'); };
        img.onerror = () => { setStatus('err', 'No se pudo cargar la imagen. Verificá la URL y CORS.'); };
        img.src = url;
      });
    }
    if (btnClearBg) {
      btnClearBg.addEventListener('click', () => { bgImage = null; render(); setStatus('info', 'Imagen de fondo quitada.'); });
    }
    if (bgScaleEl) {
      bgScaleEl.addEventListener('input', e => {
        bgScale = parseInt(e.target.value) / 100;
        document.getElementById('bg-scale-val').textContent = e.target.value;
        render();
      });
    }
    if (bgOpacityEl) {
      bgOpacityEl.addEventListener('input', e => {
        bgOpacity = parseInt(e.target.value) / 100;
        document.getElementById('bg-opacity-val').textContent = e.target.value;
        render();
      });
    }

    // Point info inputs
    document.getElementById('pi-x').addEventListener('input', e => {
      if (selectedIdx < 0) return;
      controlPoints[selectedIdx].x = parseFloat(e.target.value) || 0;
      render();
    });
    document.getElementById('pi-x').addEventListener('change', e => pushHistory());
    document.getElementById('pi-z').addEventListener('input', e => {
      if (selectedIdx < 0) return;
      controlPoints[selectedIdx].z = parseFloat(e.target.value) || 0;
      render();
    });
    document.getElementById('pi-z').addEventListener('change', e => pushHistory());


    // Canvas events
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', () => {
      mouseInCanvas = false;
      hoverTerrainIdx = -1;
      onMouseUp();
      render();
    });
    canvas.addEventListener('mouseenter', () => {
      mouseInCanvas = true;
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // Keyboard
    window.addEventListener('keydown', e => {
      // Ignorar shortcuts cuando el foco está en un input
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.code === 'Space' && !inInput) {
        e.preventDefault(); spaceDown = true;
      }

      // Ctrl+Z / Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && !inInput) {
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); return; }
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redo(); return; }
      }

      if (!inInput) {
        if (e.key === 'Delete') {
          if (selectedObsIdx >= 0)     { editorObstacles.splice(selectedObsIdx, 1); selectedObsIdx = -1; updateObstacleCount(); render(); pushHistory(); return; }
          if (selectedRampIdx >= 0)    { editorRamps.splice(selectedRampIdx, 1);    selectedRampIdx = -1; updateRampCount();    render(); pushHistory(); return; }
          if (selectedPowerupIdx >= 0) { editorPowerups.splice(selectedPowerupIdx,1); selectedPowerupIdx = -1; updatePowerupCount(); render(); pushHistory(); return; }
          if (selectedTerrainIdx >= 0) {
            editorTerrainNodes.splice(selectedTerrainIdx, 1);
            selectedTerrainIdx = -1;
            updateTerrainCount();
            editor3DNeedsSync = true; sync3DIfNeeded();
            render(); pushHistory(); return;
          }
          if (selectedShortcutIdx >= 0 && editorShortcuts[selectedShortcutIdx]) {
            const sc = editorShortcuts[selectedShortcutIdx];
            if (selectedShortcutPoint && selectedShortcutPoint.type === 'cp' && sc.controlPoints.length > 1) {
              sc.controlPoints.splice(selectedShortcutPoint.cpIdx, 1);
              selectedShortcutPoint = null;
              setStatus('info', 'Punto de control del atajo eliminado.');
            } else {
              editorShortcuts.splice(selectedShortcutIdx, 1);
              selectedShortcutIdx = -1;
              selectedShortcutPoint = null;
              setStatus('info', 'Atajo eliminado.');
            }
            updateShortcutCount();
            editor3DNeedsSync = true; sync3DIfNeeded();
            render(); pushHistory(); return;
          }
          if (selectedIdx >= 0)        { removePoint(selectedIdx); pushHistory(); }
        }
        if (e.key === 'Escape') {
          selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedTerrainIdx = -1;
          selectedShortcutIdx = -1; selectedShortcutPoint = null;
          hidePointInfo(); render();
        }
        if (e.key === 'a') setTool('add');
        if (e.key === 'm') setTool('move');
        if (e.key === 'd') setTool('delete');
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { spaceDown = false; isPanning = false; }
    });

    window.addEventListener('resize', () => { resizeCanvas(); render(); });
  }

  function setTool(t) {
    tool = t;
    if (['add','obs-add','ramp-add','pu-add','terrain-add','shortcut-add','barrier-add'].includes(t)) canvas.style.cursor = 'crosshair';
    else if (['delete','obs-delete','ramp-delete','pu-delete','terrain-delete','shortcut-delete','barrier-delete'].includes(t)) canvas.style.cursor = 'not-allowed';
    else if (t === 'elevate') canvas.style.cursor = 'ns-resize';
    else canvas.style.cursor = 'grab';
    document.querySelectorAll('.sw-tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('tool-' + t);
    if (btn) btn.classList.add('active');
    const labels = {
      'add': 'Añadir punto de pista', 'move': 'Mover punto de pista', 'delete': 'Eliminar punto de pista',
      'obs-add': 'Click en la pista para añadir obstáculo',
      'obs-delete': 'Click en obstáculo para eliminarlo',
      'ramp-add': 'Click en la pista para añadir rampa',
      'ramp-delete': 'Click en rampa para eliminarla',
      'pu-add': 'Click en la pista para añadir orbe',
      'pu-delete': 'Click en orbe para eliminarlo',
      'elevate': 'Seleccioná un punto y usá el slider para cambiar su altura',
      'terrain-add': 'Click para añadir montaña/hueco. Usá los sliders para configurar.',
      'terrain-delete': 'Click en el terreno para eliminarlo',
      'shortcut-add': 'Click 1: Inicio en pista. Clicks: Puntos intermedios. Doble Click en pista: Fin.',
      'shortcut-delete': 'Click en un atajo o en sus puntos para eliminarlo',
      'barrier-add': 'Click 1: Inicio de barrera. Click 2: Fin de barrera.',
      'barrier-delete': 'Click en una barrera para eliminarla'
    };
    setStatus('info', 'Herramienta activa: ' + (labels[t] || t));
    
    // Si cambiamos a elevate, intentamos sincronizar el slider
    if (t === 'elevate' && selectedIdx >= 0) {
      const p = controlPoints[selectedIdx];
      const hEl = document.getElementById('node-height');
      hEl.value = p.y || 0;
      document.getElementById('node-height-val').textContent = p.y || 0;
    }
  }


  function updateObstacleCount() {
    const el = document.getElementById('obs-count');
    if (el) el.textContent = `${editorObstacles.length} obstáculos`;
  }
  function updateRampCount() {
    const el = document.getElementById('ramp-count');
    if (el) el.textContent = `${editorRamps.length} rampas`;
  }
  function updatePowerupCount() {
    const el = document.getElementById('pu-count');
    if (el) el.textContent = `${editorPowerups.length} orbes`;
  }
  function updateShortcutCount() {
    const el = document.getElementById('shortcut-count');
    if (el) el.textContent = `${editorShortcuts.length} atajos`;
  }

  function updatePointCount() {
    document.getElementById('point-count').textContent = `${controlPoints.length} puntos de control`;
  }

  function showPointInfo(idx) {
    const p = controlPoints[idx];
    document.getElementById('pi-x').value = Math.round(p.x);
    document.getElementById('pi-z').value = Math.round(p.z);
    document.getElementById('point-info').classList.add('visible');
  }
  function hidePointInfo() { document.getElementById('point-info').classList.remove('visible'); }

  function setStatus(type, msg) {
    const bar = document.getElementById('status-bar');
    const txt = document.getElementById('status-text');
    if (txt) txt.textContent = msg;
    bar.className = 'sw-status ' + type;
  }

  function updateZoomIndicator() {
    document.getElementById('zoom-val').textContent = Math.round(zoom * 100) + '%';
  }

  // ────────────────────────────────────────────────────
  //  Coordenadas mundo <-> canvas
  // ────────────────────────────────────────────────────
  function worldToCanvas(wx, wz) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return {
      x: cx + (wx * zoom) + panX,
      y: cy + (wz * zoom) + panY
    };
  }

  function canvasToWorld(cx, cy) {
    const ccx = canvas.width / 2;
    const ccy = canvas.height / 2;
    return {
      x: (cx - ccx - panX) / zoom,
      z: (cy - ccy - panY) / zoom
    };
  }

  function pointRadius() { return Math.max(5, 8 / zoom); }

  // Clamp adaptativo: NUNCA menos de 150px de diametro (75px de radio) al alejar el zoom
  function getClampedScreenRadius(worldRadius) {
    return Math.max(MIN_ELEMENT_RADIUS_PX, (worldRadius || 50) * zoom);
  }

  // Hit test para el tirador/knob de rotacion orbital del tunel seleccionado
  function terrainRotationGizmoHitTest(mx, my) {
    if (selectedTerrainIdx < 0 || !editorTerrainNodes[selectedTerrainIdx]) return false;
    const node = editorTerrainNodes[selectedTerrainIdx];
    if (node.type !== 'mountain_tunnel' && !node.hasHole) return false;
    const sc = worldToCanvas(node.x, node.z);
    const rCanvas = getClampedScreenRadius(node.radius);
    const angleRad = ((node.holeAngle || 0) * Math.PI) / 180;
    const knobDist = rCanvas + 18;
    const knobX = sc.x + Math.cos(angleRad) * knobDist;
    const knobY = sc.y + Math.sin(angleRad) * knobDist;
    const dx = mx - knobX, dy = my - knobY;
    return (dx * dx + dy * dy <= 16 * 16);
  }

  // Hit test sobre montañas y estructuras de terreno usando radio clamp >= 75px (diametro >= 150px)
  function terrainHitTest(mx, my) {
    for (let i = editorTerrainNodes.length - 1; i >= 0; i--) {
      const node = editorTerrainNodes[i];
      const sc = worldToCanvas(node.x, node.z);
      const rCanvas = getClampedScreenRadius(node.radius);
      const dx = mx - sc.x, dy = my - sc.y;
      if (dx * dx + dy * dy <= rCanvas * rCanvas) return i;
    }
    return -1;
  }

  function hitTest(mx, my) {
    for (let i = controlPoints.length - 1; i >= 0; i--) {
      const sc = worldToCanvas(controlPoints[i].x, controlPoints[i].z);
      const dx = mx - sc.x, dy = my - sc.y;
      // Si el punto está seleccionado, su halo interactivo es de mínimo 150px de diámetro (75px de radio)
      const testR = (i === selectedIdx)
        ? Math.max(MIN_ELEMENT_RADIUS_PX, pointRadius() + 10)
        : Math.max(10, pointRadius() + 5);
      if (dx * dx + dy * dy <= testR * testR) return i;
    }
    return -1;
  }

  // Buscar el punto de la pista más cercano al click (para posicionar obstaculos/rampas)
  function splineHitTest(mx, my) {
    if (controlPoints.length < 2) return null;
    const spline = buildSpline(controlPoints, true, 20);
    let best = null, bestDist = Infinity;
    for (let i = 0; i < spline.length; i++) {
      const sc = worldToCanvas(spline[i].x, spline[i].z);
      const d2 = (mx - sc.x) ** 2 + (my - sc.y) ** 2;
      if (d2 < bestDist) { bestDist = d2; best = { splineIdx: i, total: spline.length, p: spline[i] }; }
    }
    if (!best || bestDist > (60 / zoom) ** 2) return null;
    // Convertir índice de spline a sampleIdx (0-600)
    const TRACK_SAMPLES = 600;
    const sampleIdx = Math.round((best.splineIdx / best.total) * TRACK_SAMPLES);
    // Calcular lane: proyección lateral del click sobre la normal de la pista
    const w = canvasToWorld(mx, my);
    const p = best.p;
    const pn = spline[(best.splineIdx + 1) % spline.length];
    const dx = pn.x - p.x, dz = pn.z - p.z;
    const len = Math.sqrt(dx*dx + dz*dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const lateral = (w.x - p.x) * nx + (w.z - p.z) * nz;
    const lane = Math.max(-0.9, Math.min(0.9, lateral / trackWidth));
    return { sampleIdx, lane };
  }

  // Hit test sobre ícono de obstáculo/rampa
  function overlayHitTest(mx, my, list, spline) {
    if (!spline || spline.length < 2) return -1;
    const TRACK_SAMPLES = 600;
    const r2 = (10 / zoom) ** 2;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      const spIdx = Math.round((item.sampleIdx / TRACK_SAMPLES) * (spline.length - 1));
      const sp = spline[Math.min(spIdx, spline.length - 1)];
      const spNext = spline[Math.min(spIdx + 1, spline.length - 1)];
      const dx = spNext.x - sp.x, dz = spNext.z - sp.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const wx = sp.x + nx * item.lane * trackWidth;
      const wz = sp.z + nz * item.lane * trackWidth;
      const sc = worldToCanvas(wx, wz);
      const ddx = mx - sc.x, ddy = my - sc.y;
      if (ddx*ddx + ddy*ddy <= r2) return i;
    }
    return -1;
  }

  // ────────────────────────────────────────────────────
  //  Geometría y detección de atajos (anclas + CPs)
  // ────────────────────────────────────────────────────
  function getShortcutGeometry(sc) {
    if (!sc || !sc.controlPoints || sc.controlPoints.length === 0) return null;
    if (controlPoints.length < 2) return null;
    const startP = getTrackWorldPoint(sc.startSampleIdx);
    const endP = getTrackWorldPoint(sc.endSampleIdx);
    if (!startP || !endP) return null;

    const hw = trackWidth;
    const firstCP = sc.controlPoints[0];
    const lastCP = sc.controlPoints[sc.controlPoints.length - 1];

    const splineAll = buildSpline(controlPoints, true, 20);
    const totalSp = splineAll.length;
    const startIdx = Math.round((sc.startSampleIdx / 600) * (totalSp - 1));
    const endIdx = Math.round((sc.endSampleIdx / 600) * (totalSp - 1));
    const sp1 = splineAll[Math.max(0, startIdx - 1)];
    const sp2 = splineAll[Math.min(totalSp - 1, startIdx + 1)];
    const sp3 = splineAll[Math.max(0, endIdx - 1)];
    const sp4 = splineAll[Math.min(totalSp - 1, endIdx + 1)];

    const tanStartX = sp2.x - sp1.x, tanStartZ = sp2.z - sp1.z;
    const tanStartLen = Math.sqrt(tanStartX*tanStartX + tanStartZ*tanStartZ) || 1;
    const normStartX = -tanStartZ / tanStartLen, normStartZ = tanStartX / tanStartLen;

    const tanEndX = sp4.x - sp3.x, tanEndZ = sp4.z - sp3.z;
    const tanEndLen = Math.sqrt(tanEndX*tanEndX + tanEndZ*tanEndZ) || 1;
    const normEndX = -tanEndZ / tanEndLen, normEndZ = tanEndX / tanEndLen;

    const toFirstX = firstCP[0] - startP.x, toFirstZ = firstCP[2] - startP.z;
    const sideStart = (toFirstX * normStartX + toFirstZ * normStartZ) >= 0 ? 1 : -1;

    const toEndX = endP.x - lastCP[0], toEndZ = endP.z - lastCP[2];
    const sideEnd = (toEndX * normEndX + toEndZ * normEndZ) >= 0 ? 1 : -1;

    const anchorStart = { x: startP.x + normStartX * hw * sideStart, z: startP.z + normStartZ * hw * sideStart };
    const anchorEnd   = { x: endP.x   + normEndX   * hw * sideEnd,   z: endP.z   + normEndZ   * hw * sideEnd   };

    const pts = [anchorStart, ...sc.controlPoints.map(p => ({ x: p[0], z: p[2] })), anchorEnd];
    const scSpline = buildSpline(pts, false, 15);

    return { startP, endP, anchorStart, anchorEnd, pts, scSpline };
  }

  function shortcutHitTest(mx, my) {
    for (let sIdx = editorShortcuts.length - 1; sIdx >= 0; sIdx--) {
      const sc = editorShortcuts[sIdx];
      const geom = getShortcutGeometry(sc);
      if (!geom) continue;

      const isShortcutSelected = (sIdx === selectedShortcutIdx);

      // 1. Puntos de control intermedios (CP)
      for (let cpIdx = sc.controlPoints.length - 1; cpIdx >= 0; cpIdx--) {
        const pt = sc.controlPoints[cpIdx];
        const scPos = worldToCanvas(pt[0], pt[2]);
        const dx = mx - scPos.x, dy = my - scPos.y;
        const isPtSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'cp' && selectedShortcutPoint.cpIdx === cpIdx;
        const hitR = isPtSelected ? Math.max(MIN_ELEMENT_RADIUS_PX, pointRadius() + 10) : Math.max(14, 10 / zoom);
        if (dx * dx + dy * dy <= hitR * hitR) {
          return { sIdx, type: 'cp', cpIdx, x: pt[0], z: pt[2] };
        }
      }

      // 2. Ancla de inicio (start)
      const scStart = worldToCanvas(geom.anchorStart.x, geom.anchorStart.z);
      const dxStart = mx - scStart.x, dyStart = my - scStart.y;
      const isStartSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'start';
      const hitRStart = isStartSelected ? Math.max(MIN_ELEMENT_RADIUS_PX, pointRadius() + 10) : Math.max(16, 11 / zoom);
      if (dxStart * dxStart + dyStart * dyStart <= hitRStart * hitRStart) {
        return { sIdx, type: 'start', cpIdx: -1, x: geom.anchorStart.x, z: geom.anchorStart.z };
      }

      // 3. Ancla de fin (end)
      const scEnd = worldToCanvas(geom.anchorEnd.x, geom.anchorEnd.z);
      const dxEnd = mx - scEnd.x, dyEnd = my - scEnd.y;
      const isEndSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'end';
      const hitREnd = isEndSelected ? Math.max(MIN_ELEMENT_RADIUS_PX, pointRadius() + 10) : Math.max(16, 11 / zoom);
      if (dxEnd * dxEnd + dyEnd * dyEnd <= hitREnd * hitREnd) {
        return { sIdx, type: 'end', cpIdx: -1, x: geom.anchorEnd.x, z: geom.anchorEnd.z };
      }

      // 4. Curva del atajo
      if (geom.scSpline) {
        for (const sp of geom.scSpline) {
          const scP = worldToCanvas(sp.x, sp.z);
          const d2 = (mx - scP.x)**2 + (my - scP.y)**2;
          if (d2 <= (Math.max(12, 16 / zoom))**2) {
            return { sIdx, type: 'curve', cpIdx: -1, x: sp.x, z: sp.z };
          }
        }
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────
  //  Mouse events
  // ────────────────────────────────────────────────────
  function onMouseDown(e) {
    const mx = e.offsetX, my = e.offsetY;

    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      isPanning = true;
      panStart = { mx, my, px: panX, py: panY };
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const spline = controlPoints.length >= 2 ? buildSpline(controlPoints, true, 20) : null;

    if (tool === 'add') {
      const w = canvasToWorld(mx, my);
      const newPt = { x: Math.round(w.x), z: Math.round(w.z) };
      if (controlPoints.length < 2) {
        // Sin pista todavía: simplemente agregar al final
        controlPoints.push(newPt);
        selectedIdx = controlPoints.length - 1;
      } else {
        // Insertar en el segmento más cercano del polígono
        const seg = closestSegmentIdx(newPt);
        controlPoints.splice(seg + 1, 0, newPt);
        selectedIdx = seg + 1;
      }
      selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
      showPointInfo(selectedIdx); updatePointCount(); render();
      pushHistory();
      return;
    }

    if (tool === 'delete') {
      const idx = hitTest(mx, my);
      if (idx >= 0) { removePoint(idx); pushHistory(); } return;
    }

    if (tool === 'obs-add') {
      const hit = splineHitTest(mx, my);
      if (hit) {
        const obsType = parseInt(document.getElementById('obs-type').value, 10) || 0;
        editorObstacles.push({ sampleIdx: hit.sampleIdx, lane: hit.lane, type: obsType });
        selectedObsIdx = editorObstacles.length - 1;
        updateObstacleCount(); render();
        pushHistory();
        setStatus('ok', `Obstáculo añadido en muestra ${hit.sampleIdx}.`);
      } else { setStatus('err', 'Hacé click más cerca de la pista.'); }
      return;
    }

    if (tool === 'obs-delete') {
      if (spline) {
        const idx = overlayHitTest(mx, my, editorObstacles, spline);
        if (idx >= 0) { editorObstacles.splice(idx, 1); selectedObsIdx = -1; updateObstacleCount(); render(); pushHistory(); setStatus('info', 'Obstáculo eliminado.'); }
      }
      return;
    }

    if (tool === 'ramp-add') {
      const hit = splineHitTest(mx, my);
      if (hit) {
        const rampType = document.getElementById('ramp-type').value || 'gold';
        editorRamps.push({ sampleIdx: hit.sampleIdx, lane: hit.lane, type: rampType });
        selectedRampIdx = editorRamps.length - 1;
        updateRampCount(); render();
        pushHistory();
        setStatus('ok', `Rampa "${rampType}" añadida en muestra ${hit.sampleIdx}.`);
      } else { setStatus('err', 'Hacé click más cerca de la pista.'); }
      return;
    }

    if (tool === 'ramp-delete') {
      if (spline) {
        const idx = overlayHitTest(mx, my, editorRamps, spline);
        if (idx >= 0) { editorRamps.splice(idx, 1); selectedRampIdx = -1; updateRampCount(); render(); pushHistory(); setStatus('info', 'Rampa eliminada.'); }
      }
      return;
    }

    if (tool === 'pu-add') {
      const hit = splineHitTest(mx, my);
      if (hit) {
        const puType = document.getElementById('pu-type').value || 'missile';
        editorPowerups.push({ sampleIdx: hit.sampleIdx, lane: hit.lane, type: puType });
        selectedPowerupIdx = editorPowerups.length - 1;
        updatePowerupCount(); render();
        pushHistory();
        setStatus('ok', `Orbe "${puType}" añadido en muestra ${hit.sampleIdx}.`);
      } else { setStatus('err', 'Hacé click más cerca de la pista.'); }
      return;
    }

    if (tool === 'pu-delete') {
      if (spline) {
        const idx = overlayHitTest(mx, my, editorPowerups, spline);
        if (idx >= 0) { editorPowerups.splice(idx, 1); selectedPowerupIdx = -1; updatePowerupCount(); render(); pushHistory(); setStatus('info', 'Orbe eliminado.'); }
      }
      return;
    }

    if (tool === 'shortcut-add') {
      const hit = splineHitTest(mx, my);
      if (!shortcutDraft) {
        if (hit) {
          shortcutDraft = { startSampleIdx: hit.sampleIdx, controlPoints: [] };
          setStatus('info', 'Inicio de atajo fijado. Hacé clicks para los puntos intermedios.');
          render();
        } else {
          setStatus('err', 'El inicio debe estar sobre la pista principal.');
        }
      } else {
        if (hit && shortcutDraft.controlPoints.length > 0) {
           editorShortcuts.push({
             startSampleIdx: shortcutDraft.startSampleIdx,
             endSampleIdx: hit.sampleIdx,
             halfWidth: trackWidth * 0.7,
             controlPoints: shortcutDraft.controlPoints
           });
           shortcutDraft = null;
           render(); pushHistory();
           setStatus('ok', 'Atajo creado.');
        } else {
           const w = canvasToWorld(mx, my);
           shortcutDraft.controlPoints.push([Math.round(w.x), 0, Math.round(w.z)]);
           render();
        }
      }
      return;
    }

    if (tool === 'shortcut-delete') {
      const hitSc = shortcutHitTest(mx, my);
      if (hitSc) {
        editorShortcuts.splice(hitSc.sIdx, 1);
        if (selectedShortcutIdx === hitSc.sIdx) {
          selectedShortcutIdx = -1;
          selectedShortcutPoint = null;
        } else if (selectedShortcutIdx > hitSc.sIdx) {
          selectedShortcutIdx--;
        }
        updateShortcutCount();
        editor3DNeedsSync = true; sync3DIfNeeded();
        render(); pushHistory();
        setStatus('ok', 'Atajo eliminado.');
      } else {
        setStatus('info', 'Hacé click sobre cualquier atajo o sus anclas para eliminarlo.');
      }
      return;
    }

    if (tool === 'terrain-add') {
      const w = canvasToWorld(mx, my);
      const type = (document.getElementById('terrain-type') && document.getElementById('terrain-type').value) || 'mountain_tunnel';
      const h = parseInt(document.getElementById('node-height').value) || (type === 'crater' ? -25 : 45);
      const r = parseInt(document.getElementById('node-radius').value) || 50;
      const isTunnel = (type === 'mountain_tunnel');
      const tunnelWidth = isTunnel ? (parseInt(document.getElementById('tunnel-width').value) || 22) : 0;
      const tunnelHeight = isTunnel ? (parseInt(document.getElementById('tunnel-height').value) || 16) : 0;
      let tunnelAngle = isTunnel ? (parseFloat(document.getElementById('tunnel-angle').value) || 0) : 0;

      // Si es túnel y ángulo es 0, alinear automáticamente a la pista
      if (isTunnel && tunnelAngle === 0) {
        tunnelAngle = getClosestTrackTangentAngle(w.x, w.z);
        const aInput = document.getElementById('tunnel-angle');
        const aVal = document.getElementById('tunnel-angle-val');
        if (aInput) aInput.value = tunnelAngle;
        if (aVal) aVal.textContent = tunnelAngle + '°';
      }

      editorTerrainNodes.push({
        x: Math.round(w.x),
        z: Math.round(w.z),
        height: h,
        radius: r,
        type: type,
        hasHole: isTunnel,
        holeWidth: tunnelWidth,
        holeHeight: tunnelHeight,
        holeAngle: tunnelAngle
      });
      selectedTerrainIdx = editorTerrainNodes.length - 1;
      updateTerrainCount();
      render(); pushHistory();
      setStatus('ok', isTunnel ? `Montaña con túnel añadida (${tunnelAngle}°).` : 'Estructura de terreno añadida.');
      return;
    }

    if (tool === 'terrain-delete') {
      const bestIdx = terrainHitTest(mx, my);
      if (bestIdx >= 0) {
        editorTerrainNodes.splice(bestIdx, 1);
        if (selectedTerrainIdx === bestIdx) selectedTerrainIdx = -1;
        else if (selectedTerrainIdx > bestIdx) selectedTerrainIdx--;
        updateTerrainCount();
        editor3DNeedsSync = true; sync3DIfNeeded();
        render(); pushHistory();
        setStatus('ok', 'Estructura de terreno eliminada.');
      }
      return;
    }

    if (tool === 'barrier-add') {
      const w = canvasToWorld(mx, my);
      if (!barrierDraft) {
        barrierDraft = { x: Math.round(w.x), z: Math.round(w.z) };
        setStatus('info', 'Inicio de barrera fijado. Hacé click para el final.');
      } else {
        editorBarriers.push({
          start: { x: barrierDraft.x, z: barrierDraft.z },
          end: { x: Math.round(w.x), z: Math.round(w.z) }
        });
        barrierDraft = null;
        render(); pushHistory();
        setStatus('ok', 'Barrera creada.');
      }
      return;
    }

    if (tool === 'barrier-delete') {
      const w = canvasToWorld(mx, my);
      const THRESHOLD = 300; // Distancia cuadrada (pixels o unidades mundo)
      let bestIdx = -1, bestDist = Infinity;
      editorBarriers.forEach((b, i) => {
        // Distancia punto a segmento
        const l2 = (b.end.x - b.start.x)**2 + (b.end.z - b.start.z)**2;
        let t = 0;
        if (l2 !== 0) {
          t = Math.max(0, Math.min(1, ((w.x - b.start.x) * (b.end.x - b.start.x) + (w.z - b.start.z) * (b.end.z - b.start.z)) / l2));
        }
        const px = b.start.x + t * (b.end.x - b.start.x);
        const pz = b.start.z + t * (b.end.z - b.start.z);
        const d = (w.x - px)**2 + (w.z - pz)**2;
        if (d < bestDist && d < THRESHOLD) { bestIdx = i; bestDist = d; }
      });
      if (bestIdx >= 0) {
        editorBarriers.splice(bestIdx, 1);
        render(); pushHistory();
        setStatus('ok', 'Barrera eliminada.');
      }
      return;
    }

    // move (default)
    // 0. Si hay un túnel seleccionado, chequear tirador orbital de rotación directa
    if (terrainRotationGizmoHitTest(mx, my)) {
      isRotatingTunnel = true;
      dragging = true;
      dragType = 'tunnel-rotate';
      canvas.style.cursor = 'crosshair';
      render();
      return;
    }

    // Prioridad: atajos (anclas y puntos) > powerups > obstáculos/rampas > puntos de control > montañas
    const hitSc = shortcutHitTest(mx, my);
    if (hitSc) {
      selectedShortcutIdx = hitSc.sIdx;
      selectedShortcutPoint = { type: hitSc.type, cpIdx: hitSc.cpIdx };
      selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedTerrainIdx = -1;
      dragging = true;
      dragIdx = hitSc.sIdx;
      if (hitSc.type === 'start') dragType = 'shortcut-start';
      else if (hitSc.type === 'end') dragType = 'shortcut-end';
      else if (hitSc.type === 'cp') dragType = 'shortcut-cp';
      else dragType = 'shortcut-curve';
      canvas.style.cursor = 'grabbing';
      hidePointInfo();
      const ptDesc = hitSc.type === 'start' ? 'Ancla de inicio ⚓' : hitSc.type === 'end' ? 'Ancla de fin 🎯' : hitSc.type === 'cp' ? `Punto de control CP#${hitSc.cpIdx + 1}` : 'Atajo';
      setStatus('ok', `${ptDesc} del Atajo #${hitSc.sIdx + 1} seleccionado. Arrastralo para reposicionar.`);
      render();
      return;
    }

    if (spline) {
      const puIdx = overlayHitTest(mx, my, editorPowerups, spline);
      if (puIdx >= 0) {
        selectedPowerupIdx = puIdx; selectedObsIdx = -1; selectedRampIdx = -1; selectedIdx = -1; selectedTerrainIdx = -1;
        selectedShortcutIdx = -1; selectedShortcutPoint = null;
        dragging = true; dragIdx = puIdx; dragType = 'pu';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
      const obsIdx = overlayHitTest(mx, my, editorObstacles, spline);
      if (obsIdx >= 0) {
        selectedObsIdx = obsIdx; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedIdx = -1; selectedTerrainIdx = -1;
        selectedShortcutIdx = -1; selectedShortcutPoint = null;
        dragging = true; dragIdx = obsIdx; dragType = 'obs';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
      const rampIdx = overlayHitTest(mx, my, editorRamps, spline);
      if (rampIdx >= 0) {
        selectedRampIdx = rampIdx; selectedObsIdx = -1; selectedPowerupIdx = -1; selectedIdx = -1; selectedTerrainIdx = -1;
        selectedShortcutIdx = -1; selectedShortcutPoint = null;
        dragging = true; dragIdx = rampIdx; dragType = 'ramp';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
    }

    const idx = hitTest(mx, my);
    if (idx >= 0) {
      dragging = true; dragIdx = idx; selectedIdx = idx; dragType = 'point';
      selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedTerrainIdx = -1;
      selectedShortcutIdx = -1; selectedShortcutPoint = null;
      canvas.style.cursor = 'grabbing';
      showPointInfo(idx); render();
      return;
    }

    // Selección y arrastre de montañas en modo move con zona clamp >= 150px
    const tHit = terrainHitTest(mx, my);
    if (tHit >= 0) {
      selectedTerrainIdx = tHit;
      selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
      selectedShortcutIdx = -1; selectedShortcutPoint = null;
      dragging = true; dragIdx = tHit; dragType = 'terrain';
      syncSidebarFromTerrainNode(editorTerrainNodes[tHit]);
      canvas.style.cursor = 'grabbing';
      hidePointInfo();
      setStatus('ok', `Montaña #${tHit + 1} seleccionada (Ø min 150px). Podés moverla o rotar el túnel.`);
      render();
      return;
    }

    // Clic en vacío: deseleccionar y paneo
    selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedTerrainIdx = -1;
    selectedShortcutIdx = -1; selectedShortcutPoint = null;
    hidePointInfo();
    isPanning = true;
    panStart = { mx, my, px: panX, py: panY };
    canvas.style.cursor = 'grabbing'; render();
  }

  function onMouseMove(e) {
    const mx = e.offsetX, my = e.offsetY;
    mouseScreenPos.x = mx;
    mouseScreenPos.y = my;
    mouseInCanvas = true;

    if (isPanning) {
      panX = panStart.px + (mx - panStart.mx);
      panY = panStart.py + (my - panStart.my);
      render(); return;
    }
    if (dragging && dragIdx >= 0) {
      if (dragType === 'point') {
        const w = canvasToWorld(mx, my);
        controlPoints[dragIdx].x = Math.round(w.x);
        controlPoints[dragIdx].z = Math.round(w.z);
        showPointInfo(dragIdx);
      } else if (dragType === 'terrain') {
        const w = canvasToWorld(mx, my);
        editorTerrainNodes[dragIdx].x = Math.round(w.x);
        editorTerrainNodes[dragIdx].z = Math.round(w.z);
        editor3DNeedsSync = true;
      } else if (dragType === 'tunnel-rotate' && selectedTerrainIdx >= 0 && editorTerrainNodes[selectedTerrainIdx]) {
        const node = editorTerrainNodes[selectedTerrainIdx];
        const sc = worldToCanvas(node.x, node.z);
        let deg = Math.round(Math.atan2(my - sc.y, mx - sc.x) * (180 / Math.PI));
        if (deg < 0) deg += 360;
        node.holeAngle = deg;
        const aInput = document.getElementById('tunnel-angle');
        const aVal = document.getElementById('tunnel-angle-val');
        if (aInput) aInput.value = deg;
        if (aVal) aVal.textContent = deg + '°';
        editor3DNeedsSync = true;
      } else if (dragType === 'shortcut-cp' && selectedShortcutPoint && selectedShortcutPoint.type === 'cp') {
        const sc = editorShortcuts[dragIdx];
        if (sc && sc.controlPoints[selectedShortcutPoint.cpIdx]) {
          const w = canvasToWorld(mx, my);
          sc.controlPoints[selectedShortcutPoint.cpIdx][0] = Math.round(w.x);
          sc.controlPoints[selectedShortcutPoint.cpIdx][2] = Math.round(w.z);
          editor3DNeedsSync = true;
        }
      } else if (dragType === 'shortcut-start') {
        const sc = editorShortcuts[dragIdx];
        const hitTrack = splineHitTest(mx, my);
        if (sc && hitTrack) {
          sc.startSampleIdx = hitTrack.sampleIdx;
          editor3DNeedsSync = true;
        }
      } else if (dragType === 'shortcut-end') {
        const sc = editorShortcuts[dragIdx];
        const hitTrack = splineHitTest(mx, my);
        if (sc && hitTrack) {
          sc.endSampleIdx = hitTrack.sampleIdx;
          editor3DNeedsSync = true;
        }
      } else if ((['obs','ramp','pu'].includes(dragType)) && controlPoints.length >= 2) {
        const spline = buildSpline(controlPoints, true, 20);
        const hit = splineHitTest(mx, my);
        if (hit) {
          if (dragType === 'obs') { editorObstacles[dragIdx].sampleIdx = hit.sampleIdx; editorObstacles[dragIdx].lane = hit.lane; }
          else if (dragType === 'ramp') { editorRamps[dragIdx].sampleIdx = hit.sampleIdx; editorRamps[dragIdx].lane = hit.lane; }
          else if (dragType === 'pu') { editorPowerups[dragIdx].sampleIdx = hit.sampleIdx; editorPowerups[dragIdx].lane = hit.lane; }
        }
      }
      render();
      return;
    }

    // Detección de hover y cursor contextual
    hoverTerrainIdx = terrainHitTest(mx, my);
    hoverShortcutPoint = shortcutHitTest(mx, my);
    if (tool === 'move') {
      if (terrainRotationGizmoHitTest(mx, my)) {
        canvas.style.cursor = 'crosshair';
      } else if (hoverShortcutPoint) {
        canvas.style.cursor = 'pointer';
      } else if (hoverTerrainIdx >= 0 || hitTest(mx, my) >= 0) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'grab';
      }
    }

    // Redibujar en tiempo real para placement ghost y hover
    if (['terrain-add', 'shortcut-add', 'add', 'move', 'terrain-delete', 'shortcut-delete'].includes(tool)) {
      render();
    }
  }

  function onMouseUp(e) {
    if (isPanning) {
      isPanning = false;
      const curs = ['add','obs-add','ramp-add','pu-add','terrain-add','shortcut-add','barrier-add'].includes(tool) ? 'crosshair'
                 : ['delete','obs-delete','ramp-delete','pu-delete','terrain-delete','shortcut-delete','barrier-delete'].includes(tool) ? 'not-allowed' : 'grab';
      canvas.style.cursor = curs;
    }
    if (dragging) { 
      if (dragType === 'terrain' || dragType === 'tunnel-rotate' || dragType === 'shortcut-cp' || dragType === 'shortcut-start' || dragType === 'shortcut-end') {
        editor3DNeedsSync = true;
        sync3DIfNeeded();
      }
      dragging = false; dragIdx = -1; dragType = null; isRotatingTunnel = false;
      canvas.style.cursor = 'grab'; 
      pushHistory();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const mx = e.offsetX, my = e.offsetY;
    const ccx = canvas.width / 2, ccy = canvas.height / 2;
    // Zoom centrado en el cursor
    panX = (panX - (mx - ccx)) * delta + (mx - ccx);
    panY = (panY - (my - ccy)) * delta + (my - ccy);
    zoom = Math.max(0.1, Math.min(8, zoom * delta));
    updateZoomIndicator();
    render();
  }

  function removePoint(idx) {
    controlPoints.splice(idx, 1);
    if (selectedIdx >= controlPoints.length) selectedIdx = controlPoints.length - 1;
    if (controlPoints.length === 0) { selectedIdx = -1; hidePointInfo(); }
    else if (selectedIdx >= 0) showPointInfo(selectedIdx);
    updatePointCount();
    render();
    setStatus('info', `Punto eliminado. ${controlPoints.length} puntos restantes.`);
  }

  // ────────────────────────────────────────────────────
  //  CatmullRom spline en 2D
  // ────────────────────────────────────────────────────
  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2*p0.x - 5*p1.x + 4*p2.x - p3.x) * t2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x) * t3),
      z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2*p0.z - 5*p1.z + 4*p2.z - p3.z) * t2 + (-p0.z + 3*p1.z - 3*p2.z + p3.z) * t3)
    };
  }

  function buildSpline(pts, closed, steps) {
    if (pts.length < 2) return [];
    const n = pts.length;
    const curve = [];
    const total = closed ? n : n - 1;
    for (let i = 0; i < total; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        curve.push(catmullRomPoint(p0, p1, p2, p3, t));
      }
    }
    if (closed) curve.push(curve[0]);
    return curve;
  }

  // ────────────────────────────────────────────────────
  //  Render
  // ────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Imagen de fondo (antes del grid para que quede debajo de todo)
    if (bgImage) {
      ctx.save();
      ctx.globalAlpha = bgOpacity;
      // La imagen se centra en el origen mundo (0,0), escalada por bgScale
      const scaledW = bgImage.naturalWidth  * bgScale * zoom;
      const scaledH = bgImage.naturalHeight * bgScale * zoom;
      const originCanvas = worldToCanvas(0, 0);
      ctx.drawImage(bgImage,
        originCanvas.x - scaledW / 2,
        originCanvas.y - scaledH / 2,
        scaledW, scaledH
      );
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    drawGrid();
    if (controlPoints.length < 2) {
      drawTerrainNodes();
      drawBarriers();
      drawPoints();
      drawPlacementGhost();
      drawNoPointsHint();
      sync3DIfNeeded();
      return;
    }
    const spline = buildSpline(controlPoints, true, 20);
    drawTrackFill(spline);
    // Atajos se dibujan ANTES de la línea roja para que queden debajo
    drawShortcuts();
    // Línea central roja
    ctx.beginPath();
    spline.forEach((p, i) => {
      const sc = worldToCanvas(p.x, p.z);
      i === 0 ? ctx.moveTo(sc.x, sc.y) : ctx.lineTo(sc.x, sc.y);
    });
    ctx.strokeStyle = '#A30000';
    ctx.lineWidth = Math.max(1, 1.5 / zoom);
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 5 / zoom;
    ctx.stroke(); ctx.shadowBlur = 0;
    
    if (controlPoints.length > 0) drawStartLine(spline);
    drawPowerups(spline);
    drawObstacles(spline);
    drawRamps(spline);
    drawTerrainNodes();
    drawBarriers();
    drawPoints();
    drawPlacementGhost();
    sync3DIfNeeded();
  }

  function drawBarriers() {
    ctx.lineWidth = Math.max(1.5, 3 / zoom);
    ctx.strokeStyle = '#00ffff';
    for (const b of editorBarriers) {
      const p1 = worldToCanvas(b.start.x, b.start.z);
      const p2 = worldToCanvas(b.end.x, b.end.z);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    if (barrierDraft) {
      const p1 = worldToCanvas(barrierDraft.x, barrierDraft.z);
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#00ffff';
      ctx.fill();
    }
  }

  function drawShortcuts() {
    updateShortcutCount();

    // Dibujar atajos terminados con sus anclas y puntos de control interactivos
    for (let sIdx = 0; sIdx < editorShortcuts.length; sIdx++) {
      const sc = editorShortcuts[sIdx];
      const geom = getShortcutGeometry(sc);
      if (!geom) continue;

      const isShortcutSelected = (sIdx === selectedShortcutIdx);
      const isCurveHovered = (hoverShortcutPoint && hoverShortcutPoint.sIdx === sIdx && hoverShortcutPoint.type === 'curve');

      ctx.save();

      // ── 1. Cinta / Pista del Atajo (Asfalto y Bordes) ──
      ctx.beginPath();
      geom.scSpline.forEach((p, i) => {
        const scPos = worldToCanvas(p.x, p.z);
        i === 0 ? ctx.moveTo(scPos.x, scPos.y) : ctx.lineTo(scPos.x, scPos.y);
      });
      ctx.strokeStyle = isShortcutSelected ? '#00e5ff' : (isCurveHovered ? '#00bbff' : '#006699');
      ctx.lineWidth = Math.max(3, (sc.halfWidth ? sc.halfWidth * 1.6 : 10) * zoom);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Línea central punteada del atajo
      ctx.beginPath();
      geom.scSpline.forEach((p, i) => {
        const scPos = worldToCanvas(p.x, p.z);
        i === 0 ? ctx.moveTo(scPos.x, scPos.y) : ctx.lineTo(scPos.x, scPos.y);
      });
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, 2 / zoom);
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── 2. Polígono / Jaula de Control (Conecta ancla inicio -> CPs -> ancla fin) ──
      ctx.beginPath();
      const scStart = worldToCanvas(geom.anchorStart.x, geom.anchorStart.z);
      ctx.moveTo(scStart.x, scStart.y);
      for (const cp of sc.controlPoints) {
        const scCp = worldToCanvas(cp[0], cp[2]);
        ctx.lineTo(scCp.x, scCp.y);
      }
      const scEnd = worldToCanvas(geom.anchorEnd.x, geom.anchorEnd.z);
      ctx.lineTo(scEnd.x, scEnd.y);
      ctx.strokeStyle = isShortcutSelected ? 'rgba(255, 204, 0, 0.75)' : 'rgba(0, 229, 255, 0.35)';
      ctx.lineWidth = Math.max(1, 1.5 / zoom);
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── 3. Guías de Conexión a la Pista Principal ──
      const scTrackStart = worldToCanvas(geom.startP.x, geom.startP.z);
      ctx.beginPath();
      ctx.moveTo(scTrackStart.x, scTrackStart.y);
      ctx.lineTo(scStart.x, scStart.y);
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.5)';
      ctx.lineWidth = Math.max(1, 1.2 / zoom);
      ctx.stroke();

      const scTrackEnd = worldToCanvas(geom.endP.x, geom.endP.z);
      ctx.beginPath();
      ctx.moveTo(scTrackEnd.x, scTrackEnd.y);
      ctx.lineTo(scEnd.x, scEnd.y);
      ctx.strokeStyle = 'rgba(255, 68, 102, 0.5)';
      ctx.lineWidth = Math.max(1, 1.2 / zoom);
      ctx.stroke();

      // ── 4. Puntos de Control Intermedios (CP) ──
      for (let cpIdx = 0; cpIdx < sc.controlPoints.length; cpIdx++) {
        const cp = sc.controlPoints[cpIdx];
        const scCp = worldToCanvas(cp[0], cp[2]);
        const isCpSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'cp' && selectedShortcutPoint.cpIdx === cpIdx;
        const isCpHovered = (hoverShortcutPoint && hoverShortcutPoint.sIdx === sIdx && hoverShortcutPoint.type === 'cp' && hoverShortcutPoint.cpIdx === cpIdx);

        // Halo de selección adaptativo >= 150px
        if (isCpSelected || isCpHovered) {
          ctx.save();
          const selR = Math.max(MIN_ELEMENT_RADIUS_PX, 16 + 8 / zoom);
          ctx.beginPath();
          ctx.arc(scCp.x, scCp.y, selR, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 187, 0, 0.15)';
          ctx.fill();
          ctx.strokeStyle = '#ffbb00';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Retícula central
          ctx.strokeStyle = '#ffbb00';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(scCp.x - 7, scCp.y); ctx.lineTo(scCp.x + 7, scCp.y);
          ctx.moveTo(scCp.x, scCp.y - 7); ctx.lineTo(scCp.x, scCp.y + 7);
          ctx.stroke();

          // Badge flotante
          const badgeText = `ATAJO #${sIdx + 1} PUNTO CP#${cpIdx + 1} [X:${Math.round(cp[0])}, Z:${Math.round(cp[2])}] | Ø ≥150px`;
          ctx.font = "bold 10px 'Share Tech Mono', monospace";
          const tw = ctx.measureText(badgeText).width;
          ctx.fillStyle = 'rgba(16, 14, 10, 0.9)';
          ctx.fillRect(scCp.x - tw / 2 - 6, scCp.y - selR - 22, tw + 12, 16);
          ctx.strokeStyle = '#ffbb00'; ctx.lineWidth = 1;
          ctx.strokeRect(scCp.x - tw / 2 - 6, scCp.y - selR - 22, tw + 12, 16);
          ctx.fillStyle = '#ffbb00'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, scCp.x, scCp.y - selR - 14);
          ctx.restore();
        }

        // Nodo circular del punto intermedio
        const nodeR = Math.max(7, 9 / zoom);
        ctx.beginPath();
        ctx.arc(scCp.x, scCp.y, nodeR, 0, Math.PI * 2);
        ctx.fillStyle = isCpSelected ? '#ffdd00' : '#ff9900';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${Math.max(7, 9 / zoom)}px 'Share Tech Mono', monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`CP${cpIdx + 1}`, scCp.x, scCp.y);
      }

      // ── 5. Ancla de Inicio (⚓ anchorStart) ──
      const isStartSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'start';
      const isStartHovered = (hoverShortcutPoint && hoverShortcutPoint.sIdx === sIdx && hoverShortcutPoint.type === 'start');

      if (isStartSelected || isStartHovered) {
        ctx.save();
        const selR = Math.max(MIN_ELEMENT_RADIUS_PX, 18 + 8 / zoom);
        ctx.beginPath();
        ctx.arc(scStart.x, scStart.y, selR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 136, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        const badgeText = `⚓ ATAJO #${sIdx + 1} ANCLA INICIO [Muestra ${sc.startSampleIdx}] | Ø ≥150px`;
        ctx.font = "bold 10px 'Share Tech Mono', monospace";
        const tw = ctx.measureText(badgeText).width;
        ctx.fillStyle = 'rgba(10, 16, 12, 0.9)';
        ctx.fillRect(scStart.x - tw / 2 - 6, scStart.y - selR - 22, tw + 12, 16);
        ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1;
        ctx.strokeRect(scStart.x - tw / 2 - 6, scStart.y - selR - 22, tw + 12, 16);
        ctx.fillStyle = '#00ff88'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, scStart.x, scStart.y - selR - 14);
        ctx.restore();
      }

      const anchorStartR = Math.max(9, 12 / zoom);
      ctx.beginPath();
      ctx.arc(scStart.x, scStart.y, anchorStartR, 0, Math.PI * 2);
      ctx.fillStyle = isStartSelected ? '#00ff88' : '#00aa55';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(8, 10 / zoom)}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚓', scStart.x, scStart.y);

      // ── 6. Ancla de Fin (🎯 anchorEnd) ──
      const isEndSelected = isShortcutSelected && selectedShortcutPoint && selectedShortcutPoint.type === 'end';
      const isEndHovered = (hoverShortcutPoint && hoverShortcutPoint.sIdx === sIdx && hoverShortcutPoint.type === 'end');

      if (isEndSelected || isEndHovered) {
        ctx.save();
        const selR = Math.max(MIN_ELEMENT_RADIUS_PX, 18 + 8 / zoom);
        ctx.beginPath();
        ctx.arc(scEnd.x, scEnd.y, selR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 68, 102, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#ff3366';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        const badgeText = `🎯 ATAJO #${sIdx + 1} ANCLA FIN [Muestra ${sc.endSampleIdx}] | Ø ≥150px`;
        ctx.font = "bold 10px 'Share Tech Mono', monospace";
        const tw = ctx.measureText(badgeText).width;
        ctx.fillStyle = 'rgba(16, 10, 12, 0.9)';
        ctx.fillRect(scEnd.x - tw / 2 - 6, scEnd.y - selR - 22, tw + 12, 16);
        ctx.strokeStyle = '#ff3366'; ctx.lineWidth = 1;
        ctx.strokeRect(scEnd.x - tw / 2 - 6, scEnd.y - selR - 22, tw + 12, 16);
        ctx.fillStyle = '#ff4466'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, scEnd.x, scEnd.y - selR - 14);
        ctx.restore();
      }

      const anchorEndR = Math.max(9, 12 / zoom);
      ctx.beginPath();
      ctx.arc(scEnd.x, scEnd.y, anchorEndR, 0, Math.PI * 2);
      ctx.fillStyle = isEndSelected ? '#ff3366' : '#cc2244';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(8, 10 / zoom)}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🎯', scEnd.x, scEnd.y);

      ctx.restore();
    }
    
    // ── 7. Dibujar borrador en curso ──
    if (shortcutDraft) {
      ctx.save();
      ctx.strokeStyle = '#ffbb00';
      ctx.lineWidth = Math.max(1.5, 3 / zoom);
      ctx.setLineDash([5, 5]);
      const startP = getTrackWorldPoint(shortcutDraft.startSampleIdx);
      if (startP) {
        ctx.beginPath();
        const startSc = worldToCanvas(startP.x, startP.z);
        ctx.moveTo(startSc.x, startSc.y);
        for (const pt of shortcutDraft.controlPoints) {
          const scPos = worldToCanvas(pt[0], pt[2]);
          ctx.lineTo(scPos.x, scPos.y);
        }
        ctx.stroke();

        // Ancla inicial del borrador
        ctx.beginPath();
        ctx.arc(startSc.x, startSc.y, Math.max(8, 11 / zoom), 0, Math.PI * 2);
        ctx.fillStyle = '#00ff88'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#000'; ctx.font = `bold ${Math.max(7, 9 / zoom)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⚓', startSc.x, startSc.y);

        // Puntos intermedios del borrador
        for (let i = 0; i < shortcutDraft.controlPoints.length; i++) {
          const pt = shortcutDraft.controlPoints[i];
          const scPos = worldToCanvas(pt[0], pt[2]);
          ctx.beginPath();
          ctx.arc(scPos.x, scPos.y, Math.max(6, 8 / zoom), 0, Math.PI * 2);
          ctx.fillStyle = '#ffbb00'; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  function updateTerrainCount() {
    const el = document.getElementById('terrain-count');
    if (el) el.textContent = `${editorTerrainNodes.length} estructuras de terreno`;
  }

  function getClosestTrackTangentAngle(wx, wz) {
    if (controlPoints.length < 2) return 0;
    const spline = buildSpline(controlPoints, true, 40);
    let minDistSq = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < spline.length; i++) {
      const p = spline[i];
      const dSq = (p.x - wx) ** 2 + (p.z - wz) ** 2;
      if (dSq < minDistSq) {
        minDistSq = dSq;
        bestIdx = i;
      }
    }
    const nextIdx = (bestIdx + 1) % spline.length;
    const prevIdx = (bestIdx - 1 + spline.length) % spline.length;
    const dx = spline[nextIdx].x - spline[prevIdx].x;
    const dz = spline[nextIdx].z - spline[prevIdx].z;
    let angleDeg = Math.round(Math.atan2(dz, dx) * (180 / Math.PI));
    if (angleDeg < 0) angleDeg += 360;
    return angleDeg;
  }

  function drawTerrainNodes() {
    updateTerrainCount();
    for (let i = 0; i < editorTerrainNodes.length; i++) {
      const node = editorTerrainNodes[i];
      const sc = worldToCanvas(node.x, node.z);
      // Clamp adaptativo: radio NUNCA inferior a 75px (diámetro >= 150px en pantalla)
      const rCanvas = getClampedScreenRadius(node.radius);
      const physR = (node.radius || 50) * zoom;
      const isSelected = (i === selectedTerrainIdx);
      const isHovered = (i === hoverTerrainIdx && !isSelected);
      const isTunnel = (node.type === 'mountain_tunnel' || node.hasHole);

      ctx.save();

      // Indicador de hover previo (anillo blanco translúcido de 150px+)
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, rCanvas + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (isTunnel) {
        // ── Montaña con Túnel (Paso Pasante) ──
        const grad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, rCanvas);
        grad.addColorStop(0, 'rgba(50, 30, 55, 0.85)');
        grad.addColorStop(0.7, 'rgba(28, 16, 32, 0.7)');
        grad.addColorStop(1, 'rgba(80, 25, 60, 0.45)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, rCanvas, 0, Math.PI * 2);
        ctx.fill();

        // Anillo exterior con glow
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 100, 200, 0.75)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        if (isSelected) {
          ctx.shadowColor = '#00ffff';
          ctx.shadowBlur = 10;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Si el tamaño real de mundo es menor al clamp de 150px, dibujar su radio físico real
        if (physR < rCanvas) {
          ctx.beginPath();
          ctx.arc(sc.x, sc.y, physR, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Corredor del túnel pasante (escalado al radio clamped para visibilidad de 150px+)
        const angleRad = ((node.holeAngle || 0) * Math.PI) / 180;
        const screenScale = rCanvas / Math.max(1, node.radius || 50);
        const hwCanvas = Math.max(14, ((node.holeWidth || 22) * screenScale) / 2);
        const hlCanvas = rCanvas * 1.05;

        ctx.save();
        ctx.translate(sc.x, sc.y);
        ctx.rotate(angleRad);

        // Fondo del canal de túnel
        ctx.fillStyle = 'rgba(10, 10, 18, 0.95)';
        ctx.fillRect(-hlCanvas, -hwCanvas, hlCanvas * 2, hwCanvas * 2);

        // Paredes del túnel (líneas punteadas cyan de alta visibilidad)
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-hlCanvas, -hwCanvas); ctx.lineTo(hlCanvas, -hwCanvas);
        ctx.moveTo(-hlCanvas, hwCanvas); ctx.lineTo(hlCanvas, hwCanvas);
        ctx.stroke();
        ctx.setLineDash([]);

        // Flecha de sentido del túnel
        ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-rCanvas * 0.35, 0); ctx.lineTo(rCanvas * 0.35, 0);
        ctx.lineTo(rCanvas * 0.2, -hwCanvas * 0.4);
        ctx.moveTo(rCanvas * 0.35, 0); ctx.lineTo(rCanvas * 0.2, hwCanvas * 0.4);
        ctx.stroke();

        // Tapas de entrada y salida
        ctx.fillStyle = '#00ffff';
        ctx.fillRect(-hlCanvas - 2, -hwCanvas, 4, hwCanvas * 2);
        ctx.fillRect(hlCanvas - 2, -hwCanvas, 4, hwCanvas * 2);
        ctx.restore();

        // Si está seleccionado: dibujar Gizmo Orbital de rotación de ángulo
        if (isSelected) {
          const knobDist = rCanvas + 18;
          const knobX = sc.x + Math.cos(angleRad) * knobDist;
          const knobY = sc.y + Math.sin(angleRad) * knobDist;

          // Órbita circular discontinua
          ctx.beginPath();
          ctx.arc(sc.x, sc.y, knobDist, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
          ctx.setLineDash([3, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Línea conector hacia el knob
          ctx.beginPath();
          ctx.moveTo(sc.x, sc.y);
          ctx.lineTo(knobX, knobY);
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Tirador orbital (Knob de rotación interactivo)
          ctx.beginPath();
          ctx.arc(knobX, knobY, 9, 0, Math.PI * 2);
          ctx.fillStyle = '#00e5ff';
          ctx.shadowColor = '#00e5ff';
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;

          ctx.beginPath();
          ctx.arc(knobX, knobY, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          // Pill indicador de ángulo
          ctx.font = "bold 9px 'Share Tech Mono', monospace";
          const angleLabel = `⟳ ROTAR ${node.holeAngle || 0}°`;
          const alw = ctx.measureText(angleLabel).width;
          ctx.fillStyle = 'rgba(10, 10, 16, 0.9)';
          ctx.fillRect(knobX - alw / 2 - 4, knobY + 12, alw + 8, 14);
          ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1;
          ctx.strokeRect(knobX - alw / 2 - 4, knobY + 12, alw + 8, 14);
          ctx.fillStyle = '#00e5ff';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(angleLabel, knobX, knobY + 19);
        }

        // Rótulo táctico superior
        const label = `⛰️ TÚNEL +${node.height}u [${node.holeAngle || 0}°]`;
        ctx.font = "bold 9px 'Share Tech Mono', monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
        ctx.fillRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 100, 200, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, sc.x, sc.y - rCanvas - 9);

      } else if (node.type === 'mountain') {
        // ── Montaña Sólida ──
        const grad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, rCanvas);
        grad.addColorStop(0, 'rgba(90, 20, 30, 0.9)');
        grad.addColorStop(0.6, 'rgba(45, 10, 18, 0.75)');
        grad.addColorStop(1, 'rgba(180, 0, 0, 0.45)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, rCanvas, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 60, 60, 0.75)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        if (isSelected) { ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 10; }
        ctx.stroke(); ctx.shadowBlur = 0;

        if (physR < rCanvas) {
          ctx.beginPath(); ctx.arc(sc.x, sc.y, physR, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.setLineDash([3, 3]);
          ctx.stroke(); ctx.setLineDash([]);
        }

        // Pico central
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.moveTo(sc.x, sc.y - 8);
        ctx.lineTo(sc.x + 7, sc.y + 6);
        ctx.lineTo(sc.x - 7, sc.y + 6);
        ctx.closePath();
        ctx.fill();

        // Rótulo superior
        const label = `🏔️ MONTAÑA +${node.height}u`;
        ctx.font = "bold 9px 'Share Tech Mono', monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
        ctx.fillRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 60, 60, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, sc.x, sc.y - rCanvas - 9);

      } else if (node.type === 'crater' || node.height < 0) {
        // ── Cráter / Depresión ──
        const grad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, rCanvas);
        grad.addColorStop(0, 'rgba(10, 0, 0, 0.95)');
        grad.addColorStop(0.7, 'rgba(60, 10, 10, 0.6)');
        grad.addColorStop(1, 'rgba(180, 50, 50, 0.35)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, rCanvas, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 50, 50, 0.7)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (physR < rCanvas) {
          ctx.beginPath(); ctx.arc(sc.x, sc.y, physR, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.setLineDash([3, 3]);
          ctx.stroke(); ctx.setLineDash([]);
        }

        const label = `🕳️ CRÁTER ${node.height}u`;
        ctx.font = "bold 9px 'Share Tech Mono', monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
        ctx.fillRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255, 50, 50, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.fillStyle = '#ff6666'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, sc.x, sc.y - rCanvas - 9);

      } else {
        // ── Colina Suave ──
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, rCanvas, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 120, 0.2)';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(0, 255, 120, 0.6)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();

        if (physR < rCanvas) {
          ctx.beginPath(); ctx.arc(sc.x, sc.y, physR, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.setLineDash([3, 3]);
          ctx.stroke(); ctx.setLineDash([]);
        }

        const label = `🟢 COLINA +${node.height}u`;
        ctx.font = "bold 9px 'Share Tech Mono', monospace";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
        ctx.fillRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(0, 255, 120, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sc.x - lw / 2 - 5, sc.y - rCanvas - 16, lw + 10, 14);
        ctx.fillStyle = '#4ade80'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, sc.x, sc.y - rCanvas - 9);
      }

      // Retícula central de arrastre cuando está seleccionado
      if (isSelected) {
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sc.x - 8, sc.y); ctx.lineTo(sc.x + 8, sc.y);
        ctx.moveTo(sc.x, sc.y - 8); ctx.lineTo(sc.x, sc.y + 8);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(sc.x, sc.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      ctx.restore();
    }
  }
  
  function getTrackWorldPoint(sampleIdx) {
    if (controlPoints.length < 2) return null;
    const spline = buildSpline(controlPoints, true, 20);
    const spIdx = Math.round((sampleIdx / 600) * (spline.length - 1));
    return spline[Math.min(spIdx, spline.length - 1)];
  }

  function drawGrid() {
    const gridSize = 50;
    ctx.save();
    ctx.strokeStyle = '#1a0000';
    ctx.lineWidth = 0.5;

    const tlw = canvasToWorld(0, 0);
    const brw = canvasToWorld(canvas.width, canvas.height);

    const startX = Math.floor(tlw.x / gridSize) * gridSize;
    const startZ = Math.floor(tlw.z / gridSize) * gridSize;

    for (let wx = startX; wx <= brw.x + gridSize; wx += gridSize) {
      const a = worldToCanvas(wx, tlw.z);
      const b = worldToCanvas(wx, brw.z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let wz = startZ; wz <= brw.z + gridSize; wz += gridSize) {
      const a = worldToCanvas(tlw.x, wz);
      const b = worldToCanvas(brw.x, wz);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Ejes
    ctx.strokeStyle = '#2a0000';
    ctx.lineWidth = 1;
    const ox = worldToCanvas(0, canvasToWorld(0, 0).z);
    const oy = worldToCanvas(canvasToWorld(0, 0).x, 0);
    ctx.beginPath(); ctx.moveTo(0, ox.y); ctx.lineTo(canvas.width, ox.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(oy.x, 0); ctx.lineTo(oy.x, canvas.height); ctx.stroke();
    ctx.restore();
  }

  function drawTrackFill(spline) {
    if (spline.length < 2) return;
    const wScale = 1.8; // Mismo WORLD_SCALE del motor
    const halfW = trackWidth * wScale * 0.5; // en unidades de mundo sin escala para el canvas
    // El canvas trabaja en coord del juego sin WORLD_SCALE (ya que controlPoints son raw)
    // así que usamos trackWidth directamente
    const hw = trackWidth;

    // Construir polígono offset izq/der
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < spline.length - 1; i++) {
      const p = spline[i];
      const pn = spline[i + 1];
      const dx = pn.x - p.x, dz = pn.z - p.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx = -dz / len, nz = dx / len; // normal perpendicular
      leftPts.push({ x: p.x + nx * hw, z: p.z + nz * hw });
      rightPts.push({ x: p.x - nx * hw, z: p.z - nz * hw });
    }

    // Pista (asfalto oscuro)
    ctx.beginPath();
    leftPts.forEach((p, i) => {
      const sc = worldToCanvas(p.x, p.z);
      i === 0 ? ctx.moveTo(sc.x, sc.y) : ctx.lineTo(sc.x, sc.y);
    });
    for (let i = rightPts.length - 1; i >= 0; i--) {
      const sc = worldToCanvas(rightPts[i].x, rightPts[i].z);
      ctx.lineTo(sc.x, sc.y);
    }
    ctx.closePath();
    ctx.fillStyle = '#120000cc';
    ctx.fill();

    // Bordes de pista — rojo táctico
    [leftPts, rightPts].forEach(side => {
      ctx.beginPath();
      side.forEach((p, i) => {
        const sc = worldToCanvas(p.x, p.z);
        i === 0 ? ctx.moveTo(sc.x, sc.y) : ctx.lineTo(sc.x, sc.y);
      });
      ctx.strokeStyle = 'rgba(163,0,0,0.7)';
      ctx.lineWidth = Math.max(0.8, 2 / zoom);
      ctx.stroke();
    });
  }

  function drawStartLine(spline) {
    const p0 = spline[0], p1 = spline[1] || spline[0];
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const hw = trackWidth;
    const a = worldToCanvas(p0.x + nx * hw, p0.z + nz * hw);
    const b = worldToCanvas(p0.x - nx * hw, p0.z - nz * hw);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, 3 / zoom);
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label "META"
    const sc = worldToCanvas(p0.x, p0.z);
    ctx.fillStyle = 'rgba(245,245,245,0.6)';
    ctx.font = `bold ${Math.max(8, 11 / zoom)}px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('META', sc.x, sc.y - 8 / zoom);
  }

  function drawPoints() {
    const r = pointRadius();
    controlPoints.forEach((p, i) => {
      const sc = worldToCanvas(p.x, p.z);
      const isSelected = i === selectedIdx;
      const isFirst = i === 0;

      // Círculo de selección adaptativo >= 150px
      if (isSelected) {
        const selR = Math.max(MIN_ELEMENT_RADIUS_PX, r + 12); // NUNCA menor a 75px de radio (150px diámetro)
        ctx.save();
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, selR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
        ctx.fill();

        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Retículas tácticas (marcas a 0, 90, 180, 270 grados)
        const tickLen = 8;
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Arriba
        ctx.moveTo(sc.x, sc.y - selR - tickLen); ctx.lineTo(sc.x, sc.y - selR + 2);
        // Abajo
        ctx.moveTo(sc.x, sc.y + selR - 2); ctx.lineTo(sc.x, sc.y + selR + tickLen);
        // Izquierda
        ctx.moveTo(sc.x - selR - tickLen, sc.y); ctx.lineTo(sc.x - selR + 2, sc.y);
        // Derecha
        ctx.moveTo(sc.x + selR - 2, sc.y); ctx.lineTo(sc.x + selR + tickLen, sc.y);
        ctx.stroke();

        // Badge HUD flotante con coordenadas y diámetro
        const label = `PUNTO #${i} [X: ${Math.round(p.x)}, Z: ${Math.round(p.z)}, Y: ${p.y || 0}u | Ø ≥150px]`;
        ctx.font = "bold 10px 'Share Tech Mono', monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.85)';
        ctx.fillRect(sc.x - tw / 2 - 6, sc.y - selR - 22, tw + 12, 16);
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sc.x - tw / 2 - 6, sc.y - selR - 22, tw + 12, 16);

        ctx.fillStyle = '#00ffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, sc.x, sc.y - selR - 14);

        ctx.restore();
      }

      // Círculo central
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFirst ? '#A30000' : isSelected ? '#ff4444' : '#2A0000';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#ff0000' : isFirst ? '#6B0000' : 'rgba(163,0,0,0.4)';
      ctx.lineWidth = Math.max(1, 1.5 / zoom);
      ctx.stroke();

      // Número y Elevación
      if (zoom > 0.4 || isSelected) {
        ctx.fillStyle = '#F5F5F5';
        ctx.font = `bold ${Math.max(6, 9 / zoom)}px 'Share Tech Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i, sc.x, sc.y);
        
        if (p.y) {
          ctx.font = `${Math.max(5, 7 / zoom)}px sans-serif`;
          ctx.fillStyle = p.y > 0 ? '#4ade80' : '#f87171';
          ctx.fillText(p.y > 0 ? `+${p.y}` : p.y, sc.x, sc.y - r - 4 / zoom);
        }
      }
    });
  }

  function drawPlacementGhost() {
    if (!mouseInCanvas) return;

    if (tool === 'terrain-add') {
      const type = (document.getElementById('terrain-type') && document.getElementById('terrain-type').value) || 'mountain_tunnel';
      const h = parseInt(document.getElementById('node-height') ? document.getElementById('node-height').value : 45) || (type === 'crater' ? -25 : 45);
      const r = parseInt(document.getElementById('node-radius') ? document.getElementById('node-radius').value : 50) || 50;
      const isTunnel = (type === 'mountain_tunnel');
      const tunnelWidth = isTunnel ? (parseInt(document.getElementById('tunnel-width') ? document.getElementById('tunnel-width').value : 22) || 22) : 0;
      let tunnelAngle = isTunnel ? (parseFloat(document.getElementById('tunnel-angle') ? document.getElementById('tunnel-angle').value : 0) || 0) : 0;

      const wPos = canvasToWorld(mouseScreenPos.x, mouseScreenPos.y);
      if (isTunnel && tunnelAngle === 0) {
        tunnelAngle = getClosestTrackTangentAngle(wPos.x, wPos.z);
      }

      const rScreen = getClampedScreenRadius(r); // Garantiza >= 75px (150px de diametro)
      const physR = r * zoom;

      ctx.save();
      ctx.translate(mouseScreenPos.x, mouseScreenPos.y);

      // Fondo holográfico
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rScreen);
      grad.addColorStop(0, isTunnel ? 'rgba(0, 229, 255, 0.22)' : 'rgba(255, 50, 90, 0.22)');
      grad.addColorStop(0.7, isTunnel ? 'rgba(0, 150, 200, 0.12)' : 'rgba(180, 30, 60, 0.12)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.04)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, rScreen, 0, Math.PI * 2);
      ctx.fill();

      // Borde neón pulsante (mínimo 150px de diámetro)
      ctx.strokeStyle = isTunnel ? '#00ffff' : '#ff3366';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Si el radio físico es menor que el clamp de 150px, dibujar círculo interno indicándolo
      if (physR < rScreen) {
        ctx.beginPath();
        ctx.arc(0, 0, physR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Retícula central
      ctx.strokeStyle = isTunnel ? 'rgba(0, 255, 255, 0.6)' : 'rgba(255, 80, 80, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-10, 0); ctx.lineTo(10, 0);
      ctx.moveTo(0, -10); ctx.lineTo(0, 10);
      ctx.stroke();

      if (isTunnel) {
        // Previsualización del corredor del túnel
        const angleRad = (tunnelAngle * Math.PI) / 180;
        const screenScale = rScreen / Math.max(1, r);
        const hwCanvas = Math.max(14, (tunnelWidth * screenScale) / 2);
        const hlCanvas = rScreen * 1.05;

        ctx.save();
        ctx.rotate(angleRad);

        // Caja de paso
        ctx.fillStyle = 'rgba(0, 20, 30, 0.8)';
        ctx.fillRect(-hlCanvas, -hwCanvas, hlCanvas * 2, hwCanvas * 2);

        // Paredes punteadas cyan
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-hlCanvas, -hwCanvas); ctx.lineTo(hlCanvas, -hwCanvas);
        ctx.moveTo(-hlCanvas, hwCanvas); ctx.lineTo(hlCanvas, hwCanvas);
        ctx.stroke();
        ctx.setLineDash([]);

        // Flecha de dirección
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-rScreen * 0.35, 0); ctx.lineTo(rScreen * 0.35, 0);
        ctx.lineTo(rScreen * 0.2, -hwCanvas * 0.4);
        ctx.moveTo(rScreen * 0.35, 0); ctx.lineTo(rScreen * 0.2, hwCanvas * 0.4);
        ctx.stroke();

        ctx.restore();
      }

      // Badge flotante
      const title = isTunnel
        ? `⛰️ COLOCAR TÚNEL [+${h}u | ${tunnelAngle}° | Ø ≥150px]`
        : `⛰️ COLOCAR MONTAÑA [+${h}u | R:${r}u | Ø ≥150px]`;
      ctx.font = "bold 10px 'Share Tech Mono', monospace";
      const bw = ctx.measureText(title).width;
      ctx.fillStyle = 'rgba(10, 10, 16, 0.9)';
      ctx.fillRect(-bw / 2 - 8, -rScreen - 26, bw + 16, 18);
      ctx.strokeStyle = isTunnel ? '#00ffff' : '#ff3366';
      ctx.lineWidth = 1;
      ctx.strokeRect(-bw / 2 - 8, -rScreen - 26, bw + 16, 18);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, 0, -rScreen - 17);

      ctx.restore();

      // Línea tangente / guía hacia el punto de pista más cercano
      if (controlPoints.length >= 2) {
        const spline = buildSpline(controlPoints, true, 25);
        let bestP = null, minDist = Infinity;
        for (const sp of spline) {
          const d = (sp.x - wPos.x)**2 + (sp.z - wPos.z)**2;
          if (d < minDist) { minDist = d; bestP = sp; }
        }
        if (bestP && minDist < (300)**2) {
          const scP = worldToCanvas(bestP.x, bestP.z);
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
          ctx.lineWidth = 1.2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(mouseScreenPos.x, mouseScreenPos.y);
          ctx.lineTo(scP.x, scP.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    } else if (tool === 'shortcut-add') {
      const hit = splineHitTest(mouseScreenPos.x, mouseScreenPos.y);
      if (!shortcutDraft) {
        if (hit) {
          // Anillo magnético de inicio de atajo en pista (>= 150px)
          const spPoint = getTrackWorldPoint(hit.sampleIdx);
          if (spPoint) {
            const sc = worldToCanvas(spPoint.x, spPoint.z);
            ctx.save();
            ctx.beginPath();
            ctx.arc(sc.x, sc.y, MIN_ELEMENT_RADIUS_PX, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 255, 128, 0.15)';
            ctx.fill();
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);

            const txt = "⚓ ANCLAR INICIO DE ATAJO (CLICK)";
            ctx.font = "bold 10px 'Share Tech Mono', monospace";
            const tw = ctx.measureText(txt).width;
            ctx.fillStyle = 'rgba(10, 16, 12, 0.9)';
            ctx.fillRect(sc.x - tw / 2 - 6, sc.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
            ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1;
            ctx.strokeRect(sc.x - tw / 2 - 6, sc.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
            ctx.fillStyle = '#00ff88'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(txt, sc.x, sc.y - MIN_ELEMENT_RADIUS_PX - 14);
            ctx.restore();
          }
        } else {
          // Guía bajo el cursor indicando acercarse a la pista
          ctx.save();
          ctx.beginPath();
          ctx.arc(mouseScreenPos.x, mouseScreenPos.y, MIN_ELEMENT_RADIUS_PX, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0, 150, 255, 0.4)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else {
        // En progreso de dibujo de atajo: línea elástica y círculo de colocación >= 150px
        const lastPt = shortcutDraft.controlPoints.length > 0
          ? shortcutDraft.controlPoints[shortcutDraft.controlPoints.length - 1]
          : null;
        let lastSc = null;
        if (lastPt) {
          lastSc = worldToCanvas(lastPt[0], lastPt[2]);
        } else {
          const spPoint = getTrackWorldPoint(shortcutDraft.startSampleIdx);
          if (spPoint) lastSc = worldToCanvas(spPoint.x, spPoint.z);
        }

        if (lastSc) {
          ctx.save();
          ctx.strokeStyle = '#ffbb00';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(lastSc.x, lastSc.y);
          ctx.lineTo(mouseScreenPos.x, mouseScreenPos.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }

        // Anillo de colocación en cursor (>= 150px)
        ctx.save();
        ctx.beginPath();
        ctx.arc(mouseScreenPos.x, mouseScreenPos.y, MIN_ELEMENT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fillStyle = hit ? 'rgba(0, 255, 128, 0.2)' : 'rgba(255, 187, 0, 0.15)';
        ctx.fill();
        ctx.strokeStyle = hit ? '#00ff88' : '#ffbb00';
        ctx.lineWidth = 2;
        ctx.stroke();

        const txt = hit ? "CLICK: CERRAR ATAJO EN PISTA" : "CLICK: AGREGAR CURVA DE ATAJO";
        ctx.font = "bold 10px 'Share Tech Mono', monospace";
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(10, 10, 16, 0.9)';
        ctx.fillRect(mouseScreenPos.x - tw / 2 - 6, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
        ctx.strokeStyle = hit ? '#00ff88' : '#ffbb00'; ctx.lineWidth = 1;
        ctx.strokeRect(mouseScreenPos.x - tw / 2 - 6, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
        ctx.fillStyle = hit ? '#00ff88' : '#ffbb00'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, mouseScreenPos.x, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 14);
        ctx.restore();
      }
    } else if (tool === 'add') {
      // Indicador de inserción de nuevo punto de pista (>= 150px)
      ctx.save();
      ctx.beginPath();
      ctx.arc(mouseScreenPos.x, mouseScreenPos.y, MIN_ELEMENT_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 68, 68, 0.1)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 68, 68, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      const wPos = canvasToWorld(mouseScreenPos.x, mouseScreenPos.y);
      if (controlPoints.length >= 2) {
        const seg = closestSegmentIdx(wPos);
        const pA = controlPoints[seg];
        const pB = controlPoints[(seg + 1) % controlPoints.length];
        const scA = worldToCanvas(pA.x, pA.z);
        const scB = worldToCanvas(pB.x, pB.z);

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(scA.x, scA.y);
        ctx.lineTo(mouseScreenPos.x, mouseScreenPos.y);
        ctx.lineTo(scB.x, scB.y);
        ctx.stroke();
      }

      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.arc(mouseScreenPos.x, mouseScreenPos.y, 6, 0, Math.PI * 2);
      ctx.fill();

      const txt = "+ INSERTAR PUNTO DE CONTROL (Ø ≥150px)";
      ctx.font = "bold 10px 'Share Tech Mono', monospace";
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(10, 10, 16, 0.9)';
      ctx.fillRect(mouseScreenPos.x - tw / 2 - 6, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
      ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 1;
      ctx.strokeRect(mouseScreenPos.x - tw / 2 - 6, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 22, tw + 12, 16);
      ctx.fillStyle = '#ff4444'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, mouseScreenPos.x, mouseScreenPos.y - MIN_ELEMENT_RADIUS_PX - 14);

      ctx.restore();
    }
  }

  function drawObstacles(spline) {
    if (!spline || spline.length < 2) return;
    const TRACK_SAMPLES = 600;
    editorObstacles.forEach((obs, i) => {
      const spIdx = Math.round((obs.sampleIdx / TRACK_SAMPLES) * (spline.length - 1));
      const sp = spline[Math.min(spIdx, spline.length - 1)];
      const spNext = spline[Math.min(spIdx + 1, spline.length - 1)];
      const dx = spNext.x - sp.x, dz = spNext.z - sp.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const wx = sp.x + nx * obs.lane * trackWidth;
      const wz = sp.z + nz * obs.lane * trackWidth;
      const sc = worldToCanvas(wx, wz);
      const r = Math.max(6, 9 / zoom);
      const isSelected = i === selectedObsIdx;
      const colors = ['#ff0055', '#00e5ff', '#9900ff'];
      const c = colors[((obs.type || 0) % 3 + 3) % 3];
      ctx.beginPath(); ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c + (isSelected ? 'ff' : '99');
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : c;
      ctx.lineWidth = isSelected ? 2 / zoom : 1 / zoom;
      ctx.stroke();
      // Ícono ✕
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(7, 10 / zoom)}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✕', sc.x, sc.y);
    });
  }

  function drawRamps(spline) {
    if (!spline || spline.length < 2) return;
    const TRACK_SAMPLES = 600;
    editorRamps.forEach((ramp, i) => {
      const spIdx = Math.round((ramp.sampleIdx / TRACK_SAMPLES) * (spline.length - 1));
      const sp = spline[Math.min(spIdx, spline.length - 1)];
      const spNext = spline[Math.min(spIdx + 1, spline.length - 1)];
      const dx = spNext.x - sp.x, dz = spNext.z - sp.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const wx = sp.x + nx * ramp.lane * trackWidth;
      const wz = sp.z + nz * ramp.lane * trackWidth;
      const sc = worldToCanvas(wx, wz);
      const r = Math.max(6, 9 / zoom);
      const isSelected = i === selectedRampIdx;
      const c = ramp.type === 'cyan' ? '#00e5ff' : '#ffaa00';
      // Triángulo (rampa)
      ctx.beginPath();
      ctx.moveTo(sc.x, sc.y - r);
      ctx.lineTo(sc.x + r * 0.86, sc.y + r * 0.5);
      ctx.lineTo(sc.x - r * 0.86, sc.y + r * 0.5);
      ctx.closePath();
      ctx.fillStyle = c + (isSelected ? 'ff' : '99');
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : c;
      ctx.lineWidth = isSelected ? 2 / zoom : 1 / zoom;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(6, 8 / zoom)}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('▲', sc.x, sc.y + 1);
    });
  }

  function drawPowerups(spline) {
    if (!spline || spline.length < 2) return;
    const TRACK_SAMPLES = 600;
    editorPowerups.forEach((pu, i) => {
      const spIdx = Math.round((pu.sampleIdx / TRACK_SAMPLES) * (spline.length - 1));
      const sp = spline[Math.min(spIdx, spline.length - 1)];
      const spNext = spline[Math.min(spIdx + 1, spline.length - 1)];
      const dx = spNext.x - sp.x, dz = spNext.z - sp.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const wx = sp.x + nx * pu.lane * trackWidth;
      const wz = sp.z + nz * pu.lane * trackWidth;
      const sc = worldToCanvas(wx, wz);
      const r = Math.max(6, 9 / zoom);
      const isSelected = i === selectedPowerupIdx;
      let c = '#00ff66'; // verde por defecto (missile)
      if (pu.type === 'homing') c = '#ff2244';
      else if (pu.type === 'boost') c = '#ffcc00';

      ctx.beginPath();
      ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c + (isSelected ? 'ff' : '88');
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : c;
      ctx.lineWidth = isSelected ? 2 / zoom : 1 / zoom;
      ctx.stroke();

      // Círculo interior para darle pinta de orbe
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    });
  }

  function drawNoPointsHint() {
    ctx.fillStyle = 'rgba(163,0,0,0.25)';
    ctx.font = "bold 14px 'Share Tech Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('// SELECCIONÁ "AÑADIR PUNTO" Y HACÉ CLICK EN EL CANVAS', canvas.width / 2, canvas.height / 2 - 14);
    ctx.font = "11px 'Share Tech Mono', monospace";
    ctx.fillStyle = 'rgba(163,0,0,0.12)';
    ctx.fillText('// o pulsá "Cargar desde servidor" para recuperar el último nivel guardado', canvas.width / 2, canvas.height / 2 + 12);
  }

  function sync3DIfNeeded() {
    if (editor3D && (viewMode === '3d' || viewMode === 'split')) {
      editor3D.syncFrom2D();
    }
  }

  // ────────────────────────────────────────────────────
  //  Canvas resize
  // ────────────────────────────────────────────────────
  function resizeCanvas() {
    const area = document.getElementById('canvas-area');
    if (!area) return;
    const isSplit = area.classList.contains('split-view');
    canvas.width = isSplit ? area.clientWidth / 2 : area.clientWidth;
    canvas.height = area.clientHeight;
    if (editor3D) editor3D.resize();
  }

  // ────────────────────────────────────────────────────
  //  Motor 3D de Previsualización (Three.js)
  // ────────────────────────────────────────────────────
  function initEditor3D() {
    if (editor3D) return;
    const container = document.getElementById('viewport-3d');
    const threeCanvas = document.getElementById('three-canvas');
    if (!window.THREE || !container || !threeCanvas) return;
    editor3D = new Editor3DEngine(threeCanvas, container);
  }

  class Editor3DEngine {
    constructor(canvasEl, containerEl) {
      this.canvas = canvasEl;
      this.container = containerEl;
      this.worldScale = 1.8;

      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false
      });
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x06060c);
      this.scene.fog = new THREE.FogExp2(0x06060c, 0.001);

      this.camera = new THREE.PerspectiveCamera(
        55,
        (this.container.clientWidth || 800) / (this.container.clientHeight || 600),
        1,
        2500
      );
      this.camera.position.set(0, 320, 380);

      if (window.THREE.OrbitControls) {
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
        this.controls.minDistance = 20;
        this.controls.maxDistance = 1400;
        this.controls.target.set(0, 0, 0);
      }

      this.setupLights();

      this.trackGroup = new THREE.Group();
      this.objectsGroup = new THREE.Group();
      this.terrainGroup = new THREE.Group();
      this.mountainsGroup = new THREE.Group();

      this.scene.add(this.terrainGroup);
      this.scene.add(this.trackGroup);
      this.scene.add(this.mountainsGroup);
      this.scene.add(this.objectsGroup);

      this.isAnimating = false;
      this.startAnimation();

      window.addEventListener('resize', () => this.resize());
    }

    setupLights() {
      const hemiLight = new THREE.HemisphereLight(0xffffff, 0x110508, 0.55);
      hemiLight.position.set(0, 200, 0);
      this.scene.add(hemiLight);

      const dirLight = new THREE.DirectionalLight(0xffe8e8, 0.9);
      dirLight.position.set(200, 350, 150);
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.width = 1024;
      dirLight.shadow.mapSize.height = 1024;
      const d = 400;
      dirLight.shadow.camera.left = -d; dirLight.shadow.camera.right = d;
      dirLight.shadow.camera.top = d; dirLight.shadow.camera.bottom = -d;
      this.scene.add(dirLight);

      const redAmbient = new THREE.AmbientLight(0xa30000, 0.25);
      this.scene.add(redAmbient);
    }

    resetCamera() {
      this.camera.position.set(0, 320, 380);
      if (this.controls) {
        this.controls.target.set(0, 0, 0);
        this.controls.update();
      }
    }

    topCamera() {
      this.camera.position.set(0, 650, 1);
      if (this.controls) {
        this.controls.target.set(0, 0, 0);
        this.controls.update();
      }
    }

    trackCamera() {
      if (controlPoints.length > 0) {
        const p0 = controlPoints[0];
        const p1 = controlPoints[1] || controlPoints[0];
        const cx = p0.x * this.worldScale;
        const cy = (p0.y || 0) * this.worldScale + 4;
        const cz = p0.z * this.worldScale;
        const tx = p1.x * this.worldScale;
        const tz = p1.z * this.worldScale;
        this.camera.position.set(cx, cy + 6, cz);
        if (this.controls) {
          this.controls.target.set(tx, cy + 2, tz);
          this.controls.update();
        }
      }
    }

    resize() {
      if (!this.container || !this.renderer) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w === 0 || h === 0) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }

    startAnimation() {
      if (this.isAnimating) return;
      this.isAnimating = true;
      const animate = () => {
        if (!this.isAnimating) return;
        requestAnimationFrame(animate);
        if (this.controls) this.controls.update();
        this.renderer.render(this.scene, this.camera);
      };
      animate();
    }

    clearGroup(group) {
      while (group.children.length > 0) {
        const obj = group.children[0];
        group.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      }
    }

    syncFrom2D() {
      this.buildTerrain();
      this.buildTrack();
      this.buildObjects();
      this.buildMountains();
    }

    buildTerrain() {
      this.clearGroup(this.terrainGroup);

      const groundGeo = new THREE.PlaneGeometry(1200, 1200, 100, 100);
      const pos = groundGeo.attributes.position;
      const count = pos.count;

      for (let i = 0; i < count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const wx = vx;
        const wz = -vy;

        let zh = 0;
        for (const node of editorTerrainNodes) {
          if (node.type === 'hill' || node.type === 'crater') {
            const dx = wx - (node.x * this.worldScale);
            const dz = wz - (node.z * this.worldScale);
            const distSq = dx * dx + dz * dz;
            const r = (node.radius || 40) * this.worldScale;
            if (distSq < r * r) {
              const t = 1 - Math.sqrt(distSq) / r;
              const smoothT = t * t * (3 - 2 * t);
              zh += (node.height || 10) * this.worldScale * smoothT;
            }
          }
        }
        pos.setZ(i, zh);
      }
      pos.needsUpdate = true;
      groundGeo.computeVertexNormals();

      const groundMat = new THREE.MeshStandardMaterial({
        color: 0x0c0b15, roughness: 0.92, metalness: 0.1
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.terrainGroup.add(ground);

      const grid = new THREE.GridHelper(1200, 60, 0xa30000, 0x1c050a);
      grid.position.y = 0.02;
      this.terrainGroup.add(grid);
    }

    buildTrack() {
      this.clearGroup(this.trackGroup);
      if (controlPoints.length < 3) return;

      const pts = controlPoints.map(p => new THREE.Vector3(
        p.x * this.worldScale,
        (p.y || 0) * this.worldScale,
        p.z * this.worldScale
      ));
      const curve = new THREE.CatmullRomCurve3(pts, true);
      const samplesCount = 600;
      const samples = [];
      const halfW = (trackWidth || 14) * (this.worldScale / 2);

      for (let i = 0; i <= samplesCount; i++) {
        const t = i / samplesCount;
        const p = curve.getPointAt(t);
        const tan = curve.getTangentAt(t).normalize();
        const normal = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
        samples.push({ x: p.x, y: p.y, z: p.z, tan, normal, t });
      }

      // Asfalto
      const roadGeo = new THREE.BufferGeometry();
      const pos = [], uvs = [], indices = [];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        pos.push(s.x + s.normal.x * halfW, s.y + 0.05, s.z + s.normal.z * halfW);
        pos.push(s.x - s.normal.x * halfW, s.y + 0.05, s.z - s.normal.z * halfW);
        uvs.push(0, s.t * 20); uvs.push(1, s.t * 20);
        if (i < samples.length - 1) {
          const v1 = i * 2, v2 = i * 2 + 1, v3 = (i + 1) * 2, v4 = (i + 1) * 2 + 1;
          indices.push(v1, v3, v2); indices.push(v2, v3, v4);
        }
      }
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      roadGeo.setIndex(indices);
      roadGeo.computeVertexNormals();

      const roadMat = new THREE.MeshStandardMaterial({
        color: 0x181824, roughness: 0.75, metalness: 0.25, side: THREE.DoubleSide
      });
      const roadMesh = new THREE.Mesh(roadGeo, roadMat);
      roadMesh.receiveShadow = true;
      this.trackGroup.add(roadMesh);

      // Línea central roja
      const lineGeo = new THREE.TubeGeometry(curve, 300, 0.25, 4, true);
      const lineMat = new THREE.MeshStandardMaterial({
        color: 0xa30000, emissive: 0xa30000, emissiveIntensity: 1.4
      });
      const centerLine = new THREE.Mesh(lineGeo, lineMat);
      centerLine.position.y = 0.08;
      this.trackGroup.add(centerLine);

      // Bordillos laterales neón
      const curbMat = new THREE.MeshStandardMaterial({
        color: 0x222222, emissive: 0xa30000, emissiveIntensity: 0.35, roughness: 0.5
      });
      const makeCurv = (dist) => {
        const cPts = samples.map(s => new THREE.Vector3(s.x + s.normal.x * dist, s.y + 0.5, s.z + s.normal.z * dist));
        const c = new THREE.CatmullRomCurve3(cPts, true);
        const tg = new THREE.TubeGeometry(c, 300, 0.45, 6, true);
        return new THREE.Mesh(tg, curbMat);
      };
      this.trackGroup.add(makeCurv(halfW + 1.2));
      this.trackGroup.add(makeCurv(-(halfW + 1.2)));

      // Meta
      const s0 = samples[0];
      const startGeo = new THREE.BoxGeometry(1.5, 0.1, halfW * 2);
      const startMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const startMesh = new THREE.Mesh(startGeo, startMat);
      startMesh.position.set(s0.x, s0.y + 0.1, s0.z);
      startMesh.rotation.y = -Math.atan2(s0.tan.z, s0.tan.x);
      this.trackGroup.add(startMesh);

      // Atajos en 3D (pistas secundarias con bordillos y líneas)
      const scRoadMat = new THREE.MeshStandardMaterial({
        color: 0x221828, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide
      });
      const scLineMat = new THREE.MeshStandardMaterial({
        color: 0xffaa00, emissive: 0xff8800, emissiveIntensity: 1.2
      });
      const scCurbMat = new THREE.MeshStandardMaterial({
        color: 0x332211, emissive: 0xff8800, emissiveIntensity: 0.35, roughness: 0.5
      });

      for (const sc of editorShortcuts) {
        const scGeom = getShortcutGeometry(sc);
        if (!scGeom || scGeom.pts.length < 2) continue;

        const sc3DPts = scGeom.pts.map(p => new THREE.Vector3(
          p.x * this.worldScale,
          0.06,
          p.z * this.worldScale
        ));
        const scCurve = new THREE.CatmullRomCurve3(sc3DPts, false);
        const scSamplesCount = Math.max(30, scGeom.pts.length * 15);
        const scSamples = [];
        const scHalfW = ((sc.width || trackWidth || 14) * 0.75) * (this.worldScale / 2);

        for (let i = 0; i <= scSamplesCount; i++) {
          const t = i / scSamplesCount;
          const p = scCurve.getPointAt(t);
          const tan = scCurve.getTangentAt(t).normalize();
          const normal = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
          scSamples.push({ x: p.x, y: p.y, z: p.z, tan, normal, t });
        }

        const scRoadGeo = new THREE.BufferGeometry();
        const scPos = [], scUvs = [], scIndices = [];
        for (let i = 0; i < scSamples.length; i++) {
          const s = scSamples[i];
          scPos.push(s.x + s.normal.x * scHalfW, s.y, s.z + s.normal.z * scHalfW);
          scPos.push(s.x - s.normal.x * scHalfW, s.y, s.z - s.normal.z * scHalfW);
          scUvs.push(0, s.t * 10); scUvs.push(1, s.t * 10);
          if (i < scSamples.length - 1) {
            const v1 = i * 2, v2 = i * 2 + 1, v3 = (i + 1) * 2, v4 = (i + 1) * 2 + 1;
            scIndices.push(v1, v3, v2); scIndices.push(v2, v3, v4);
          }
        }
        scRoadGeo.setAttribute('position', new THREE.Float32BufferAttribute(scPos, 3));
        scRoadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(scUvs, 2));
        scRoadGeo.setIndex(scIndices);
        scRoadGeo.computeVertexNormals();

        const scRoadMesh = new THREE.Mesh(scRoadGeo, scRoadMat);
        scRoadMesh.receiveShadow = true;
        this.trackGroup.add(scRoadMesh);

        // Línea central dorada
        const scLineGeo = new THREE.TubeGeometry(scCurve, scSamplesCount, 0.18, 4, false);
        const scCenterLine = new THREE.Mesh(scLineGeo, scLineMat);
        scCenterLine.position.y = 0.09;
        this.trackGroup.add(scCenterLine);

        // Bordillos neón naranja/dorado
        const makeScCurb = (dist) => {
          const cPts = scSamples.map(s => new THREE.Vector3(s.x + s.normal.x * dist, s.y + 0.35, s.z + s.normal.z * dist));
          const c = new THREE.CatmullRomCurve3(cPts, false);
          const tg = new THREE.TubeGeometry(c, scSamplesCount, 0.35, 6, false);
          return new THREE.Mesh(tg, scCurbMat);
        };
        this.trackGroup.add(makeScCurb(scHalfW + 0.8));
        this.trackGroup.add(makeScCurb(-(scHalfW + 0.8)));
      }

      this.samples = samples;
      this.halfW = halfW;
    }

    buildObjects() {
      this.clearGroup(this.objectsGroup);
      if (!this.samples || this.samples.length < 2) return;

      const samples = this.samples;
      const TRACK_SAMPLES = 600;

      // Obstáculos
      const obsMat = new THREE.MeshStandardMaterial({ color: 0xdd3333, metalness: 0.5, roughness: 0.4 });
      for (const obs of editorObstacles) {
        const s = samples[Math.min(obs.sampleIdx, samples.length - 1)];
        if (!s) continue;
        const wx = s.x + s.normal.x * obs.lane * this.halfW;
        const wz = s.z + s.normal.z * obs.lane * this.halfW;
        const geo = new THREE.CylinderGeometry(1.8, 1.8, 3.2, 12);
        const m = new THREE.Mesh(geo, obsMat);
        m.position.set(wx, s.y + 1.6, wz);
        m.castShadow = true;
        this.objectsGroup.add(m);
      }

      // Rampas
      const rampMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff6600, emissiveIntensity: 0.4 });
      for (const r of editorRamps) {
        const s = samples[Math.min(r.sampleIdx, samples.length - 1)];
        if (!s) continue;
        const wx = s.x + s.normal.x * r.lane * this.halfW;
        const wz = s.z + s.normal.z * r.lane * this.halfW;
        const geo = new THREE.BoxGeometry(3.5, 1.2, 5.0);
        const m = new THREE.Mesh(geo, rampMat);
        m.position.set(wx, s.y + 0.6, wz);
        m.rotation.y = -Math.atan2(s.tan.z, s.tan.x);
        m.castShadow = true;
        this.objectsGroup.add(m);
      }

      // Power-ups
      for (const pu of editorPowerups) {
        const s = samples[Math.min(pu.sampleIdx, samples.length - 1)];
        if (!s) continue;
        const wx = s.x + s.normal.x * pu.lane * this.halfW;
        const wz = s.z + s.normal.z * pu.lane * this.halfW;
        const col = pu.type === 'homing' ? 0xff2244 : (pu.type === 'boost' ? 0xffcc00 : 0x00ff66);
        const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.9 });
        const geo = new THREE.SphereGeometry(1.6, 16, 16);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(wx, s.y + 2.5, wz);
        this.objectsGroup.add(m);
      }

      // Barreras
      const barrierMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.5 });
      for (const b of editorBarriers) {
        const p1 = new THREE.Vector3(b.start.x * this.worldScale, 1.5, b.start.z * this.worldScale);
        const p2 = new THREE.Vector3(b.end.x * this.worldScale, 1.5, b.end.z * this.worldScale);
        const c = new THREE.LineCurve3(p1, p2);
        const geo = new THREE.TubeGeometry(c, 16, 0.6, 6, false);
        const m = new THREE.Mesh(geo, barrierMat);
        this.objectsGroup.add(m);
      }
    }

    buildMountains() {
      this.clearGroup(this.mountainsGroup);
      for (const node of editorTerrainNodes) {
        if (node.type === 'mountain' || node.type === 'mountain_tunnel' || node.hasHole) {
          const m = createEditorMountainMesh(node, this.worldScale);
          this.mountainsGroup.add(m);
        }
      }
    }
  }

  function createEditorMountainMesh(node, worldScale = 1.8) {
    const group = new THREE.Group();
    const radius = (node.radius || 50) * worldScale;
    const height = Math.max(16, (node.height || 45) * worldScale);
    const holeWidth = Math.max(12, (node.holeWidth || 22) * worldScale);
    const holeHeight = Math.min(height * 0.75, Math.max(8, (node.holeHeight || 16) * worldScale));
    const angleRad = ((node.holeAngle || 0) * Math.PI) / 180;

    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x18101a, roughness: 0.95, metalness: 0.15, flatShading: true
    });
    const neonPortalMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.85, roughness: 0.2
    });

    if (node.hasHole || node.type === 'mountain_tunnel') {
      const flankOffset = (holeWidth / 2) + (radius * 0.32);
      const flankGeo = new THREE.ConeGeometry(radius * 0.55, height, 6);

      const leftFlank = new THREE.Mesh(flankGeo, rockMat);
      leftFlank.position.set(-Math.sin(angleRad + Math.PI/2) * flankOffset, height / 2, Math.cos(angleRad + Math.PI/2) * flankOffset);
      leftFlank.castShadow = true;
      leftFlank.receiveShadow = true;
      group.add(leftFlank);

      const rightFlank = new THREE.Mesh(flankGeo, rockMat);
      rightFlank.position.set(Math.sin(angleRad + Math.PI/2) * flankOffset, height / 2, -Math.cos(angleRad + Math.PI/2) * flankOffset);
      rightFlank.castShadow = true;
      rightFlank.receiveShadow = true;
      group.add(rightFlank);

      const archThickness = Math.max(6, height - holeHeight);
      const archGeo = new THREE.BoxGeometry(holeWidth * 1.5, archThickness, radius * 1.5);
      const archMesh = new THREE.Mesh(archGeo, rockMat);
      archMesh.position.set(0, holeHeight + archThickness / 2, 0);
      archMesh.rotation.y = -angleRad;
      archMesh.castShadow = true;
      archMesh.receiveShadow = true;
      group.add(archMesh);

      const tunnelGeo = new THREE.CylinderGeometry(holeWidth * 0.52, holeWidth * 0.52, radius * 1.8, 12, 1, true);
      const tunnelMat = new THREE.MeshStandardMaterial({
        color: 0x0f0b12, roughness: 0.95, side: THREE.BackSide
      });
      const tunnelMesh = new THREE.Mesh(tunnelGeo, tunnelMat);
      tunnelMesh.position.set(0, holeHeight * 0.55, 0);
      tunnelMesh.rotation.x = Math.PI / 2;
      tunnelMesh.rotation.z = -angleRad;
      group.add(tunnelMesh);

      const portalGeo = new THREE.TorusGeometry(holeWidth * 0.54, 0.45, 8, 16, Math.PI);
      const forwardX = Math.cos(angleRad) * (radius * 0.85);
      const forwardZ = Math.sin(angleRad) * (radius * 0.85);

      const entrancePortal = new THREE.Mesh(portalGeo, neonPortalMat);
      entrancePortal.position.set(forwardX, holeHeight * 0.5, forwardZ);
      entrancePortal.rotation.y = -angleRad + Math.PI / 2;
      group.add(entrancePortal);

      const exitPortal = new THREE.Mesh(portalGeo, neonPortalMat);
      exitPortal.position.set(-forwardX, holeHeight * 0.5, -forwardZ);
      exitPortal.rotation.y = -angleRad - Math.PI / 2;
      group.add(exitPortal);

    } else {
      const coneGeo = new THREE.ConeGeometry(radius, height, 7);
      const cone = new THREE.Mesh(coneGeo, rockMat);
      cone.position.set(0, height / 2, 0);
      cone.rotation.y = Math.random() * Math.PI;
      cone.castShadow = true;
      cone.receiveShadow = true;
      group.add(cone);
    }

    group.position.set((node.x || 0) * worldScale, 0, (node.z || 0) * worldScale);
    return group;
  }

})();
