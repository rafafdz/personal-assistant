import { Bot } from 'grammy';
import dotenv from 'dotenv';
import { handleAgentQuery } from './handlers/agent-handler';
import { getSession, saveSession, clearSession } from './handlers/session-manager';
import { transcribeVoiceMessage } from './handlers/voice-handler';

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
  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';

  console.log(`[${new Date().toISOString()}] Received message from ${username} (${userId}) in ${chatType} chat (${chatId})`);
  console.log(`Message: "${userMessage}"`);

  // In groups, only respond when bot is mentioned or replied to
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (isGroup) {
    const botUsername = ctx.me.username;
    const isMentioned = userMessage.includes(`@${botUsername}`);
    const isReply = ctx.message.reply_to_message?.from?.id === ctx.me.id;

    if (!isMentioned && !isReply) {
      console.log(`[${new Date().toISOString()}] Ignoring message - bot not mentioned or replied to`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Bot was mentioned/replied to - processing message`);
  }

  try {
    // Get existing session for this chat
    const existingSession = await getSession(chatId);

    if (existingSession) {
      console.log(`[${new Date().toISOString()}] Resuming session: ${existingSession}`);
    } else {
      console.log(`[${new Date().toISOString()}] Starting new session`);
    }

    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Handle agent query
    const result = await handleAgentQuery({
      ctx,
      chatId,
      userMessage,
      existingSession,
    });

    // Store session ID if returned
    if (result.sessionId) {
      await saveSession(chatId, result.sessionId);
    }

    // If no messages were sent and no error was already handled, send error
    if (result.sentMessages === 0 && !result.hadError) {
      await ctx.reply('Sorry, I couldn\'t generate a response.');
      console.log(`[${new Date().toISOString()}] No response generated`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing message:`, error);
    await ctx.reply('Sorry, there was an error processing your request.');
  }
});

// Handle voice messages
bot.on('message:voice', async (ctx) => {
  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';

  console.log(`[${new Date().toISOString()}] Received voice message from ${username} (${userId}) in ${chatType} chat (${chatId})`);

  // In groups, only respond when bot is mentioned or replied to
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (isGroup) {
    const isReply = ctx.message.reply_to_message?.from?.id === ctx.me.id;

    if (!isReply) {
      console.log(`[${new Date().toISOString()}] Ignoring voice message - bot not replied to in group`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Bot was replied to - processing voice message`);
  }

  try {
    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Transcribe voice message (this also sends transcription to user)
    const transcribedText = await transcribeVoiceMessage(ctx, ctx.message.voice.file_id);

    // Get existing session
    const existingSession = await getSession(chatId);

    if (existingSession) {
      console.log(`[${new Date().toISOString()}] Resuming session: ${existingSession}`);
    } else {
      console.log(`[${new Date().toISOString()}] Starting new session`);
    }

    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Process transcribed text with agent
    const result = await handleAgentQuery({
      ctx,
      chatId,
      userMessage: transcribedText,
      existingSession,
    });

    // Store session ID if returned
    if (result.sessionId) {
      await saveSession(chatId, result.sessionId);
    }

    console.log(`[${new Date().toISOString()}] Voice message processing completed`);
    if (result.toolsUsed.length > 0) {
      console.log(`[${new Date().toISOString()}] Tools used: ${result.toolsUsed.join(', ')}`);
    }

    // If no messages were sent (besides transcription) and no error was already handled, send error
    if (result.sentMessages === 0 && !result.hadError) {
      await ctx.reply('Sorry, I couldn\'t generate a response.');
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing voice message:`, error);
    await ctx.reply('Sorry, there was an error processing your voice message.');
  }
});

// Start the bot
bot.start();
console.log('Bot is running...');
