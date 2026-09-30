const { Markup } = require('telegraf');
const db = require('./db');
const queueManager = require('./queue');
const { sendPostToChannel, replyWithPreview, getMediaDescription } = require('./utils');

function formatInterval(minutes) {
  if (minutes < 60) {
    return `${minutes} Min${minutes > 1 ? 's' : ''}`;
  }
  const hours = minutes / 60;
  return `${hours} Hour${hours > 1 ? 's' : ''}`;
}

// In-memory sessions to track user steps for each custom bot
// Key: `${userId}:${botToken}`, Value: { channelId, step }
const sessions = new Map();

// In-memory atomic tracker for last queued timestamp per channel to prevent race conditions during bulk forwards
const channelLastQueuedTime = new Map();

async function calculateNextQueueRunAt(channelId, intervalMinutes) {
  let baseTime = Date.now();

  const lastMemoryTime = channelLastQueuedTime.get(channelId);
  if (lastMemoryTime && lastMemoryTime > baseTime) {
    baseTime = lastMemoryTime;
  } else {
    const latestRunAt = await db.getLatestQueuedPostRunAt(channelId);
    if (latestRunAt) {
      const latestDbTime = new Date(latestRunAt).getTime();
      if (latestDbTime > baseTime) {
        baseTime = latestDbTime;
      }
    }
  }

  const runAtTime = baseTime + intervalMinutes * 60 * 1000;
  channelLastQueuedTime.set(channelId, runAtTime);
  return new Date(runAtTime);
}

function setupCustomBot(bot) {

  // Middleware to ensure only the bot owner can use it
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      return; // Ignore group/channel messages sent directly to the bot handler
    }
    
    const token = ctx.telegram.token;
    const botConfig = await db.getBot(token);
    if (!botConfig) {
      return; // Bot is not registered in our database
    }

    const userId = ctx.from ? ctx.from.id : null;
    if (!userId) return;

    if (String(userId) !== String(botConfig.owner_id)) {
      return ctx.reply("❌ Access Denied. This is a private Controller Bot. You can create your own bot via @BotFather and connect it using the main Controller Bot.");
    }

    return next();
  });

  // Start/Newpost Command
  const startHandler = async (ctx) => {
    const token = ctx.telegram.token;
    const channels = await db.getChannelsByBot(token);

    if (channels.length === 0) {
      return ctx.reply(
        "👋 Welcome! This bot is registered as a custom poster, but no channels are connected to it yet.\n\n" +
        "Please go to the main Controller Bot to connect your channel first."
      );
    }

    if (channels.length === 1) {
      // Auto-select the only channel
      const channel = channels[0];
      const sessionKey = `${ctx.from.id}:${token}`;
      sessions.set(sessionKey, { channelId: channel.channel_id, step: 'waiting_for_text' });

      // Clear any existing draft first
      await db.clearDraft(ctx.from.id);

      return ctx.reply(
        `📝 Creating a new post for channel: *${channel.title}*\n\n` +
        `Send me the *text message*, *photo*, *video*, *document*, or *forwarded post* you want to post.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // Let the user choose the channel
      const buttons = channels.map(ch => 
        Markup.button.callback(ch.title, `select_channel:${ch.channel_id}`)
      );
      const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });

      return ctx.reply("Please choose the target channel for your post:", keyboard);
    }
  };

  bot.command('start', startHandler);
  bot.command('newpost', startHandler);

  // Handle Channel Selection Callback
  bot.action(/^select_channel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const channelId = ctx.match[1];
    const token = ctx.telegram.token;

    const channel = await db.getChannel(channelId);
    if (!channel) {
      return ctx.reply("❌ Channel not found.");
    }

    const sessionKey = `${ctx.from.id}:${token}`;
    sessions.set(sessionKey, { channelId, step: 'waiting_for_text' });

    // Clear any existing draft
    await db.clearDraft(ctx.from.id);

    await ctx.editMessageText(
      `📝 Creating a new post for channel: *${channel.title}*\n\n` +
      `Send me the *text message*, *photo*, *video*, *document*, or *forwarded post* you want to post.`,
      { parse_mode: 'Markdown' }
    );
  });

  function getDraftKeyboard(draftId) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👁️ Preview', `preview_post:${draftId}`)],
      [
        Markup.button.callback('📤 Send Now', `send_post:${draftId}`),
        Markup.button.callback('📥 Add to Queue', `add_to_queue:${draftId}`)
      ],
      [
        Markup.button.callback('🕒 Send with Delay', `choose_delay:${draftId}`),
        Markup.button.callback('❌ Cancel', `cancel_post:${draftId}`)
      ]
    ]);
  }

  // Handle Action Buttons (Preview, Send, Cancel, Queue)
  bot.action(/^(?:preview_post|preview_post:(.+))$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    console.log(`🔘 [Custom Bot] User ${ctx.from.id} clicked preview_post for draft ${draftId}`);
    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.reply("❌ No active draft found or already processed.");
    }

    await ctx.reply("👁️ *Preview of your post:*", { parse_mode: 'Markdown' });
    await replyWithPreview(ctx, draft.media_type, draft.file_id, draft.text);
  });

  // Action: Preview for a post already in Queue
  bot.action(/^preview_queued_post:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const postId = parseInt(ctx.match[1], 10);
    console.log(`🔘 [Custom Bot] User ${ctx.from.id} clicked preview_queued_post for post ID ${postId}`);

    const res = await db.pool.query('SELECT * FROM scheduled_posts WHERE id = $1', [postId]);
    const post = res.rows[0];

    if (!post) {
      return ctx.reply("❌ Post no longer exists in queue or already sent.");
    }

    await ctx.reply("👁️ *Preview of queued post:*", { parse_mode: 'Markdown' });
    await replyWithPreview(ctx, post.media_type, post.file_id, post.text);
  });

  // Action: Send Now for a post already in Queue
  bot.action(/^send_queued_post:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const postId = parseInt(ctx.match[1], 10);
    console.log(`📤 [Custom Bot] User ${ctx.from.id} requested immediate send for queued post ID ${postId}`);

    const res = await db.pool.query('SELECT * FROM scheduled_posts WHERE id = $1', [postId]);
    const post = res.rows[0];

    if (!post) {
      return ctx.reply("❌ Post no longer exists in queue or already sent.");
    }

    try {
      await ctx.reply("📤 Sending post immediately...");
      await sendPostToChannel(ctx.telegram, post.channel_id, post.media_type, post.file_id, post.text);
      await queueManager.removeScheduledJob(post.id);
      await db.deleteScheduledPost(post.id);
      await ctx.reply("🎉 *Done!* Queued post sent immediately.", { parse_mode: 'Markdown' });
      console.log(`✅ [Custom Bot] Queued post ID ${post.id} sent immediately.`);
    } catch (err) {
      console.error(`❌ Error sending queued post ID ${postId} immediately:`, err);
      await ctx.reply(`❌ *Failed to send post:* ${err.message}`);
    }
  });

  bot.action(/^(?:send_post|send_post:(.+))$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    console.log(`📤 [Custom Bot] User ${ctx.from.id} clicked send_post for draft ${draftId}`);
    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.reply("❌ No active draft found or already processed.");
    }

    try {
      await ctx.reply("📤 Sending post to destination...");
      await sendPostToChannel(ctx.telegram, draft.channel_id, draft.media_type, draft.file_id, draft.text);
      
      await ctx.reply("🎉 *Done!* Message successfully sent to destination.", { parse_mode: 'Markdown' });
      
      await db.clearDraft(draft.id);
      const sessionKey = `${ctx.from.id}:${ctx.telegram.token}`;
      sessions.delete(sessionKey);
    } catch (err) {
      console.error('Error sending message:', err);
      await ctx.reply(`❌ *Failed to send message:* ${err.message}\n\nMake sure this bot is an administrator in the destination with posting rights.`);
    }
  });

  // Handle Delay Selection Menu
  bot.action(/^(?:choose_delay|choose_delay:(.+))$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⏱️ 5 Mins', `schedule:${draft.id}:5`),
        Markup.button.callback('⏱️ 15 Mins', `schedule:${draft.id}:15`),
        Markup.button.callback('⏱️ 30 Mins', `schedule:${draft.id}:30`)
      ],
      [
        Markup.button.callback('⏱️ 1 Hour', `schedule:${draft.id}:60`),
        Markup.button.callback('⏱️ 2 Hours', `schedule:${draft.id}:120`),
        Markup.button.callback('⏱️ 6 Hours', `schedule:${draft.id}:360`)
      ],
      [
        Markup.button.callback('⏱️ 12 Hours', `schedule:${draft.id}:720`),
        Markup.button.callback('⏱️ 24 Hours', `schedule:${draft.id}:1440`)
      ],
      [Markup.button.callback('↩️ Back to Draft', `back_to_draft:${draft.id}`)]
    ]);

    await ctx.editMessageText(
      "🕒 *Choose a delay interval before sending:*",
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });

  // Handle Go Back to Draft Options
  bot.action(/^(?:back_to_draft|back_to_draft:(.+))$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    const keyboard = getDraftKeyboard(draft.id);
    const description = getMediaDescription(draft.media_type, draft.text, false);

    await ctx.editMessageText(
      `${description}\n\n` +
      `Click *Preview* to see how it looks, *Send Now* to post immediately, *Add to Queue* to queue it, *Send with Delay* to schedule it with a custom delay, or *Cancel* to discard it.`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });

  // Handle Schedule execution
  bot.action(/^schedule:(?:(\d+):)?(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    const minutes = parseInt(ctx.match[2], 10);
    const userId = ctx.from.id;
    const token = ctx.telegram.token;

    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.reply("❌ No active draft found or already processed.");
    }

    try {
      const runAt = new Date(Date.now() + minutes * 60 * 1000);

      const post = await db.schedulePost(
        userId,
        token,
        draft.channel_id,
        draft.text,
        draft.media_type,
        draft.file_id,
        runAt
      );

      await queueManager.addScheduledJob(post.id, post.run_at);
      await db.clearDraft(draft.id);

      const sessionKey = `${userId}:${token}`;
      sessions.delete(sessionKey);

      const timeString = runAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });

      await ctx.editMessageText(
        `🕒 *Post successfully scheduled!*\n\n` +
        `It will be sent to destination in *${minutes} minutes* (on ${dateString} at ${timeString}).`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Scheduling error:', err);
      await ctx.reply(`❌ Failed to schedule post: ${err.message}`);
    }
  });

  bot.action(/^(?:cancel_post|cancel_post:(.+))$/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = ctx.match[1] || ctx.from.id;
    await db.clearDraft(draftId);
    
    const sessionKey = `${ctx.from.id}:${ctx.telegram.token}`;
    sessions.delete(sessionKey);

    await ctx.reply("❌ Post creation cancelled. Draft discarded.");
  });

  // Handle Add to Queue execution
  bot.action(/^(?:add_to_queue|add_to_queue:(.+))$/, async (ctx) => {
    const draftId = ctx.match[1] || ctx.from.id;
    const userId = ctx.from.id;
    const token = ctx.telegram.token;

    const draft = await db.getDraft(draftId);
    if (!draft) {
      return ctx.answerCbQuery("❌ No active draft found or already processed!", { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery().catch(() => {});

    try {
      const channel = await db.getChannel(draft.channel_id);
      const intervalMinutes = channel ? (channel.queue_interval || 1) : 1;

      const runAt = await calculateNextQueueRunAt(draft.channel_id, intervalMinutes);

      const post = await db.schedulePost(
        userId,
        token,
        draft.channel_id,
        draft.text,
        draft.media_type,
        draft.file_id,
        runAt,
        true
      );

      await queueManager.addScheduledJob(post.id, post.run_at);
      await db.clearDraft(draft.id);

      const sessionKey = `${userId}:${token}`;
      sessions.delete(sessionKey);

      const timeString = runAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });

      await ctx.editMessageText(
        `📥 *Post successfully added to Queue!*\n\n` +
        `• Queue Interval: *${formatInterval(intervalMinutes)}*\n` +
        `• Scheduled to send on: *${dateString} at ${timeString}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Queue scheduling error:', err);
      await ctx.reply(`❌ Failed to add post to queue: ${err.message}`);
    }
  });


  // Handle Queue viewing and management
  bot.command('queue', async (ctx) => {
    const token = ctx.telegram.token;
    const channels = await db.getChannelsByBot(token);

    if (channels.length === 0) {
      return ctx.reply("❌ No channels connected to this bot yet.");
    }

    if (channels.length === 1) {
      return showChannelQueue(ctx, channels[0].channel_id);
    } else {
      const buttons = channels.map(ch => 
        Markup.button.callback(ch.title, `view_queue_ch:${ch.channel_id}`)
      );
      const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });

      return ctx.reply("Please choose the target channel to view its queue:", keyboard);
    }
  });

  // Clear all queued posts command
  bot.command('clearqueue', async (ctx) => {
    const token = ctx.telegram.token;
    const userId = ctx.from.id;
    console.log(`🧹 [Custom Bot] User ${userId} ran /clearqueue command`);

    const channels = await db.getChannelsByBot(token);
    if (channels.length === 0) {
      return ctx.reply("❌ No channels connected to this bot.");
    }

    let totalDeleted = 0;
    for (const channel of channels) {
      const posts = await db.getScheduledPostsForChannel(channel.channel_id);
      const queuedPosts = posts.filter(p => p.is_queue);

      for (const post of queuedPosts) {
        await db.deleteScheduledPost(post.id);
        await queueManager.removeScheduledJob(post.id);
        totalDeleted++;
      }
      channelLastQueuedTime.delete(channel.channel_id);
    }

    return ctx.reply(`🧹 *Queue Purged!*\nSuccessfully deleted *${totalDeleted}* queued post(s).`, { parse_mode: 'Markdown' });
  });

  bot.action(/^view_queue_ch:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const channelId = ctx.match[1];
    return showChannelQueue(ctx, channelId, true);
  });

  bot.action(/^del_q_post:(\d+):(.+)$/, async (ctx) => {
    const postId = parseInt(ctx.match[1], 10);
    const channelId = ctx.match[2];
    console.log(`🗑️ [Custom Bot] User ${ctx.from.id} requested deletion of queued post ID ${postId}`);

    const deleted = await db.deleteScheduledPost(postId);
    if (deleted) {
      await queueManager.removeScheduledJob(postId);
      await ctx.answerCbQuery("✅ Post deleted from queue.").catch(() => {});
      try {
        await ctx.editMessageText("🗑️ *Post removed from queue.*", { parse_mode: 'Markdown' });
      } catch (err) {
        await ctx.reply("🗑️ *Post removed from queue.*", { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.answerCbQuery("⚠️ Post not found or already sent.").catch(() => {});
    }
  });

  // Handle target channel selection for draft (for multiple channels flow)
  bot.action(/^sel_draft_ch:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const channelId = ctx.match[1];
    const userId = ctx.from.id;
    const token = ctx.telegram.token;

    const channel = await db.getChannel(channelId);
    if (!channel) {
      return ctx.reply("❌ Channel not found.");
    }

    const draft = await db.getDraft(userId);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    try {
      const intervalMinutes = channel.queue_interval || 1;
      const runAt = await calculateNextQueueRunAt(channel.channel_id, intervalMinutes);

      const post = await db.schedulePost(
        userId,
        token,
        channel.channel_id,
        draft.text,
        draft.media_type,
        draft.file_id,
        runAt,
        true // is_queue = true
      );

      await queueManager.addScheduledJob(post.id, post.run_at);
      await db.clearDraft(draft.id);

      console.log(`📌 [Custom Bot] Post ID ${post.id} auto-queued for Channel "${channel.title}" after channel selection. RunAt: ${runAt.toISOString()}`);

      const timeString = runAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('👁️ Preview', `preview_queued_post:${post.id}`),
          Markup.button.callback('📤 Send Now', `send_queued_post:${post.id}`)
        ],
        [
          Markup.button.callback('❌ Delete from Queue', `del_q_post:${post.id}:${channel.channel_id}`)
        ]
      ]);

      await ctx.editMessageText(
        `📥 *Post auto-queued for ${channel.title}!*\n\n` +
        `• Queue Interval: *${formatInterval(intervalMinutes)}*\n` +
        `• Scheduled Send: *${dateString} at ${timeString}*`,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    } catch (err) {
      console.error(`❌ Failed to auto-queue post after channel selection:`, err);
      await ctx.reply(`❌ Failed to add post to queue: ${err.message}`);
    }
  });

  // Handle incoming message for post (Accepts text, photo, video, document, animation, audio, voice, forwarded messages)
  bot.on('message', async (ctx) => {
    const token = ctx.telegram.token;
    const sessionKey = `${ctx.from.id}:${token}`;
    const session = sessions.get(sessionKey);

    const me = await ctx.telegram.getMe().catch(() => ({ username: 'custom_bot' }));
    const botUsername = me ? me.username : 'custom_bot';

    // Extract text/media from incoming message
    let text = null;
    let mediaType = 'text';
    let fileId = null;

    if (ctx.message.photo) {
      const photos = ctx.message.photo;
      fileId = photos[photos.length - 1].file_id;
      text = ctx.message.caption || null;
      mediaType = 'photo';
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
      text = ctx.message.caption || null;
      mediaType = 'video';
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      text = ctx.message.caption || null;
      mediaType = 'document';
    } else if (ctx.message.animation) {
      fileId = ctx.message.animation.file_id;
      text = ctx.message.caption || null;
      mediaType = 'animation';
    } else if (ctx.message.audio) {
      fileId = ctx.message.audio.file_id;
      text = ctx.message.caption || null;
      mediaType = 'audio';
    } else if (ctx.message.voice) {
      fileId = ctx.message.voice.file_id;
      text = ctx.message.caption || null;
      mediaType = 'voice';
    } else if (ctx.message.text) {
      text = ctx.message.text;
      mediaType = 'text';
    } else {
      console.log(`⚠️ [Bot @${botUsername}] Received unsupported message format from user ${ctx.from.id}`);
      return ctx.reply("⚠️ Unsupported message format. Please send a text, photo, video, document, GIF, or audio file.");
    }

    const isForwarded = !!(ctx.message.forward_origin || ctx.message.forward_date || ctx.message.forward_from_chat || ctx.message.forward_from);
    console.log(`📩 [Bot @${botUsername}] Received ${isForwarded ? 'FORWARDED ' : ''}${mediaType.toUpperCase()} from user ${ctx.from.id} (Caption/Text length: ${text ? text.length : 0})`);

    const channels = await db.getChannelsByBot(token);
    if (channels.length === 0) {
      console.log(`⚠️ [Bot @${botUsername}] User ${ctx.from.id} sent message, but no channels connected to this bot.`);
      return ctx.reply("👋 Welcome! Please connect a channel using the main Controller Bot first.");
    }

    let targetChannel = channels[0];
    if (channels.length > 1) {
      const existingDraft = await db.getDraft(ctx.from.id);
      if (existingDraft && existingDraft.channel_id) {
        const matchCh = channels.find(c => String(c.channel_id) === String(existingDraft.channel_id));
        if (matchCh) {
          targetChannel = matchCh;
        }
      } else if (!session || session.step !== 'waiting_for_text') {
        // Multiple channels connected and no channel selected yet: save draft and prompt for channel selection
        await db.saveDraft(ctx.from.id, token, 0, text, mediaType, fileId);
        const buttons = channels.map(ch => Markup.button.callback(ch.title, `sel_draft_ch:${ch.channel_id}`));
        const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });
        const description = getMediaDescription(mediaType, text, isForwarded);
        console.log(`📋 [Bot @${botUsername}] Prompting user ${ctx.from.id} to select target channel from ${channels.length} options.`);
        return ctx.reply(`${description}\n\nPlease choose the target channel for your post:`, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
      }
    }

    // Auto-queue the post immediately for targetChannel
    try {
      const intervalMinutes = targetChannel.queue_interval || 1;
      const runAt = await calculateNextQueueRunAt(targetChannel.channel_id, intervalMinutes);

      const post = await db.schedulePost(
        ctx.from.id,
        token,
        targetChannel.channel_id,
        text,
        mediaType,
        fileId,
        runAt,
        true // is_queue = true
      );

      // Add to Redis Queue
      await queueManager.addScheduledJob(post.id, post.run_at);

      console.log(`📌 [Bot @${botUsername}] AUTO-QUEUED Post ID ${post.id} for Channel "${targetChannel.title}" (${targetChannel.channel_id}). RunAt: ${runAt.toISOString()}, Interval: ${intervalMinutes}m`);

      if (session && session.step === 'waiting_for_text') {
        sessions.delete(sessionKey);
      }

      const timeString = runAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('👁️ Preview', `preview_queued_post:${post.id}`),
          Markup.button.callback('📤 Send Now', `send_queued_post:${post.id}`)
        ],
        [
          Markup.button.callback('❌ Delete from Queue', `del_q_post:${post.id}:${targetChannel.channel_id}`)
        ]
      ]);

      const label = isForwarded ? 'Forwarded post' : `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} post`;

      return ctx.reply(
        `📥 *${label} auto-queued!*\n` +
        `• Channel: *${targetChannel.title}*\n` +
        `• Queue Interval: *${formatInterval(intervalMinutes)}*\n` +
        `• Scheduled Send: *${dateString} at ${timeString}*`,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    } catch (err) {
      console.error(`❌ [Bot @${botUsername}] Auto-queue failed for user ${ctx.from.id}:`, err);
      return ctx.reply(`❌ Failed to auto-queue post: ${err.message}`);
    }
  });

}

async function showChannelQueue(ctx, channelId, editMessage = false) {
  const channel = await db.getChannel(channelId);
  if (!channel) {
    const text = "❌ Channel not found.";
    return editMessage ? ctx.editMessageText(text) : ctx.reply(text);
  }

  const posts = await db.getScheduledPostsForChannel(channelId);
  const queuedPosts = posts.filter(p => p.is_queue);

  if (queuedPosts.length === 0) {
    const text = `📭 *Queue is empty for channel: ${channel.title}*\n\nSend /newpost to start queuing posts.`;
    return editMessage ? ctx.editMessageText(text, { parse_mode: 'Markdown' }) : ctx.reply(text, { parse_mode: 'Markdown' });
  }

  let text = `📅 *Queue for channel: ${channel.title}*\n`;
  text += `⏱️ *Queue Interval:* ${formatInterval(channel.queue_interval || 1)}\n\n`;

  const keyboardButtons = [];

  queuedPosts.forEach((post, index) => {
    const runAt = new Date(post.run_at);
    const timeString = runAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const dateString = runAt.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
    
    let contentSnippet = '';
    if (post.text) {
      contentSnippet = post.text.replace(/\n/g, ' ').substring(0, 30);
      if (post.text.length > 30) contentSnippet += '...';
    } else if (post.media_type) {
      contentSnippet = `[${post.media_type.toUpperCase()}]`;
    }


    text += `*#${index + 1}* • ${dateString} at ${timeString}\n`;
    text += `   📝 \`${contentSnippet}\`\n\n`;

    keyboardButtons.push([
      Markup.button.callback(`❌ Delete #${index + 1}`, `del_q_post:${post.id}:${channelId}`)
    ]);
  });

  const keyboard = Markup.inlineKeyboard(keyboardButtons);

  if (editMessage) {
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    return ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

module.exports = {
  setupCustomBot
};
