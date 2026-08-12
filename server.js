import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Configuración de middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

// Configuración de la API SpiderWebARG
const SPIDER_API_URL = 'https://spiderwebargapi.com.ar/api/v1';
const SPIDER_API_KEY = process.env.spiderapikey || 'c20cdfd802d9e387d77176ee597ac66f26b9513bd15d2a95886d34befc0b7ad6';
const SPIDER_DB_NAME = process.env.spiderdbname || 'sw_Franco Calegari_SpiderKart';

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

// Endpoint para inicializar tablas si no existen (opcional)
app.get('/api/init-db', async (req, res) => {
    try {
        const queryUsers = `
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
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
        await executeQuery(queryLeaderboard);
        res.json({ message: 'Tablas inicializadas correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error inicializando la base de datos' });
    }
});

// Endpoint de Registro
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        // Verificar si el usuario ya existe
        const checkQuery = `SELECT * FROM users WHERE username = '${username}'`;
        const checkResult = await executeQuery(checkQuery);
        
        if (checkResult.result && checkResult.result.length > 0) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }

        // Hashear contraseña
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Insertar usuario
        const insertQuery = `INSERT INTO users (username, password_hash) VALUES ('${username}', '${passwordHash}')`;
        await executeQuery(insertQuery);
        
        console.log(`[INFO] Nuevo usuario registrado: ${username}`);
        res.status(201).json({ message: 'Usuario registrado exitosamente' });
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

// ---------------------------------------------------------
// Lógica de Salas y WebSockets (Multijugador)
// ---------------------------------------------------------
const rooms = {}; // roomName -> { phase, laps, players: [{ws, id, name, ready, color, timeMs}] }
const playersGlobal = {}; // id -> { ws, room, id, name }
const MIN_PLAYERS = 2;

function getRoom(roomName) {
    if (!rooms[roomName]) {
        rooms[roomName] = { phase: 'waiting', laps: 3, players: [] };
    }
    return rooms[roomName];
}

function broadcastToRoom(roomName, msg, excludeWs = null) {
    const room = rooms[roomName];
    if (!room) return;
    const msgStr = JSON.stringify(msg);
    room.players.forEach(p => {
        if (p.ws !== excludeWs && p.ws.readyState === 1 /* OPEN */) {
            p.ws.send(msgStr);
        }
    });
}

function handleLeave(ws) {
    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === ws);
    if (!playerGlobal) return;
    
    const { room: roomName, id } = playerGlobal;
    const room = rooms[roomName];
    if (room) {
        room.players = room.players.filter(p => p.id !== id);
        broadcastToRoom(roomName, { type: 'player_left', id });
        
        if (room.players.length === 0) {
            delete rooms[roomName];
        } else if (room.players.length < MIN_PLAYERS && room.phase !== 'racing' && room.phase !== 'finished') {
            room.phase = 'waiting';
            if (room.countdownInterval) clearInterval(room.countdownInterval);
            broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: MIN_PLAYERS });
        }
    }
    delete playersGlobal[id];
}

function startCountdown(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    room.phase = 'countdown';
    let seconds = 5;
    
    broadcastToRoom(roomName, { type: 'countdown', seconds });
    
    room.countdownInterval = setInterval(() => {
        seconds--;
        if (seconds > 0) {
            broadcastToRoom(roomName, { type: 'countdown', seconds });
        } else {
            clearInterval(room.countdownInterval);
            if (room.players.length >= MIN_PLAYERS) {
                room.phase = 'racing';
                broadcastToRoom(roomName, { type: 'race_start', laps: room.laps });
            } else {
                room.phase = 'waiting';
                broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: MIN_PLAYERS });
            }
        }
    }, 1000);
}

function checkRaceFinish(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    
    const allFinished = room.players.every(p => p.timeMs > 0);
    if (allFinished) {
        room.phase = 'finished';
        const results = room.players
            .map(p => ({ id: p.id, name: p.name, timeMs: p.timeMs }))
            .sort((a, b) => a.timeMs - b.timeMs)
            .map((r, idx) => ({ ...r, position: idx + 1 }));
            
        // Opcional: Aquí se podría integrar la lógica para guardar el puntaje en SpiderWebARG
        // usando executeQuery() si los jugadores están validados.
        
        broadcastToRoom(roomName, { type: 'race_results', results, saved: false });
        
        // Reiniciar la sala después de un tiempo
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
}

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, room: roomName, name, pilotId, timeMs, lap } = data;

            switch (type) {
                case 'join': {
                    if (!roomName || !name) return;
                    const id = pilotId || 'pilot_' + Math.random().toString(36).substr(2, 9);
                    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
                    
                    const room = getRoom(roomName);
                    
                    if (room.phase === 'racing' || room.phase === 'countdown') {
                        ws.send(JSON.stringify({ type: 'error', message: 'La carrera ya empezó' }));
                        return;
                    }

                    // Limpiar sesión previa si se reconecta rápido
                    if (playersGlobal[id]) {
                        handleLeave(playersGlobal[id].ws);
                    }

                    const player = { ws, id, name, ready: true, color, timeMs: 0, position: 0 };
                    room.players.push(player);
                    playersGlobal[id] = { ws, room: roomName, id, name };

                    ws.send(JSON.stringify({
                        type: 'joined',
                        room: roomName,
                        playerId: id,
                        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, ready: p.ready }))
                    }));

                    broadcastToRoom(roomName, {
                        type: 'player_joined',
                        id, name, color
                    }, ws);

                    if (room.players.length >= MIN_PLAYERS && room.phase === 'waiting') {
                        startCountdown(roomName);
                    } else if (room.phase === 'waiting') {
                        broadcastToRoom(roomName, { type: 'waiting', count: room.players.length, min: MIN_PLAYERS });
                    }
                    break;
                }
                
                case 'state': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === ws);
                    if (!playerGlobal) return;
                    const { x, y, z, angle, speed, boosting } = data;
                    broadcastToRoom(playerGlobal.room, {
                        type: 'state',
                        id: playerGlobal.id,
                        x, y, z, angle, speed, boosting, lap
                    }, ws);
                    break;
                }

                case 'finish': {
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === ws);
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
                    const playerGlobal = Object.values(playersGlobal).find(p => p.ws === ws);
                    if (!playerGlobal) return;
                    broadcastToRoom(playerGlobal.room, {
                        type: 'hit',
                        targetId: data.targetId,
                        sourceId: playerGlobal.id
                    }, null);
                    break;
                }
                
                case 'leave': {
                    handleLeave(ws);
                    break;
                }
            }
        } catch (e) {
            console.error('WS Error:', e);
        }
    });

    ws.on('close', () => handleLeave(ws));
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP y WebSocket corriendo en el puerto ${PORT}`);
});
