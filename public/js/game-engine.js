/**
 * SpiderKart — Game Engine v0.3
 * Controls: WASD / Arrow keys to move, Space to jump, K for power
 *
 * Novedades v0.3:
 *  - Escenario más grande: circuito escalado, cielo/fondo con montañas
 *    lejanas, niebla y campo de estrellas ampliados
 *  - Ruedas corregidas: geometría con el eje de giro horneado en la
 *    geometría (ya no se pisan rotation.y/rotation.z entre sí), y las
 *    ruedas delanteras ahora SÍ giran visualmente al doblar
 *  - Hooks de multiplayer por salas: window.SpiderKart expone el
 *    estado local y permite renderizar karts remotos (ghost karts).
 *    La conexión de red en sí vive en multiplayer.js (scaffold aparte).
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────
     DOM & Container
  ────────────────────────────────────────── */
  const container = document.getElementById('game-canvas-container');
  if (!container) return;

  const overlay = document.getElementById('canvas-overlay');
  if (overlay) overlay.style.display = 'none';

  /* ──────────────────────────────────────────
     Scene, Camera, Renderer
  ────────────────────────────────────────── */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);
  scene.fog = new THREE.FogExp2(0x0a0a12, 0.008);

  const W = container.clientWidth;
  const H = container.clientHeight;
  const camera = new THREE.PerspectiveCamera(65, W / H, 0.1, 1400);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  /* ──────────────────────────────────────────
     Lights
  ────────────────────────────────────────── */
  const ambient = new THREE.AmbientLight(0x1a1a2e, 1.5);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(90, 140, 60);
  sun.castShadow = true;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.left = -240;
  sun.shadow.camera.right = 240;
  sun.shadow.camera.top = 240;
  sun.shadow.camera.bottom = -240;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const redLight = new THREE.PointLight(0xa30000, 3, 40);
  redLight.position.set(0, 8, 0);
  scene.add(redLight);

  /* ──────────────────────────────────────────
     Track path — circuito variado, ahora más grande
     (rectas largas, curva rápida, horquilla y chicana)
  ────────────────────────────────────────── */
  const WORLD_SCALE = 1.6;     // agranda todo el circuito para que las curvas sean más amplias
  const HALF_WIDTH = 11;       // ampliamos también el ancho de la pista
  const BARRIER_GAP = 1.5;     // separación entre borde de pista y muro

  const controlPoints = [
    [ 100,   0], [ 100, -50],         // recta de salida
    [  70, -100], [  10, -110],       // gran curva rápida a la izquierda
    [ -50, -110], [-100, -80],        // recta trasera diagonal
    [-120, -30], [-120,  30],         // horquilla amplia (curvón suave)
    [ -80,  90], [ -30, 100],         // entrada chicana / S suave
    [  10,  80], [  50, 100],         // centro de la S
    [  90,  70], [ 100,  30]          // curva de salida hacia meta
  ].map(([x, z]) => new THREE.Vector3(x * WORLD_SCALE, 0, z * WORLD_SCALE));

  // Cambiamos a centripetal para transiciones más suaves y menos cerradas
  const trackCurve = new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal', 0.5);

  // Muestreo denso de la curva: usado para geometría, colisión y progreso de vuelta
  const TRACK_SAMPLES = 400;
  const trackSamples = [];
  for (let i = 0; i <= TRACK_SAMPLES; i++) {
    const t = i / TRACK_SAMPLES;
    const p = trackCurve.getPointAt(t);
    const tan = trackCurve.getTangentAt(t).clone().normalize();
    const normal = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    trackSamples.push({ x: p.x, z: p.z, tan, normal, t });
  }

  function offsetCurve(dist) {
    const pts = trackSamples.map(s => new THREE.Vector3(
      s.x + s.normal.x * dist,
      0.5,
      s.z + s.normal.z * dist
    ));
    return new THREE.CatmullRomCurve3(pts, true);
  }

  /* ──────────────────────────────────────────
     Track meshes + fondo del escenario
  ────────────────────────────────────────── */
  function addMountains(group) {
    const mountMat = new THREE.MeshStandardMaterial({
      color: 0x140912,
      roughness: 1,
      metalness: 0,
      emissive: 0x22040a,
      emissiveIntensity: 0.25
    });
    const MOUNTAINS = 28;
    for (let i = 0; i < MOUNTAINS; i++) {
      const a = (i / MOUNTAINS) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const r = 260 + Math.random() * 120;
      const h = 26 + Math.random() * 46;
      const rad = 16 + Math.random() * 22;
      const geo = new THREE.ConeGeometry(rad, h, 6);
      const m = new THREE.Mesh(geo, mountMat);
      m.position.set(Math.cos(a) * r, h / 2 - 3, Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      m.castShadow = false;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  function buildTrack() {
    const group = new THREE.Group();

    // Ground plane (mundo mucho más grande alrededor del circuito)
    const groundGeo = new THREE.PlaneGeometry(700, 700, 48, 48);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0d0d1a,
      roughness: 0.9,
      metalness: 0.1
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    const gridHelper = new THREE.GridHelper(700, 70, 0x1a0000, 0x150000);
    gridHelper.position.y = 0.01;
    group.add(gridHelper);

    // Superficie de pista (tubo siguiendo la curva real del circuito)
    const trackGeo = new THREE.TubeGeometry(trackCurve, 500, HALF_WIDTH, 10, true);
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x1c1c1c,
      roughness: 0.8,
      metalness: 0.3
    });
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.receiveShadow = true;
    group.add(track);

    // Línea central (raya roja brillante)
    const lineGeo = new THREE.TubeGeometry(trackCurve, 500, 0.15, 6, true);
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0xa30000,
      emissive: 0xa30000,
      emissiveIntensity: 1.2
    });
    const centerLine = new THREE.Mesh(lineGeo, lineMat);
    centerLine.position.y = 0.05;
    group.add(centerLine);

    // Barreras — offset real por normales, no radios escalados
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.6,
      metalness: 0.5,
      emissive: 0xa30000,
      emissiveIntensity: 0.1
    });
    function addBarrier(dist) {
      const c = offsetCurve(dist);
      const g = new THREE.TubeGeometry(c, 500, 0.35, 6, true);
      const m = new THREE.Mesh(g, barrierMat);
      m.castShadow = true;
      group.add(m);
    }
    addBarrier(HALF_WIDTH + BARRIER_GAP);
    addBarrier(-(HALF_WIDTH + BARRIER_GAP));

    // Línea de salida/meta (cuadros) en t = 0
    const startSampleLocal = trackSamples[0];
    const startAngleLocal = Math.atan2(startSampleLocal.tan.z, startSampleLocal.tan.x);
    const startGeo = new THREE.BoxGeometry(0.8, 0.05, HALF_WIDTH * 2);
    const startMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const startLine = new THREE.Mesh(startGeo, startMat);
    startLine.position.set(startSampleLocal.x, 0.06, startSampleLocal.z);
    startLine.rotation.y = -startAngleLocal;
    group.add(startLine);

    // Pilares decorativos siguiendo el trazado
    const pillarGeo = new THREE.CylinderGeometry(0.4, 0.4, 6, 8);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      emissive: 0xa30000,
      emissiveIntensity: 0.3,
      metalness: 0.8
    });
    // Nota: antes cada pilar tenía una esfera brillante ("cúpula") en la
    // punta, a 6.5 de altura — casi la misma altura que la cámara (5),
    // así que quedaba metida en el encuadre todo el tiempo, sobre todo
    // en curvas cerradas. Se saca y el pilar queda solo como poste.
    const PILLARS = 48;
    for (let i = 0; i < PILLARS; i++) {
      const s = trackSamples[Math.floor((i / PILLARS) * TRACK_SAMPLES)];
      const side = i % 2 === 0 ? 1 : -1;
      const dist = HALF_WIDTH + 9;
      const px = s.x + s.normal.x * dist * side;
      const pz = s.z + s.normal.z * dist * side;

      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(px, 3, pz);
      pillar.castShadow = true;
      group.add(pillar);
    }

    addMountains(group);

    scene.add(group);
  }
  buildTrack();

  /* ──────────────────────────────────────────
     Power-ups — cajas de ítem distribuidas
  ────────────────────────────────────────── */
  const POWERUP_COUNT = 18;
  const POWERUP_RESPAWN = 6.0;
  const POWERUP_PICKUP_RADIUS = 2.4;
  const powerups = [];

  function buildPowerups() {
    const boxGeo = new THREE.OctahedronGeometry(0.75, 0);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00,
      emissive: 0xff9500,
      emissiveIntensity: 1.4,
      roughness: 0.25,
      metalness: 0.6
    });
    const ringGeo = new THREE.TorusGeometry(1.1, 0.06, 8, 20);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00,
      emissive: 0xffcc00,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.6
    });

    for (let i = 0; i < POWERUP_COUNT; i++) {
      const s = trackSamples[Math.floor((i / POWERUP_COUNT) * TRACK_SAMPLES)];
      // Alterna: centro, izquierda, derecha, para obligar a variar la trazada
      const lane = [0, 1, -1, 0.5, -0.5][i % 5];
      const lateral = lane * (HALF_WIDTH - 2);
      const px = s.x + s.normal.x * lateral;
      const pz = s.z + s.normal.z * lateral;

      const group = new THREE.Group();
      const gem = new THREE.Mesh(boxGeo, boxMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      group.add(gem);
      group.add(ring);
      group.position.set(px, 1.3, pz);
      scene.add(group);

      powerups.push({
        mesh: group,
        basePos: new THREE.Vector3(px, 1.3, pz),
        active: true,
        respawnTimer: 0
      });
    }
  }
  buildPowerups();

  /* ──────────────────────────────────────────
     Kart — geometría compartida (local + fantasmas remotos)
  ────────────────────────────────────────── */
  const bodyGeo = new THREE.BoxGeometry(1.8, 0.5, 3);
  const cockpitGeo = new THREE.BoxGeometry(1.2, 0.4, 1.5);
  const shieldGeo = new THREE.BoxGeometry(1.1, 0.4, 0.1);

  // Rueda: se hornea la rotación en la geometría para que el eje de giro
  // "natural" del mesh (X local) sea el eje de rodado. Así, más abajo,
  // rotar en X hace rodar la rueda y rotar el grupo padre en Y (dirección)
  // no pisa ni distorsiona esa rotación — antes ambas cosas competían
  // sobre los mismos ejes y las ruedas se veían "temblando".
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.26, 8);
  rimGeo.rotateZ(Math.PI / 2);

  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.9,
    metalness: 0.2
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x888888,
    roughness: 0.2,
    metalness: 0.9,
    emissive: 0x333333
  });

  const WHEEL_DEFS = [
    { x: -1.1, y: 0.32, z: 1.0, front: true },
    { x: 1.1, y: 0.32, z: 1.0, front: true },
    { x: -1.1, y: 0.32, z: -1.0, front: false },
    { x: 1.1, y: 0.32, z: -1.0, front: false }
  ];

  // Arma un tren de ruedas sobre un kartGroup dado.
  // Devuelve [{ spin, steer|null }] — 'spin' es lo que rueda, 'steer'
  // (solo delanteras) es lo que gira para simular la dirección.
  function attachWheels(kartGroup, opts) {
    opts = opts || {};
    const tireMat = opts.wheelMat || wheelMat;
    const wheelRimMat = opts.rimMat || rimMat;
    const rig = [];
    WHEEL_DEFS.forEach(def => {
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(wheelGeo, tireMat);
      tire.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, wheelRimMat);
      spin.add(tire, rim);

      if (def.front) {
        const steer = new THREE.Group();
        steer.position.set(def.x, def.y, def.z);
        steer.add(spin);
        kartGroup.add(steer);
        rig.push({ spin, steer });
      } else {
        spin.position.set(def.x, def.y, def.z);
        kartGroup.add(spin);
        rig.push({ spin, steer: null });
      }
    });
    return rig;
  }

  /* ──────────────────────────────────────────
     Kart local
  ────────────────────────────────────────── */
  const kartGroup = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xa30000,
    roughness: 0.3,
    metalness: 0.7,
    emissive: 0x3a0000,
    emissiveIntensity: 0.4
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.5;
  body.castShadow = true;
  kartGroup.add(body);

  const cockpitMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    roughness: 0.5,
    metalness: 0.9
  });
  const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
  cockpit.position.set(0, 0.95, -0.2);
  cockpit.castShadow = true;
  kartGroup.add(cockpit);

  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x00d4ff,
    transparent: true,
    opacity: 0.3,
    roughness: 0,
    metalness: 1
  });
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.position.set(0, 1.05, 0.6);
  kartGroup.add(shield);

  const wheelRig = attachWheels(kartGroup);

  const exhaustGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.6, 6);
  const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.9 });
  [-0.4, 0.4].forEach(ox => {
    const ex = new THREE.Mesh(exhaustGeo, exhaustMat);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(ox, 0.4, -1.7);
    kartGroup.add(ex);
  });

  const flameGeo = new THREE.SphereGeometry(0.15, 6, 6);
  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xff6600,
    emissive: 0xff3300,
    emissiveIntensity: 3,
    transparent: true,
    opacity: 0.8
  });
  const flames = [];
  [-0.4, 0.4].forEach(ox => {
    const fl = new THREE.Mesh(flameGeo, flameMat);
    fl.position.set(ox, 0.4, -2.0);
    fl.visible = false;
    kartGroup.add(fl);
    flames.push(fl);
  });

  const kartLight = new THREE.PointLight(0xa30000, 2, 8);
  kartLight.position.set(0, 1, 0);
  kartGroup.add(kartLight);

  // Posición y orientación inicial: sobre el inicio del circuito, mirando en tangente
  const startSample = trackSamples[0];
  const startAngle0 = Math.atan2(startSample.tan.z, startSample.tan.x);
  kartGroup.position.set(startSample.x, 0.0, startSample.z);
  scene.add(kartGroup);

  /* ──────────────────────────────────────────
     Karts remotos (fantasmas) — multiplayer por salas
     El transporte real (WebSocket, salas) vive en multiplayer.js;
     acá solo se resuelve cómo se ve/interpola un jugador remoto.
  ────────────────────────────────────────── */
  const remoteKarts = {};

  function makeNameSprite(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10,10,18,0.6)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = '700 30px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(name || 'PILOTO').slice(0, 12).toUpperCase(), 128, 42);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.4, 0.6, 1);
    sprite.position.set(0, 2.1, 0);
    return sprite;
  }

  function createGhostKart(color, name) {
    const group = new THREE.Group();
    const ghostBodyMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.35, metalness: 0.6,
      emissive: color, emissiveIntensity: 0.35,
      transparent: true, opacity: 0.9
    });
    const ghostCockpitMat = new THREE.MeshStandardMaterial({
      color: 0x111111, roughness: 0.5, metalness: 0.9,
      transparent: true, opacity: 0.9
    });
    const gBody = new THREE.Mesh(bodyGeo, ghostBodyMat);
    gBody.position.y = 0.5;
    group.add(gBody);
    const gCockpit = new THREE.Mesh(cockpitGeo, ghostCockpitMat);
    gCockpit.position.set(0, 0.95, -0.2);
    group.add(gCockpit);

    attachWheels(group);
    group.add(makeNameSprite(name));

    const light = new THREE.PointLight(color, 1.4, 6);
    light.position.set(0, 1, 0);
    group.add(light);

    return group;
  }

  function shortestAngleDiff(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function ensureRemoteKart(id, meta) {
    if (remoteKarts[id]) return remoteKarts[id];
    meta = meta || {};
    const group = createGhostKart(meta.color || 0x2299ff, meta.name || 'PILOTO');
    scene.add(group);
    const entry = {
      group,
      pos: group.position.clone(),
      angle: 0,
      targetPos: group.position.clone(),
      targetAngle: 0,
      lastSeen: performance.now()
    };
    remoteKarts[id] = entry;
    return entry;
  }

  function applyRemoteState(id, remoteState, meta) {
    const entry = ensureRemoteKart(id, meta);
    entry.targetPos.set(remoteState.x, remoteState.y || 0, remoteState.z);
    entry.targetAngle = remoteState.angle || 0;
    entry.lastSeen = performance.now();
  }

  function removeRemotePlayer(id) {
    const entry = remoteKarts[id];
    if (!entry) return;
    scene.remove(entry.group);
    delete remoteKarts[id];
  }

  const REMOTE_TIMEOUT_MS = 8000; // limpia fantasmas si dejan de mandar estado
  function updateRemoteKarts(dt) {
    const now = performance.now();
    for (const id in remoteKarts) {
      const e = remoteKarts[id];
      if (now - e.lastSeen > REMOTE_TIMEOUT_MS) { removeRemotePlayer(id); continue; }
      const smooth = Math.min(1, dt * 8);
      e.pos.lerp(e.targetPos, smooth);
      e.angle += shortestAngleDiff(e.angle, e.targetAngle) * smooth;
      e.group.position.copy(e.pos);
      e.group.rotation.y = -e.angle + Math.PI / 2;
    }
  }

  /* ──────────────────────────────────────────
     Particles (exhaust smoke + pickup bursts)
  ────────────────────────────────────────── */
  const PARTICLE_COUNT = 200;
  const particleGeo = new THREE.BufferGeometry();
  const pPositions = new Float32Array(PARTICLE_COUNT * 3);
  const pColors = new Float32Array(PARTICLE_COUNT * 3);
  const pVelocities = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pPositions[i * 3] = 9999;
    pPositions[i * 3 + 1] = 9999;
    pPositions[i * 3 + 2] = 9999;
    pColors[i * 3] = 1; pColors[i * 3 + 1] = 0.3; pColors[i * 3 + 2] = 0.1;
    pVelocities.push({ x: 0, y: 0, z: 0, life: 0, maxLife: 0 });
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
  particleGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.18,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    vertexColors: true
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);
  let nextParticle = 0;

  function spawnParticle(x, y, z, vx, vy, vz, r = 1, g = 0.3, b = 0.1) {
    const i = nextParticle % PARTICLE_COUNT;
    pPositions[i * 3] = x;
    pPositions[i * 3 + 1] = y;
    pPositions[i * 3 + 2] = z;
    pColors[i * 3] = r; pColors[i * 3 + 1] = g; pColors[i * 3 + 2] = b;
    pVelocities[i] = { x: vx, y: vy, z: vz, life: 1.0, maxLife: 1.0 };
    nextParticle++;
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.color.needsUpdate = true;
  }

  function spawnPickupBurst(x, y, z) {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.05 + Math.random() * 0.08;
      spawnParticle(
        x, y, z,
        Math.cos(a) * speed, 0.06 + Math.random() * 0.06, Math.sin(a) * speed,
        1, 0.8, 0.15
      );
    }
  }

  /* ──────────────────────────────────────────
     Stars background
  ────────────────────────────────────────── */
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(4500);
  for (let i = 0; i < 4500; i++) {
    starPos[i] = (Math.random() - 0.5) * 1000;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, transparent: true, opacity: 0.6 });
  scene.add(new THREE.Points(starGeo, starMat));

  /* ──────────────────────────────────────────
     Input
  ────────────────────────────────────────── */
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  /* ──────────────────────────────────────────
     Checkpoints — validan que la vuelta se recorra
     completa y en el sentido correcto (no solo que
     se cruce la meta) y sirven para saber en qué
     parte del circuito está el piloto en todo momento
  ────────────────────────────────────────── */
  const CHECKPOINT_COUNT = 10; // checkpoint 0 = línea de salida/meta (t = 0)
  const checkpoints = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    const idx = Math.floor((i / CHECKPOINT_COUNT) * TRACK_SAMPLES);
    checkpoints.push({ idx, t: trackSamples[idx].t });
  }
  // Media distancia entre checkpoints consecutivos: ventana de detección
  // para no exigir pasar por el sample exacto, pero sin que se solape
  // con el checkpoint siguiente o anterior.
  const CHECKPOINT_TOLERANCE = Math.floor(TRACK_SAMPLES / CHECKPOINT_COUNT / 2);

  // Distancia mínima entre dos índices de sample en un circuito circular
  function sampleIdxDelta(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, TRACK_SAMPLES - d);
  }

  function resetCheckpoints() {
    // El piloto arranca parado sobre el checkpoint 0 (la meta), así
    // que el próximo que tiene que buscar es el 1.
    state.nextCheckpoint = 1;
    state.checkpointsPassed = 0;
  }

  // Se llama con el índice de sample más cercano a la posición actual
  // del kart (ya calculado en resolveTrackCollision, para no repetir
  // la búsqueda). Si el kart llegó al próximo checkpoint esperado —y
  // solo a ese, no a cualquiera— lo marca y avanza el puntero, en el
  // ciclo 1 → 2 → … → 9 → 0 → 1 → …
  //
  // OJO con el bug que tenía esto antes: contaba la vuelta apenas el
  // puntero LLEGABA a 10 (es decir, al tocar el checkpoint 9), pero el
  // checkpoint 9 está en idx≈360/400 — 90% del circuito, NO sobre la
  // línea de salida/meta (idx=0). Eso hacía que la vuelta se acreditara
  // ~40 samples antes de cruzar la meta de verdad. La vuelta solo debe
  // contar cuando el puntero, después de haber recorrido 1..9 en orden,
  // vuelve a caer exactamente sobre el checkpoint 0 (la meta real).
  function updateCheckpointProgress(sampleIdx) {
    const target = checkpoints[state.nextCheckpoint];
    if (sampleIdxDelta(sampleIdx, target.idx) > CHECKPOINT_TOLERANCE) return;

    const closingLap = state.nextCheckpoint === 0;
    state.nextCheckpoint = (state.nextCheckpoint + 1) % CHECKPOINT_COUNT;

    if (closingLap) {
      // Tocó el checkpoint 0, es decir volvió a cruzar la línea de
      // salida/meta habiendo pasado antes por los 9 checkpoints
      // intermedios en orden: vuelta válida.
      state.lap += 1;
      if (hudLap) hudLap.textContent = `VUELTA ${state.lap + 1}`;
      state.checkpointsPassed = 0;
    } else {
      state.checkpointsPassed++;
    }
  }

  /* ──────────────────────────────────────────
     Kart physics state
  ────────────────────────────────────────── */
  const state = {
    speed: 0,
    angle: startAngle0,
    posX: startSample.x,
    posZ: startSample.z,
    posY: 0,
    velY: 0,
    isGrounded: true,
    wheelRot: 0,
    steerAngle: 0,
    powerActive: false,
    powerTimer: 0,
    powerCooldown: 0,
    jumpCooldown: 0,
    boost: 1,
    lap: 0,
    lastT: 0,
    nearestIdx: 0,
    nextCheckpoint: 1,     // próximo checkpoint que el piloto tiene que tocar
    checkpointsPassed: 0   // cuántos lleva en la vuelta actual (info/HUD)
  };

  const ACCEL = 0.012;
  const MAX_SPEED = 0.6;
  const BOOST_MULT = 1.8;
  const STEER = 0.032;
  const GRAVITY = -0.018;
  const JUMP_VEL = 0.28;
  const GROUND_Y = 0;
  const WALL_MARGIN = 0.9;      // margen entre el borde de pista y el límite de colisión
  const WALL_CORRECTION = 0.35; // fracción de la penetración que se corrige por frame (evita el "snap" duro)
  const WALL_FRICTION = 0.965;  // fricción al rozar el muro — pérdida gradual, no un frenazo
  const MAX_STEER_VISUAL = 0.5; // radianes que giran las ruedas delanteras al máximo

  /* ──────────────────────────────────────────
     HUD Elements
  ────────────────────────────────────────── */
  function buildHUD() {
    const hud = document.createElement('div');
    hud.id = 'sk-hud';
    hud.innerHTML = `
      <div class="sk-hud-speed">
        <span class="sk-hud-val" id="hud-speed">0</span>
        <span class="sk-hud-unit">KM/H</span>
      </div>
      <div class="sk-hud-lap" id="hud-lap">VUELTA 1</div>
      <div class="sk-hud-progress">
        <div class="sk-hud-progress-fill" id="hud-progress-fill"></div>
      </div>
      <div class="sk-hud-power">
        <span class="sk-hud-label">[ K ] POWER</span>
        <div class="sk-hud-bar"><div class="sk-hud-fill" id="hud-power-fill"></div></div>
      </div>
      <div class="sk-hud-controls">
        <span>WASD / ↑↓←→ MOVER</span>
        <span>SPACE SALTAR</span>
        <span>K PODER</span>
      </div>
      <div class="sk-hud-power-fx hidden" id="hud-power-fx">⚡ BOOST ACTIVO</div>
      <div class="sk-hud-item-fx hidden" id="hud-item-fx">🔶 ¡ÍTEM!</div>
    `;
    container.appendChild(hud);

    const style = document.createElement('style');
    style.textContent = `
      #game-canvas-container { position:relative; }
      #sk-hud {
        position:absolute; inset:0; pointer-events:none;
        font-family:'Share Tech Mono',monospace;
        color:#f5f5f5;
      }
      .sk-hud-speed {
        position:absolute; bottom:20px; left:24px;
        display:flex; align-items:baseline; gap:6px;
      }
      .sk-hud-val {
        font-size:2.8rem; font-weight:900; color:#a30000;
        text-shadow:0 0 20px rgba(163,0,0,0.8);
        font-family:'Barlow Condensed',sans-serif;
      }
      .sk-hud-unit { font-size:0.7rem; letter-spacing:0.2em; color:#888; }
      .sk-hud-lap {
        position:absolute; top:12px; right:24px;
        font-size:0.85rem; letter-spacing:0.15em; font-weight:700;
        color:#fff; background:rgba(163,0,0,0.25);
        border:1px solid rgba(163,0,0,0.5);
        padding:4px 10px; clip-path:polygon(6px 0,100% 0,100% 100%,0 100%,0 6px);
      }
      .sk-hud-progress {
        position:absolute; top:38px; right:24px;
        width:160px; height:4px;
        background:rgba(255,255,255,0.08);
        border:1px solid rgba(163,0,0,0.25);
      }
      .sk-hud-progress-fill {
        height:100%; width:0%;
        background:linear-gradient(90deg,#a30000,#ff6600);
        transition:width 0.15s linear;
      }
      .sk-hud-power {
        position:absolute; bottom:20px; right:24px;
        display:flex; flex-direction:column; align-items:flex-end; gap:6px;
      }
      .sk-hud-label { font-size:0.6rem; letter-spacing:0.2em; color:#666; }
      .sk-hud-bar {
        width:120px; height:6px;
        background:rgba(255,255,255,0.08);
        border:1px solid rgba(163,0,0,0.3);
        clip-path:polygon(0 0,calc(100% - 4px) 0,100% 4px,100% 100%,4px 100%,0 calc(100% - 4px));
      }
      .sk-hud-fill {
        height:100%; width:100%;
        background:linear-gradient(90deg,#6b0000,#a30000);
        transition:width 0.1s;
        box-shadow:0 0 8px rgba(163,0,0,0.6);
      }
      .sk-hud-controls {
        position:absolute; top:12px; left:50%;
        transform:translateX(-50%);
        display:flex; gap:16px;
        font-size:0.55rem; letter-spacing:0.15em;
        color:rgba(255,255,255,0.25);
        text-transform:uppercase;
      }
      .sk-hud-power-fx {
        position:absolute; top:50%; left:50%;
        transform:translate(-50%,-50%);
        font-size:1.4rem; letter-spacing:0.3em;
        color:#ff6600; text-shadow:0 0 30px #ff3300;
        animation:skPulse 0.4s ease-in-out infinite alternate;
      }
      .sk-hud-power-fx.hidden { display:none; }
      .sk-hud-item-fx {
        position:absolute; top:38%; left:50%;
        transform:translate(-50%,-50%);
        font-size:1.1rem; letter-spacing:0.25em;
        color:#ffcc00; text-shadow:0 0 24px #ff9500;
        animation:skItemPop 0.6s ease-out forwards;
      }
      .sk-hud-item-fx.hidden { display:none; }
      @keyframes skPulse {
        from { opacity:0.6; transform:translate(-50%,-50%) scale(0.95); }
        to   { opacity:1;   transform:translate(-50%,-50%) scale(1.05); }
      }
      @keyframes skItemPop {
        0%   { opacity:0;   transform:translate(-50%,-50%) scale(0.7); }
        20%  { opacity:1;   transform:translate(-50%,-50%) scale(1.1); }
        80%  { opacity:1;   transform:translate(-50%,-50%) scale(1); }
        100% { opacity:0;   transform:translate(-50%,-60%) scale(1); }
      }
    `;
    document.head.appendChild(style);
  }
  buildHUD();

  const hudSpeed = document.getElementById('hud-speed');
  const hudFill = document.getElementById('hud-power-fill');
  const hudPowerFx = document.getElementById('hud-power-fx');
  const hudLap = document.getElementById('hud-lap');
  const hudItemFx = document.getElementById('hud-item-fx');
  const hudProgressFill = document.getElementById('hud-progress-fill');

  /* ──────────────────────────────────────────
     Track collision + progreso de vuelta
  ────────────────────────────────────────── */
  function resolveTrackCollision() {
    // Búsqueda del punto más cercano de la curva (con ventana alrededor
    // del índice anterior para no recorrer todos los samples si no hace falta)
    let bestIdx = -1;
    let bestDist = Infinity;
    const searchWindow = 60;
    const lastIdx = state.nearestIdx;
    for (let d = -searchWindow; d <= searchWindow; d++) {
      const i = ((lastIdx + d) % TRACK_SAMPLES + TRACK_SAMPLES) % TRACK_SAMPLES;
      const s = trackSamples[i];
      const dx = state.posX - s.x;
      const dz = state.posZ - s.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const sample = trackSamples[bestIdx];
    state.nearestIdx = bestIdx;

    const relX = state.posX - sample.x;
    const relZ = state.posZ - sample.z;
    const perp = relX * sample.normal.x + relZ * sample.normal.z;
    const limit = HALF_WIDTH - WALL_MARGIN;

    if (Math.abs(perp) > limit) {
      const side = perp > 0 ? 1 : -1;
      const penetration = Math.abs(perp) - limit;

      // Empuje suave hacia adentro de la pista: corrige solo una fracción
      // de la penetración por frame en vez de clavar al kart exactamente
      // en el límite. Eso es lo que hacía que se sintiera como un
      // frenazo contra un bloque — con corrección gradual, se nota como
      // un roce contra el muro.
      const push = penetration * WALL_CORRECTION;
      state.posX -= sample.normal.x * side * push;
      state.posZ -= sample.normal.z * side * push;

      // Se conserva el deslizamiento: la velocidad se proyecta sobre la
      // tangente de la pista (a lo largo del muro), descartando la
      // componente que apuntaba hacia adentro. Con fricción leve, el
      // kart sigue avanzando "raspando" el muro en vez de detenerse.
      const velX = Math.cos(state.angle) * state.speed;
      const velZ = Math.sin(state.angle) * state.speed;
      const vTangent = velX * sample.tan.x + velZ * sample.tan.z;
      state.speed = vTangent * WALL_FRICTION;
    }

    // Progreso de vuelta vía checkpoints: reemplaza la vieja detección
    // por umbral de t (0.85 -> 0.15), que contaba la vuelta con solo
    // cruzar la línea de meta sin importar qué camino se hizo antes
    // (se podía cortar campo, ir y volver sobre la meta, etc.). Ahora
    // hace falta tocar, en orden, cada uno de los checkpoints
    // intermedios antes de que la vuelta cuente.
    updateCheckpointProgress(bestIdx);
    state.lastT = sample.t;
  }

  /* ──────────────────────────────────────────
     Power-up pickup
  ────────────────────────────────────────── */
  function updatePowerups(dt) {
    for (const p of powerups) {
      if (p.active) {
        const bob = Math.sin(Date.now() * 0.003 + p.basePos.x) * 0.15;
        p.mesh.position.y = p.basePos.y + bob;
        p.mesh.rotation.y += dt * 1.6;
        p.mesh.children[1].rotation.z += dt * 0.8;

        const dx = state.posX - p.mesh.position.x;
        const dz = state.posZ - p.mesh.position.z;
        if (dx * dx + dz * dz < POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) {
          p.active = false;
          p.respawnTimer = POWERUP_RESPAWN;
          p.mesh.visible = false;
          spawnPickupBurst(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z);

          // Ítem recogido: recarga el poder al instante y activa un boost corto
          state.powerCooldown = 0;
          state.powerTimer = Math.max(state.powerTimer, 1.6);

          if (hudItemFx) {
            hudItemFx.classList.remove('hidden');
            void hudItemFx.offsetWidth; // reinicia la animación
            hudItemFx.style.animation = 'none';
            requestAnimationFrame(() => { hudItemFx.style.animation = ''; });
          }
        }
      } else {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) {
          p.active = true;
          p.mesh.visible = true;
          p.mesh.scale.setScalar(0.2);
        } else if (p.mesh.scale.x < 1) {
          p.mesh.scale.setScalar(Math.min(1, p.mesh.scale.x + dt * 3));
        }
      }
    }
  }

  /* ──────────────────────────────────────────
     Game Loop
  ────────────────────────────────────────── */
  const clock = new THREE.Clock();

  function update(dt) {
    const forward = (keys['KeyW'] || keys['ArrowUp']);
    const backward = (keys['KeyS'] || keys['ArrowDown']);
    const left = (keys['KeyA'] || keys['ArrowLeft']);
    const right = (keys['KeyD'] || keys['ArrowRight']);
    const jumpKey = keys['Space'];
    const powerKey = keys['KeyK'];

    // Power / boost
    if (state.powerCooldown > 0) state.powerCooldown -= dt;
    if (state.powerTimer > 0) {
      state.powerTimer -= dt;
      state.powerActive = true;
      state.boost = BOOST_MULT;
      flames.forEach(f => { f.visible = true; f.scale.setScalar(1 + Math.sin(Date.now() * 0.02) * 0.3); });
      if (hudPowerFx) hudPowerFx.classList.remove('hidden');
    } else {
      state.powerActive = false;
      state.boost = 1;
      flames.forEach(f => { f.visible = false; });
      if (hudPowerFx) hudPowerFx.classList.add('hidden');
    }

    if (powerKey && state.powerCooldown <= 0 && state.powerTimer <= 0) {
      state.powerTimer = 3.0;
      state.powerCooldown = 10.0;
    }

    // Acceleration
    if (forward) {
      state.speed = Math.min(state.speed + ACCEL * state.boost, MAX_SPEED * state.boost);
    } else if (backward) {
      state.speed = Math.max(state.speed - ACCEL, -MAX_SPEED * 0.5);
    } else {
      state.speed *= 0.96;
      if (Math.abs(state.speed) < 0.001) state.speed = 0;
    }

    // Steering
    const steerAmt = Math.abs(state.speed) > 0.01 ? STEER * (state.speed > 0 ? 1 : -1) : 0;
    if (left) {
      state.angle -= steerAmt;
      state.steerAngle = Math.max(state.steerAngle - 0.05, -0.4);
    } else if (right) {
      state.angle += steerAmt;
      state.steerAngle = Math.min(state.steerAngle + 0.05, 0.4);
    } else {
      state.steerAngle *= 0.8;
    }

    // Jump
    if (state.jumpCooldown > 0) state.jumpCooldown -= dt;
    if (jumpKey && state.isGrounded && state.jumpCooldown <= 0) {
      state.velY = JUMP_VEL;
      state.isGrounded = false;
      state.jumpCooldown = 0.5;
    }

    // Gravity
    if (!state.isGrounded) {
      state.velY += GRAVITY;
      state.posY += state.velY;
      if (state.posY <= GROUND_Y) {
        state.posY = GROUND_Y;
        state.velY = 0;
        state.isGrounded = true;
      }
    }

    // Move
    state.posX += Math.cos(state.angle) * state.speed;
    state.posZ += Math.sin(state.angle) * state.speed;

    // Mantener al kart dentro de la pista + progreso de vuelta (checkpoints)
    resolveTrackCollision();

    // Power-ups
    updatePowerups(dt);

    // Karts remotos (fantasmas de otros jugadores, si hay sala activa)
    updateRemoteKarts(dt);

    // Update kart mesh
    kartGroup.position.set(state.posX, state.posY, state.posZ);
    kartGroup.rotation.y = -state.angle + Math.PI / 2;

    // Ruedas: rodado real (eje X horneado en la geometría) + dirección
    // visual en las delanteras (grupo "steer" gira en Y, independiente
    // del rodado del grupo "spin" que cuelga adentro).
    state.wheelRot += state.speed * 2.6;
    wheelRig.forEach(w => {
      w.spin.rotation.x = state.wheelRot;
      if (w.steer) w.steer.rotation.y = state.steerAngle * (MAX_STEER_VISUAL / 0.4);
    });

    // Exhaust particles when moving
    if (Math.abs(state.speed) > 0.03) {
      const bx = state.posX - Math.cos(state.angle) * 1.7;
      const bz = state.posZ - Math.sin(state.angle) * 1.7;
      for (let i = 0; i < (state.powerActive ? 4 : 1); i++) {
        spawnParticle(
          bx + (Math.random() - 0.5) * 0.5,
          state.posY + 0.4,
          bz + (Math.random() - 0.5) * 0.5,
          (Math.random() - 0.5) * 0.04,
          Math.random() * 0.04,
          (Math.random() - 0.5) * 0.04,
          1, 0.3, 0.1
        );
      }
    }

    // Update particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (pVelocities[i].life > 0) {
        pVelocities[i].life -= dt * 1.2;
        pPositions[i * 3] += pVelocities[i].x;
        pPositions[i * 3 + 1] += pVelocities[i].y;
        pPositions[i * 3 + 2] += pVelocities[i].z;
        pVelocities[i].y -= 0.002;
        if (pVelocities[i].life <= 0) {
          pPositions[i * 3] = 9999;
          pPositions[i * 3 + 1] = 9999;
          pPositions[i * 3 + 2] = 9999;
        }
      }
    }
    particleGeo.attributes.position.needsUpdate = true;

    // Red kart light pulse
    redLight.position.set(state.posX, state.posY + 4, state.posZ);
    kartLight.intensity = state.powerActive ? 4 + Math.sin(Date.now() * 0.02) * 2 : 2;

    // Camera: follow kart from behind and above
    const camDist = 10;
    const camHeight = 5;
    const camX = state.posX - Math.cos(state.angle) * camDist;
    const camZ = state.posZ - Math.sin(state.angle) * camDist;
    camera.position.lerp(new THREE.Vector3(camX, state.posY + camHeight, camZ), 0.08);
    camera.lookAt(state.posX, state.posY + 1.5, state.posZ);

    // HUD
    const kmh = Math.round(Math.abs(state.speed) * 300);
    if (hudSpeed) hudSpeed.textContent = kmh;
    const powerPct = state.powerTimer > 0 ? (state.powerTimer / 3.0) * 100
      : state.powerCooldown > 0 ? (1 - state.powerCooldown / 10) * 100 : 100;
    if (hudFill) hudFill.style.width = powerPct + '%';
    if (hudProgressFill) {
      const progressPct = (state.checkpointsPassed / CHECKPOINT_COUNT) * 100;
      hudProgressFill.style.width = progressPct + '%';
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    update(dt);
    renderer.render(scene, camera);
  }

  // Resize
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  /* ──────────────────────────────────────────
     API pública para multiplayer.js (o cualquier otro módulo)
  ────────────────────────────────────────── */
  window.SpiderKart = {
    getLocalState() {
      return {
        x: state.posX, y: state.posY, z: state.posZ,
        angle: state.angle, speed: state.speed,
        boosting: state.powerActive, lap: state.lap,
        nextCheckpoint: state.nextCheckpoint,
        checkpointsPassed: state.checkpointsPassed,
        checkpointCount: CHECKPOINT_COUNT
      };
    },
    applyRemoteState,
    removeRemotePlayer,
    // Reinicia vuelta y checkpoints (no la posición del kart) para
    // arrancar una carrera nueva en modo multijugador — lo usa
    // multiplayer.js al recibir la señal de largada de una sala.
    resetRace() {
      state.lap = 0;
      resetCheckpoints();
      if (hudLap) hudLap.textContent = 'VUELTA 1';
    },
    trackHalfWidth: HALF_WIDTH,
    startPoint: { x: startSample.x, z: startSample.z, angle: startAngle0 }
  };

  animate();
})();