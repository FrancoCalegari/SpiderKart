/**
 * SpiderKart — Multiplayer por salas (v0.2)
 * ---------------------------------------------------------------
 * Este archivo es un ANDAMIO de cliente: implementa toda la parte
 * de UI, protocolo, sesión de piloto y sincronización de karts
 * remotos, asumiendo un servidor WebSocket con salas. Ese servidor
 * todavía NO existe — hasta que se despliegue, el cliente falla en
 * silencio, muestra "SIN SERVIDOR (modo local)" y, si está en modo
 * debug, deja jugar solo sin guardar resultados.
 *
 * Requiere que game-engine.js se cargue ANTES y exponga:
 *   window.SpiderKart.getLocalState()   -> incluye .lap
 *   window.SpiderKart.applyRemoteState(id, state, meta)
 *   window.SpiderKart.removeRemotePlayer(id)
 *   window.SpiderKart.resetRace()       -> reinicia vuelta/checkpoints
 *
 * ── Reglas de partida ─────────────────────────────────────────
 *   - Para jugar hace falta tener sesión de piloto iniciada: sin
 *     sesión no hay forma de guardar nombre/resultados, así que el
 *     panel pide "loguearse" (guardar el nombre como sesión local)
 *     antes de poder unirse a una sala.
 *   - Carrera por defecto: 3 vueltas (DEFAULT_LAPS).
 *   - Mínimo para arrancar una partida real: 2 jugadores listos
 *     (MIN_PLAYERS). Si falta gente, la sala queda "esperando".
 *   - Modo debug (window.SPIDERKART_DEBUG = true, o ?debug=1 en la
 *     URL): permite arrancar solo, con 1 jugador — pero la carrera
 *     se corre sin backend real de resultados, así que los puntos
 *     NO se guardan aunque haya sesión.
 *
 * ── Protocolo esperado del servidor (JSON sobre WebSocket) ─────
 *
 *   Cliente → Servidor
 *     { type:'join',   room, name, pilotId }
 *     { type:'ready',  laps }                     (laps solicitados, dueño de sala)
 *     { type:'state',  x,y,z,angle,speed,boosting,lap }   (~12/s, durante la carrera)
 *     { type:'finish', timeMs, lap }
 *     { type:'leave' }
 *
 *   Servidor → Cliente
 *     { type:'joined',        room, playerId, players:[{id,name,color,ready}] }
 *     { type:'player_joined', id, name, color }
 *     { type:'player_ready',  id, ready }
 *     { type:'player_left',   id }
 *     { type:'waiting',       count, min }          (faltan jugadores para largar)
 *     { type:'countdown',     seconds }
 *     { type:'race_start',    laps }
 *     { type:'state',         id, x,y,z,angle,speed,boosting,lap }
 *     { type:'race_results',  results:[{id,name,timeMs,position}], saved }
 *     { type:'room_full' | 'error', message }
 *
 * Config: definir window.SPIDERKART_WS_URL antes de cargar este
 * archivo para apuntar a un servidor real cuando exista.
 */
(function () {
  'use strict';

  const container = document.getElementById('game-canvas-container');
  if (!container) return;

  const WS_URL = window.SPIDERKART_WS_URL || 'wss://backend-pendiente.example/ws/spiderkart';
  const STATE_HZ = 12;
  const MAX_RETRIES = 3;
  const DEFAULT_LAPS = 3;
  const MIN_PLAYERS = 2;
  const SESSION_KEY = 'spiderkart_session';

  // Modo debug: query param ?debug=1 o flag global seteado antes de
  // cargar este script. En debug se puede arrancar la carrera solo
  // (bypassea MIN_PLAYERS) pero el resultado nunca se guarda.
  const DEBUG_MODE = !!window.SPIDERKART_DEBUG ||
    new URLSearchParams(window.location.search).get('debug') === '1';

  let ws = null;
  let retries = 0;
  let playerId = null;
  let room = null;
  let stateInterval = null;
  let lapPollInterval = null;
  const players = {}; // id -> { name, color, ready }

  // Estado de la partida en curso (fase de lobby/carrera)
  const race = {
    phase: 'lobby',       // 'lobby' | 'waiting' | 'countdown' | 'racing' | 'finished'
    laps: DEFAULT_LAPS,
    startedAt: 0,
    finished: false
  };

  /* ──────────────────────────────────────────
     Sesión de piloto
     ---------------------------------------------------------------
     Todavía no hay backend de autenticación, así que esto es un
     placeholder deliberado: "iniciar sesión" guarda localmente un
     pilotId + nombre persistentes. El día que exista un login real,
     getSession()/startSession() son el único lugar a tocar — el
     resto del archivo ya asume "hay sesión o no hay sesión" y no le
     importa de dónde sale.
     Sin sesión: se puede seguir jugando en modo debug, pero nunca
     se guardan resultados (no hay a nombre de quién guardarlos).
  ────────────────────────────────────────── */
  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function startSession(name) {
    const session = {
      pilotId: 'pilot_' + Math.random().toString(36).slice(2, 10),
      name,
      startedAt: Date.now()
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* noop */ }
    return session;
  }

  function endSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
  }

  let session = getSession();

  /* ──────────────────────────────────────────
     UI — panel de sala (inputs con pointer-events propios,
     separado del HUD que es puramente informativo)
  ────────────────────────────────────────── */
  function buildUI() {
    const panel = document.createElement('div');
    panel.id = 'sk-mp-panel';
    panel.innerHTML = `
      <div class="sk-mp-status" id="sk-mp-status">● SIN CONEXIÓN</div>
      ${DEBUG_MODE ? '<div class="sk-mp-debug">MODO DEBUG — 1 JUGADOR, SIN GUARDAR PUNTOS</div>' : ''}

      <div class="sk-mp-section" id="sk-mp-session-section">
        <div class="sk-mp-row">
          <input id="sk-mp-name" class="sk-mp-input sk-mp-input-wide" maxlength="12" placeholder="Nombre de piloto" />
        </div>
        <div class="sk-mp-row">
          <button id="sk-mp-login" class="sk-mp-btn">Iniciar sesión</button>
        </div>
      </div>

      <div class="sk-mp-section hidden" id="sk-mp-room-section">
        <div class="sk-mp-pilot" id="sk-mp-pilot"></div>
        <div class="sk-mp-row">
          <input id="sk-mp-room" class="sk-mp-input sk-mp-input-wide" maxlength="8" placeholder="SALA" />
        </div>
        <div class="sk-mp-row">
          <button id="sk-mp-join" class="sk-mp-btn">Unirse</button>
          <button id="sk-mp-leave" class="sk-mp-btn hidden">Salir</button>
        </div>
        <button id="sk-mp-logout" class="sk-mp-btn sk-mp-btn-ghost">Cerrar sesión</button>
      </div>

      <div class="sk-mp-race-status hidden" id="sk-mp-race-status"></div>
      <ul class="sk-mp-players" id="sk-mp-players"></ul>
    `;
    container.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #sk-mp-panel {
        position:absolute; top:12px; left:24px;
        width:200px; pointer-events:auto;
        font-family:'Share Tech Mono',monospace; font-size:0.7rem;
        background:rgba(10,10,18,0.72);
        border:1px solid rgba(163,0,0,0.4);
        border-radius:4px; padding:10px 12px;
        color:#eee; z-index:5;
      }
      .sk-mp-status { letter-spacing:0.08em; color:#a30000; margin-bottom:8px; font-weight:700; }
      .sk-mp-status.sk-mp-ok { color:#39d17d; }
      .sk-mp-debug {
        font-size:0.58rem; letter-spacing:0.06em; color:#ffcc00;
        background:rgba(255,204,0,0.12); border:1px solid rgba(255,204,0,0.35);
        padding:3px 6px; border-radius:2px; margin-bottom:8px;
      }
      .sk-mp-section.hidden { display:none; }
      .sk-mp-pilot {
        font-size:0.65rem; color:rgba(255,255,255,0.6);
        margin-bottom:6px; letter-spacing:0.05em;
      }
      .sk-mp-row { display:flex; gap:6px; margin-bottom:6px; }
      .sk-mp-input {
        width:50%; background:rgba(255,255,255,0.06);
        border:1px solid rgba(255,255,255,0.15); color:#fff;
        font-family:inherit; font-size:0.68rem; padding:4px 6px; border-radius:2px;
      }
      .sk-mp-input-wide { width:100%; }
      .sk-mp-btn {
        flex:1; background:rgba(163,0,0,0.25); border:1px solid rgba(163,0,0,0.5);
        color:#fff; font-family:inherit; font-size:0.65rem; letter-spacing:0.08em;
        padding:5px 0; border-radius:2px; cursor:pointer;
      }
      .sk-mp-btn:hover { background:rgba(163,0,0,0.45); }
      .sk-mp-btn.hidden { display:none; }
      .sk-mp-btn-ghost {
        background:transparent; border:1px solid rgba(255,255,255,0.15);
        color:rgba(255,255,255,0.5); margin-top:2px; font-size:0.58rem;
      }
      .sk-mp-btn-ghost:hover { background:rgba(255,255,255,0.06); }
      .sk-mp-race-status {
        margin-top:8px; padding:6px 8px;
        background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
        border-radius:2px; font-size:0.62rem; letter-spacing:0.04em;
        color:#fff;
      }
      .sk-mp-race-status.hidden { display:none; }
      .sk-mp-players { list-style:none; margin:6px 0 0; padding:0; max-height:110px; overflow-y:auto; }
      .sk-mp-players li {
        padding:2px 0; color:rgba(255,255,255,0.75);
        border-top:1px solid rgba(255,255,255,0.06);
        display:flex; justify-content:space-between;
      }
      .sk-mp-players li .sk-mp-ready { color:#39d17d; font-size:0.6rem; }
      .sk-mp-players li .sk-mp-notready { color:rgba(255,255,255,0.3); font-size:0.6rem; }
    `;
    document.head.appendChild(style);
  }
  buildUI();

  const statusEl = document.getElementById('sk-mp-status');
  const sessionSection = document.getElementById('sk-mp-session-section');
  const roomSection = document.getElementById('sk-mp-room-section');
  const nameInput = document.getElementById('sk-mp-name');
  const loginBtn = document.getElementById('sk-mp-login');
  const pilotLabel = document.getElementById('sk-mp-pilot');
  const roomInput = document.getElementById('sk-mp-room');
  const joinBtn = document.getElementById('sk-mp-join');
  const leaveBtn = document.getElementById('sk-mp-leave');
  const logoutBtn = document.getElementById('sk-mp-logout');
  const playersList = document.getElementById('sk-mp-players');
  const raceStatusEl = document.getElementById('sk-mp-race-status');

  function setStatus(text, ok) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('sk-mp-ok', !!ok);
  }

  function setRaceStatus(text) {
    if (!raceStatusEl) return;
    if (!text) {
      raceStatusEl.classList.add('hidden');
      raceStatusEl.textContent = '';
      return;
    }
    raceStatusEl.classList.remove('hidden');
    raceStatusEl.textContent = text;
  }

  function renderPlayers() {
    if (!playersList) return;
    playersList.innerHTML = '';
    Object.keys(players).forEach(id => {
      const li = document.createElement('li');
      const mine = id === playerId ? '★ ' : '';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = mine + (players[id].name || 'Piloto');
      const readySpan = document.createElement('span');
      readySpan.className = players[id].ready ? 'sk-mp-ready' : 'sk-mp-notready';
      readySpan.textContent = players[id].ready ? 'LISTO' : '—';
      li.appendChild(nameSpan);
      li.appendChild(readySpan);
      playersList.appendChild(li);
    });
  }

  // Refleja si hay sesión activa: muestra el panel de sala (con el
  // nombre del piloto ya cargado) o el panel de login, nunca los dos.
  function renderSessionUI() {
    if (session) {
      sessionSection.classList.add('hidden');
      roomSection.classList.remove('hidden');
      pilotLabel.textContent = 'PILOTO: ' + session.name.toUpperCase();
    } else {
      sessionSection.classList.remove('hidden');
      roomSection.classList.add('hidden');
    }
  }
  renderSessionUI();

  /* ──────────────────────────────────────────
     Login (sesión) — sin sesión no se puede unir a una sala, porque
     no hay a nombre de quién guardar nada.
  ────────────────────────────────────────── */
  loginBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim().slice(0, 12);
    if (!name) {
      nameInput.placeholder = 'Ingresá un nombre';
      nameInput.focus();
      return;
    }
    session = startSession(name);
    renderSessionUI();
  });

  logoutBtn.addEventListener('click', () => {
    disconnect();
    endSession();
    session = null;
    renderSessionUI();
  });

  /* ──────────────────────────────────────────
     Conexión
  ────────────────────────────────────────── */
  function connect(roomCode, name) {
    if (ws) { try { ws.close(); } catch (e) { /* noop */ } }
    room = roomCode;
    race.phase = 'lobby';
    race.finished = false;
    setRaceStatus(null);

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      handleOffline();
      return;
    }

    ws.addEventListener('open', () => {
      retries = 0;
      setStatus('CONECTADO — SALA ' + room, true);
      ws.send(JSON.stringify({
        type: 'join', room, name, pilotId: session ? session.pilotId : null
      }));

      if (stateInterval) clearInterval(stateInterval);
      stateInterval = setInterval(() => {
        if (!window.SpiderKart || !ws || ws.readyState !== WebSocket.OPEN) return;
        if (race.phase !== 'racing') return; // no spamear estado fuera de carrera
        const localState = window.SpiderKart.getLocalState();
        ws.send(JSON.stringify(Object.assign({ type: 'state' }, localState)));
        checkLocalFinish(localState);
      }, 1000 / STATE_HZ);
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
      if (retries < MAX_RETRIES) {
        retries++;
        setStatus('RECONECTANDO… (' + retries + '/' + MAX_RETRIES + ')', false);
        setTimeout(() => connect(room, name), 1500 * retries);
      } else {
        handleOffline();
      }
    });

    ws.addEventListener('error', () => {
      // el evento 'close' que sigue resuelve estado y reintentos
    });
  }

  // Sin servidor real todavía: si estamos en modo debug, se deja
  // arrancar una carrera local de un solo jugador (para poder probar
  // el circuito completo con vueltas), pero queda explícitamente
  // marcada como no guardable — no hay servidor al que mandarle el
  // resultado, y aunque lo hubiera, en debug no corresponde guardarlo.
  function handleOffline() {
    if (DEBUG_MODE) {
      setStatus('SIN SERVIDOR (modo local — debug)', false);
      players[playerId = 'local'] = { name: (session && session.name) || 'Piloto', ready: true };
      renderPlayers();
      startLocalDebugRace();
    } else {
      setStatus('SIN SERVIDOR — SE NECESITAN ' + MIN_PLAYERS + ' JUGADORES', false);
      setRaceStatus('No hay servidor disponible. Para largar una carrera real hacen falta ' + MIN_PLAYERS + ' jugadores conectados; sin backend no se puede armar la partida.');
    }
  }

  function startLocalDebugRace() {
    race.phase = 'racing';
    race.laps = DEFAULT_LAPS;
    race.startedAt = performance.now();
    race.finished = false;
    if (window.SpiderKart) window.SpiderKart.resetRace();
    setRaceStatus('MODO DEBUG — Carrera local a ' + DEFAULT_LAPS + ' vueltas. Los puntos no se guardan.');
    if (lapPollInterval) clearInterval(lapPollInterval);
    lapPollInterval = setInterval(() => {
      if (!window.SpiderKart || race.phase !== 'racing') return;
      checkLocalFinish(window.SpiderKart.getLocalState());
    }, 1000 / STATE_HZ);
  }

  // Corta la carrera cuando el piloto local completa las vueltas
  // configuradas. En modo online se lo avisa al servidor (que decide
  // si guarda el resultado según haya sesión válida); en modo debug
  // offline se resuelve todo localmente y jamás se guarda nada.
  function checkLocalFinish(localState) {
    if (race.phase !== 'racing' || race.finished) return;
    if ((localState.lap || 0) < race.laps) return;

    race.finished = true;
    race.phase = 'finished';
    const timeMs = Math.round(performance.now() - race.startedAt);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'finish', timeMs, lap: localState.lap }));
      setRaceStatus('¡Carrera terminada! Esperando resultados de la sala…');
    } else {
      // Local/offline (debug): no hay a quién mandarle el resultado.
      if (lapPollInterval) { clearInterval(lapPollInterval); lapPollInterval = null; }
      const timeStr = (timeMs / 1000).toFixed(2) + 's';
      setRaceStatus('¡Carrera terminada en ' + timeStr + '! (modo debug: no se guarda)');
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        playerId = msg.playerId;
        (msg.players || []).forEach(p => {
          players[p.id] = { name: p.name, color: p.color, ready: !!p.ready };
        });
        renderPlayers();
        race.phase = Object.keys(players).length >= MIN_PLAYERS ? 'lobby' : 'waiting';
        setRaceStatus(race.phase === 'waiting'
          ? 'Esperando jugadores… (' + Object.keys(players).length + '/' + MIN_PLAYERS + ')'
          : 'Sala lista — esperando que el servidor largue la carrera.');
        break;

      case 'player_joined':
        players[msg.id] = { name: msg.name, color: msg.color, ready: false };
        renderPlayers();
        if (race.phase === 'waiting' && Object.keys(players).length >= MIN_PLAYERS) {
          race.phase = 'lobby';
          setRaceStatus('Ya hay ' + MIN_PLAYERS + ' jugadores — se puede largar.');
        }
        break;

      case 'player_ready':
        if (players[msg.id]) players[msg.id].ready = !!msg.ready;
        renderPlayers();
        break;

      case 'player_left':
        delete players[msg.id];
        if (window.SpiderKart) window.SpiderKart.removeRemotePlayer(msg.id);
        renderPlayers();
        if (Object.keys(players).length < MIN_PLAYERS && race.phase !== 'racing') {
          race.phase = 'waiting';
          setRaceStatus('Esperando jugadores… (' + Object.keys(players).length + '/' + MIN_PLAYERS + ')');
        }
        break;

      case 'waiting':
        race.phase = 'waiting';
        setRaceStatus('Esperando jugadores… (' + msg.count + '/' + msg.min + ')');
        break;

      case 'countdown':
        race.phase = 'countdown';
        setRaceStatus('¡LARGADA EN ' + msg.seconds + '…!');
        break;

      case 'race_start':
        race.phase = 'racing';
        race.laps = msg.laps || DEFAULT_LAPS;
        race.startedAt = performance.now();
        race.finished = false;
        if (window.SpiderKart) window.SpiderKart.resetRace();
        setRaceStatus('¡EN CARRERA! ' + race.laps + ' vueltas.');
        break;

      case 'race_results':
        race.phase = 'finished';
        renderResults(msg.results, msg.saved);
        break;

      case 'state':
        if (msg.id === playerId) return; // nunca aplicar el propio eco
        if (window.SpiderKart) {
          window.SpiderKart.applyRemoteState(msg.id, msg, players[msg.id] || {});
        }
        break;

      case 'room_full':
      case 'error':
        setStatus(msg.message || 'ERROR DE SALA', false);
        break;

      default:
        break;
    }
  }

  function renderResults(results, saved) {
    if (!results || !results.length) {
      setRaceStatus('Carrera terminada.');
      return;
    }
    const lines = results
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(r => (r.position + '° ' + r.name + ' — ' + (r.timeMs / 1000).toFixed(2) + 's'))
      .join(' · ');
    const savedNote = saved ? '' : ' (sin guardar — sin sesión válida)';
    setRaceStatus(lines + savedNote);
  }

  function disconnect() {
    if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
    if (lapPollInterval) { clearInterval(lapPollInterval); lapPollInterval = null; }
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'leave' })); ws.close(); } catch (e) { /* noop */ }
    }
    ws = null;
    if (window.SpiderKart) {
      Object.keys(players).forEach(id => window.SpiderKart.removeRemotePlayer(id));
    }
    Object.keys(players).forEach(id => delete players[id]);
    playerId = null;
    race.phase = 'lobby';
    race.finished = false;
    renderPlayers();
    setStatus('SIN CONEXIÓN', false);
    setRaceStatus(null);
    joinBtn.classList.remove('hidden');
    leaveBtn.classList.add('hidden');
  }

  joinBtn.addEventListener('click', () => {
    if (!session) {
      // No debería poder llegar acá sin sesión (la sección de sala
      // está oculta hasta loguearse), pero se valida igual por las
      // dudas de que se dispare desde otro lado.
      setStatus('INICIÁ SESIÓN PRIMERO', false);
      return;
    }
    const roomCode = (roomInput.value || 'SPIDER').trim().toUpperCase().slice(0, 8) || 'SPIDER';

    retries = 0;
    setStatus('CONECTANDO…', false);
    connect(roomCode, session.name);
    joinBtn.classList.add('hidden');
    leaveBtn.classList.remove('hidden');
  });

  leaveBtn.addEventListener('click', disconnect);

  // Expuesto por si se quiere disparar la conexión desde otro lugar
  // (por ejemplo un botón "Multijugador" en el menú principal).
  window.SpiderKartMultiplayer = {
    connect,
    disconnect,
    isDebugMode: () => DEBUG_MODE,
    getSession,
    minPlayers: MIN_PLAYERS,
    defaultLaps: DEFAULT_LAPS
  };
})();