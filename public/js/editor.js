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
  let trackWidth = 14;
  let levelName = 'Circuito Variado Grande';

  // Estado del editor
  let tool = 'move';         // 'add' | 'move' | 'delete' | 'obs-add' | 'obs-move' | 'obs-delete' | 'ramp-add' | 'ramp-move' | 'ramp-delete' | 'pu-add' | 'pu-move' | 'pu-delete'
  let selectedIdx = -1;      // índice en controlPoints
  let selectedObsIdx = -1;   // índice en editorObstacles
  let selectedRampIdx = -1;  // índice en editorRamps
  let selectedPowerupIdx = -1; // índice en editorPowerups
  let dragging = false;
  let dragIdx = -1;
  let dragType = null; // 'point' | 'obs' | 'ramp' | 'pu'

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
  const loginScreen    = document.getElementById('login-screen');
  const loginTokenInput = document.getElementById('login-token');
  const loginBtn       = document.getElementById('login-btn');
  const loginError     = document.getElementById('login-error');
  const editorScreen   = document.getElementById('editor-screen');

  async function doLogin() {
    const token = loginTokenInput.value.trim();
    if (!token) { loginError.textContent = 'Escribe el token.'; return; }

    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fa fa-circle-notch fa-spin"></i> Verificando...';

    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await r.json();
      if (data.ok) {
        adminToken = token;
        loginScreen.classList.add('hidden');
        editorScreen.classList.remove('hidden');
        initEditor();
      } else {
        showLoginError(data.error || 'Token incorrecto.');
      }
    } catch (e) {
      showLoginError('Error de conexión con el servidor.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = '<i class="fa fa-right-to-bracket"></i> INGRESAR';
    }
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }

  loginBtn.addEventListener('click', doLogin);
  loginTokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // ────────────────────────────────────────────────────
  //  Inicialización del editor
  // ────────────────────────────────────────────────────
  async function initEditor() {
    resizeCanvas();
    resetViewport();
    await loadFromServer();
    pushHistory(); // estado inicial en la pila
    bindUI();
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

  async function saveToServer() {
    if (controlPoints.length < 3) {
      setStatus('err', 'Necesitas al menos 3 puntos de control.');
      return;
    }
    setStatus('info', 'Guardando nivel...');
    const payload = {
      name: levelName,
      trackWidth,
      controlPoints: controlPoints.map(p => [p.x, p.z]),
      obstacles: editorObstacles.map(o => ({ sampleIdx: o.sampleIdx, lane: o.lane, type: o.type })),
      ramps:     editorRamps.map(r => ({ sampleIdx: r.sampleIdx, lane: r.lane, type: r.type })),
      powerups:  editorPowerups.map(p => ({ sampleIdx: p.sampleIdx, lane: p.lane, type: p.type }))
    };
    try {
      const r = await fetch('/api/level', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken
        },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setStatus('ok', `Guardado. ${data.message}`);
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
    controlPoints = (data.controlPoints || []).map(p =>
      Array.isArray(p) ? { x: p[0], z: p[1] } : p
    );
    if (data.obstacles || data.ramps || data.powerups) {
      editorObstacles = (data.obstacles || []).map(o => ({ ...o }));
      editorRamps     = (data.ramps     || []).map(r => ({ ...r }));
      editorPowerups  = (data.powerups  || []).map(p => ({ ...p }));
    } else {
      generateDefaultObjects();
    }
    document.getElementById('level-name').value = levelName;
    document.getElementById('track-width').value = trackWidth;
    document.getElementById('track-width-val').textContent = trackWidth;
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
      pups: editorPowerups.map(p => ({ ...p }))
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
    selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
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
    canvas.addEventListener('mouseleave', onMouseUp);
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
          if (selectedObsIdx >= 0)    { editorObstacles.splice(selectedObsIdx, 1); selectedObsIdx = -1; updateObstacleCount(); render(); pushHistory(); return; }
          if (selectedRampIdx >= 0)   { editorRamps.splice(selectedRampIdx, 1);    selectedRampIdx = -1; updateRampCount();    render(); pushHistory(); return; }
          if (selectedPowerupIdx >= 0) { editorPowerups.splice(selectedPowerupIdx,1); selectedPowerupIdx = -1; updatePowerupCount(); render(); pushHistory(); return; }
          if (selectedIdx >= 0)       { removePoint(selectedIdx); pushHistory(); }
        }
        if (e.key === 'Escape') { selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1; hidePointInfo(); render(); }
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
    if (['add','obs-add','ramp-add','pu-add'].includes(t)) canvas.style.cursor = 'crosshair';
    else if (['delete','obs-delete','ramp-delete','pu-delete'].includes(t)) canvas.style.cursor = 'not-allowed';
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
      'pu-delete': 'Click en orbe para eliminarlo'
    };
    setStatus('info', `Herramienta: ${labels[t] || t}`);
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

  function hitTest(mx, my) {
    const r = pointRadius() + 4;
    for (let i = controlPoints.length - 1; i >= 0; i--) {
      const sc = worldToCanvas(controlPoints[i].x, controlPoints[i].z);
      const dx = mx - sc.x, dy = my - sc.y;
      if (dx * dx + dy * dy <= r * r) return i;
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

    // move (default)
    // Prioridad: powerups > obstáculos/rampas > puntos de control
    if (spline) {
      const puIdx = overlayHitTest(mx, my, editorPowerups, spline);
      if (puIdx >= 0) {
        selectedPowerupIdx = puIdx; selectedObsIdx = -1; selectedRampIdx = -1; selectedIdx = -1;
        dragging = true; dragIdx = puIdx; dragType = 'pu';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
      const obsIdx = overlayHitTest(mx, my, editorObstacles, spline);
      if (obsIdx >= 0) {
        selectedObsIdx = obsIdx; selectedRampIdx = -1; selectedPowerupIdx = -1; selectedIdx = -1;
        dragging = true; dragIdx = obsIdx; dragType = 'obs';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
      const rampIdx = overlayHitTest(mx, my, editorRamps, spline);
      if (rampIdx >= 0) {
        selectedRampIdx = rampIdx; selectedObsIdx = -1; selectedPowerupIdx = -1; selectedIdx = -1;
        dragging = true; dragIdx = rampIdx; dragType = 'ramp';
        canvas.style.cursor = 'grabbing'; hidePointInfo(); render(); return;
      }
    }

    const idx = hitTest(mx, my);
    if (idx >= 0) {
      dragging = true; dragIdx = idx; selectedIdx = idx; dragType = 'point';
      selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
      canvas.style.cursor = 'grabbing';
      showPointInfo(idx); render();
    } else {
      selectedIdx = -1; selectedObsIdx = -1; selectedRampIdx = -1; selectedPowerupIdx = -1;
      hidePointInfo();
      isPanning = true;
      panStart = { mx, my, px: panX, py: panY };
      canvas.style.cursor = 'grabbing'; render();
    }
  }

  function onMouseMove(e) {
    const mx = e.offsetX, my = e.offsetY;
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
    }
  }

  function onMouseUp(e) {
    if (isPanning) {
      isPanning = false;
      const curs = ['add','obs-add','ramp-add','pu-add'].includes(tool) ? 'crosshair'
                 : ['delete','obs-delete','ramp-delete','pu-delete'].includes(tool) ? 'not-allowed' : 'grab';
      canvas.style.cursor = curs;
    }
    if (dragging) { 
      dragging = false; dragIdx = -1; dragType = null; canvas.style.cursor = 'grab'; 
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
    drawGrid();
    if (controlPoints.length < 2) { drawNoPointsHint(); return; }
    const spline = buildSpline(controlPoints, true, 20);
    drawTrackFill(spline);
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
    drawPoints();
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

      // Halo
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, r + 5 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = '#6e00cc33';
        ctx.fill();
      }

      // Círculo
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFirst ? '#A30000' : isSelected ? '#ff4444' : '#2A0000';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#ff0000' : isFirst ? '#6B0000' : 'rgba(163,0,0,0.4)';
      ctx.lineWidth = Math.max(1, 1.5 / zoom);
      ctx.stroke();

      // Número
      if (zoom > 0.4) {
        ctx.fillStyle = '#F5F5F5';
        ctx.font = `bold ${Math.max(6, 9 / zoom)}px 'Share Tech Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i, sc.x, sc.y);
      }
    });
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

  // ────────────────────────────────────────────────────
  //  Canvas resize
  // ────────────────────────────────────────────────────
  function resizeCanvas() {
    const area = document.getElementById('canvas-area');
    canvas.width = area.clientWidth;
    canvas.height = area.clientHeight;
  }

})();
