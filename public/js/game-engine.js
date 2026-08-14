/**
 * SpiderKart — Game Engine v0.4
 * Controls: WASD / Arrow keys — move | Space — jump | Space+turn — DRIFT | K — power
 *
 * Novedades v0.4:
 *  - Rotación de ruedas corregida: ahora ruedan hacia adelante al acelerar
 *  - Sentido contrario: detección por dot product con la tangente + bloqueo
 *    de checkpoints/vueltas + alerta "SENTIDO CONTRARIO" en HUD
 *  - Derrape (Drift): Space + giro = fricción lateral reducida + chispas +
 *    mini-turbo al salir del drift
 *  - Salto más corto (JUMP_VEL reducido) para que el drift sea táctico
 *  - Carrera a 5 vueltas con cronómetro total, tiempo de vuelta y mejor vuelta
 *  - Minimapa Canvas 2D con posición del kart en tiempo real
 *  - HUD sin emojis — solo texto y Font Awesome
 *  - Pantalla de victoria al completar TOTAL_LAPS vueltas
 *  - Llama a window._finishLoading() para ocultar la pantalla de carga
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

  const W = container.clientWidth  || window.innerWidth;
  const H = container.clientHeight || window.innerHeight;
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
     Track path — circuito variado grande
  ────────────────────────────────────────── */
  const WORLD_SCALE = 1.8;
  const HALF_WIDTH = 14;
  const BARRIER_GAP = 1.5;

  const controlPoints = [
    [ 160,   0],
    [ 160, -70],
    [ 150, -140],
    [ 110, -200],
    [  50, -210],
    [   0, -180],
    [ -40, -130],
    [ -90, -150],
    [-140, -130],
    [-180, -80],
    [-190,   0],
    [-160,  60],
    [-100,  80],
    [ -60,  40],
    [ -20,  90],
    [  30, 130],
    [  90, 140],
    [ 140, 110],
    [ 160,  60]
  ].map(([x, z]) => new THREE.Vector3(x * WORLD_SCALE, 0, z * WORLD_SCALE));

  const trackCurve = new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal', 0.5);

  const TRACK_SAMPLES = 600;
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
      s.x + s.normal.x * dist, 0.5, s.z + s.normal.z * dist
    ));
    return new THREE.CatmullRomCurve3(pts, true);
  }

  /* ──────────────────────────────────────────
     Track meshes
  ────────────────────────────────────────── */
  function addMountains(group) {
    const mountMat = new THREE.MeshStandardMaterial({
      color: 0x140912, roughness: 1, metalness: 0,
      emissive: 0x22040a, emissiveIntensity: 0.25
    });
    // El tráfico del circuito llega hasta ~190 * WORLD_SCALE = 342 unidades.
    // Las montañas se colocan a partir de 500 unidades para no invadir la pista.
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
      const r = 500 + Math.random() * 250; // Fuera del área de la pista
      const h = 32 + Math.random() * 60;
      const rad = 22 + Math.random() * 30;
      const geo = new THREE.ConeGeometry(rad, h, 6);
      const m = new THREE.Mesh(geo, mountMat);
      m.position.set(Math.cos(a) * r, h / 2 - 3, Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  function buildFlatRoadMesh() {
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const uvs = [];
    const indices = [];

    const numSamples = trackSamples.length;
    for (let i = 0; i < numSamples; i++) {
      const s = trackSamples[i];
      const lx = s.x + s.normal.x * HALF_WIDTH;
      const lz = s.z + s.normal.z * HALF_WIDTH;
      const rx = s.x - s.normal.x * HALF_WIDTH;
      const rz = s.z - s.normal.z * HALF_WIDTH;

      pos.push(lx, 0.02, lz);
      pos.push(rx, 0.02, rz);

      const u = s.t * 20;
      uvs.push(0, u);
      uvs.push(1, u);

      if (i < numSamples - 1) {
        const v1 = i * 2;
        const v2 = i * 2 + 1;
        const v3 = (i + 1) * 2;
        const v4 = (i + 1) * 2 + 1;

        indices.push(v1, v3, v2);
        indices.push(v2, v3, v4);
      }
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x181824,
      roughness: 0.75,
      metalness: 0.25,
      side: THREE.DoubleSide
    });
    return new THREE.Mesh(geo, mat);
  }

  function buildTrack() {
    const group = new THREE.Group();

    const groundGeo = new THREE.PlaneGeometry(1200, 1200, 64, 64);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0d0d1a, roughness: 0.9, metalness: 0.1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    const gridHelper = new THREE.GridHelper(1200, 80, 0x1a0000, 0x150000);
    gridHelper.position.y = 0.01;
    group.add(gridHelper);

    // Carretera plana (sin túnel negro)
    const trackMesh = buildFlatRoadMesh();
    trackMesh.receiveShadow = true;
    group.add(trackMesh);

    // Línea central roja
    const lineGeo = new THREE.TubeGeometry(trackCurve, 600, 0.2, 6, true);
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xa30000, emissive: 0xa30000, emissiveIntensity: 1.4 });
    const centerLine = new THREE.Mesh(lineGeo, lineMat);
    centerLine.position.y = 0.06;
    group.add(centerLine);

    // Barreras laterales neón
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0x222222, roughness: 0.6, metalness: 0.5,
      emissive: 0xa30000, emissiveIntensity: 0.3
    });
    function addBarrier(dist) {
      const c = offsetCurve(dist);
      const g = new THREE.TubeGeometry(c, 600, 0.4, 6, true);
      const m = new THREE.Mesh(g, barrierMat);
      m.castShadow = true;
      group.add(m);
    }
    addBarrier(HALF_WIDTH + BARRIER_GAP);
    addBarrier(-(HALF_WIDTH + BARRIER_GAP));

    // Línea de meta
    const startSampleLocal = trackSamples[0];
    const startAngleLocal = Math.atan2(startSampleLocal.tan.z, startSampleLocal.tan.x);
    const startGeo = new THREE.BoxGeometry(1.0, 0.05, HALF_WIDTH * 2);
    const startMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const startLine = new THREE.Mesh(startGeo, startMat);
    startLine.position.set(startSampleLocal.x, 0.07, startSampleLocal.z);
    startLine.rotation.y = -startAngleLocal;
    group.add(startLine);

    // Pilares neón
    const pillarGeo = new THREE.CylinderGeometry(0.45, 0.45, 7, 8);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xa30000, emissiveIntensity: 0.4, metalness: 0.8
    });
    for (let i = 0; i < 60; i++) {
      const s = trackSamples[Math.floor((i / 60) * TRACK_SAMPLES)];
      const side = i % 2 === 0 ? 1 : -1;
      const dist = HALF_WIDTH + 11;
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(s.x + s.normal.x * dist * side, 3.5, s.z + s.normal.z * dist * side);
      pillar.castShadow = true;
      group.add(pillar);
    }

    addMountains(group);
    scene.add(group);
  }
  buildTrack();

  /* ──────────────────────────────────────────
     Obstáculos variados y aleatorizados en la pista
  ────────────────────────────────────────── */
  const OBSTACLE_COUNT = 26;
  const OBSTACLE_RESPAWN = 7.0; // Segundos para regenerarse tras ser destruido
  const obstacles = [];

  function buildObstacles() {
    // Geometrías para 3 tipos distintos de obstáculos
    const barrelBaseGeo = new THREE.CylinderGeometry(0.8, 1.1, 1.3, 8);
    const spikeGeo      = new THREE.OctahedronGeometry(0.65, 0);

    const crystalBaseGeo = new THREE.ConeGeometry(1.0, 0.6, 6);
    const crystalGeo     = new THREE.OctahedronGeometry(0.8, 0);

    const eggBaseGeo = new THREE.SphereGeometry(0.9, 8, 8);
    eggBaseGeo.scale(1, 0.6, 1);
    const eggCoreGeo = new THREE.IcosahedronGeometry(0.5, 0);

    // Materiales neón
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.5, metalness: 0.8 });
    const matPink = new THREE.MeshStandardMaterial({ color: 0xff0055, emissive: 0xff0033, emissiveIntensity: 1.8, roughness: 0.2 });
    const matCyan = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00b4d8, emissiveIntensity: 1.9, roughness: 0.2 });
    const matPurple = new THREE.MeshStandardMaterial({ color: 0x9900ff, emissive: 0x7700cc, emissiveIntensity: 2.0, roughness: 0.2 });

    let currentIdx = 25;
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      // Separación aleatorizada entre obstáculos
      currentIdx += Math.floor(16 + Math.random() * 22);
      if (currentIdx >= TRACK_SAMPLES - 35) break;

      const s = trackSamples[currentIdx];
      // Desplazamiento lateral completamente aleatorizado en el ancho de la pista
      const side = (Math.random() < 0.5 ? 1 : -1);
      const laneFrac = 0.15 + Math.random() * 0.65;
      const lateral = side * (HALF_WIDTH * laneFrac);
      const ox = s.x + s.normal.x * lateral;
      const oz = s.z + s.normal.z * lateral;

      const type = i % 3; // 0: Barril, 1: Cristal Neón, 2: Mina Araña
      const group = new THREE.Group();
      let spikeMesh = null;
      let lightColor = 0xff0055;

      if (type === 0) {
        // Tipo 1: Barril de Picos
        const base = new THREE.Mesh(barrelBaseGeo, darkMat);
        base.position.y = 0.65;
        base.castShadow = true;
        spikeMesh = new THREE.Mesh(spikeGeo, matPink);
        spikeMesh.position.y = 1.5;
        spikeMesh.castShadow = true;
        group.add(base, spikeMesh);
        lightColor = 0xff0055;
      } else if (type === 1) {
        // Tipo 2: Cristal de Láser Neón
        const base = new THREE.Mesh(crystalBaseGeo, darkMat);
        base.position.y = 0.3;
        base.castShadow = true;
        spikeMesh = new THREE.Mesh(crystalGeo, matCyan);
        spikeMesh.position.y = 1.3;
        spikeMesh.scale.set(0.9, 1.4, 0.9);
        spikeMesh.castShadow = true;
        group.add(base, spikeMesh);
        lightColor = 0x00e5ff;
      } else {
        // Tipo 3: Huevo de Araña / Mina
        const base = new THREE.Mesh(eggBaseGeo, darkMat);
        base.position.y = 0.45;
        base.castShadow = true;
        spikeMesh = new THREE.Mesh(eggCoreGeo, matPurple);
        spikeMesh.position.y = 1.1;
        spikeMesh.castShadow = true;
        group.add(base, spikeMesh);
        lightColor = 0x9900ff;
      }

      // Variación aleatoria de escala y rotación
      const randScale = 0.85 + Math.random() * 0.35;
      group.scale.setScalar(randScale);
      group.rotation.y = Math.random() * Math.PI * 2;
      group.position.set(ox, 0, oz);
      scene.add(group);

      const light = new THREE.PointLight(lightColor, 1.5, 6);
      light.position.set(ox, 1.5, oz);
      scene.add(light);

      obstacles.push({
        mesh: group,
        spike: spikeMesh,
        light: light,
        x: ox,
        z: oz,
        radius: 1.7 * randScale,
        color: lightColor,
        active: true,
        respawnTimer: 0
      });
    }
  }
  buildObstacles();

  /* ──────────────────────────────────────────
     Power-ups (Verde: Misil, Rojo: Teledirigido, Amarillo: Turbo)
  ────────────────────────────────────────── */
  const POWERUP_COUNT = 24;
  const POWERUP_RESPAWN = 6.0;
  const POWERUP_PICKUP_RADIUS = 2.5;
  const powerups = [];

  function buildPowerups() {
    const boxGeo = new THREE.OctahedronGeometry(0.75, 0);
    const ringGeo = new THREE.TorusGeometry(1.1, 0.06, 8, 20);

    const materials = {
      missile: { // Verde
        gem: new THREE.MeshStandardMaterial({ color: 0x00ff66, emissive: 0x00cc44, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.6 }),
        ring: new THREE.MeshStandardMaterial({ color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 1.5, transparent: true, opacity: 0.6 })
      },
      homing: { // Rojo
        gem: new THREE.MeshStandardMaterial({ color: 0xff2244, emissive: 0xcc0022, emissiveIntensity: 1.5, roughness: 0.25, metalness: 0.6 }),
        ring: new THREE.MeshStandardMaterial({ color: 0xff2244, emissive: 0xff2244, emissiveIntensity: 1.5, transparent: true, opacity: 0.6 })
      },
      boost: { // Amarillo
        gem: new THREE.MeshStandardMaterial({ color: 0xffcc00, emissive: 0xff9500, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.6 }),
        ring: new THREE.MeshStandardMaterial({ color: 0xffcc00, emissive: 0xffcc00, emissiveIntensity: 1.5, transparent: true, opacity: 0.6 })
      }
    };

    const types = ['missile', 'homing', 'boost'];

    for (let i = 0; i < POWERUP_COUNT; i++) {
      // Offset longitudinal respecto a los obstáculos para evitar coincidencias
      const frac = ((i + 0.18) / POWERUP_COUNT) % 1;
      const s = trackSamples[Math.floor(frac * TRACK_SAMPLES)];
      const lane = [0, 0.65, -0.65, 0.35, -0.35][i % 5];
      let lateral = lane * (HALF_WIDTH - 3.5);

      let px = s.x + s.normal.x * lateral;
      let pz = s.z + s.normal.z * lateral;

      // Garantizar separación estricta con obstáculos (mínimo 10 unidades)
      for (const obs of obstacles) {
        const dx = px - obs.x;
        const dz = pz - obs.z;
        if (dx * dx + dz * dz < 100) {
          lateral = -lateral;
          if (Math.abs(lateral) < 2) lateral = (HALF_WIDTH - 4.5);
          px = s.x + s.normal.x * lateral;
          pz = s.z + s.normal.z * lateral;
          break;
        }
      }

      const type = types[i % 3];
      const mats = materials[type];

      const group = new THREE.Group();
      const gem = new THREE.Mesh(boxGeo, mats.gem);
      const ring = new THREE.Mesh(ringGeo, mats.ring);
      ring.rotation.x = Math.PI / 2;
      group.add(gem, ring);
      group.position.set(px, 1.3, pz);
      scene.add(group);

      powerups.push({
        mesh: group,
        basePos: new THREE.Vector3(px, 1.3, pz),
        type,
        active: true,
        respawnTimer: 0
      });
    }
  }
  buildPowerups();

  /* ──────────────────────────────────────────
     Kart — geometría
  ────────────────────────────────────────── */
  const bodyGeo    = new THREE.BoxGeometry(1.8, 0.5, 3);
  const cockpitGeo = new THREE.BoxGeometry(1.2, 0.4, 1.5);
  const shieldGeo  = new THREE.BoxGeometry(1.1, 0.4, 0.1);

  // Rueda: el eje de giro está horneado en Z para que rotation.x = rodar
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.26, 8);
  rimGeo.rotateZ(Math.PI / 2);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.2 });
  const rimMat   = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.2, metalness: 0.9, emissive: 0x333333 });

  const WHEEL_DEFS = [
    { x: -1.1, y: 0.32, z:  1.0, front: true  },
    { x:  1.1, y: 0.32, z:  1.0, front: true  },
    { x: -1.1, y: 0.32, z: -1.0, front: false },
    { x:  1.1, y: 0.32, z: -1.0, front: false }
  ];

  function attachWheels(kartGroup, opts) {
    opts = opts || {};
    const tireMat     = opts.wheelMat || wheelMat;
    const wheelRimMat = opts.rimMat   || rimMat;
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
    color: 0xa30000, roughness: 0.3, metalness: 0.7,
    emissive: 0x3a0000, emissiveIntensity: 0.4
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.5;
  body.castShadow = true;
  kartGroup.add(body);

  const cockpitMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.9 });
  const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
  cockpit.position.set(0, 0.95, -0.2);
  cockpit.castShadow = true;
  kartGroup.add(cockpit);

  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x00d4ff, transparent: true, opacity: 0.3, roughness: 0, metalness: 1
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
    color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 3,
    transparent: true, opacity: 0.8
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

  const startSample = trackSamples[0];
  const startAngle0 = Math.atan2(startSample.tan.z, startSample.tan.x);
  kartGroup.position.set(startSample.x, 0.0, startSample.z);
  scene.add(kartGroup);

  /* ──────────────────────────────────────────
     Karts remotos (fantasmas)
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
      group, pos: group.position.clone(), angle: 0,
      targetPos: group.position.clone(), targetAngle: 0, lastSeen: performance.now()
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

  const REMOTE_TIMEOUT_MS = 8000;
  function updateRemoteKarts(dt) {
    const now = performance.now();
    for (const id in remoteKarts) {
      const e = remoteKarts[id];
      if (now - e.lastSeen > REMOTE_TIMEOUT_MS) { removeRemotePlayer(id); continue; }
      const smooth = Math.min(1, dt * 8);
      e.pos.lerp(e.targetPos, smooth);
      e.angle += shortestAngleDiff(e.angle, e.targetAngle) * smooth;
      e.group.position.copy(e.pos);

      if (e.spinOutTimer > 0) {
        e.spinOutTimer -= dt;
        e.group.rotation.y += dt * 20;
      } else {
        e.group.rotation.y = -e.angle + Math.PI / 2;
      }
    }
  }

  function triggerRemoteHit(targetId) {
    if (targetId === 'local') {
      if (window.SpiderKart && window.SpiderKart.spinOut) window.SpiderKart.spinOut();
      return;
    }
    const rk = remoteKarts[targetId];
    if (rk) {
      rk.spinOutTimer = 1.5;
      spawnPickupBurst(rk.pos.x, rk.pos.y + 0.5, rk.pos.z);
    }
  }

  /* ──────────────────────────────────────────
     Particles (exhaust smoke + drift sparks + pickup bursts)
  ────────────────────────────────────────── */
  const PARTICLE_COUNT = 300;
  const particleGeo = new THREE.BufferGeometry();
  const pPositions = new Float32Array(PARTICLE_COUNT * 3);
  const pColors    = new Float32Array(PARTICLE_COUNT * 3);
  const pVelocities = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pPositions[i * 3] = pPositions[i * 3 + 1] = pPositions[i * 3 + 2] = 0;
    pColors[i * 3] = 1; pColors[i * 3 + 1] = 0.3; pColors[i * 3 + 2] = 0.1;
    pVelocities.push({ x: 0, y: 0, z: 0, life: 0, maxLife: 0 });
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
  particleGeo.setAttribute('color',    new THREE.BufferAttribute(pColors,    3));
  const particleMat = new THREE.PointsMaterial({
    size: 0.22, transparent: true, opacity: 0.85,
    sizeAttenuation: true, vertexColors: true
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  particles.frustumCulled = false;
  scene.add(particles);
  let nextParticle = 0;

  function spawnParticle(x, y, z, vx, vy, vz, r = 1, g = 0.3, b = 0.1) {
    const i = nextParticle % PARTICLE_COUNT;
    pPositions[i * 3] = x; pPositions[i * 3 + 1] = y; pPositions[i * 3 + 2] = z;
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
      spawnParticle(x, y, z, Math.cos(a) * speed, 0.06 + Math.random() * 0.06, Math.sin(a) * speed, 1, 0.8, 0.15);
    }
  }

  function spawnObstacleExplosion(x, y, z, colorHex) {
    const c = new THREE.Color(colorHex || 0x00ff55);
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.07 + Math.random() * 0.12;
      spawnParticle(
        x, y + 0.5, z,
        Math.cos(a) * speed,
        0.08 + Math.random() * 0.08,
        Math.sin(a) * speed,
        c.r, c.g, c.b
      );
    }
  }

  // Chispas de derrape en las ruedas traseras
  function spawnDriftSparks(driftPower) {
    const rearX = state.posX - Math.cos(state.angle) * 1.2;
    const rearZ = state.posZ - Math.sin(state.angle) * 1.2;
    // Color: azul al inicio → naranja con potencia alta
    const r = Math.min(1, driftPower * 2);
    const g = Math.max(0, 0.6 - driftPower);
    const b = Math.max(0, 1 - driftPower * 2.5);
    for (let i = 0; i < 3; i++) {
      const a = state.angle + (Math.random() - 0.5) * 1.2;
      const spd = 0.04 + Math.random() * 0.06;
      spawnParticle(
        rearX + (Math.random() - 0.5) * 0.8,
        state.posY + 0.15 + Math.random() * 0.2,
        rearZ + (Math.random() - 0.5) * 0.8,
        Math.cos(a) * spd,
        0.03 + Math.random() * 0.05,
        Math.sin(a) * spd,
        r, g, b
      );
    }
  }

  /* ──────────────────────────────────────────
     Stars background
  ────────────────────────────────────────── */
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(4500);
  for (let i = 0; i < 4500; i++) starPos[i] = (Math.random() - 0.5) * 1000;
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, transparent: true, opacity: 0.6 })));

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
     Checkpoints
  ────────────────────────────────────────── */
  const CHECKPOINT_COUNT = 15;
  const checkpoints = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    const idx = Math.floor((i / CHECKPOINT_COUNT) * TRACK_SAMPLES);
    checkpoints.push({ idx, t: trackSamples[idx].t });
  }
  const CHECKPOINT_TOLERANCE = Math.floor(TRACK_SAMPLES / CHECKPOINT_COUNT / 2);

  function sampleIdxDelta(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, TRACK_SAMPLES - d);
  }

  function resetCheckpoints() {
    state.nextCheckpoint = 1;
    state.checkpointsPassed = 0;
  }

  function updateCheckpointProgress(sampleIdx) {
    // No avanzar checkpoints si vamos en sentido contrario
    if (state.isWrongWay) return;

    const target = checkpoints[state.nextCheckpoint];
    if (sampleIdxDelta(sampleIdx, target.idx) > CHECKPOINT_TOLERANCE) return;

    const isFinishCheckpoint = state.nextCheckpoint === 0;
    // Para la meta: el kart debe estar ya AL OTRO LADO de la línea (bestIdx cerca de 0),
    // no antes (bestIdx cerca de TRACK_SAMPLES). Esto evita el cierre prematuro.
    if (isFinishCheckpoint) {
      // Sólo permitir el cierre si el índice actual es pequeño (kart pasó la línea)
      if (sampleIdx > CHECKPOINT_TOLERANCE * 2) return;
    }
    const closingLap = isFinishCheckpoint
      && state.checkpointsPassed >= CHECKPOINT_COUNT - 1; // Exige haber pasado todos los anteriores
    state.nextCheckpoint = (state.nextCheckpoint + 1) % CHECKPOINT_COUNT;

    if (closingLap) {
      // Vuelta completada
      const now = performance.now();
      const lapTime = now - state.lapStartTime;
      state.lapStartTime = now;

      if (state.bestLap < 0 || lapTime < state.bestLap) {
        state.bestLap = lapTime;
      }
      state.lastLapTime = lapTime;

      state.lap += 1;
      state.checkpointsPassed = 0;

      // Actualizar HUD vuelta — mostrar vuelta ACTUAL (recien completada +1)
      const displayLap = Math.min(state.lap + 1, TOTAL_LAPS);
      if (hudLap) hudLap.textContent = `VUELTA ${displayLap} / ${TOTAL_LAPS}`;
      if (hudLapTime) hudLapTime.textContent = 'VUELTA: ' + formatTime(lapTime);
      if (hudBestLap && state.bestLap >= 0) hudBestLap.textContent = 'MEJOR: ' + formatTime(state.bestLap);

      // Mostrar cartel de vuelta (no en la vuelta 1 inicial)
      if (state.lap >= 1 && !state.raceFinished) {
        showLapAnnounce(state.lap + 1, TOTAL_LAPS);
      }

      // Chequear fin de carrera
      if (state.lap >= TOTAL_LAPS && !state.raceFinished) {
        state.raceFinished = true;
        state.raceEndTime = now;
        showFinishScreen();
      }
    } else {
      state.checkpointsPassed++;
    }
  }

  /* ──────────────────────────────────────────
     Carrera — constantes y tiempo
  ────────────────────────────────────────── */
  const TOTAL_LAPS = 5;

  function formatTime(ms) {
    if (ms < 0) return '--:--.---';
    const m   = Math.floor(ms / 60000);
    const s   = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    return `${m}:${String(s).padStart(2,'0')}.${String(mil).padStart(3,'0')}`;
  }

  function showFinishScreen() {
    const finishEl = document.getElementById('finish-screen');
    if (!finishEl) return;
    const totalTime = state.raceEndTime - state.raceStartTime;
    const fsTotal = document.getElementById('fs-total-time');
    const fsBest  = document.getElementById('fs-best-time');
    if (fsTotal) fsTotal.textContent = formatTime(totalTime);
    if (fsBest)  fsBest.textContent  = formatTime(state.bestLap);
    finishEl.classList.add('active');
  }

  /* ──────────────────────────────────────────
     Physics state
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
    nextCheckpoint: 1,
    checkpointsPassed: 0,
    isWrongWay: false,
    wrongWayTimer: 0, // Segundos acumulados yendo en sentido contrario
    // Drift
    isDrifting: false,
    driftPower: 0,      // 0..1 — crece mientras dura el derrape
    driftDir: 0,        // dirección fijada al iniciar el derrape: -1 izq, +1 der
    driftBoostPending: 0, // mini-turbo acumulado al soltar el drift
    wasJumpingAndTurning: false,
    // Tiempo — raceStartTime se actualiza al primer movimiento real
    raceStartTime: performance.now(),
    lapStartTime:  performance.now(),
    raceTimerStarted: false, // El cronómetro no empieza hasta el primer aceleración
    lastLapTime: -1,
    bestLap: -1,
    raceFinished: false,
    raceEndTime: 0,
    isLocked: true,
    missiles: [], // Almacén de hasta 3 misiles
    missileCooldown: 0,
    spinOutTimer: 0,
    invulnerableTimer: 0
  };

  const activeMissiles = [];

  const ACCEL      = 0.012;
  const MAX_SPEED  = 0.6;
  const BOOST_MULT = 1.8;
  const STEER      = 0.032;
  const GRAVITY    = -0.018;
  const JUMP_VEL   = 0.16;   // salto más corto para favorecer mecánica de derrape
  const GROUND_Y   = 0;
  const WALL_MARGIN     = 0.9;
  const WALL_CORRECTION = 0.35;
  const WALL_FRICTION   = 0.965;
  const MAX_STEER_VISUAL = 0.5;

  /* ──────────────────────────────────────────
     HUD references (game.html has them pre-built)
  ────────────────────────────────────────── */
  const hudSpeed       = document.getElementById('hud-speed');
  const hudFill        = document.getElementById('hud-power-fill');
  const hudPowerFx     = document.getElementById('hud-power-fx');
  const hudLap         = document.getElementById('hud-lap');
  const hudItemFx      = document.getElementById('hud-item-fx');
  const hudProgressFill= document.getElementById('hud-progress-fill');
  const hudTimer       = document.getElementById('hud-timer');
  const hudLapTime     = document.getElementById('hud-lap-time');
  const hudBestLap     = document.getElementById('hud-best-lap');
  const hudWrongWay    = document.getElementById('hud-wrong-way');
  const hudDrift       = document.getElementById('hud-drift');
  const driftBar       = document.getElementById('drift-bar');
  const minimapCanvas  = document.getElementById('minimap-canvas');
  const minimapCtx     = minimapCanvas ? minimapCanvas.getContext('2d') : null;
  const hudCountdown    = document.getElementById('hud-countdown');
  const hudCountdownNum = document.getElementById('hud-countdown-num');
  const wrongWayBar     = document.getElementById('wrong-way-bar');
  const hudLapAnnounce  = document.getElementById('hud-lap-announce');
  const lapAnnounceNum  = document.getElementById('lap-announce-num');
  const lapAnnounceLabel= document.getElementById('lap-announce-label');
  let lapAnnounceTimer  = null;

  function showLapAnnounce(lap, totalLaps) {
    if (!hudLapAnnounce) return;
    const isLast = lap > totalLaps;
    // Re-leer nodos frescos del DOM (pueden haber sido reemplazados en llamadas anteriores)
    const numEl = document.getElementById('lap-announce-num');
    const lblEl = document.getElementById('lap-announce-label');
    if (!numEl || !lblEl) return;
    lblEl.textContent = isLast ? '¡ÚLTIMA' : 'VUELTA';
    numEl.textContent = isLast ? 'VUELTA!' : String(lap);
    numEl.classList.toggle('last-lap', isLast);
    hudLapAnnounce.classList.remove('hidden');
    // Reiniciar animación CSS clonando el nodo (fuerza reflow)
    const numClone = numEl.cloneNode(true);
    numEl.replaceWith(numClone);
    const lblClone = lblEl.cloneNode(true);
    lblEl.replaceWith(lblClone);
    if (lapAnnounceTimer) clearTimeout(lapAnnounceTimer);
    lapAnnounceTimer = setTimeout(() => {
      hudLapAnnounce.classList.add('hidden');
    }, 2500);
  }
  const missileSlots = [
    document.getElementById('missile-slot-0'),
    document.getElementById('missile-slot-1'),
    document.getElementById('missile-slot-2')
  ];

  function updateMissileHUD() {
    for (let i = 0; i < 3; i++) {
      const slot = missileSlots[i];
      if (!slot) continue;
      const item = state.missiles[i];
      if (item === 'missile') {
        slot.className = 'sk-missile-slot active-straight';
        slot.innerHTML = '<i class="fa-solid fa-crosshair"></i>';
      } else if (item === 'homing') {
        slot.className = 'sk-missile-slot active-homing';
        slot.innerHTML = '<i class="fa-solid fa-bullseye"></i>';
      } else if (item === 'boost') {
        slot.className = 'sk-missile-slot active-boost';
        slot.innerHTML = '<i class="fa-solid fa-bolt"></i>';
      } else {
        slot.className = 'sk-missile-slot';
        slot.innerHTML = '<i class="fa-solid fa-crosshair"></i>';
      }
    }
  }

  let localCountdownTimer = null;

  function showCountdownNum(val) {
    if (!hudCountdown || !hudCountdownNum) return;
    hudCountdown.classList.remove('hidden');
    hudCountdownNum.textContent = val;
    hudCountdownNum.classList.toggle('go', val === 'GO!' || val === '¡GO!');
    void hudCountdownNum.offsetWidth;
    hudCountdownNum.style.animation = 'none';
    requestAnimationFrame(() => { hudCountdownNum.style.animation = ''; });
  }

  function hideCountdown() {
    if (hudCountdown) hudCountdown.classList.add('hidden');
  }

  function startLocalCountdown() {
    if (localCountdownTimer) clearInterval(localCountdownTimer);
    state.isLocked = true;
    let count = 5;
    showCountdownNum(count);

    localCountdownTimer = setInterval(() => {
      count--;
      if (count > 0) {
        showCountdownNum(count);
      } else if (count === 0) {
        showCountdownNum('GO!');
        state.isLocked = false;
        state.raceStartTime = performance.now();
        state.lapStartTime  = performance.now();
      } else {
        clearInterval(localCountdownTimer);
        localCountdownTimer = null;
        setTimeout(hideCountdown, 800);
      }
    }, 1000);
  }

  /* ──────────────────────────────────────────
     Minimapa — pre-calculo de bounds y puntos
  ────────────────────────────────────────── */
  let mmMinX = Infinity, mmMaxX = -Infinity, mmMinZ = Infinity, mmMaxZ = -Infinity;
  trackSamples.forEach(s => {
    if (s.x < mmMinX) mmMinX = s.x; if (s.x > mmMaxX) mmMaxX = s.x;
    if (s.z < mmMinZ) mmMinZ = s.z; if (s.z > mmMaxZ) mmMaxZ = s.z;
  });
  const mmPad = 10;
  mmMinX -= mmPad; mmMaxX += mmPad; mmMinZ -= mmPad; mmMaxZ += mmPad;

  function worldToMinimap(x, z) {
    const cw = minimapCanvas ? minimapCanvas.width  : 140;
    const ch = minimapCanvas ? minimapCanvas.height : 140;
    const nx = (x - mmMinX) / (mmMaxX - mmMinX);
    const nz = (z - mmMinZ) / (mmMaxZ - mmMinZ);
    return { mx: nx * cw, my: nz * ch };
  }

  function drawMinimap() {
    if (!minimapCtx || !minimapCanvas) return;
    const cw = minimapCanvas.width;
    const ch = minimapCanvas.height;
    minimapCtx.clearRect(0, 0, cw, ch);

    // Fondo
    minimapCtx.fillStyle = 'rgba(5,5,12,0.85)';
    minimapCtx.fillRect(0, 0, cw, ch);

    // Trazado del circuito
    minimapCtx.beginPath();
    const step = 4; // saltear samples para no dibujar cada uno
    for (let i = 0; i < TRACK_SAMPLES; i += step) {
      const s = trackSamples[i];
      const { mx, my } = worldToMinimap(s.x, s.z);
      if (i === 0) minimapCtx.moveTo(mx, my);
      else         minimapCtx.lineTo(mx, my);
    }
    minimapCtx.closePath();
    minimapCtx.strokeStyle = 'rgba(255,255,255,0.18)';
    minimapCtx.lineWidth = 7;
    minimapCtx.stroke();

    // Línea central roja
    minimapCtx.beginPath();
    for (let i = 0; i < TRACK_SAMPLES; i += step) {
      const s = trackSamples[i];
      const { mx, my } = worldToMinimap(s.x, s.z);
      if (i === 0) minimapCtx.moveTo(mx, my);
      else         minimapCtx.lineTo(mx, my);
    }
    minimapCtx.closePath();
    minimapCtx.strokeStyle = 'rgba(163,0,0,0.55)';
    minimapCtx.lineWidth = 2;
    minimapCtx.stroke();

    // Obstáculos en minimapa con sus respectivos colores neón (solo si están activos)
    for (const obs of obstacles) {
      if (!obs.active) continue;
      const { mx: ox, my: oz } = worldToMinimap(obs.x, obs.z);
      minimapCtx.fillStyle = obs.color ? '#' + obs.color.toString(16).padStart(6, '0') : '#ff0055';
      minimapCtx.beginPath();
      minimapCtx.arc(ox, oz, 2.5, 0, Math.PI * 2);
      minimapCtx.fill();
    }

    // Punto del jugador
    const { mx: px, my: pz } = worldToMinimap(state.posX, state.posZ);
    // Sombra/glow
    minimapCtx.shadowColor = 'rgba(0,212,255,0.8)';
    minimapCtx.shadowBlur = 6;
    minimapCtx.beginPath();
    minimapCtx.arc(px, pz, 3.5, 0, Math.PI * 2);
    minimapCtx.fillStyle = state.isWrongWay ? '#ff0000' : '#00d4ff';
    minimapCtx.fill();
    minimapCtx.shadowBlur = 0;

    // Línea de meta
    const { mx: sx, my: sz } = worldToMinimap(trackSamples[0].x, trackSamples[0].z);
    minimapCtx.beginPath();
    minimapCtx.arc(sx, sz, 3, 0, Math.PI * 2);
    minimapCtx.fillStyle = '#ffffff';
    minimapCtx.fill();
  }

  /* ──────────────────────────────────────────
     Track collision + progreso de vuelta
  ────────────────────────────────────────── */
  function resolveTrackCollision(dt) {
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
      const push = penetration * WALL_CORRECTION;
      state.posX -= sample.normal.x * side * push;
      state.posZ -= sample.normal.z * side * push;

      const velX = Math.cos(state.angle) * state.speed;
      const velZ = Math.sin(state.angle) * state.speed;
      const vTangent = velX * sample.tan.x + velZ * sample.tan.z;
      state.speed = vTangent * WALL_FRICTION;
    }

    // Detección de sentido contrario
    const dirX = Math.cos(state.angle);
    const dirZ = Math.sin(state.angle);
    const dot = dirX * sample.tan.x + dirZ * sample.tan.z;
    // Solo activa el aviso si el kart se mueve (no si está quieto)
    const nowWrongWay = (Math.abs(state.speed) > 0.04) && (dot < -0.2);
    state.isWrongWay = nowWrongWay;

    // Acumular tiempo en sentido contrario
    if (nowWrongWay) {
      // dt se pasa desde update() pero aquí no tenemos acceso — usamos un estimado de 1/60
      // Se acumula via resolveTrackCollision que se llama cada frame desde update(dt)
      state.wrongWayTimer += dt;
      if (state.wrongWayTimer >= 5.0) {
        // Teleportar al último checkpoint válido que el jugador cruzó
        const lastCpIdx = ((state.nextCheckpoint - 1) + CHECKPOINT_COUNT) % CHECKPOINT_COUNT;
        const lastCp = checkpoints[lastCpIdx];
        const cpSample = trackSamples[lastCp.idx];
        // Posicionar al kart en el checkpoint, orientado en el sentido correcto
        state.posX = cpSample.x;
        state.posZ = cpSample.z;
        state.posY = 0;
        state.angle = Math.atan2(cpSample.tan.z, cpSample.tan.x);
        state.speed = 0;
        state.isWrongWay = false;
        state.wrongWayTimer = 0;
        spawnPickupBurst(state.posX, 1.0, state.posZ);
      }
    } else {
      state.wrongWayTimer = 0;
    }

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
          
          if (state.missiles.length < 3) {
            const newItem = p.type || 'missile';
            state.missiles.push(newItem);
            updateMissileHUD();

            if (hudItemFx) {
              hudItemFx.classList.remove('hidden');
              hudItemFx.textContent = newItem === 'homing' ? 'MISIL TELEDIRIGIDO' : (newItem === 'boost' ? 'TURBO VELOCIDAD' : 'MISIL PUNTERÍA');
              hudItemFx.style.color = newItem === 'homing' ? '#ff2244' : (newItem === 'boost' ? '#ffcc00' : '#00ff66');
              void hudItemFx.offsetWidth;
              hudItemFx.style.animation = 'none';
              requestAnimationFrame(() => { hudItemFx.style.animation = ''; });
            }
          }
        }
      } else {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) {
          p.active = true; p.mesh.visible = true; p.mesh.scale.setScalar(0.2);
        } else if (p.mesh.scale.x < 1) {
          p.mesh.scale.setScalar(Math.min(1, p.mesh.scale.x + dt * 3));
        }
      }
    }
  }

  /* ──────────────────────────────────────────
     Missiles (Misiles y Misiles Teledirigidos)
  ────────────────────────────────────────── */
  const missileGeo = new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8);
  missileGeo.rotateX(Math.PI / 2);
  const missileMatGreen = new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.4 });
  const missileMatRed = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.4 });

  function spawnMissile(type) {
    const isHoming = type === 'homing';
    const mesh = new THREE.Mesh(missileGeo, isHoming ? missileMatRed : missileMatGreen);
    // Posicionar adelante del kart
    const startX = state.posX + Math.cos(state.angle) * 2;
    const startZ = state.posZ + Math.sin(state.angle) * 2;
    mesh.position.set(startX, state.posY + 0.5, startZ);
    mesh.rotation.y = -state.angle + Math.PI / 2;
    scene.add(mesh);
    
    activeMissiles.push({
      mesh,
      type,
      x: startX, y: state.posY + 0.5, z: startZ,
      angle: state.angle,
      speed: 1.2, // Doble de rápido que un kart
      life: 5.0 // Segundos antes de desaparecer
    });
  }

  function updateMissiles(dt) {
    for (let i = activeMissiles.length - 1; i >= 0; i--) {
      const m = activeMissiles[i];
      m.life -= dt;
      if (m.life <= 0) {
        scene.remove(m.mesh);
        activeMissiles.splice(i, 1);
        continue;
      }

      if (m.type === 'homing') {
        // Buscar el kart más cercano por delante
        let bestTarget = null;
        let bestDist = Infinity;
        for (const id in remoteKarts) {
          const rk = remoteKarts[id];
          const dx = rk.pos.x - m.x;
          const dz = rk.pos.z - m.z;
          const dist = Math.sqrt(dx*dx + dz*dz);
          if (dist < 40) { // Rango de visión
            const angleToTarget = Math.atan2(dz, dx);
            const angleDiff = Math.abs(shortestAngleDiff(m.angle, angleToTarget));
            if (angleDiff < Math.PI / 3 && dist < bestDist) { // Solo si está más o menos en frente
              bestDist = dist;
              bestTarget = rk;
            }
          }
        }
        if (bestTarget) {
          const dx = bestTarget.pos.x - m.x;
          const dz = bestTarget.pos.z - m.z;
          const targetAngle = Math.atan2(dz, dx);
          const diff = shortestAngleDiff(m.angle, targetAngle);
          m.angle += diff * Math.min(1, dt * 4); // Girar hacia el objetivo
        }
      }

      m.x += Math.cos(m.angle) * m.speed;
      m.z += Math.sin(m.angle) * m.speed;
      m.mesh.position.set(m.x, m.y, m.z);
      m.mesh.rotation.y = -m.angle + Math.PI / 2;

      // Estela de partículas del misil
      for (let k = 0; k < 2; k++) {
        spawnParticle(
          m.x + (Math.random() - 0.5) * 0.3,
          m.y + (Math.random() - 0.5) * 0.3,
          m.z + (Math.random() - 0.5) * 0.3,
          (Math.random() - 0.5) * 0.03,
          Math.random() * 0.04,
          (Math.random() - 0.5) * 0.03,
          m.type === 'homing' ? 1.0 : 0.2,
          m.type === 'homing' ? 0.2 : 1.0,
          0.2
        );
      }

      // Colisión con otros karts
      let hitSomeone = false;
      for (const id in remoteKarts) {
        const rk = remoteKarts[id];
        const dx = rk.pos.x - m.x;
        const dz = rk.pos.z - m.z;
        if (dx*dx + dz*dz < 4) { // Radio de colisión 2^2
          hitSomeone = true;
          spawnPickupBurst(m.x, m.y, m.z); // Explosión visual
          triggerRemoteHit(id);
          if (window.SpiderKartMultiplayer && window.SpiderKartMultiplayer.sendHit) {
            window.SpiderKartMultiplayer.sendHit(id);
          }
          break;
        }
      }

      // Colisión con obstáculos (solo misiles verdes 'missile')
      let hitObstacle = false;
      if (!hitSomeone && m.type === 'missile') {
        for (const obs of obstacles) {
          if (!obs.active) continue;
          const dx = obs.x - m.x;
          const dz = obs.z - m.z;
          const hitRadius = obs.radius + 0.6;
          if (dx * dx + dz * dz < hitRadius * hitRadius) {
            hitObstacle = true;
            obs.active = false;
            obs.respawnTimer = OBSTACLE_RESPAWN;
            obs.mesh.visible = false;
            if (obs.light) obs.light.visible = false;
            spawnPickupBurst(obs.x, 1.0, obs.z);
            spawnObstacleExplosion(obs.x, 1.0, obs.z, obs.color);
            break;
          }
        }
      }

      if (hitSomeone || hitObstacle) {
        if (hitObstacle) {
          spawnPickupBurst(m.x, m.y, m.z);
        }
        scene.remove(m.mesh);
        activeMissiles.splice(i, 1);
      }
    }
  }

  /* ──────────────────────────────────────────
     Game Loop
  ────────────────────────────────────────── */
  const clock = new THREE.Clock();

  function update(dt) {
    if (state.raceFinished) return; // congelar al terminar
    
    updateMissiles(dt);

    if (state.invulnerableTimer > 0) {
      state.invulnerableTimer -= dt;
    }

    // ── Colisión y Regeneración de Obstáculos ──
    for (const obs of obstacles) {
      if (!obs.active) {
        obs.respawnTimer -= dt;
        if (obs.respawnTimer <= 0) {
          obs.active = true;
          obs.mesh.visible = true;
          if (obs.light) obs.light.visible = true;
          spawnPickupBurst(obs.x, 1.0, obs.z);
        }
        continue;
      }
      if (obs.spike) obs.spike.rotation.y += dt * 2.0;
      const dx = state.posX - obs.x;
      const dz = state.posZ - obs.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < obs.radius * obs.radius) {
        if (state.spinOutTimer <= 0 && state.invulnerableTimer <= 0) {
          state.spinOutTimer = 1.5; // Gira durante 1.5 segundos
          state.invulnerableTimer = 3.0; // 1.5s giro + 1.5s cooldown de inmunidad
          state.speed *= 0.2;
          spawnPickupBurst(obs.x, 1.0, obs.z);
        }
      }
    }

    // ── Bloqueo de largada ──
    if (state.isLocked) {
      updateRemoteKarts(dt);
      return;
    }

    // ── Trompo (Spin Out) ──
    if (state.spinOutTimer > 0) {
      state.spinOutTimer -= dt;
      state.speed *= 0.9;
      state.posX += Math.cos(state.angle) * state.speed;
      state.posZ += Math.sin(state.angle) * state.speed;
      resolveTrackCollision();
      updateRemoteKarts(dt);
      
      kartGroup.position.set(state.posX, state.posY, state.posZ);
      kartGroup.rotation.y += dt * 20; // Girar durante 1.5s
      kartGroup.visible = true;
      return;
    }

    // Parpadeo visual durante el cooldown de inmunidad (2.4 segundos post-trompo)
    if (state.invulnerableTimer > 0) {
      kartGroup.visible = Math.floor(performance.now() / 90) % 2 === 0;
    } else {
      kartGroup.visible = true;
    }

    const forward    = (keys['KeyW'] || keys['ArrowUp']);
    const backward   = (keys['KeyS'] || keys['ArrowDown']);
    const left       = (keys['KeyA'] || keys['ArrowLeft']);
    const right      = (keys['KeyD'] || keys['ArrowRight']);
    const jumpKey    = keys['Space'];
    const powerKey   = keys['KeyK'];
    const missileKey = keys['KeyE'];
    const turning    = left || right;

    // ── Turbo (Tecla K) ──
    if (state.powerCooldown > 0) state.powerCooldown -= dt;
    if (powerKey && state.powerTimer <= 0 && state.powerCooldown <= 0) {
      state.powerTimer = 3.0;
      state.powerCooldown = 1.0;
    }

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

    // ── Disparo de Misiles / Usar Ítem (Tecla E) ──
    if (state.missileCooldown > 0) state.missileCooldown -= dt;
    if (missileKey && state.missiles.length > 0 && state.missileCooldown <= 0) {
      const launched = state.missiles.shift();
      if (launched === 'boost') {
        state.powerTimer = 3.0;
        state.boost = BOOST_MULT;
      } else {
        spawnMissile(launched);
      }
      updateMissileHUD();
      state.missileCooldown = 0.3;
    }

    // ── Aceleración ──
    if (forward) {
      state.speed = Math.min(state.speed + ACCEL * state.boost, MAX_SPEED * state.boost);
    } else if (backward) {
      state.speed = Math.max(state.speed - ACCEL, -MAX_SPEED * 0.5);
    } else {
      state.speed *= 0.96;
      if (Math.abs(state.speed) < 0.001) state.speed = 0;
    }

    // ── Steering ──
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

    // ── Salto ──
    if (state.jumpCooldown > 0) state.jumpCooldown -= dt;
    if (jumpKey && state.isGrounded && state.jumpCooldown <= 0 && !state.isDrifting) {
      state.velY = JUMP_VEL;
      state.isGrounded = false;
      state.jumpCooldown = 0.5;
    }

    // ── Derrape (Drift) Mario Kart Style ──
    // Al saltar y girar, se fija la dirección del derrape
    if (jumpKey && turning) {
      if (state.isGrounded && !state.isDrifting && state.jumpCooldown > 0) {
        state.isDrifting = true;
        state.driftDir = right ? 1 : -1; // Fijar dirección al iniciar
      }
    }

    if (!jumpKey) {
      if (state.isDrifting) {
        // Soltar el drift: mini-turbo
        state.driftBoostPending = state.driftPower;
        state.isDrifting = false;
        state.driftPower = 0;
        state.driftDir = 0;
        if (state.driftBoostPending > 0.25) {
          const boostDuration = 0.5 + state.driftBoostPending * 1.5;
          state.powerTimer = Math.max(state.powerTimer, boostDuration);
        }
        state.driftBoostPending = 0;
      }
    }

    if (state.isDrifting) {
      state.driftPower = Math.min(state.driftPower + dt * 0.7, 1.0);
      // Curvatura del derrape: escalada por dt para no depender del framerate
      // Reducida a 0.45 rad/s para que sea controlable pero notoria
      const driftSteer = STEER * 0.45 * dt * 60;
      state.angle += driftSteer * state.driftDir;
      spawnDriftSparks(state.driftPower);
    }

    // ── Gravedad ──
    if (!state.isGrounded) {
      state.velY += GRAVITY;
      state.posY += state.velY;
      if (state.posY <= GROUND_Y) {
        state.posY = GROUND_Y;
        state.velY = 0;
        state.isGrounded = true;
      }
    }

    // ── Movimiento ──
    state.posX += Math.cos(state.angle) * state.speed;
    state.posZ += Math.sin(state.angle) * state.speed;

    resolveTrackCollision(dt);
    updatePowerups(dt);
    updateRemoteKarts(dt);

    // ── Kart mesh ──
    kartGroup.position.set(state.posX, state.posY, state.posZ);
    kartGroup.rotation.y = -state.angle + Math.PI / 2;

    // Inclinación lateral en drift
    if (state.isDrifting) {
      const tiltDir = left ? -1 : right ? 1 : 0;
      kartGroup.rotation.z = THREE.MathUtils.lerp(kartGroup.rotation.z, tiltDir * 0.18, 0.15);
    } else {
      kartGroup.rotation.z = THREE.MathUtils.lerp(kartGroup.rotation.z, 0, 0.1);
    }

    // ── Ruedas ──
    state.wheelRot -= state.speed * 2.6;
    wheelRig.forEach(w => {
      w.spin.rotation.x = state.wheelRot;
      if (w.steer) w.steer.rotation.y = -state.steerAngle * (MAX_STEER_VISUAL / 0.4);
    });

    // ── Partículas de escape ──
    if (Math.abs(state.speed) > 0.03) {
      const bx = state.posX - Math.cos(state.angle) * 1.7;
      const bz = state.posZ - Math.sin(state.angle) * 1.7;
      for (let i = 0; i < (state.powerActive ? 4 : 1); i++) {
        spawnParticle(
          bx + (Math.random() - 0.5) * 0.5, state.posY + 0.4,
          bz + (Math.random() - 0.5) * 0.5,
          (Math.random() - 0.5) * 0.04, Math.random() * 0.04,
          (Math.random() - 0.5) * 0.04, 1, 0.3, 0.1
        );
      }
    }

    // ── Update particles ──
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (pVelocities[i].life > 0) {
        pVelocities[i].life -= dt * 1.5;
        pPositions[i * 3]     += pVelocities[i].x;
        pPositions[i * 3 + 1] += pVelocities[i].y;
        pPositions[i * 3 + 2] += pVelocities[i].z;
        pVelocities[i].y -= 0.002;
        if (pVelocities[i].life <= 0) {
          pPositions[i * 3] = pPositions[i * 3 + 1] = pPositions[i * 3 + 2] = 0;
          pColors[i * 3] = pColors[i * 3 + 1] = pColors[i * 3 + 2] = 0;
        }
      }
    }
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.color.needsUpdate = true;

    // ── Luces ──
    redLight.position.set(state.posX, state.posY + 4, state.posZ);
    kartLight.intensity = state.powerActive ? 4 + Math.sin(Date.now() * 0.02) * 2 : 2;

    // ── Cámara ──
    const camDist   = 10;
    const camHeight = 5;
    const camX = state.posX - Math.cos(state.angle) * camDist;
    const camZ = state.posZ - Math.sin(state.angle) * camDist;
    camera.position.lerp(new THREE.Vector3(camX, state.posY + camHeight, camZ), 0.08);
    camera.lookAt(state.posX, state.posY + 1.5, state.posZ);

    // ── HUD ──
    const kmh = Math.round(Math.abs(state.speed) * 300);
    if (hudSpeed) {
      hudSpeed.textContent = kmh;
      hudSpeed.classList.toggle('boosting', state.powerActive || state.isDrifting);
    }

    const powerPct = state.powerTimer > 0 ? (state.powerTimer / 3.0) * 100
      : state.powerCooldown > 0 ? (1 - state.powerCooldown / 10) * 100 : 100;
    if (hudFill) hudFill.style.width = powerPct + '%';

    if (hudProgressFill) {
      const progressPct = (state.checkpointsPassed / CHECKPOINT_COUNT) * 100;
      hudProgressFill.style.width = progressPct + '%';
    }

    // Cronómetro de carrera (solo avanza una vez que el jugador se mueve por primera vez)
    if (hudTimer && !state.raceFinished) {
      if (state.raceTimerStarted) {
        const elapsed = performance.now() - state.raceStartTime;
        hudTimer.textContent = formatTime(elapsed);
      } else {
        hudTimer.textContent = formatTime(0);
        // Arrancar cuando el jugador empiece a moverse
        if (!state.isLocked && Math.abs(state.speed) > 0.005) {
          state.raceTimerStarted = true;
          state.raceStartTime = performance.now();
          state.lapStartTime  = performance.now();
        }
      }
    }

    // Sentido contrario + barra de temporizador
    if (hudWrongWay) hudWrongWay.classList.toggle('hidden', !state.isWrongWay);
    if (wrongWayBar) wrongWayBar.style.width = Math.min(state.wrongWayTimer / 5.0 * 100, 100) + '%';

    // Indicador de drift
    if (hudDrift) {
      hudDrift.classList.toggle('hidden', !state.isDrifting);
      if (driftBar && state.isDrifting) {
        driftBar.style.width = (state.driftPower * 100) + '%';
        driftBar.style.background = state.driftPower > 0.6
          ? 'linear-gradient(90deg,#ff6600,#ffcc00)'
          : 'linear-gradient(90deg,#0066ff,#00ccff)';
      }
    }

    // Minimapa
    drawMinimap();
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    update(dt);
    renderer.render(scene, camera);
  }

  // Resize
  window.addEventListener('resize', () => {
    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // Finalizar carga
  if (typeof window._finishLoading === 'function') {
    setTimeout(window._finishLoading, 400);
  }

  /* ──────────────────────────────────────────
     API pública para multiplayer.js
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
    resetRace() {
      state.lap = 0;
      state.raceFinished = false;
      state.bestLap = -1;
      state.lastLapTime = -1;
      state.missiles = [];
      state.spinOutTimer = 0;
      state.invulnerableTimer = 0;
      state.raceTimerStarted = false;
      kartGroup.visible = true;
      updateMissileHUD();
      resetCheckpoints();
      for (const obs of obstacles) {
        obs.active = true;
        obs.respawnTimer = 0;
        obs.mesh.visible = true;
        if (obs.light) obs.light.visible = true;
      }
      if (hudLap) hudLap.textContent = `VUELTA 1 / ${TOTAL_LAPS}`;
      startLocalCountdown();
    },
    setCountdown(seconds) {
      if (localCountdownTimer) {
        clearInterval(localCountdownTimer);
        localCountdownTimer = null;
      }
      if (seconds > 0) {
        state.isLocked = true;
        showCountdownNum(seconds);
      } else {
        showCountdownNum('GO!');
        state.isLocked = false;
        state.raceStartTime = performance.now();
        state.lapStartTime  = performance.now();
        setTimeout(hideCountdown, 800);
      }
    },
    triggerRemoteHit,
    lockAndReset(positionIndex = 0) {
      state.isLocked = true;
      state.speed = 0;
      state.velY = 0;
      state.spinOutTimer = 0;
      state.invulnerableTimer = 0;
      state.wrongWayTimer = 0;
      kartGroup.visible = true;
      state.missiles = [];
      updateMissileHUD();
      
      // Offset lateral basado en positionIndex
      const lateralOffset = (positionIndex % 2 === 0 ? 1 : -1) * (2 + Math.floor(positionIndex/2) * 2);
      const backwardOffset = Math.floor(positionIndex/2) * 3;
      
      const s = trackSamples[0];
      const startAngle = Math.atan2(s.tan.z, s.tan.x);
      
      state.angle = startAngle;
      state.posX = s.x + s.normal.x * lateralOffset - Math.cos(startAngle) * backwardOffset;
      state.posZ = s.z + s.normal.z * lateralOffset - Math.sin(startAngle) * backwardOffset;
      state.posY = 0;
    },
    unlock() {
      state.isLocked = false;
    },
    spinOut() {
      if (state.spinOutTimer <= 0 && state.invulnerableTimer <= 0) {
        state.spinOutTimer = 1.5; // 1.5 segundos de trompo
        state.invulnerableTimer = 3.0; // 1.5s trompo + 1.5s cooldown
        state.speed = 0;
        state.powerActive = false;
        state.powerTimer = 0;
        state.boost = 1;
      }
    },
    trackHalfWidth: HALF_WIDTH,
    startPoint: { x: startSample.x, z: startSample.z, angle: startAngle0 }
  };

  // Iniciar conteo local al arrancar
  startLocalCountdown();

  animate();
})();