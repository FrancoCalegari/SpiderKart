import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Server } from 'socket.io';
import { createServer } from 'http';

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
    if (!room) return;
    
    const allFinished = room.players.every(p => p.timeMs > 0);
    if (allFinished) {
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
                    broadcastToRoom(playerGlobal.room, {
                        type: 'hit',
                        targetId: data.targetId,
                        sourceId: playerGlobal.id
                    }, null);
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

server.listen(PORT, () => {
    console.log(`Servidor HTTP y WebSocket corriendo en el puerto ${PORT}`);
});
