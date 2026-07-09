const { Pool } = require('pg');
require('dotenv').config({ override: true });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ Error: DATABASE_URL environment variable is missing!');
  process.exit(1);
}

// Support SSL connections if running on cloud databases like Heroku, Supabase, Neon
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

/**
 * Initialize Database Schema
 */
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users table for main Controller Bot wizard state
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        step VARCHAR(50) DEFAULT 'idle',
        temp_token TEXT
      )
    `);

    // Bots table for custom bot API keys registered by users
    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        token TEXT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        owner_id BIGINT NOT NULL
      )
    `);

    // Channels table linked to custom bots
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id BIGINT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        username VARCHAR(255),
        bot_token TEXT REFERENCES bots(token) ON DELETE CASCADE,
        owner_id BIGINT NOT NULL
      )
    `);

    // Drafts table for active post creation flows
    await client.query(`
      CREATE TABLE IF NOT EXISTS drafts (
        user_id BIGINT PRIMARY KEY,
        bot_token TEXT NOT NULL REFERENCES bots(token) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL,
        text TEXT,
        media_type VARCHAR(50) DEFAULT 'text',
        file_id TEXT
      )
    `);

    // Run safe migrations in case the database already exists
    await client.query(`
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS media_type VARCHAR(50) DEFAULT 'text';
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS file_id TEXT;
      ALTER TABLE drafts ALTER COLUMN text DROP NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('✅ PostgreSQL Database schema checked & initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// --- USER OPERATIONS ---

async function getUser(telegramId) {
  const res = await pool.query(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  if (res.rows.length === 0) {
    // Insert default user
    const insertRes = await pool.query(
      'INSERT INTO users (telegram_id, step) VALUES ($1, $2) RETURNING *',
      [telegramId, 'idle']
    );
    return insertRes.rows[0];
  }
  return res.rows[0];
}

async function updateUserStep(telegramId, step, tempToken = null) {
  // Enforce user exists first
  await getUser(telegramId);
  const res = await pool.query(
    'UPDATE users SET step = $2, temp_token = $3 WHERE telegram_id = $1 RETURNING *',
    [telegramId, step, tempToken]
  );
  return res.rows[0];
}

// --- BOT OPERATIONS ---

async function addBot(token, username, name, ownerId) {
  const res = await pool.query(
    `INSERT INTO bots (token, username, name, owner_id) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT (token) DO UPDATE 
     SET username = EXCLUDED.username, name = EXCLUDED.name, owner_id = EXCLUDED.owner_id
     RETURNING *`,
    [token, username, name, ownerId]
  );
  return res.rows[0];
}

async function getBots() {
  const res = await pool.query('SELECT * FROM bots');
  return res.rows;
}

async function getBot(token) {
  const res = await pool.query('SELECT * FROM bots WHERE token = $1', [token]);
  return res.rows[0] || null;
}

async function getBotsByOwner(ownerId) {
  const res = await pool.query('SELECT * FROM bots WHERE owner_id = $1', [ownerId]);
  return res.rows;
}

async function removeBot(token) {
  const res = await pool.query('DELETE FROM bots WHERE token = $1 RETURNING *', [token]);
  return res.rows[0] || null;
}

// --- CHANNEL OPERATIONS ---

async function addChannel(channelId, title, username, botToken, ownerId) {
  const res = await pool.query(
    `INSERT INTO channels (channel_id, title, username, bot_token, owner_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id) DO UPDATE
     SET title = EXCLUDED.title, username = EXCLUDED.username, bot_token = EXCLUDED.bot_token, owner_id = EXCLUDED.owner_id
     RETURNING *`,
    [channelId, title, username, botToken, ownerId]
  );
  return res.rows[0];
}

async function getChannel(channelId) {
  const res = await pool.query('SELECT * FROM channels WHERE channel_id = $1', [channelId]);
  return res.rows[0] || null;
}

async function getChannelsByBot(botToken) {
  const res = await pool.query('SELECT * FROM channels WHERE bot_token = $1', [botToken]);
  return res.rows;
}

async function getChannelsByOwner(ownerId) {
  const res = await pool.query('SELECT * FROM channels WHERE owner_id = $1', [ownerId]);
  return res.rows;
}

async function removeChannel(channelId) {
  const res = await pool.query('DELETE FROM channels WHERE channel_id = $1 RETURNING *', [channelId]);
  return res.rows[0] || null;
}

// --- DRAFT OPERATIONS ---

async function saveDraft(userId, botToken, channelId, text, mediaType = 'text', fileId = null) {
  const res = await pool.query(
    `INSERT INTO drafts (user_id, bot_token, channel_id, text, media_type, file_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE
     SET bot_token = EXCLUDED.bot_token, channel_id = EXCLUDED.channel_id, text = EXCLUDED.text, media_type = EXCLUDED.media_type, file_id = EXCLUDED.file_id
     RETURNING *`,
    [userId, botToken, channelId, text, mediaType, fileId]
  );
  return res.rows[0];
}

async function getDraft(userId) {
  const res = await pool.query('SELECT * FROM drafts WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function clearDraft(userId) {
  const res = await pool.query('DELETE FROM drafts WHERE user_id = $1 RETURNING *', [userId]);
  return res.rows[0] || null;
}

module.exports = {
  pool,
  initDb,
  getUser,
  updateUserStep,
  addBot,
  getBots,
  getBot,
  getBotsByOwner,
  removeBot,
  addChannel,
  getChannel,
  getChannelsByBot,
  getChannelsByOwner,
  removeChannel,
  saveDraft,
  getDraft,
  clearDraft
};
