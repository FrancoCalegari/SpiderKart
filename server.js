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
if (!ADMIN_TOKEN) {
    console.warn('⚠️  [ADVERTENCIA] ADMIN_TOKEN no está definido en el archivo .env. El editor de niveles (/admin) rechazará accesos.');
}
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
    if (!ADMIN_TOKEN) {
        return res.status(500).json({ error: 'ADMIN_TOKEN no está configurado en el servidor (.env).' });
    }
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
    if (!ADMIN_TOKEN) {
        return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN no está configurado en las variables de entorno del servidor (.env).' });
    }
    const { token } = req.body;
    if (token && token === ADMIN_TOKEN) {
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
        const queryBestLaps = `
            CREATE TABLE IF NOT EXISTS best_laps (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                map_name VARCHAR(50) NOT NULL,
                lap_time_ms INT NOT NULL,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE KEY unique_user_map (user_id, map_name)
            );
        `;
        const queryMultiplayerStats = `
            CREATE TABLE IF NOT EXISTS multiplayer_stats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                map_name VARCHAR(50) NOT NULL,
                wins INT DEFAULT 1,
                last_win_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE KEY unique_user_map_multi (user_id, map_name)
            );
        `;
        await executeQuery(queryUsers);
        try {
            await executeQuery('ALTER TABLE users ADD COLUMN email VARCHAR(100) UNIQUE;');
        } catch (e) {
            console.log('[DB] Nota: Columna email ya existe o no se pudo crear en este paso.');
        }
        await executeQuery(queryBestLaps);
        await executeQuery(queryMultiplayerStats);
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

// Endpoint para registrar mejor vuelta (Time Trial)
app.post('/api/best-lap', async (req, res) => {
    const { userId, mapName, lapTimeMs } = req.body;
    try {
        if (!userId || !mapName || !lapTimeMs) return res.status(400).json({ error: 'Faltan datos' });
        
        const checkQuery = `SELECT lap_time_ms FROM best_laps WHERE user_id = ${userId} AND map_name = '${mapName}'`;
        const checkResult = await executeQuery(checkQuery);
        
        if (checkResult.result && checkResult.result.length > 0) {
            const currentBest = checkResult.result[0].lap_time_ms;
            if (lapTimeMs < currentBest) {
                await executeQuery(`UPDATE best_laps SET lap_time_ms = ${lapTimeMs}, recorded_at = CURRENT_TIMESTAMP WHERE user_id = ${userId} AND map_name = '${mapName}'`);
                return res.json({ message: 'Nuevo récord personal registrado', updated: true });
            } else {
                return res.json({ message: 'No superó su mejor tiempo', updated: false });
            }
        } else {
            await executeQuery(`INSERT INTO best_laps (user_id, map_name, lap_time_ms) VALUES (${userId}, '${mapName}', ${lapTimeMs})`);
            return res.status(201).json({ message: 'Primer tiempo registrado', updated: true });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error guardando tiempo' });
    }
});

// Endpoint para registrar victoria en multijugador
app.post('/api/multiplayer-win', async (req, res) => {
    const { userId, mapName } = req.body;
    try {
        if (!userId || !mapName) return res.status(400).json({ error: 'Faltan datos' });
        
        const checkQuery = `SELECT wins FROM multiplayer_stats WHERE user_id = ${userId} AND map_name = '${mapName}'`;
        const checkResult = await executeQuery(checkQuery);
        
        if (checkResult.result && checkResult.result.length > 0) {
            await executeQuery(`UPDATE multiplayer_stats SET wins = wins + 1, last_win_at = CURRENT_TIMESTAMP WHERE user_id = ${userId} AND map_name = '${mapName}'`);
        } else {
            await executeQuery(`INSERT INTO multiplayer_stats (user_id, map_name, wins) VALUES (${userId}, '${mapName}', 1)`);
        }
        res.json({ message: 'Victoria registrada' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error guardando victoria' });
    }
});

// Endpoint de Leaderboard Tiempos
app.get('/api/leaderboard/laps/:mapName', async (req, res) => {
    try {
        const query = `
            SELECT u.username, b.lap_time_ms, b.recorded_at 
            FROM best_laps b
            JOIN users u ON b.user_id = u.id
            WHERE b.map_name = '${req.params.mapName}'
            ORDER BY b.lap_time_ms ASC
            LIMIT 10
        `;
        const result = await executeQuery(query);
        res.json({ data: result.result || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo leaderboard' });
    }
});

// Endpoint de Leaderboard Victorias (Global o por mapa)
app.get('/api/leaderboard/multiplayer', async (req, res) => {
    try {
        const mapName = req.query.map;
        let query = "";
        if (mapName) {
            query = `
                SELECT u.username, m.wins, m.last_win_at 
                FROM multiplayer_stats m
                JOIN users u ON m.user_id = u.id
                WHERE m.map_name = '${mapName}'
                ORDER BY m.wins DESC
                LIMIT 10
            `;
        } else {
            query = `
                SELECT u.username, SUM(m.wins) as total_wins
                FROM multiplayer_stats m
                JOIN users u ON m.user_id = u.id
                GROUP BY m.user_id, u.username
                ORDER BY total_wins DESC
                LIMIT 10
            `;
        }
        const result = await executeQuery(query);
        res.json({ data: result.result || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo leaderboard' });
    }
});

// Endpoint Undercode Day Winners
app.get('/api/undercode-day-winners', async (req, res) => {
    try {
        const mapsResult = await executeQuery("SELECT DISTINCT map_name FROM best_laps");
        const maps = (mapsResult.result || []).map(m => m.map_name);
        
        const points = {};
        
        for (const mapName of maps) {
            const lapsResult = await executeQuery(`
                SELECT u.username 
                FROM best_laps b JOIN users u ON b.user_id = u.id 
                WHERE b.map_name = '${mapName}' 
                ORDER BY b.lap_time_ms ASC LIMIT 3
            `);
            const top = lapsResult.result || [];
            if (top[0]) points[top[0].username] = (points[top[0].username] || 0) + 50;
            if (top[1]) points[top[1].username] = (points[top[1].username] || 0) + 30;
            if (top[2]) points[top[2].username] = (points[top[2].username] || 0) + 15;
        }
        
        const winsResult = await executeQuery(`
            SELECT u.username, SUM(m.wins) as total_wins
            FROM multiplayer_stats m JOIN users u ON m.user_id = u.id
            GROUP BY m.user_id, u.username
        `);
        const wins = winsResult.result || [];
        for (const w of wins) {
            points[w.username] = (points[w.username] || 0) + (w.total_wins * 10);
        }
        
        const sortedWinners = Object.keys(points)
            .map(username => ({ username, score: points[username] }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
            
        res.json({ winners: sortedWinners });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error calculando ganadores' });
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
const KART_PALETTE = [
    '#e6194b', // P1: Crimson / Rojo Neón
    '#00d4ff', // P2: Cyan / Azul Neón
    '#ffe119', // P3: Amarillo Eléctrico / Oro
    '#00ff66', // P4: Verde Neón / Esmeralda
    '#f58231', // P5: Naranja Radiante
    '#9900ff'  // P6: Púrpura / Violeta
];

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
        } else if (room.phase === 'racing') {
            // Si un jugador se va durante la carrera, chequear si los restantes ya terminaron
            checkRaceFinish(roomName);
        } else if (room.phase === 'finished') {
            // Actualizar estado de revancha con los jugadores restantes
            const readyPlayers = room.players.filter(p => p.rematchReady);
            const isSplitRoom = roomName.startsWith('SPLIT_');
            const minReq = isSplitRoom ? (room.expectedSplit || 2) : 1;
            broadcastToRoom(roomName, {
                type: 'rematch_status',
                readyCount: readyPlayers.length,
                totalCount: room.players.length,
                readyIds: readyPlayers.map(p => p.id)
            });
            if (readyPlayers.length >= room.players.length && room.players.length >= minReq) {
                room.players.forEach(p => { p.timeMs = 0; p.rematchReady = false; });
                startCountdown(roomName);
            }
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
    if (room.countdownInterval) clearInterval(room.countdownInterval);

    const isSplit = roomName.startsWith('SPLIT_');

    function beginRaceCountdown() {
        if (room.countdownInterval) clearInterval(room.countdownInterval);
        room.phase = 'countdown';
        room.countdown = 3;
        
        room.players.forEach((p, idx) => { 
            p.startPosition = idx;
            p.timeMs = 0;
            p.rematchReady = false;
        });
        
        broadcastToRoom(roomName, { 
            type: 'countdown', 
            seconds: room.countdown,
            players: room.players.map(p => ({ id: p.id, startPosition: p.startPosition, color: p.color }))
        });
        
        room.countdownInterval = setInterval(() => {
            room.countdown--;
            if (room.countdown > 0) {
                broadcastToRoom(roomName, { type: 'countdown', seconds: room.countdown });
            } else {
                clearInterval(room.countdownInterval);
                room.countdownInterval = null;
                if (room.players.length > 0) {
                    room.phase = 'racing';
                    broadcastToRoom(roomName, { type: 'race_start', laps: room.laps });
                } else {
                    room.phase = 'waiting';
                }
            }
        } , 1000);
    }

    if (isSplit) {
        // En modo pantalla dividida, todos los jugadores ya están presentes: largada directa sin espera de lobby
        beginRaceCountdown();
    } else {
        // En salas online, dar 5s de lobby antes del conteo de largada
        room.phase = 'lobby_wait';
        room.lobbySeconds = 5;
        broadcastToRoom(roomName, { type: 'lobby_wait', seconds: room.lobbySeconds });
        
        room.countdownInterval = setInterval(() => {
            room.lobbySeconds--;
            if (room.lobbySeconds > 0) {
                broadcastToRoom(roomName, { type: 'lobby_wait', seconds: room.lobbySeconds });
            } else {
                clearInterval(room.countdownInterval);
                room.countdownInterval = null;
                beginRaceCountdown();
            }
        }, 1000);
    }
}

function checkRaceFinish(roomName) {
    const room = rooms[roomName];
    if (!room || room.phase !== 'racing') return;

    const finished = room.players.filter(p => p.timeMs > 0);
    const pending  = room.players.filter(p => p.timeMs <= 0);

    // Notificar avance de llegadas a toda la sala
    broadcastToRoom(roomName, {
        type: 'finish_progress',
        finishedCount: finished.length,
        totalCount: room.players.length,
        pendingCount: pending.length,
        finishedPlayers: finished.map(p => ({ id: p.id, name: p.name, timeMs: p.timeMs, color: p.color }))
    });

    // En multijugador se debe de esperar a que TODOS los pilotos crucen la línea de meta de su última vuelta
    if (pending.length > 0) {
        // Aún hay pilotos pendientes en pista
        return;
    }

    // Todos los pilotos terminaron su última vuelta!
    room.phase = 'finished';
    const results = room.players
        .map(p => ({ id: p.id, name: p.name, timeMs: p.timeMs, color: p.color }))
        .sort((a, b) => a.timeMs - b.timeMs)
        .map((r, idx) => ({ ...r, position: idx + 1 }));

    // Resetear banderas de revancha
    room.players.forEach(p => { p.rematchReady = false; });

    broadcastToRoom(roomName, { type: 'race_results', results, saved: false, laps: room.laps });
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
                    const room = getRoom(roomName);
                    const isSplitRoom = roomName.startsWith('SPLIT_');

                    let color = data.color;
                    if (!color) {
                        if (typeof data.playerIdx === 'number') {
                            color = KART_PALETTE[data.playerIdx % KART_PALETTE.length];
                        } else {
                            const usedColors = new Set(room.players.map(p => p.color));
                            color = KART_PALETTE.find(c => !usedColors.has(c)) || KART_PALETTE[room.players.length % KART_PALETTE.length];
                        }
                    }

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

                    const expectedSplit = (data.splitPlayers && data.splitPlayers >= 2) ? data.splitPlayers : 2;
                    const effectiveMin = isSplitRoom ? expectedSplit : MIN_PLAYERS;

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

                case 'rematch_ready': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === socket);
                    if (!playerGlobal) return;
                    const room = rooms[playerGlobal.room];
                    if (!room || room.phase !== 'finished') return;

                    const player = room.players.find(p => p.id === playerGlobal.id);
                    if (player) {
                        player.rematchReady = (data.ready !== false);
                    }

                    const readyPlayers = room.players.filter(p => p.rematchReady);
                    const readyCount = readyPlayers.length;
                    const totalCount = room.players.length;

                    broadcastToRoom(playerGlobal.room, {
                        type: 'rematch_status',
                        readyCount,
                        totalCount,
                        readyIds: readyPlayers.map(p => p.id)
                    });

                    // Si todos los pilotos están listos para la siguiente carrera
                    const isSplit = playerGlobal.room.startsWith('SPLIT_');
                    const minReq = isSplit ? (room.expectedSplit || 2) : 1;
                    if (readyCount >= totalCount && totalCount >= minReq) {
                        room.players.forEach(p => {
                            p.timeMs = 0;
                            p.rematchReady = false;
                        });
                        startCountdown(playerGlobal.room);
                    }
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
