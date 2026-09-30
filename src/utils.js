const db = require('./db');

/**
 * Helper to log and format Telegram API errors clearly for console/Railway logs
 */
function logTelegramError(contextTitle, err, targetId) {
  const code = err?.response?.error_code || err?.code || 'UNKNOWN';
  const description = err?.response?.description || err?.message || String(err);

  console.error(`❌ [${contextTitle}] Telegram API Error (Target: ${targetId}):`);
  console.error(`   • Error Code: ${code}`);
  console.error(`   • Description: ${description}`);

  if (description.includes('bot was kicked') || description.includes('not a member') || description.includes('Forbidden')) {
    console.error(`   💡 Diagnosis: Bot was kicked or is not a member of ${targetId}. Add the bot back as an Administrator with full posting permissions.`);
  } else if (description.includes('chat not found')) {
    console.error(`   💡 Diagnosis: Destination ${targetId} not found. Verify the bot is added to the channel/group.`);
  } else if (description.includes('need administrator rights') || description.includes('not an administrator')) {
    console.error(`   💡 Diagnosis: Admin permissions required in ${targetId}. Grant 'Post Messages' rights to the bot.`);
  } else if (description.includes('caption is too long')) {
    console.error(`   💡 Diagnosis: Media caption exceeds Telegram's 1024-character limit.`);
  }
}

/**
 * Send post to Telegram Channel/Group/Supergroup based on media type, handling chat migration
 */
async function sendPostToChannel(telegram, channelId, mediaType, fileId, text) {
  const options = { caption: text || undefined };

  const dispatch = async (id) => {
    switch (mediaType) {
      case 'photo':
        return await telegram.sendPhoto(id, fileId, options);
      case 'video':
        return await telegram.sendVideo(id, fileId, options);
      case 'document':
        return await telegram.sendDocument(id, fileId, options);
      case 'animation':
        return await telegram.sendAnimation(id, fileId, options);
      case 'audio':
        return await telegram.sendAudio(id, fileId, options);
      case 'voice':
        return await telegram.sendVoice(id, fileId, options);
      default:
        return await telegram.sendMessage(id, text || '');
    }
  };

  try {
    return await dispatch(channelId);
  } catch (err) {
    // Handle supergroup migration error (migrate_to_chat_id)
    const newChatId = err?.response?.parameters?.migrate_to_chat_id;
    if (newChatId) {
      console.log(`🔄 [Telegram Migration] Group ${channelId} was upgraded to Supergroup ${newChatId}. Updating database records...`);
      try {
        await db.pool.query('UPDATE channels SET channel_id = $1 WHERE channel_id = $2', [String(newChatId), String(channelId)]);
        await db.pool.query('UPDATE drafts SET channel_id = $1 WHERE channel_id = $2', [String(newChatId), String(channelId)]);
        await db.pool.query('UPDATE scheduled_posts SET channel_id = $1 WHERE channel_id = $2', [String(newChatId), String(channelId)]);
        console.log(`✅ [Telegram Migration] Database updated successfully to new supergroup ID ${newChatId}. Retrying post send...`);
        return await dispatch(newChatId);
      } catch (dbErr) {
        console.error('❌ Failed to update channel ID on migration:', dbErr);
      }
    }

    logTelegramError('Post Dispatcher', err, channelId);
    throw err;
  }
}

/**
 * Reply with post preview to user based on media type
 */
async function replyWithPreview(ctx, mediaType, fileId, text) {
  const options = { caption: text || undefined };
  switch (mediaType) {
    case 'photo':
      return await ctx.replyWithPhoto(fileId, options);
    case 'video':
      return await ctx.replyWithVideo(fileId, options);
    case 'document':
      return await ctx.replyWithDocument(fileId, options);
    case 'animation':
      return await ctx.replyWithAnimation(fileId, options);
    case 'audio':
      return await ctx.replyWithAudio(fileId, options);
    case 'voice':
      return await ctx.replyWithVoice(fileId, options);
    default:
      return await ctx.reply(text || '');
  }
}

/**
 * Get human-readable description for media type
 */
function getMediaDescription(mediaType, text, isForwarded = false) {
  const prefix = isForwarded ? '↪️ *Forwarded ' : '✍️ *';
  const textLength = text ? text.length : 0;
  const captionText = text ? ` (Caption: ${textLength} chars)` : '';

  switch (mediaType) {
    case 'photo':
      return `📸 *${isForwarded ? 'Forwarded Photo' : 'Photo'} Draft saved!*${captionText}`;
    case 'video':
      return `🎥 *${isForwarded ? 'Forwarded Video' : 'Video'} Draft saved!*${captionText}`;
    case 'document':
      return `📄 *${isForwarded ? 'Forwarded Document' : 'Document'} Draft saved!*${captionText}`;
    case 'animation':
      return `🎞️ *${isForwarded ? 'Forwarded GIF' : 'GIF'} Draft saved!*${captionText}`;
    case 'audio':
      return `🎵 *${isForwarded ? 'Forwarded Audio' : 'Audio'} Draft saved!*${captionText}`;
    case 'voice':
      return `🎙️ *${isForwarded ? 'Forwarded Voice' : 'Voice'} Draft saved!*${captionText}`;
    default:
      return `✍️ *${isForwarded ? 'Forwarded Text' : 'Text'} Draft saved!* (${textLength} chars)`;
  }
}

module.exports = {
  sendPostToChannel,
  replyWithPreview,
  getMediaDescription,
  logTelegramError
};

