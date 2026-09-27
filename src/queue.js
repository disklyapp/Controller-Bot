const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
require('dotenv').config({ override: true });

const redisUrl = process.env.REDIS_URL || 'redis://default:kUmJPwOOwBRCbSSVNtPzNxDvSRmcHhco@iriguchi.proxy.rlwy.net:50293';

// Setup IORedis connection for BullMQ
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

connection.on('connect', () => {
  console.log('✅ Connected to Redis instance for post queue.');
});

connection.on('error', (err) => {
  console.error('❌ Redis Connection Error:', err.message);
});

const QUEUE_NAME = 'scheduled-posts-queue';

const postQueue = new Queue(QUEUE_NAME, { connection });

let postWorker = null;

/**
 * Add a scheduled post job to Redis BullMQ Queue
 */
async function addScheduledJob(postId, runAt) {
  const delay = Math.max(0, new Date(runAt).getTime() - Date.now());
  const jobId = `post_${postId}`;

  // Remove existing job if any
  try {
    const existingJob = await postQueue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove();
    }
  } catch (e) {}

  await postQueue.add(
    'send-scheduled-post',
    { postId },
    {
      jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: false
    }
  );

  console.log(`📌 [Redis Queue] Post ID ${postId} enqueued with delay ${Math.round(delay / 1000)}s (JobId: ${jobId})`);
}

/**
 * Remove a scheduled job from Redis BullMQ Queue
 */
async function removeScheduledJob(postId) {
  const jobId = `post_${postId}`;
  try {
    const job = await postQueue.getJob(jobId);
    if (job) {
      await job.remove();
      console.log(`🗑️ [Redis Queue] Job ${jobId} removed from queue.`);
    }
  } catch (err) {
    console.error(`Error removing job ${jobId} from Redis queue:`, err.message);
  }
}

/**
 * Initialize Worker and start processing Redis queue jobs
 */
function initQueueWorker(getRunningBotFn) {
  if (postWorker) return;

  postWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { postId } = job.data;
      console.log(`🚀 [Redis Queue Worker] Processing job for post ID ${postId}...`);

      // Fetch post details from DB
      const res = await db.pool.query('SELECT * FROM scheduled_posts WHERE id = $1', [postId]);
      const post = res.rows[0];

      if (!post) {
        console.log(`⚠️ [Redis Queue Worker] Post ID ${postId} no longer exists in DB. Skipping.`);
        return;
      }

      const bot = getRunningBotFn(post.bot_token);
      if (!bot) {
        console.error(`❌ [Redis Queue Worker] Bot token ${post.bot_token.substring(0, 10)}... is not active. Skipping post ID ${post.id}.`);
        await db.deleteScheduledPost(post.id);
        return;
      }

      try {
        console.log(`📤 [Redis Queue Worker] Sending scheduled post ID ${post.id} to channel ${post.channel_id}...`);

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

        console.log(`✅ [Redis Queue Worker] Post ID ${post.id} successfully sent.`);
      } catch (sendErr) {
        console.error(`❌ [Redis Queue Worker] Error sending post ID ${post.id}:`, sendErr.message);

        // Notify user of failure
        await bot.telegram.sendMessage(
          post.user_id,
          `❌ *Scheduled Post Failed!*\nYour scheduled post failed to send: ${sendErr.message}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } finally {
        // Always remove post from database to prevent duplicate sending
        await db.deleteScheduledPost(post.id);
      }
    },
    { connection }
  );

  postWorker.on('failed', (job, err) => {
    console.error(`❌ [Redis Queue Worker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ [Redis Queue Worker] Scheduler worker started successfully.');
}

/**
 * Sync Database posts with Redis Queue on system startup
 */
async function syncQueueWithDb() {
  try {
    const res = await db.pool.query('SELECT * FROM scheduled_posts ORDER BY run_at ASC');
    const posts = res.rows;
    console.log(`🔄 [Redis Queue] Syncing ${posts.length} scheduled post(s) from database...`);

    for (const post of posts) {
      await addScheduledJob(post.id, post.run_at);
    }
  } catch (err) {
    console.error('❌ [Redis Queue] Error syncing DB with Redis Queue:', err.message);
  }
}

/**
 * Shutdown Queue and Worker gracefully
 */
async function closeQueue() {
  if (postWorker) {
    await postWorker.close();
    postWorker = null;
  }
  await postQueue.close();
  await connection.quit();
  console.log('🛑 [Redis Queue] Queue and connection closed.');
}

module.exports = {
  postQueue,
  addScheduledJob,
  removeScheduledJob,
  initQueueWorker,
  syncQueueWithDb,
  closeQueue
};
