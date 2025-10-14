import { Bot } from 'grammy';
import dotenv from 'dotenv';
import { clearSession } from './handlers/session-manager';
import { transcribeVoiceMessage } from './handlers/voice-handler';
import { downloadAndSaveImage } from './handlers/image-handler';
import { processMessage } from './handlers/message-processor';
import { shouldRespondInGroup, getUserInfo } from './utils/message-helpers';

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Register bot commands with Telegram
bot.api.setMyCommands([
  { command: 'reset', description: 'Clear conversation history and start fresh' }
]);

// Command to reset conversation history
bot.command('reset', async (ctx) => {
  const chatId = ctx.chat.id;
  const hadSession = clearSession(chatId);

  console.log(`[${new Date().toISOString()}] Session reset for chat ${chatId}`);

  if (hadSession) {
    await ctx.reply('✅ Conversation history cleared. Starting fresh!');
  } else {
    await ctx.reply('ℹ️ No active session to reset.');
  }
});

// Handle all text messages (works in groups and private chats)
bot.on('message:text', async (ctx) => {
  const userMessage = ctx.message.text;
  const { username, userId, chatId, chatType } = getUserInfo(ctx);

  console.log(`[${new Date().toISOString()}] Received message from ${username} (${userId}) in ${chatType} chat (${chatId})`);
  console.log(`Message: "${userMessage}"`);

  // Check if bot should respond in group chats
  if (!shouldRespondInGroup(ctx, userMessage)) {
    console.log(`[${new Date().toISOString()}] Ignoring message - bot not mentioned or replied to`);
    return;
  }

  try {
    await processMessage({ ctx, chatId, userMessage });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing message:`, error);
    await ctx.reply('Sorry, there was an error processing your request.');
  }
});

// Handle photo messages
bot.on('message:photo', async (ctx) => {
  const caption = ctx.message.caption || 'What is in this image?';
  const { username, userId, chatId, chatType } = getUserInfo(ctx);

  console.log(`[${new Date().toISOString()}] Received photo from ${username} (${userId}) in ${chatType} chat (${chatId})`);
  console.log(`Caption: "${caption}"`);

  // Check if bot should respond in group chats
  if (!shouldRespondInGroup(ctx, caption)) {
    console.log(`[${new Date().toISOString()}] Ignoring photo - bot not mentioned or replied to`);
    return;
  }

  try {
    // Get the largest photo (best quality)
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];

    // Download and save the image
    const imagePath = await downloadAndSaveImage(ctx, largestPhoto.file_id);

    await processMessage({
      ctx,
      chatId,
      userMessage: caption,
      imagePaths: [imagePath],
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing photo:`, error);
    await ctx.reply('Sorry, there was an error processing your photo.');
  }
});

// Handle voice messages
bot.on('message:voice', async (ctx) => {
  const { username, userId, chatId, chatType } = getUserInfo(ctx);

  console.log(`[${new Date().toISOString()}] Received voice message from ${username} (${userId}) in ${chatType} chat (${chatId})`);

  // Check if bot should respond in group chats
  if (!shouldRespondInGroup(ctx)) {
    console.log(`[${new Date().toISOString()}] Ignoring voice message - bot not replied to in group`);
    return;
  }

  try {
    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Transcribe voice message (this also sends transcription to user)
    const transcribedText = await transcribeVoiceMessage(ctx, ctx.message.voice.file_id);

    await processMessage({ ctx, chatId, userMessage: transcribedText });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing voice message:`, error);
    await ctx.reply('Sorry, there was an error processing your voice message.');
  }
});

// Start the bot
bot.start();
console.log('Bot is running...');
