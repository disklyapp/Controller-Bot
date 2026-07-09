const { Telegraf } = require('telegraf');
require('dotenv').config({ override: true });

const db = require('./db');
const botManager = require('./botManager');
const { setupControllerBot } = require('./controllerBot');

async function main() {
  console.log('🚀 Starting Telegram Controller Bot System...');

  // 1. Initialize Database Schema DDL
  try {
    await db.initDb();
  } catch (err) {
    console.error('❌ Database initialization failed. Exiting system.', err);
    process.exit(1);
  }

  // 2. Validate Controller Bot token
  const controllerToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!controllerToken || controllerToken === 'your_controller_bot_token_here') {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing or not configured in your .env file!');
    process.exit(1);
  }

  // 3. Initialize & Start Main Controller Bot
  const controllerBot = new Telegraf(controllerToken);
  
  try {
    setupControllerBot(controllerBot);
    const me = await controllerBot.telegram.getMe();
    console.log(`🤖 Main Controller Bot @${me.username} verified successfully.`);

    // Start main bot
    await controllerBot.launch();
    console.log(`✅ Main Controller Bot is online and polling.`);
  } catch (err) {
    console.error('❌ Failed to launch main Controller Bot:', err.message);
    process.exit(1);
  }

  // 4. Start all registered custom user bots
  try {
    await botManager.startAll();
  } catch (err) {
    console.error('❌ Failed to start custom user bots:', err);
  }

  console.log('✨ System is fully operational.');

  // 5. Setup Graceful Shutdown Listeners
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    
    // Stop main bot polling
    try {
      console.log('Stopping main Controller Bot...');
      await controllerBot.stop();
    } catch (err) {
      console.error('Error stopping main bot:', err);
    }

    // Stop all custom bots polling
    try {
      await botManager.stopAll();
    } catch (err) {
      console.error('Error stopping custom bots:', err);
    }

    // Close Database Pool
    try {
      console.log('Closing database connection pool...');
      await db.pool.end();
    } catch (err) {
      console.error('Error closing database pool:', err);
    }

    console.log('👋 Goodbye!');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Unhandled system error on startup:', err);
  process.exit(1);
});
