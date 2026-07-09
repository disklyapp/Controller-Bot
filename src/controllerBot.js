const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const botManager = require('./botManager');

function setupControllerBot(bot) {
  // Global error handler for the main controller bot
  bot.catch((err, ctx) => {
    console.error('Error in Main Controller Bot:', err);
    ctx.reply('⚠️ An unexpected error occurred. Please try again later.');
  });

  // /start command
  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    await db.updateUserStep(userId, 'idle', null);

    await ctx.reply(
      `👋 *Welcome to Controller Bot!*\n\n` +
      `I can help you manage your Telegram channels and post rich text posts to them using your own custom bots.\n\n` +
      `🛠️ *Available Commands:*\n` +
      `/addchannel - Connect a new channel (by registering a custom bot)\n` +
      `/mychannels - View and manage your connected channels\n` +
      `/cancel - Cancel any active setup wizard`,
      { parse_mode: 'Markdown' }
    );
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    const userId = ctx.from.id;
    await db.updateUserStep(userId, 'idle', null);
    await ctx.reply('❌ Active setup wizard has been cancelled. Back to home status.');
  });

  // /addchannel command
  bot.command('addchannel', async (ctx) => {
    const userId = ctx.from.id;
    await db.updateUserStep(userId, 'waiting_for_token', null);

    await ctx.reply(
      `🔌 *Step 1: Connecting your custom bot*\n\n` +
      `To post messages, you must use your own custom bot token. Please follow these steps:\n\n` +
      `1. Open @BotFather and create a new bot using the \`/newbot\` command.\n` +
      `2. Customize the name and username as you wish.\n` +
      `3. @BotFather will send you an API Token (e.g., \`123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ\`).\n\n` +
      `👉 *Copy and paste (or forward) that API Token to me now.*`,
      { parse_mode: 'Markdown' }
    );
  });

  // /mychannels command
  bot.command('mychannels', async (ctx) => {
    const userId = ctx.from.id;
    const channels = await db.getChannelsByOwner(userId);

    if (channels.length === 0) {
      return ctx.reply(
        `ℹ️ *No channels connected yet.*\n\nUse /addchannel to connect your first channel!`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.reply(`📋 *Your Connected Channels:*`, { parse_mode: 'Markdown' });

    for (const channel of channels) {
      const botConfig = await db.getBot(channel.bot_token);
      const botUser = botConfig ? `@${botConfig.username}` : 'unknown bot';
      const channelLink = channel.username ? `@${channel.username}` : `ID: \`${channel.channel_id}\``;

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('❌ Remove Channel', `remove_channel:${channel.channel_id}`)
      ]);

      await ctx.reply(
        `📣 *${channel.title}*\n` +
        `• Destination: ${channelLink}\n` +
        `• Posting Bot: ${botUser}`,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    }
  });

  // Handle Remove Channel Callback
  bot.action(/^remove_channel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const channelId = ctx.match[1];
    
    // Fetch details before removing
    const channel = await db.getChannel(channelId);
    if (!channel) {
      return ctx.reply('❌ Channel not found or already removed.');
    }

    // Verify ownership
    if (String(channel.owner_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ You do not own this channel.');
    }

    const botToken = channel.bot_token;
    await db.removeChannel(channelId);

    // If no other channels are using this bot, stop the bot manager instance
    const remainingChannels = await db.getChannelsByBot(botToken);
    if (remainingChannels.length === 0) {
      const botConfig = await db.getBot(botToken);
      if (botConfig) {
        console.log(`No more channels connected to bot @${botConfig.username}. Stopping and deleting bot...`);
        await botManager.stopBot(botToken);
        await db.removeBot(botToken);
      }
    }

    await ctx.editMessageText(`✅ Removed channel *${channel.title}* from your dashboard.`, { parse_mode: 'Markdown' });
  });

  // Normal text/message wizard flows
  bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const user = await db.getUser(userId);

    if (!user) return;

    // STEP 1: Waiting for custom bot token
    if (user.step === 'waiting_for_token') {
      const token = ctx.message.text ? ctx.message.text.trim() : null;

      if (!token) {
        return ctx.reply('⚠️ Please send a valid text API token.');
      }

      // Check basic token format (e.g. 123456789:ABCdefGh...)
      const tokenRegex = /^\d+:[A-Za-z0-9_-]+$/;
      if (!tokenRegex.test(token)) {
        return ctx.reply('❌ Invalid token format. It must look like: `123456789:ABCdef...`\n\nPlease try again or send /cancel.');
      }

      const statusMsg = await ctx.reply('🔍 Verifying bot token, please wait...');

      try {
        // Validate with Telegram
        const tempBot = new Telegraf(token);
        const botInfo = await tempBot.telegram.getMe();

        // Save bot details
        await db.addBot(token, botInfo.username, botInfo.first_name, userId);

        // Dynamically start bot instance in the Manager
        await botManager.startBot(token);

        // Update user wizard status to waiting for channel
        await db.updateUserStep(userId, 'waiting_for_channel', token);

        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        await ctx.reply(
          `🤖 *Bot Verified!* Connected to @${botInfo.username}\n\n` +
          `📢 *Step 2: Connecting your channel*\n\n` +
          `Please do the following now:\n` +
          `1. Add @${botInfo.username} as an *Administrator* in your channel.\n` +
          `2. Grant the bot permission to *Post Messages*.\n` +
          `3. *Forward* any message from your channel to this chat, or type/paste the channel's *Username* (e.g. \`@mychannel\`) or *ID* (e.g. \`-1001234567890\`) below.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Bot token validation error:', err);
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        await ctx.reply(`❌ *Verification failed:* ${err.message}\n\nPlease check the token and send it again, or run /cancel to abort.`);
      }
      return;
    }

    // STEP 2: Waiting for channel username/ID or forwarded message
    if (user.step === 'waiting_for_channel') {
      let targetChatId = null;
      let directText = ctx.message.text ? ctx.message.text.trim() : null;

      // Check if message is forwarded from a channel
      if (ctx.message.forward_from_chat && ctx.message.forward_from_chat.type === 'channel') {
        targetChatId = ctx.message.forward_from_chat.id;
      } else if (directText) {
        // Support both @channel and numeric ID
        targetChatId = directText;
      }

      if (!targetChatId) {
        return ctx.reply('⚠️ Please forward a message from your channel or type its username (starting with @) or ID.');
      }

      const botToken = user.temp_token;
      if (!botToken) {
        await db.updateUserStep(userId, 'idle', null);
        return ctx.reply('❌ Active session lost. Please run /addchannel again.');
      }

      const statusMsg = await ctx.reply('🔍 Connecting to channel, please wait...');

      try {
        const customBot = new Telegraf(botToken);
        
        // Fetch chat information via custom bot
        const chat = await customBot.telegram.getChat(targetChatId);

        if (chat.type !== 'channel') {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          return ctx.reply('❌ That is not a channel. You can only connect channels. Please send a channel username or ID.');
        }

        // Verify if custom bot is administrator in the channel
        const admins = await customBot.telegram.getChatAdministrators(chat.id);
        const botMe = await customBot.telegram.getMe();
        
        const isBotAdmin = admins.some(admin => String(admin.user.id) === String(botMe.id));

        if (!isBotAdmin) {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          return ctx.reply(`❌ The bot @${botMe.username} is not an administrator in that channel. Please add it as an administrator with posting rights first.`);
        }

        // Add channel connection
        await db.addChannel(
          chat.id,
          chat.title || chat.username || 'Untitled Channel',
          chat.username || null,
          botToken,
          userId
        );

        // Reset wizard status
        await db.updateUserStep(userId, 'idle', null);

        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        await ctx.reply(
          `🎉 *Channel successfully connected!*\n\n` +
          `Channel: *${chat.title}*\n` +
          `Username: ${chat.username ? `@${chat.username}` : 'Private'}\n` +
          `Posting Bot: @${botMe.username}\n\n` +
          `👉 Go to @${botMe.username} and run /start to create and post messages!`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Channel connection error:', err);
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        await ctx.reply(
          `❌ *Connection failed:* ${err.message}\n\n` +
          `Make sure:\n` +
          `1. The username or ID is correct.\n` +
          `2. Your custom bot has been added to the channel as an Administrator with *Post Messages* permission.\n\n` +
          `Please check and try again, or send /cancel to abort.`
        );
      }
      return;
    }

    // Default reply
    await ctx.reply('ℹ️ Send /start to see available commands.');
  });
}

module.exports = {
  setupControllerBot
};
