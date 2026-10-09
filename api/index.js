/**
 * SpiderKart — Vercel Serverless API Handler
 *
 * Este archivo adapta todas las rutas REST de server.js para funcionar
 * como una función serverless en Vercel.
 *
 * LIMITACIONES VS. SERVIDOR COMPLETO:
 *  - Sin Socket.io / WebSockets (multiplayer en tiempo real).
 *    El multijugador en línea requiere un servidor separado (Railway/Render/Fly.io).
 *    Configura SPIDERKART_WS_URL en las variables de entorno del cliente para apuntar allí.
 *
 *  - Sin escritura a disco (levels.json / levels_slots.json).
 *    Todo se persiste ÚNICAMENTE en la DB remota de SpiderWebARG.
 *    Los slots 2-5 del editor también se guardan en la DB usando filas separadas.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Servir /public como estáticos (sólo aplica al correr localmente con este handler)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, '..', 'public')));

// ─── SpiderWebARG API ────────────────────────────────────────────────────────
const SPIDER_API_URL = 'https://spiderwebargapi.com.ar/api/v1';
const SPIDER_API_KEY = process.env.spiderapikey;
const SPIDER_DB_NAME = process.env.spiderdbname;
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN;

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

let _dbErrorLogged = false;

async function executeQuery(query) {
    const response = await fetch(`${SPIDER_API_URL}/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': SPIDER_API_KEY
        },
        body: JSON.stringify({ database: SPIDER_DB_NAME, query })
    });

    if (!response.ok) {
        const err = new Error(`DB Error: ${response.statusText} (${response.status})`);
        if (!_dbErrorLogged) {
            _dbErrorLogged = true;
            console.error('[DB] Error:', response.status, response.statusText);
            setTimeout(() => { _dbErrorLogged = false; }, 60000);
        }
        throw err;
    }
    _dbErrorLogged = false;
    return await response.json();
}

// ─── Middleware Admin ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'No autorizado. Token inválido.' });
}

// ─── Helpers de Nivel ────────────────────────────────────────────────────────
// En Vercel no hay disco: todos los slots van a la DB.
// Slot 0/1 → tabla spiderkart_levels (activo)
// Slots 2-5 → tabla spiderkart_level_slots (name='slot_N')

async function ensureLevelTable() {
    await executeQuery(`
        CREATE TABLE IF NOT EXISTS spiderkart_levels (
            id INT AUTO_INCREMENT PRIMARY KEY,
            level_json TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
}

async function ensureSlotTable() {
    await executeQuery(`
        CREATE TABLE IF NOT EXISTS spiderkart_level_slots (
            slot INT PRIMARY KEY,
            level_json TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
}

async function readLevelData(slot = 0) {
    // Slots 2-5: tabla de slots secundarios
    if (slot >= 2 && slot <= 5) {
        try {
            await ensureSlotTable();
            const r = await executeQuery(`SELECT level_json FROM spiderkart_level_slots WHERE slot = ${slot} LIMIT 1`);
            if (r.result && r.result.length > 0) return JSON.parse(r.result[0].level_json);
        } catch (e) {
            console.warn(`[Level] No se pudo leer slot ${slot}:`, e.message);
        }
        return { ...DEFAULT_LEVEL, name: `Slot ${slot} vacío` };
    }

    // Slot 0/1: nivel activo
    try {
        await ensureLevelTable();
        const r = await executeQuery(`SELECT level_json FROM spiderkart_levels ORDER BY updated_at DESC LIMIT 1`);
        if (r.result && r.result.length > 0) return JSON.parse(r.result[0].level_json);
    } catch (e) {
        console.warn('[Level] DB no disponible, devolviendo default:', e.message);
    }
    return DEFAULT_LEVEL;
}

async function saveLevelData(levelData, slot = 0) {
    const json = JSON.stringify(levelData).replace(/'/g, "''");

    if (slot >= 2 && slot <= 5) {
        try {
            await ensureSlotTable();
            await executeQuery(`
                INSERT INTO spiderkart_level_slots (slot, level_json)
                VALUES (${slot}, '${json}')
                ON DUPLICATE KEY UPDATE level_json = '${json}', updated_at = CURRENT_TIMESTAMP
            `);
            return true;
        } catch (e) {
            console.error('[Level] Error guardando slot:', e.message);
            return false;
        }
    }

    // Nivel activo: reemplazar en spiderkart_levels
    try {
        await ensureLevelTable();
        await executeQuery(`DELETE FROM spiderkart_levels`);
        await executeQuery(`INSERT INTO spiderkart_levels (level_json) VALUES ('${json}')`);
        // También refrescar slot 1 en la tabla de slots
        await ensureSlotTable();
        await executeQuery(`
            INSERT INTO spiderkart_level_slots (slot, level_json)
            VALUES (1, '${json}')
            ON DUPLICATE KEY UPDATE level_json = '${json}', updated_at = CURRENT_TIMESTAMP
        `);
        return true;
    } catch (e) {
        console.error('[Level] Error guardando nivel activo:', e.message);
        return false;
    }
}

// ─── Rutas Admin ─────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'admin.html'));
});

// GET /api/level — nivel activo (público)
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

// GET /api/levels — listar slots (admin)
app.get('/api/levels', requireAdmin, async (req, res) => {
    try {
        const active = await readLevelData(0);
        const slots = [{ slot: 1, name: active.name, empty: false, totalLaps: active.totalLaps || 3 }];
        for (let i = 2; i <= 5; i++) {
            const lvl = await readLevelData(i);
            slots.push({ slot: i, name: lvl.name, empty: lvl.name === `Slot ${i} vacío`, totalLaps: lvl.totalLaps || 3 });
        }
        res.json({ slots });
    } catch (e) {
        res.status(500).json({ error: 'Error leyendo slots.' });
    }
});

// POST /api/level — guardar nivel (admin)
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
    res.json({ ok: true, savedToDb, slot: slot || 1, message: savedToDb ? 'Guardado en DB.' : 'Error guardando en DB.' });
});

// POST /api/level/activate — activar slot como nivel activo (admin)
app.post('/api/level/activate', requireAdmin, async (req, res) => {
    const { slot } = req.body;
    if (!slot || slot < 1 || slot > 5) return res.status(400).json({ error: 'Slot inválido (1-5).' });
    try {
        const levelData = await readLevelData(slot);
        if (!levelData || levelData.name === `Slot ${slot} vacío`) {
            return res.status(404).json({ error: `Slot ${slot} está vacío.` });
        }
        await saveLevelData(levelData, 0);
        res.json({ ok: true, message: `Slot ${slot} activado como nivel actual.` });
    } catch (e) {
        res.status(500).json({ error: 'Error activando slot.' });
    }
});

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
    const { token } = req.body;
    if (token === ADMIN_TOKEN) {
        res.json({ ok: true });
    } else {
        res.status(401).json({ ok: false, error: 'Token incorrecto.' });
    }
});

// ─── DB Init ─────────────────────────────────────────────────────────────────
app.get('/api/init-db', async (req, res) => {
    try {
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try { await executeQuery('ALTER TABLE users ADD COLUMN email VARCHAR(100) UNIQUE;'); } catch (e) {}
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                score INT NOT NULL,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
        await ensureLevelTable();
        await ensureSlotTable();
        res.json({ message: 'Tablas inicializadas correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error inicializando la base de datos' });
    }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const checkResult = await executeQuery(`SELECT id FROM users WHERE username = '${username}' OR email = '${email}'`);
        if (checkResult.result && checkResult.result.length > 0) {
            return res.status(400).json({ error: 'El usuario o el correo ya existen' });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        await executeQuery(`INSERT INTO users (username, email, password_hash) VALUES ('${username}', '${email}', '${passwordHash}')`);
        console.log(`[INFO] Nuevo usuario registrado: ${username}`);
        res.status(201).json({ message: 'Usuario registrado exitosamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/auth/quick-register', async (req, res) => {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const emailResult = await executeQuery(`SELECT id, username FROM users WHERE email = '${email}'`);
        if (emailResult.result && emailResult.result.length > 0) {
            const user = emailResult.result[0];
            return res.status(200).json({ message: 'Sesión iniciada exitosamente', username: user.username, userId: user.id });
        }
        const userResult = await executeQuery(`SELECT id FROM users WHERE username = '${username}'`);
        if (userResult.result && userResult.result.length > 0) {
            return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
        }
        const passwordHash = await bcrypt.hash(email + '_quick', 10);
        await executeQuery(`INSERT INTO users (username, email, password_hash) VALUES ('${username}', '${email}', '${passwordHash}')`);
        const finalUserResult = await executeQuery(`SELECT id, username FROM users WHERE username = '${username}'`);
        const userInserted = finalUserResult.result[0];
        console.log(`[INFO] Registro rápido: ${username}`);
        res.status(201).json({ message: 'Usuario registrado exitosamente', username: userInserted.username, userId: userInserted.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const result = await executeQuery(`SELECT * FROM users WHERE username = '${username}'`);
        if (!result.result || result.result.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        const user = result.result[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });
        res.json({ message: 'Login exitoso', username: user.username, userId: user.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── Leaderboard ─────────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await executeQuery(`
            SELECT u.username, l.score, l.recorded_at
            FROM leaderboard l
            JOIN users u ON l.user_id = u.id
            ORDER BY l.score DESC
            LIMIT 10
        `);
        res.json({ data: result.result || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo leaderboard' });
    }
});

app.post('/api/leaderboard', async (req, res) => {
    const { userId, score } = req.body;
    try {
        await executeQuery(`INSERT INTO leaderboard (user_id, score) VALUES (${userId}, ${score})`);
        res.status(201).json({ message: 'Score registrado exitosamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error guardando score' });
    }
});

// ─── Salas (solo informativo en Vercel — no hay rooms en memoria) ─────────────
app.get('/api/rooms', (req, res) => {
    res.json({ rooms: [], note: 'WebSocket multiplayer no disponible en este entorno. Configura SPIDERKART_WS_URL.' });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).sendFile(join(__dirname, '..', 'public', '404.html'));
});

export default app;
