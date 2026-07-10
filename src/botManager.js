const { Telegraf } = require('telegraf');
const db = require('./db');
const { setupCustomBot } = require('./customBot');

// Keep track of active Telegraf instances by token
// Key: botToken, Value: Telegraf instance
const runningBots = new Map();

/**
 * Start a single custom bot by its token
 */
async function startBot(token) {
  if (runningBots.has(token)) {
    console.log('Bot is already running.');
    return runningBots.get(token);
  }

  try {
    const bot = new Telegraf(token);

    // Fetch details to verify token and log its username
    const botInfo = await bot.telegram.getMe();
    console.log(`🤖 Starting custom bot: @${botInfo.username}`);

    // Setup handlers
    setupCustomBot(bot);

    // Global error handler for this specific bot instance
    bot.catch((err, ctx) => {
      console.error(`Error in bot @${botInfo.username}:`, err);
    });

    // Launch polling in the background to avoid blocking the main bot or startup thread
    bot.launch()
      .then(() => {
        console.log(`✅ Custom bot @${botInfo.username} is now online and polling.`);
      })
      .catch(err => {
        console.error(`❌ Failed to launch polling for custom bot @${botInfo.username}:`, err.message);
        runningBots.delete(token);
      });
    
    runningBots.set(token, bot);
    return bot;
  } catch (err) {
    console.error(`❌ Failed to start custom bot with token ${token.substring(0, 10)}... :`, err.message);
    throw err;
  }
}

/**
 * Stop a running custom bot
 */
async function stopBot(token) {
  const bot = runningBots.get(token);
  if (!bot) {
    return false;
  }

  try {
    await bot.stop();
    runningBots.delete(token);
    console.log(`🛑 Custom bot stopped successfully.`);
    return true;
  } catch (err) {
    console.error('Error while stopping custom bot:', err);
    runningBots.delete(token); // Force remove from running list
    return false;
  }
}

/**
 * Start all bots currently registered in the database
 */
async function startAll() {
  console.log('🔄 Loading all registered custom bots from database...');
  const bots = await db.getBots();
  console.log(`Found ${bots.length} custom bot(s) to load.`);

  for (const botRecord of bots) {
    try {
      await startBot(botRecord.token);
    } catch (err) {
      console.error(`Skipping starting bot with token ${botRecord.token.substring(0, 10)}... due to errors.`);
    }
  }
}

/**
 * Stop all running custom bots
 */
async function stopAll() {
  console.log('🛑 Stopping all custom bots...');
  for (const token of runningBots.keys()) {
    await stopBot(token);
  }
  console.log('All custom bots stopped.');
}

/**
 * Retrieve a running bot instance
 */
function getRunningBot(token) {
  return runningBots.get(token) || null;
}

let schedulerIntervalId = null;

/**
 * Checks for due scheduled posts, sends them, and cleans up the queue
 */
async function checkScheduledPosts() {
  const checkTime = new Date();
  console.log(`⏰ [Scheduler] Checking database for due scheduled posts at ${checkTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} (IST)...`);
  try {
    const duePosts = await db.getDueScheduledPosts();
    console.log(`⏰ [Scheduler] Query complete. Found ${duePosts.length} due scheduled post(s) to process.`);
    if (duePosts.length === 0) return;

    console.log(`⏰ [Scheduler] Processing ${duePosts.length} due scheduled post(s)...`);

    for (const post of duePosts) {
      const bot = runningBots.get(post.bot_token);
      if (!bot) {
        console.error(`❌ [Scheduler] Bot with token ${post.bot_token.substring(0, 10)}... is not active. Skipping post ID ${post.id}.`);
        await db.deleteScheduledPost(post.id);
        continue;
      }

      try {
        console.log(`📤 [Scheduler] Sending scheduled post ID ${post.id} to channel ${post.channel_id}...`);
        
        if (post.media_type === 'photo') {
          await bot.telegram.sendPhoto(post.channel_id, post.file_id, { caption: post.text || undefined });
        } else {
          await bot.telegram.sendMessage(post.channel_id, post.text);
        }

        // Notify user of success
        await bot.telegram.sendMessage(
          post.user_id,
          `🕒 *Scheduled Post Sent!*\nYour scheduled post was successfully published to the channel.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});

        console.log(`✅ [Scheduler] Post ID ${post.id} successfully sent.`);
      } catch (sendErr) {
        console.error(`❌ [Scheduler] Error sending post ID ${post.id}:`, sendErr.message);
        
        // Notify user of failure
        await bot.telegram.sendMessage(
          post.user_id,
          `❌ *Scheduled Post Failed!*\nYour scheduled post failed to send: ${sendErr.message}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // Always remove from scheduled queue to prevent double-sending
      await db.deleteScheduledPost(post.id);
    }
  } catch (err) {
    console.error('❌ [Scheduler] Error checking due scheduled posts:', err);
  }
}

/**
 * Start the background scheduler check
 */
function startScheduler(intervalMs = 30000) { // Every 30 seconds by default
  if (schedulerIntervalId) return;
  console.log('⏰ Starting background scheduler worker (checking every 30s)...');
  schedulerIntervalId = setInterval(checkScheduledPosts, intervalMs);
}

/**
 * Stop the background scheduler check
 */
function stopScheduler() {
  if (schedulerIntervalId) {
    console.log('🛑 Stopping background scheduler worker...');
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
  }
}

module.exports = {
  startBot,
  stopBot,
  startAll,
  stopAll,
  getRunningBot,
  startScheduler,
  stopScheduler
};
