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

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = window.SPIDERKART_WS_URL || `${protocol}//${window.location.host}`;
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

  const urlParamsMulti = new URLSearchParams(window.location.search);
  const autoJoinRoom = urlParamsMulti.get('autoJoin');
  const forcedPlayerName = urlParamsMulti.get('playerName');
  const hideMenuForce = urlParamsMulti.get('hideMenu') === '1';
  const isSplitModeMulti = urlParamsMulti.get('splitMode') === '1';

  // En modo split ignoramos la sesión guardada para que cada iframe reciba
  // un pilotId único, evitando que el servidor los expulse por "reconexión".
  let session = isSplitModeMulti ? null : getSession();
  if (forcedPlayerName && session) {
      session.name = forcedPlayerName;
  }
  // En modo split, crear sesión guest automática si no hay sesión registrada
  if (isSplitModeMulti && autoJoinRoom && !session && forcedPlayerName) {
      session = { name: forcedPlayerName, pilotId: 'split_' + Math.random().toString(36).slice(2,10), isGuest: true };
  }

  /* ──────────────────────────────────────────
     Menú Principal y Lobby
  ────────────────────────────────────────── */
  const mainMenu = document.getElementById('main-menu');
  const mmButtons = document.getElementById('mm-buttons');
  const mpLobby = document.getElementById('mp-lobby');
  const btnBestLap = document.getElementById('btn-best-lap');
  const btnMultiplayer = document.getElementById('btn-multiplayer');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');
  const roomsList = document.getElementById('rooms-list');
  const roomNameInput = document.getElementById('new-room-name');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnBackMm = document.getElementById('btn-back-mm');

  const btnExitRace = document.getElementById('btn-exit-race');

  if (hideMenuForce && mainMenu) {
      mainMenu.style.display = 'none';
      window.sessionStorage.setItem('sk_hide_menu', '1');
  }

  if (isSplitModeMulti && autoJoinRoom && session) {
      // En splitMode esperamos la señal del padre (split.html) para asegurar
      // que TODOS los iframes se conecten al mismo tiempo a la misma sala.
      window.addEventListener('message', e => {
          if (e.data?.type === 'sk-connect-now') {
              if (mainMenu) mainMenu.style.display = 'none';
              window.sessionStorage.setItem('sk_hide_menu', '1');
              connect(autoJoinRoom, session.name);
          }
      });
  } else if (autoJoinRoom && session) {
      // Modo normal (no split): autoconectar con pequeño delay
      setTimeout(() => {
          if (mainMenu) mainMenu.style.display = 'none';
          window.sessionStorage.setItem('sk_hide_menu', '1');
          connect(autoJoinRoom, session.name);
      }, 500);
  }

  if (btnExitRace) {
      btnExitRace.addEventListener('click', () => {
          disconnect();
          if (!hideMenuForce) {
              mainMenu.style.display = 'flex';
              mmButtons.style.display = 'flex';
              mpLobby.style.display = 'none';
              window.sessionStorage.removeItem('sk_hide_menu');
          }
      });
  }

  // Funciones auxiliares para mostrar mensajes dentro del juego o lobby
  function showToast(msg) {
    console.log('[SpiderKart] ' + msg); // Placeholder for toast if needed
  }

  if (btnBestLap) {
      btnBestLap.addEventListener('click', () => {
          mainMenu.style.display = 'none';
          window.sessionStorage.setItem('sk_hide_menu', '1');
          startLocalTimeTrial();
      });
  }

  if (btnMultiplayer) {
      btnMultiplayer.addEventListener('click', () => {
          checkSessionAndShowModal(); // Muestra modal si no hay sesión
          if (!session) return; // Espera a que haya sesión
          
          mmButtons.style.display = 'none';
          mpLobby.style.display = 'block';
          fetchRooms();
      });
  }

  if (btnBackMm) {
      btnBackMm.addEventListener('click', () => {
          mpLobby.style.display = 'none';
          mmButtons.style.display = 'flex';
      });
  }

  if (btnRefreshRooms) {
      btnRefreshRooms.addEventListener('click', fetchRooms);
  }

  if (btnCreateRoom) {
      btnCreateRoom.addEventListener('click', () => {
          const rName = roomNameInput.value.trim().toUpperCase();
          if (rName.length > 0) {
              mainMenu.style.display = 'none';
              window.sessionStorage.setItem('sk_hide_menu', '1');
              connect(rName, session.name);
          }
      });
  }

  async function fetchRooms() {
      if (!roomsList) return;
      roomsList.innerHTML = '<div style="color:rgba(255,255,255,0.5); font-size:0.8rem; text-align:center;">CARGANDO SALAS...</div>';
      try {
          const res = await fetch('/api/rooms');
          const data = await res.json();
          roomsList.innerHTML = '';
          
          if (!data.rooms || data.rooms.length === 0) {
              roomsList.innerHTML = '<div style="color:rgba(255,255,255,0.5); font-size:0.8rem; text-align:center;">NO HAY SALAS ACTIVAS</div>';
              return;
          }

          data.rooms.forEach(r => {
              const div = document.createElement('div');
              div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border:1px solid rgba(255,255,255,0.1); border-radius:3px;';
              
              const info = document.createElement('div');
              info.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
              info.innerHTML = `
                <div>
                  <span style="color:#fff; font-weight:bold; font-size:1.1rem; margin-right:15px;">${r.name}</span>
                  <span style="color:${r.players >= r.max ? '#ff3333' : '#00ff66'}; font-size:0.8rem;">${r.players}/${r.max}</span>
                  <span style="color:rgba(255,255,255,0.5); font-size:0.7rem; margin-left:10px;">${r.phase.toUpperCase()}</span>
                </div>
                <div style="font-size:0.65rem; color:#aaa; letter-spacing:0.05em;">HOST: <span style="color:#00d4ff;">${r.host || 'Desc.'}</span></div>
              `;
              
              const btn = document.createElement('button');
              btn.textContent = 'UNIRSE';
              btn.style.cssText = 'background:rgba(163,0,0,0.4); border:1px solid rgba(163,0,0,0.7); color:#fff; padding:6px 15px; font-family:inherit; cursor:pointer; font-size:0.8rem; transition:background 0.2s;';
              
              if (r.players >= r.max || r.phase === 'racing' || r.phase === 'countdown') {
                  btn.disabled = true;
                  btn.style.opacity = '0.5';
                  btn.style.cursor = 'not-allowed';
              } else {
                  btn.onclick = () => {
                      mainMenu.style.display = 'none';
                      window.sessionStorage.setItem('sk_hide_menu', '1');
                      connect(r.name, session.name);
                  };
              }

              div.appendChild(info);
              div.appendChild(btn);
              roomsList.appendChild(div);
          });
      } catch (err) {
          roomsList.innerHTML = '<div style="color:#ff3333; font-size:0.8rem; text-align:center;">ERROR AL OBTENER SALAS</div>';
      }
  }

  function startLocalTimeTrial() {
      // Bypassea la lógica multiplayer e inicia una carrera local
      room = null;
      playerId = session ? session.pilotId : ('pilot_' + Math.random().toString(36).slice(2,10));
      players[playerId] = { name: session ? session.name : 'Tú', color: '#00ff66', ready: true };
      race.phase = 'racing';
      race.startedAt = Date.now();
      
      const evt = new CustomEvent('spiderkart:start', { detail: { isMultiplayer: false, laps: DEFAULT_LAPS } });
      window.dispatchEvent(evt);
      if (window.SpiderKart) { window.SpiderKart.resetRace(); }
      
      startStateBroadcast();
      startLapPoll();
  }


  // Escuchar migración de sala desde el frame padre (split.html)
  window.addEventListener('message', e => {
    if (e.data?.type === 'sk-migrate') {
      const newRoom = e.data.room;
      const newName = e.data.playerName || (session?.name) || 'Piloto';
      if (mainMenu) mainMenu.style.display = 'none';
      window.sessionStorage.setItem('sk_hide_menu', '1');
      connect(newRoom, newName);
    }
  });

  /* ──────────────────────────────────────────
     Conexión
  ────────────────────────────────────────── */

  function connect(roomCode, name) {
    if (ws) {
      // ws.disconnect() in socket.io automatically triggers leave logic if we don't reconnect
      ws.disconnect();
    }
    room = roomCode;
    race.phase = 'lobby';
    race.finished = false;
    setRaceStatus(null);

    try {
      // Usar io global proporcionado por el script importado en html
      ws = io(WS_URL, {
          reconnectionAttempts: MAX_RETRIES,
          reconnectionDelay: 1500
      });
    } catch (e) {
      handleOffline();
      return;
    }

    ws.on('connect', () => {
      retries = 0;
      setStatus('CONECTADO — SALA ' + room, true);
      ws.emit('message', {
        type: 'join', room, name, pilotId: session ? session.pilotId : null
      });

      if (stateInterval) clearInterval(stateInterval);
      stateInterval = setInterval(() => {
        if (!window.SpiderKart || !ws || !ws.connected) return;
        if (race.phase !== 'racing') return; // no spamear estado fuera de carrera
        const localState = window.SpiderKart.getLocalState();
        ws.emit('message', Object.assign({ type: 'state' }, localState));
        checkLocalFinish(localState);
      }, 1000 / STATE_HZ);
    });

    ws.on('message', msg => {
      // Socket.io maneja objetos por defecto, pero si por alguna razón es string
      const payload = typeof msg === 'string' ? JSON.parse(msg) : msg;
      handleMessage(payload);
    });

    ws.on('disconnect', (reason) => {
      if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
      if (reason === 'io client disconnect') {
          // Desconexión intencional (ej. migración de sala o click en salir)
          return;
      }
      setStatus('DESCONECTADO', false);
    });

    ws.on('connect_error', (error) => {
        if (ws.io.opts.reconnectionAttempts <= retries) {
            handleOffline();
        } else {
            retries++;
            setStatus('RECONECTANDO… (' + retries + '/' + MAX_RETRIES + ')', false);
        }
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

    if (ws && ws.connected) {
      ws.emit('message', { type: 'finish', timeMs, lap: localState.lap });
      setRaceStatus('¡Carrera terminada! Esperando resultados de la sala…');
    } else {
      if (lapPollInterval) { clearInterval(lapPollInterval); lapPollInterval = null; }
      const timeStr = (timeMs / 1000).toFixed(2) + 's';
      
      if (session && session.userId) {
          const score = Math.max(0, 300000 - timeMs); // Asume base 300 segs (5 mins)
          fetch('/api/leaderboard', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: session.userId, score })
          }).then(() => {
              setRaceStatus('¡Carrera terminada en ' + timeStr + '! Puntaje guardado.');
          }).catch(() => {
              setRaceStatus('¡Carrera terminada en ' + timeStr + '! (Error al guardar puntaje)');
          });
      } else {
          setRaceStatus('¡Carrera terminada en ' + timeStr + '! (modo local: no se guardó)');
      }
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

      case 'lobby_wait':
        setRaceStatus('Esperando más jugadores… (' + msg.seconds + ')');
        break;

      case 'countdown':
        race.phase = 'countdown';
        setRaceStatus('¡LARGADA EN ' + msg.seconds + '…!');
        if (window.SpiderKart) {
          if (msg.players) {
            const me = msg.players.find(p => p.id === playerId);
            const myPos = me ? (me.startPosition || 0) : 0;
            window.SpiderKart.lockAndReset(myPos);
          }
          if (window.SpiderKart.setCountdown) {
            window.SpiderKart.setCountdown(msg.seconds);
          }
        }
        break;

      case 'race_start':
        race.phase = 'racing';
        race.laps = msg.laps || DEFAULT_LAPS;
        race.startedAt = performance.now();
        race.finished = false;
        if (window.SpiderKart) {
          if (window.SpiderKart.setCountdown) window.SpiderKart.setCountdown(0);
          else window.SpiderKart.unlock();
          
          if (window.SpiderKart.resetRace) {
            // El resetRace() de SpiderKart ya no debería bloquear si le pasamos false
            // O directamente no lo llamamos, porque lockAndReset() ya preparó todo
            // Vamos a solo reiniciar tiempos locales
            window.SpiderKart.resetRace(false);
          }
          window.SpiderKart.unlock(); // Asegurar desbloqueo
        }
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

      case 'hit':
        if (window.SpiderKart) {
          if (window.SpiderKart.triggerRemoteHit) {
            window.SpiderKart.triggerRemoteHit(msg.targetId === playerId ? 'local' : msg.targetId);
          } else if (msg.targetId === playerId) {
            window.SpiderKart.spinOut();
          }
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

  // Funciones de UI que fueron reemplazadas o eliminadas
  function setStatus(msg, isGood) {
    console.log('[Status]', msg);
  }
  function setRaceStatus(msg) {
    if (msg) console.log('[Race]', msg);
    // TODO: Mostrar en el HUD si es necesario
  }
  function renderPlayers() {
    // El viejo panel fue eliminado, así que no renderizamos la lista por ahora
  }

  function disconnect() {
    if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
    if (lapPollInterval) { clearInterval(lapPollInterval); lapPollInterval = null; }
    if (ws) {
      try { ws.emit('message', { type: 'leave' }); ws.disconnect(); } catch (e) { /* noop */ }
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
  }

  // Expuesto por si se quiere disparar la conexión desde otro lugar
  // (por ejemplo un botón "Multijugador" en el menú principal).
  window.SpiderKartMultiplayer = {
    connect,
    disconnect,
    isDebugMode: () => DEBUG_MODE,
    getSession,
    minPlayers: MIN_PLAYERS,
    defaultLaps: DEFAULT_LAPS,
    sendHit: (targetId) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'hit', targetId }));
      }
    }
  };

  // Quick Register Modal Logic (Game.html)
  function checkSessionAndShowModal() {
    if (!session) {
      const modal = document.getElementById('quick-register-modal');
      if (modal) modal.style.display = 'flex';
    }
  }

  const quickForm = document.getElementById('quick-register-form');
  if (quickForm) {
      quickForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const username = document.getElementById('quick-username').value;
          const email = document.getElementById('quick-email').value;
          const btn = document.getElementById('quick-submit-btn');
          const alert = document.getElementById('quick-alert');
          
          btn.disabled = true;
          btn.textContent = 'CARGANDO...';
          
          try {
              const res = await fetch('/api/auth/quick-register', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username, email })
              });
              const data = await res.json();
              
              if (res.ok) {
                  session = startSession(data.username);
                  session.userId = data.userId;
                  localStorage.setItem('spiderkart_username', data.username);
                  localStorage.setItem('spiderkart_userId', data.userId);
                  
                  document.getElementById('quick-register-modal').style.display = 'none';
              } else {
                  alert.textContent = data.error || 'Error al crear cuenta';
                  alert.style.display = 'block';
              }
          } catch(err) {
              alert.textContent = 'Error de conexión';
              alert.style.display = 'block';
          }
          btn.disabled = false;
          btn.textContent = 'COMENZAR';
      });
  }

  // Check on load
  checkSessionAndShowModal();

})();