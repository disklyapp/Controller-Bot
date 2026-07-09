const { Markup } = require('telegraf');
const db = require('./db');

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
      [Markup.button.callback('📤 Send', 'send_post'), Markup.button.callback('❌ Cancel', 'cancel_post')]
    ]);

    const description = mediaType === 'photo'
      ? `📸 *Photo Draft saved!*${text ? ` (Caption: ${text.length} chars)` : ''}`
      : `✍️ *Text Draft saved!* (${text.length} chars)`;

    await ctx.reply(
      `${description}\n\n` +
      `Click *Preview* to see how it looks, *Send* to post it to the channel, or *Cancel* to discard it.`,
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
  });
}

module.exports = {
  setupCustomBot
};
