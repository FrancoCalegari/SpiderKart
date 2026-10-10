import dotenv from 'dotenv';
dotenv.config();

const API = 'https://spiderwebargapi.com.ar/api/v1';
const KEY = process.env.spiderapikey;
const DB = process.env.spiderdbname;

async function initDb() {
    const queryUsers = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
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

    try {
        const res1 = await fetch(API + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
            body: JSON.stringify({ database: DB, query: queryUsers })
        }).then(r => r.json());
        console.log('Users table init:', res1);

        const resLaps = await fetch(API + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
            body: JSON.stringify({ database: DB, query: queryBestLaps })
        }).then(r => r.json());
        console.log('Best Laps table init:', resLaps);

        const resMulti = await fetch(API + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
            body: JSON.stringify({ database: DB, query: queryMultiplayerStats })
        }).then(r => r.json());
        console.log('Multiplayer Stats table init:', resMulti);
    } catch (e) {
        console.error(e);
    }
}
initDb();
