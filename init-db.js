const API = 'https://spiderwebargapi.com.ar/api/v1';
const KEY = 'c20cdfd802d9e387d77176ee597ac66f26b9513bd15d2a95886d34befc0b7ad6';
const DB = 'sw_Franco Calegari_SpiderKart';

async function initDb() {
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

    try {
        const res1 = await fetch(API + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
            body: JSON.stringify({ database: DB, query: queryUsers })
        }).then(r => r.json());
        console.log('Users table init:', res1);

        const res2 = await fetch(API + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': KEY },
            body: JSON.stringify({ database: DB, query: queryLeaderboard })
        }).then(r => r.json());
        console.log('Leaderboard table init:', res2);
    } catch (e) {
        console.error(e);
    }
}
initDb();
