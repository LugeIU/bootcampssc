const { createClient } = require('@libsql/client');
require('dotenv').config();

async function initDB() {
    const client = createClient({
        url: process.env.TURSO_DATABASE_URL || 'file:bootcamp.db',
        authToken: process.env.TURSO_AUTH_TOKEN
    });

    await client.execute(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            riot_id TEXT UNIQUE NOT NULL,
            puuid TEXT NOT NULL,
            preferred_tier INTEGER NOT NULL,
            tier_group INTEGER DEFAULT 0,
            status TEXT DEFAULT 'REGISTERED',
            eliminated_round INTEGER DEFAULT NULL,
            current_rank TEXT DEFAULT 'UNRANKED',
            current_lp INTEGER DEFAULT 0,
            total_points INTEGER DEFAULT 0,
            games_played INTEGER DEFAULT 0,
            checkpoint_games INTEGER DEFAULT 0,
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Bọc các hàm để tương thích hoàn toàn với server.js hiện tại
    return {
        all: async (sql, params = []) => {
            const res = await client.execute({ sql, args: params });
            return res.rows;
        },
        get: async (sql, params = []) => {
            const res = await client.execute({ sql, args: params });
            return res.rows[0];
        },
        run: async (sql, params = []) => {
            return await client.execute({ sql, args: params });
        }
    };
}

module.exports = { initDB };