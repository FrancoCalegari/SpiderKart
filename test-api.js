import dotenv from 'dotenv';
import fetch from 'node-fetch';
import bcrypt from 'bcrypt';
dotenv.config();

const SPIDER_API_URL = 'https://spiderwebargapi.com.ar/api/v1';
const SPIDER_API_KEY = process.env.spiderapikey;
const SPIDER_DB_NAME = process.env.spiderdbname;

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
    console.log('Query:', query);
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text);
    if (!response.ok) throw new Error('Failed');
    return JSON.parse(text);
}

async function test() {
    try {
        const username = 'testuser2';
        const passwordHash = await bcrypt.hash('12345', 10);
        
        const checkQuery = `SELECT * FROM users WHERE username = '${username}'`;
        await executeQuery(checkQuery);
        
        const insertQuery = `INSERT INTO users (username, password_hash) VALUES ('${username}', '${passwordHash}')`;
        await executeQuery(insertQuery);
        
    } catch(e) {
        console.error('Error:', e);
    }
}
test();
