const { Markup } = require('telegraf');
const db = require('./db');

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
        `Send me the *text message* or *photo* you want to post. You can include emojis and captions.`,
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
      `Send me the *text message* or *photo* you want to post. You can include emojis and captions.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle Action Buttons (Preview, Send, Cancel)
  bot.action('preview_post', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = await db.getDraft(ctx.from.id);
    if (!draft) {
      return ctx.reply("❌ No active draft found. Send /newpost to start a new post.");
    }

    await ctx.reply("👁️ *Preview of your post:*", { parse_mode: 'Markdown' });
    
    if (draft.media_type === 'photo') {
      await ctx.replyWithPhoto(draft.file_id, { caption: draft.text || undefined });
    } else {
      await ctx.reply(draft.text);
    }
  });

  bot.action('send_post', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = await db.getDraft(ctx.from.id);
    if (!draft) {
      return ctx.reply("❌ No active draft found. Send /newpost to start.");
    }

    try {
      await ctx.reply("📤 Sending post to channel...");
      
      if (draft.media_type === 'photo') {
        await ctx.telegram.sendPhoto(draft.channel_id, draft.file_id, { caption: draft.text || undefined });
      } else {
        await ctx.telegram.sendMessage(draft.channel_id, draft.text);
      }
      
      await ctx.reply("🎉 *Done!* Message successfully sent to the channel.", { parse_mode: 'Markdown' });
      
      // Clean up
      await db.clearDraft(ctx.from.id);
      const sessionKey = `${ctx.from.id}:${ctx.telegram.token}`;
      sessions.delete(sessionKey);
    } catch (err) {
      console.error('Error sending message to channel:', err);
      await ctx.reply(`❌ *Failed to send message:* ${err.message}\n\nMake sure this bot is still an administrator in the channel and has posting rights.`);
    }
  });

  // Handle Delay Selection Menu
  bot.action('choose_delay', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = await db.getDraft(ctx.from.id);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⏱️ 5 Mins', 'schedule:5'),
        Markup.button.callback('⏱️ 15 Mins', 'schedule:15'),
        Markup.button.callback('⏱️ 30 Mins', 'schedule:30')
      ],
      [
        Markup.button.callback('⏱️ 1 Hour', 'schedule:60'),
        Markup.button.callback('⏱️ 2 Hours', 'schedule:120'),
        Markup.button.callback('⏱️ 6 Hours', 'schedule:360')
      ],
      [
        Markup.button.callback('⏱️ 12 Hours', 'schedule:720'),
        Markup.button.callback('⏱️ 24 Hours', 'schedule:1440')
      ],
      [Markup.button.callback('↩️ Back to Draft', 'back_to_draft')]
    ]);

    await ctx.editMessageText(
      "🕒 *Choose a delay interval before sending to channel:*",
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });

  // Handle Go Back to Draft Options
  bot.action('back_to_draft', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = await db.getDraft(ctx.from.id);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👁️ Preview', 'preview_post')],
      [
        Markup.button.callback('📤 Send Now', 'send_post'),
        Markup.button.callback('📥 Add to Queue', 'add_to_queue')
      ],
      [
        Markup.button.callback('🕒 Send with Delay', 'choose_delay'),
        Markup.button.callback('❌ Cancel', 'cancel_post')
      ]
    ]);

    const description = draft.media_type === 'photo'
      ? `📸 *Photo Draft saved!*${draft.text ? ` (Caption: ${draft.text.length} chars)` : ''}`
      : `✍️ *Text Draft saved!* (${draft.text.length} chars)`;

    await ctx.editMessageText(
      `${description}\n\n` +
      `Click *Preview* to see how it looks, *Send Now* to post immediately, *Add to Queue* to queue it, *Send with Delay* to schedule it with a custom delay, or *Cancel* to discard it.`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });

  // Handle Schedule execution
  bot.action(/^schedule:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const minutes = parseInt(ctx.match[1], 10);
    const userId = ctx.from.id;
    const token = ctx.telegram.token;

    const draft = await db.getDraft(userId);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    try {
      const runAt = new Date(Date.now() + minutes * 60 * 1000);

      // Save to scheduled posts table
      await db.schedulePost(
        userId,
        token,
        draft.channel_id,
        draft.text,
        draft.media_type,
        draft.file_id,
        runAt
      );

      // Clear active draft
      await db.clearDraft(userId);

      // Reset user session
      const sessionKey = `${userId}:${token}`;
      sessions.delete(sessionKey);

      const timeString = runAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString([], { month: 'short', day: 'numeric' });

      await ctx.editMessageText(
        `🕒 *Post successfully scheduled!*\n\n` +
        `It will be sent to the channel in *${minutes} minutes* (on ${dateString} at ${timeString}).`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Scheduling error:', err);
      await ctx.reply(`❌ Failed to schedule post: ${err.message}`);
    }
  });

  bot.action('cancel_post', async (ctx) => {
    await ctx.answerCbQuery();
    await db.clearDraft(ctx.from.id);
    
    const sessionKey = `${ctx.from.id}:${ctx.telegram.token}`;
    sessions.delete(sessionKey);

    await ctx.reply("❌ Post creation cancelled. Draft discarded.");
  });

  // Handle incoming message for draft (Accepts text and photos)
  bot.on('message', async (ctx) => {
    const token = ctx.telegram.token;
    const sessionKey = `${ctx.from.id}:${token}`;
    const session = sessions.get(sessionKey);

    if (!session || session.step !== 'waiting_for_text') {
      return ctx.reply("Please use /newpost to start creating a post.");
    }

    let text = null;
    let mediaType = 'text';
    let fileId = null;

    if (ctx.message.photo) {
      const photos = ctx.message.photo;
      // Get highest resolution photo file ID
      fileId = photos[photos.length - 1].file_id;
      text = ctx.message.caption || null;
      mediaType = 'photo';
    } else if (ctx.message.text) {
      text = ctx.message.text;
      mediaType = 'text';
    } else {
      return ctx.reply("⚠️ Sorry, this bot only supports text and photo posts. Please send a text or a photo.");
    }
    
    // Save draft in PostgreSQL database
    await db.saveDraft(ctx.from.id, token, session.channelId, text, mediaType, fileId);

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👁️ Preview', 'preview_post')],
      [
        Markup.button.callback('📤 Send Now', 'send_post'),
        Markup.button.callback('📥 Add to Queue', 'add_to_queue')
      ],
      [
        Markup.button.callback('🕒 Send with Delay', 'choose_delay'),
        Markup.button.callback('❌ Cancel', 'cancel_post')
      ]
    ]);

    const description = mediaType === 'photo'
      ? `📸 *Photo Draft saved!*${text ? ` (Caption: ${text.length} chars)` : ''}`
      : `✍️ *Text Draft saved!* (${text.length} chars)`;

    await ctx.reply(
      `${description}\n\n` +
      `Click *Preview* to see how it looks, *Send Now* to post immediately, *Add to Queue* to queue it, *Send with Delay* to schedule it with a custom delay, or *Cancel* to discard it.`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });

  // Handle Add to Queue execution
  bot.action('add_to_queue', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const token = ctx.telegram.token;

    const draft = await db.getDraft(userId);
    if (!draft) {
      return ctx.reply("❌ No active draft found.");
    }

    try {
      const channel = await db.getChannel(draft.channel_id);
      const intervalMinutes = channel ? (channel.queue_interval || 1) : 1;

      const latestRunAt = await db.getLatestQueuedPostRunAt(draft.channel_id);
      
      let baseTime = Date.now();
      if (latestRunAt) {
        const latestTime = new Date(latestRunAt).getTime();
        if (latestTime > baseTime) {
          baseTime = latestTime;
        }
      }

      const runAt = new Date(baseTime + intervalMinutes * 60 * 1000);

      await db.schedulePost(
        userId,
        token,
        draft.channel_id,
        draft.text,
        draft.media_type,
        draft.file_id,
        runAt,
        true
      );

      await db.clearDraft(userId);

      const sessionKey = `${userId}:${token}`;
      sessions.delete(sessionKey);

      const timeString = runAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateString = runAt.toLocaleDateString([], { month: 'short', day: 'numeric' });

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

  bot.action(/^view_queue_ch:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const channelId = ctx.match[1];
    return showChannelQueue(ctx, channelId, true);
  });

  bot.action(/^del_q_post:(\d+):(.+)$/, async (ctx) => {
    const postId = parseInt(ctx.match[1], 10);
    const channelId = ctx.match[2];

    const deleted = await db.deleteScheduledPost(postId);
    if (deleted) {
      await ctx.answerCbQuery("Post deleted from queue.");
    } else {
      await ctx.answerCbQuery("Post not found or already sent.");
    }

    return showChannelQueue(ctx, channelId, true);
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
    const timeString = runAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateString = runAt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    
    let contentSnippet = '';
    if (post.text) {
      contentSnippet = post.text.replace(/\n/g, ' ').substring(0, 30);
      if (post.text.length > 30) contentSnippet += '...';
    } else if (post.media_type === 'photo') {
      contentSnippet = '[Photo]';
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
