import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

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
            console.error('[DB] Error al conectar con SpiderWebARG API:', response.status, response.statusText);
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
        
        if (checkResult.data && checkResult.data.length > 0) {
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
        
        if (!result.data || result.data.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const user = result.data[0];
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
        res.json({ data: result.data || [] });
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

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
