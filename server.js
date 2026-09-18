import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Configuración de middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

// Configuración de la API SpiderWebARG
const SPIDER_API_URL = 'https://spiderwebargapi.com.ar/api/v1';
const SPIDER_API_KEY = process.env.spiderapikey;
const SPIDER_DB_NAME = process.env.spiderdbname;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const LEVELS_FILE = join(__dirname, 'levels.json');
const LEVELS_SLOTS_FILE = join(__dirname, 'levels_slots.json');

const DEFAULT_LEVEL = {
    name: 'Circuito Variado Grande',
    trackWidth: 14,
    totalLaps: 3,
    controlPoints: [
        [160,0],[160,-70],[150,-140],[110,-200],[50,-210],
        [0,-180],[-40,-130],[-90,-150],[-140,-130],[-180,-80],
        [-190,0],[-160,60],[-100,80],[-60,40],[-20,90],
        [30,130],[90,140],[140,110],[160,60]
    ]
};

// Helper: obtener store de slots (archivo local de slots)
function readSlotsStore() {
    if (existsSync(LEVELS_SLOTS_FILE)) {
        try { return JSON.parse(readFileSync(LEVELS_SLOTS_FILE, 'utf8')); } catch(e) {}
    }
    return {};
}
function writeSlotsStore(store) {
    writeFileSync(LEVELS_SLOTS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// Middleware de autenticación para /admin
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'No autorizado. Token inválido.' });
}

// Helper: leer nivel desde SpiderWebARG DB (con fallback a levels.json local)
// slot: 1..5, 0 = activo (default). Slot 1 siempre es el nivel activo.
async function readLevelData(slot = 0) {
    // Slots 2-5: solo local (no van a la DB remota)
    if (slot >= 2 && slot <= 5) {
        const store = readSlotsStore();
        return store[slot] || { ...DEFAULT_LEVEL, name: `Slot ${slot} vacío` };
    }
    // Slot 0 o 1 = nivel activo
    // 1) Intentar desde la DB remota
    try {
        const result = await executeQuery(`SELECT level_json FROM spiderkart_levels ORDER BY updated_at DESC LIMIT 1`);
        if (result.result && result.result.length > 0) {
            return JSON.parse(result.result[0].level_json);
        }
    } catch (e) {
        console.warn('[Level] DB no disponible, usando fallback local:', e.message);
    }
    // 2) Fallback a levels.json local
    if (existsSync(LEVELS_FILE)) {
        try { return JSON.parse(readFileSync(LEVELS_FILE, 'utf8')); } catch(e) {}
    }
    // 3) Hardcoded default
    return DEFAULT_LEVEL;
}

// Helper: guardar nivel en SpiderWebARG DB (y local como backup)
async function saveLevelData(levelData, slot = 0) {
    const json = JSON.stringify(levelData);
    let savedToDb = false;

    // Slots 2-5: solo local
    if (slot >= 2 && slot <= 5) {
        const store = readSlotsStore();
        store[slot] = levelData;
        try { writeSlotsStore(store); console.log(`[Level] Slot ${slot} guardado local.`); } catch(e) { console.error('[Level] Error guardando slot local:', e.message); }
        return false;
    }

    // Slot 0 o 1 = nivel activo → guardar en DB + local
    try {
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS spiderkart_levels (
                id INT AUTO_INCREMENT PRIMARY KEY,
                level_json TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await executeQuery(`DELETE FROM spiderkart_levels`);
        await executeQuery(`INSERT INTO spiderkart_levels (level_json) VALUES ('${json.replace(/'/g, "''")}')`);
        savedToDb = true;
        console.log('[Level] Guardado en SpiderWebARG DB.');
    } catch (e) {
        console.warn('[Level] No se pudo guardar en DB, guardando solo local:', e.message);
    }

    // Siempre guardar en levels.json local como backup
    try {
        writeFileSync(LEVELS_FILE, JSON.stringify(levelData, null, 2), 'utf8');
        // Además actualizar slot 1 en el store de slots
        const store = readSlotsStore();
        store[1] = levelData;
        writeSlotsStore(store);
        console.log('[Level] Guardado en levels.json local.');
    } catch (e) {
        console.error('[Level] Error guardando levels.json:', e.message);
    }

    return savedToDb;
}

// Flag para suprimir errores repetitivos de la misma naturaleza
let _dbErrorLogged = false;

async function executeQuery(query) {
    const response = await fetch(`${SPIDER_API_URL}/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': SPIDER_API_KEY
        },
        body: JSON.stringify({
            database: SPIDER_DB_NAME,
            query: query
        })
    });
    
    if (!response.ok) {
        const err = new Error(`Error en la consulta: ${response.statusText} (${response.status})`);
        if (!_dbErrorLogged) {
            _dbErrorLogged = true;
            const errText = await response.text();
            console.error('[DB] Error al conectar con SpiderWebARG API:', response.status, response.statusText);
            console.error('[DB] Query original:', query);
            console.error('[DB] Respuesta del servidor:', errText);
            console.error('[DB] Verificar que spiderapikey y spiderdbname sean correctos en .env');
            setTimeout(() => { _dbErrorLogged = false; }, 60000); // permitir re-log tras 60s
        }
        throw err;
    }
    _dbErrorLogged = false;
    return await response.json();
}

// ---------------------------------------------------------
// Rutas del Editor de Niveles (/admin)
// ---------------------------------------------------------

// Sirve la página del editor de niveles
app.get('/admin', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'admin.html'));
});

// GET /api/level — obtener el nivel actual (público, lo necesita el juego)
// Query param: ?slot=1..5 (opcional, default = nivel activo)
app.get('/api/level', async (req, res) => {
    try {
        const slot = parseInt(req.query.slot) || 0;
        const level = await readLevelData(slot);
        res.json(level);
    } catch (error) {
        console.error('[Level] Error leyendo nivel:', error);
        res.json(DEFAULT_LEVEL);
    }
});

// GET /api/levels — listar todos los slots disponibles (solo admin)
app.get('/api/levels', requireAdmin, async (req, res) => {
    try {
        const store = readSlotsStore();
        const slots = [];
        // Slot 1 = nivel activo
        const active = await readLevelData(0);
        store[1] = active;
        for (let i = 1; i <= 5; i++) {
            const lvl = store[i];
            slots.push({
                slot: i,
                name: lvl ? lvl.name : `Slot ${i} (vacío)`,
                empty: !lvl,
                totalLaps: lvl ? (lvl.totalLaps || 3) : 3
            });
        }
        res.json({ slots });
    } catch (e) {
        res.status(500).json({ error: 'Error leyendo slots.' });
    }
});

// POST /api/level — guardar nuevo nivel (solo admin)
// Query param: ?slot=1..5 (opcional, default = 1 = nivel activo)
app.post('/api/level', requireAdmin, async (req, res) => {
    const { name, trackWidth, totalLaps, controlPoints, obstacles, ramps, powerups, shortcuts, terrainNodes, barriers } = req.body;
    const slot = parseInt(req.query.slot) || 0;

    if (!controlPoints || !Array.isArray(controlPoints) || controlPoints.length < 3) {
        return res.status(400).json({ error: 'El nivel necesita al menos 3 puntos de control.' });
    }

    const levelData = {
        name: name || 'Nivel Sin Nombre',
        trackWidth: trackWidth || 14,
        totalLaps: Math.max(1, Math.min(20, parseInt(totalLaps) || 3)),
        controlPoints,
        obstacles: obstacles || [],
        ramps: ramps || [],
        powerups: powerups || [],
        shortcuts: shortcuts || [],
        terrainNodes: terrainNodes || [],
        barriers: barriers || []
    };

    const savedToDb = await saveLevelData(levelData, slot);
    res.json({ ok: true, savedToDb, slot: slot || 1, message: savedToDb ? 'Guardado en DB y local.' : 'Guardado solo local (DB no disponible).' });
});

// POST /api/level/activate — activar un slot como nivel activo (solo admin)
app.post('/api/level/activate', requireAdmin, async (req, res) => {
    const { slot } = req.body;
    if (!slot || slot < 1 || slot > 5) return res.status(400).json({ error: 'Slot inválido (1-5).' });
    try {
        const store = readSlotsStore();
        const levelData = store[slot];
        if (!levelData) return res.status(404).json({ error: `Slot ${slot} está vacío.` });
        // Guardar como nivel activo (slot 0/1)
        await saveLevelData(levelData, 0);
        // Notificar a todos los clientes conectados que el nivel cambió
        io.emit('message', { type: 'level_changed', slot });
        res.json({ ok: true, message: `Slot ${slot} activado como nivel actual.` });
    } catch(e) {
        res.status(500).json({ error: 'Error activando slot.' });
    }
});

// POST /api/admin/login — verificar token de admin
app.post('/api/admin/login', (req, res) => {
    const { token } = req.body;
    if (token === ADMIN_TOKEN) {
        res.json({ ok: true });
    } else {
        res.status(401).json({ ok: false, error: 'Token incorrecto.' });
    }
});

// Endpoint para inicializar tablas si no existen (opcional)
app.get('/api/init-db', async (req, res) => {
    try {
        const queryUsers = `
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        const queryLeaderboard = `
            CREATE TABLE IF NOT EXISTS leaderboard (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                score INT NOT NULL,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `;
        await executeQuery(queryUsers);
        try {
            await executeQuery('ALTER TABLE users ADD COLUMN email VARCHAR(100) UNIQUE;');
        } catch (e) {
            console.log('[DB] Nota: Columna email ya existe o no se pudo crear en este paso.');
        }
        await executeQuery(queryLeaderboard);
        res.json({ message: 'Tablas inicializadas correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error inicializando la base de datos' });
    }
});

// Endpoint de Registro
app.post('/api/auth/register', async (req, res) => {
    const { username, password, email } = req.body;
    
    if (!username || !password || !email) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        // Verificar si el usuario ya existe
        const checkQuery = `SELECT * FROM users WHERE username = '${username}' OR email = '${email}'`;
        const checkResult = await executeQuery(checkQuery);
        
        if (checkResult.result && checkResult.result.length > 0) {
            return res.status(400).json({ error: 'El usuario o el correo ya existen' });
        }

        // Hashear contraseña
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Insertar usuario
        const insertQuery = `INSERT INTO users (username, email, password_hash) VALUES ('${username}', '${email}', '${passwordHash}')`;
        await executeQuery(insertQuery);
        
        console.log(`[INFO] Nuevo usuario registrado: ${username}`);
        res.status(201).json({ message: 'Usuario registrado exitosamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint de Registro Rápido
app.post('/api/auth/quick-register', async (req, res) => {
    const { username, email } = req.body;
    
    if (!username || !email) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        // Verificar si el correo ya existe
        const checkEmailQuery = `SELECT * FROM users WHERE email = '${email}'`;
        const emailResult = await executeQuery(checkEmailQuery);
        
        if (emailResult.result && emailResult.result.length > 0) {
            // Ya existe una cuenta con este correo: Iniciar sesión automáticamente
            const user = emailResult.result[0];
            console.log(`[INFO] Inicio de sesión rápido existente: ${user.username}`);
            return res.status(200).json({ message: 'Sesión iniciada exitosamente', username: user.username, userId: user.id });
        }

        // Si el correo no existe, verificar que el nombre de usuario esté libre
        const checkUserQuery = `SELECT * FROM users WHERE username = '${username}'`;
        const userResult = await executeQuery(checkUserQuery);
        if (userResult.result && userResult.result.length > 0) {
            return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
        }

        // Hashear contraseña por defecto (ya que es cuenta rápida)
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(email + '_quick', saltRounds);

        // Insertar usuario
        const insertQuery = `INSERT INTO users (username, email, password_hash) VALUES ('${username}', '${email}', '${passwordHash}')`;
        await executeQuery(insertQuery);
        
        // Obtener el usuario insertado para loguearlo
        const finalUserQuery = `SELECT id, username FROM users WHERE username = '${username}'`;
        const finalUserResult = await executeQuery(finalUserQuery);
        const userInserted = finalUserResult.result[0];

        console.log(`[INFO] Registro rápido: ${username}`);
        res.status(201).json({ message: 'Usuario registrado exitosamente', username: userInserted.username, userId: userInserted.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint de Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        const query = `SELECT * FROM users WHERE username = '${username}'`;
        const result = await executeQuery(query);
        
        if (!result.result || result.result.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const user = result.result[0];
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        res.json({ message: 'Login exitoso', username: user.username, userId: user.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint de Leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const query = `
            SELECT u.username, l.score, l.recorded_at 
            FROM leaderboard l
            JOIN users u ON l.user_id = u.id
            ORDER BY l.score DESC
            LIMIT 10
        `;
        const result = await executeQuery(query);
        res.json({ data: result.result || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo leaderboard' });
    }
});

// Para enviar un score (útil para pruebas)
app.post('/api/leaderboard', async (req, res) => {
    const { userId, score } = req.body;
    try {
        const insertQuery = `INSERT INTO leaderboard (user_id, score) VALUES (${userId}, ${score})`;
        await executeQuery(insertQuery);
        res.status(201).json({ message: 'Score registrado exitosamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error guardando score' });
    }
});

// Endpoint para listar salas activas
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    for (const [roomName, room] of Object.entries(rooms)) {
        activeRooms.push({
            name: roomName,
            host: room.isSystemRoom ? 'SERVIDOR (SISTEMA)' : (room.players.length > 0 ? room.players[0].name : 'Vacío'),
            players: room.players.length,
            max: 6,
            phase: room.phase
        });
    }
    res.json({ rooms: activeRooms });
});

// ---------------------------------------------------------
// Lógica de Salas y WebSockets (Multijugador)
// ---------------------------------------------------------
const rooms = {
    'GLOBAL': { phase: 'waiting', laps: 3, players: [], isSystemRoom: true }
}; // roomName -> { phase, laps, players: [{ws, id, name, ready, color, timeMs}], isSystemRoom }
const playersGlobal = {}; // id -> { ws, room, id, name }
const MIN_PLAYERS = 2;

function getRoom(roomName) {
    if (!rooms[roomName]) {
        rooms[roomName] = { phase: 'waiting', laps: 3, players: [], isSystemRoom: false };
    }
    return rooms[roomName];
}

function broadcastToRoom(roomName, msg, excludeSocket = null) {
    const room = rooms[roomName];
    if (!room) return;
    
    // Si queremos excluir al emisor, usamos excludeSocket.to(room).emit
    // Si no excluimos a nadie, usamos io.to(room).emit
    if (excludeSocket) {
        excludeSocket.to(roomName).emit('message', msg);
    } else {
        io.to(roomName).emit('message', msg);
    }
}

function handleLeave(socket) {
    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
    if (!playerGlobal) return;
    
    const { room: roomName, id } = playerGlobal;
    const room = rooms[roomName];
    if (room) {
        room.players = room.players.filter(p => p.id !== id);
        broadcastToRoom(roomName, { type: 'player_left', id });
        
        if (room.players.length === 0 && !room.isSystemRoom) {
            delete rooms[roomName];
        } else if (room.players.length < MIN_PLAYERS && room.phase !== 'racing' && room.phase !== 'finished') {
            room.phase = 'waiting';
            if (room.countdownInterval) clearInterval(room.countdownInterval);
            broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: MIN_PLAYERS });
        } else if (room.players.length === 0 && room.isSystemRoom) {
            room.phase = 'waiting';
            if (room.countdownInterval) clearInterval(room.countdownInterval);
        }
    }
    delete playersGlobal[id];
}

function startCountdown(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    
    room.phase = 'lobby_wait';
    room.lobbySeconds = 5;
    broadcastToRoom(roomName, { type: 'lobby_wait', seconds: room.lobbySeconds });
    
    room.countdownInterval = setInterval(() => {
        room.lobbySeconds--;
        if (room.lobbySeconds > 0) {
            broadcastToRoom(roomName, { type: 'lobby_wait', seconds: room.lobbySeconds });
        } else {
            clearInterval(room.countdownInterval);
            
            room.phase = 'countdown';
            room.countdown = 5;
            
            room.players.forEach((p, idx) => { p.startPosition = idx; });
            
            broadcastToRoom(roomName, { 
                type: 'countdown', 
                seconds: room.countdown,
                players: room.players.map(p => ({ id: p.id, startPosition: p.startPosition }))
            });
            
            room.countdownInterval = setInterval(() => {
                room.countdown--;
                if (room.countdown > 0) {
                    broadcastToRoom(roomName, { type: 'countdown', seconds: room.countdown });
                } else {
                    clearInterval(room.countdownInterval);
                    if (room.players.length > 0) {
                        room.phase = 'racing';
                        broadcastToRoom(roomName, { type: 'race_start', laps: room.laps });
                    } else {
                        room.phase = 'waiting';
                    }
                }
            }, 1000);
        }
    }, 1000);
}

function checkRaceFinish(roomName) {
    const room = rooms[roomName];
    if (!room || room.phase !== 'racing') return;

    const finished = room.players.filter(p => p.timeMs > 0);
    const pending  = room.players.filter(p => p.timeMs <= 0);

    // La carrera termina cuando:
    //  a) Todos completaron, O
    //  b) Solo queda 1 jugador sin terminar (el último — se le da tiempo extra o se le fuerza)
    const shouldEnd = pending.length === 0 || (finished.length > 0 && pending.length === 1);
    if (!shouldEnd) return;

    // Si queda 1 pendiente, darle 60 s adicionales antes de forzar fin
    if (pending.length === 1 && !room.lastPlayerTimer) {
        broadcastToRoom(roomName, {
            type: 'last_player',
            id: pending[0].id,
            name: pending[0].name
        });
        room.lastPlayerTimer = setTimeout(() => {
            // Tiempo expiró: asignar tiempo máximo al jugador pendiente
            const lastPlayer = room.players.find(p => p.timeMs <= 0);
            if (lastPlayer) lastPlayer.timeMs = 99 * 60 * 1000; // 99 min DNF
            room.lastPlayerTimer = null;
            checkRaceFinish(roomName);
        }, 60000);
        return;
    }

    // Cancelar timer del último jugador si todos terminaron
    if (room.lastPlayerTimer) {
        clearTimeout(room.lastPlayerTimer);
        room.lastPlayerTimer = null;
    }

    room.phase = 'finished';
    const results = room.players
        .map(p => ({ id: p.id, name: p.name, timeMs: p.timeMs }))
        .sort((a, b) => a.timeMs - b.timeMs)
        .map((r, idx) => ({ ...r, position: idx + 1 }));

    broadcastToRoom(roomName, { type: 'race_results', results, saved: false });

    setTimeout(() => {
        if (!rooms[roomName]) return;
        room.players.forEach(p => p.timeMs = 0);
        room.phase = 'waiting';
        if (room.players.length >= MIN_PLAYERS) {
            startCountdown(roomName);
        } else {
            broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: MIN_PLAYERS });
        }
    }, 10000);
}

io.on('connection', (socket) => {
    socket.on('message', (message) => {
        try {
            const data = typeof message === 'string' ? JSON.parse(message) : message;
            const { type, room: roomName, name, pilotId, timeMs, lap } = data;

            switch (type) {
                case 'join': {
                    if (!roomName || !name) return;
                    const id = pilotId || 'pilot_' + Math.random().toString(36).substr(2, 9);
                    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
                    
                    const room = getRoom(roomName);
                    const isSplitRoom = roomName.startsWith('SPLIT_');

                    if (room.phase === 'racing') {
                        socket.emit('message', { type: 'error', message: 'La carrera ya empezó' });
                        return;
                    }
                    
                    if (room.players.length >= 6) {
                        socket.emit('message', { type: 'error', message: 'La sala está llena (máximo 6 jugadores)' });
                        return;
                    }

                    if (playersGlobal[id]) {
                        const prevSocket = playersGlobal[id].ws;
                        handleLeave(prevSocket);
                        prevSocket.disconnect(true);
                    }

                    const player = { ws: socket, id, name, ready: true, color, timeMs: 0, position: 0 };
                    room.players.push(player);
                    playersGlobal[id] = { ws: socket, room: roomName, id, name };
                    
                    socket.join(roomName);

                    socket.emit('message', {
                        type: 'joined',
                        room: roomName,
                        playerId: id,
                        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, ready: p.ready }))
                    });

                    broadcastToRoom(roomName, {
                        type: 'player_joined',
                        id, name, color
                    }, socket);

                    const effectiveMin = isSplitRoom ? 1 : MIN_PLAYERS;

                    if (room.phase === 'waiting' && room.players.length >= effectiveMin) {
                        startCountdown(roomName);
                    } else if (room.phase === 'lobby_wait') {
                        socket.emit('message', { type: 'lobby_wait', seconds: room.lobbySeconds || 5 });
                    } else if (room.phase === 'countdown') {
                        socket.emit('message', { 
                            type: 'countdown', 
                            seconds: room.countdown || 5,
                            players: room.players.map(p => ({ id: p.id, startPosition: p.startPosition }))
                        });
                    } else if (room.phase === 'waiting') {
                        broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: effectiveMin });
                    }
                    break;
                }
                
                case 'state': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
                    if (!playerGlobal) return;
                    const { x, y, z, angle, speed, boosting } = data;
                    broadcastToRoom(playerGlobal.room, {
                        type: 'state',
                        id: playerGlobal.id,
                        x, y, z, angle, speed, boosting, lap
                    }, socket);
                    break;
                }

                case 'finish': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
                    if (!playerGlobal) return;
                    const room = rooms[playerGlobal.room];
                    if (!room) return;
                    
                    const player = room.players.find(p => p.id === playerGlobal.id);
                    if (player) {
                        player.timeMs = timeMs;
                        checkRaceFinish(playerGlobal.room);
                    }
                    break;
                }
                
                case 'hit': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
                    if (!playerGlobal) return;
                    // Broadcast a TODA la sala (incluido emisor) para que el targetId reciba el hit
                    io.to(playerGlobal.room).emit('message', {
                        type: 'hit',
                        targetId: data.targetId,
                        sourceId: playerGlobal.id
                    });
                    break;
                }

                case 'consume_powerup': {
                    // Sincronizar consumo de powerup: informar al resto que ese powerup desapareció
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
                    if (!playerGlobal) return;
                    broadcastToRoom(playerGlobal.room, {
                        type: 'powerup_consumed',
                        powerupIdx: data.powerupIdx,
                        consumedBy: playerGlobal.id
                    }, socket); // excluir al que lo consumió (ya lo procesó localmente)
                    break;
                }

                case 'leave': {
                    handleLeave(socket);
                    break;
                }
            }
        } catch (e) {
            console.error('Socket Error:', e);
        }
    });

    socket.on('disconnect', () => handleLeave(socket));
});

// Middleware para manejar 404
app.use((req, res, next) => {
    res.status(404).sendFile(join(__dirname, 'public', '404.html'));
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP y WebSocket corriendo en el puerto ${PORT}`);
});
