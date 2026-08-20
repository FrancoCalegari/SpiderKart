const fs = require('fs');
let code = fs.readFileSync('public/js/multiplayer.js', 'utf8');

// 1. Delete buildUI() function
code = code.replace(/function buildUI\(\) \{[\s\S]*?\}[\s\S]*?buildUI\(\);/, '');

// 2. Remove old DOM queries
const domQueries = `  const statusEl = document.getElementById('sk-mp-status');
  const sessionSection = document.getElementById('sk-mp-session-section');
  const roomSection = document.getElementById('sk-mp-room-section');
  const nameInput = document.getElementById('sk-mp-name');
  const passwordInput = document.getElementById('sk-mp-password');
  const loginBtn = document.getElementById('sk-mp-login');
  const registerBtn = document.getElementById('sk-mp-register');
  const pilotLabel = document.getElementById('sk-mp-pilot');
  const roomInput = document.getElementById('sk-mp-room');
  const joinBtn = document.getElementById('sk-mp-join');
  const leaveBtn = document.getElementById('sk-mp-leave');
  const logoutBtn = document.getElementById('sk-mp-logout');
  const playersList = document.getElementById('sk-mp-players');
  const raceStatusEl = document.getElementById('sk-mp-race-status');`;

code = code.replace(domQueries, `  // Nuevos DOM queries
  const mainMenu = document.getElementById('main-menu');
  const mpLobby = document.getElementById('mp-lobby');
  const mmButtons = document.getElementById('mm-buttons');
  const roomsList = document.getElementById('rooms-list');
  const roomNameInput = document.getElementById('new-room-name');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');
`);

// 3. Remove old login/register/logout handlers and connect handlers (from loginBtn to roomJoinBtn)
// Let's just write a script to replace the whole block from renderSessionUI to connect(roomCode, name).

fs.writeFileSync('public/js/multiplayer.js', code);
