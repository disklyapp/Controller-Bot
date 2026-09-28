/**
 * Send post to Telegram Channel based on media type
 */
async function sendPostToChannel(telegram, channelId, mediaType, fileId, text) {
  const options = { caption: text || undefined };
  switch (mediaType) {
    case 'photo':
      return await telegram.sendPhoto(channelId, fileId, options);
    case 'video':
      return await telegram.sendVideo(channelId, fileId, options);
    case 'document':
      return await telegram.sendDocument(channelId, fileId, options);
    case 'animation':
      return await telegram.sendAnimation(channelId, fileId, options);
    case 'audio':
      return await telegram.sendAudio(channelId, fileId, options);
    case 'voice':
      return await telegram.sendVoice(channelId, fileId, options);
    default:
      return await telegram.sendMessage(channelId, text || '');
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
  getMediaDescription
};
