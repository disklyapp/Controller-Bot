const { Pool } = require('pg');
require('dotenv').config({ override: true });

function getDatabaseUrl() {
  let rawUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const defaultPassword = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'NoAYNPbJLkVIDIvKciqNMvQkKyAOZdlL';
  const defaultUser = process.env.PGUSER || process.env.POSTGRES_USER || 'postgres';
  const defaultDb = process.env.PGDATABASE || process.env.POSTGRES_DB || 'railway';

  if (!rawUrl) {
    return `postgresql://${defaultUser}:${defaultPassword}@crossover.proxy.rlwy.net:24012/${defaultDb}`;
  }

  rawUrl = rawUrl.trim();

  // If user provided full valid URL scheme
  if (rawUrl.startsWith('postgresql://') || rawUrl.startsWith('postgres://')) {
    if (!rawUrl.includes('@')) {
      const clean = rawUrl.replace(/^postgresql:\/\//, '').replace(/^postgres:\/\//, '');
      return `postgresql://${defaultUser}:${defaultPassword}@${clean}`;
    }
    return rawUrl;
  }

  // If user provided raw hostname like "postgres-msgo.railway.internal" or "crossover.proxy.rlwy.net:24012"
  const port = rawUrl.includes(':') ? '' : ':5432';
  return `postgresql://${defaultUser}:${defaultPassword}@${rawUrl}${port}/${defaultDb}`;
}

const connectionString = getDatabaseUrl();

// Support SSL connections if running on cloud databases like Heroku, Supabase, Neon
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1') || connectionString.includes('.railway.internal')
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
        owner_id BIGINT NOT NULL,
        queue_interval INTEGER DEFAULT 1
      )
    `);

    // Drafts table for active post creation flows
    await client.query(`
      CREATE TABLE IF NOT EXISTS drafts (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        bot_token TEXT NOT NULL REFERENCES bots(token) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL,
        text TEXT,
        media_type VARCHAR(50) DEFAULT 'text',
        file_id TEXT
      )
    `);

    // Scheduled posts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        bot_token TEXT REFERENCES bots(token) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL,
        text TEXT,
        media_type VARCHAR(50) DEFAULT 'text',
        file_id TEXT,
        run_at TIMESTAMP WITH TIME ZONE NOT NULL,
        is_queue BOOLEAN DEFAULT FALSE
      )
    `);

    // Run safe migrations in case the database already exists
    await client.query(`
      ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_pkey;
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS media_type VARCHAR(50) DEFAULT 'text';
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS file_id TEXT;
      ALTER TABLE drafts ALTER COLUMN text DROP NOT NULL;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS queue_interval INTEGER DEFAULT 1;
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS is_queue BOOLEAN DEFAULT FALSE;
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
     RETURNING *`,
    [userId, botToken, channelId, text, mediaType, fileId]
  );
  return res.rows[0];
}

async function getDraft(draftIdOrUserId) {
  if (typeof draftIdOrUserId === 'number' || (typeof draftIdOrUserId === 'string' && /^\d+$/.test(draftIdOrUserId))) {
    const resId = await pool.query('SELECT * FROM drafts WHERE id = $1', [parseInt(draftIdOrUserId, 10)]);
    if (resId.rows.length > 0) return resId.rows[0];
  }
  const resUser = await pool.query('SELECT * FROM drafts WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [draftIdOrUserId]);
  return resUser.rows[0] || null;
}

async function clearDraft(draftIdOrUserId) {
  if (typeof draftIdOrUserId === 'number' || (typeof draftIdOrUserId === 'string' && /^\d+$/.test(draftIdOrUserId))) {
    const resId = await pool.query('DELETE FROM drafts WHERE id = $1 RETURNING *', [parseInt(draftIdOrUserId, 10)]);
    if (resId.rows.length > 0) return resId.rows[0];
  }
  const resUser = await pool.query('DELETE FROM drafts WHERE user_id = $1 RETURNING *', [draftIdOrUserId]);
  return resUser.rows[0] || null;
}


// --- SCHEDULED POSTS OPERATIONS ---

async function schedulePost(userId, botToken, channelId, text, mediaType, fileId, runAt, isQueue = false) {
  const res = await pool.query(
    `INSERT INTO scheduled_posts (user_id, bot_token, channel_id, text, media_type, file_id, run_at, is_queue)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, botToken, channelId, text, mediaType, fileId, runAt, isQueue]
  );
  return res.rows[0];
}

async function getDueScheduledPosts() {
  const res = await pool.query(
    'SELECT * FROM scheduled_posts WHERE run_at <= $1 ORDER BY run_at ASC',
    [new Date()]
  );
  return res.rows;
}

async function deleteScheduledPost(id) {
  const res = await pool.query(
    'DELETE FROM scheduled_posts WHERE id = $1 RETURNING *',
    [id]
  );
  return res.rows[0] || null;
}

async function updateChannelInterval(channelId, queueInterval) {
  const res = await pool.query(
    'UPDATE channels SET queue_interval = $2 WHERE channel_id = $1 RETURNING *',
    [channelId, queueInterval]
  );
  return res.rows[0];
}

async function getLatestQueuedPostRunAt(channelId) {
  const res = await pool.query(
    'SELECT MAX(run_at) as max_run FROM scheduled_posts WHERE channel_id = $1 AND is_queue = true',
    [channelId]
  );
  return res.rows[0] ? res.rows[0].max_run : null;
}

async function getScheduledPostsForChannel(channelId) {
  const res = await pool.query(
    'SELECT * FROM scheduled_posts WHERE channel_id = $1 ORDER BY run_at ASC',
    [channelId]
  );
  return res.rows;
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
  clearDraft,
  schedulePost,
  getDueScheduledPosts,
  deleteScheduledPost,
  updateChannelInterval,
  getLatestQueuedPostRunAt,
  getScheduledPostsForChannel
};
