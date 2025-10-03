import { Bot } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Store session IDs per chat (in-memory for now)
// Key: chat_id, Value: session_id
const chatSessions = new Map<number, string>();

// Command to reset conversation history
bot.command('reset', async (ctx) => {
  const chatId = ctx.chat.id;
  const hadSession = chatSessions.has(chatId);

  chatSessions.delete(chatId);

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
      return; // Don't respond if not mentioned or replied to
    }

    console.log(`[${new Date().toISOString()}] Bot was mentioned/replied to - processing message`);
  }

  try {
    // Get existing session for this chat
    const existingSession = chatSessions.get(chatId);

    if (existingSession) {
      console.log(`[${new Date().toISOString()}] Resuming session: ${existingSession}`);
    } else {
      console.log(`[${new Date().toISOString()}] Starting new session`);
    }

    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Call Claude Agent SDK
    const agentQuery = query({
      prompt: userMessage,
      options: {
        maxTurns: 5,
        permissionMode: 'bypassPermissions', // Allow agent to work freely
        disallowedTools: ['Bash', 'Write', 'Edit'], // Disable file system access for safety
        resume: existingSession, // Resume previous session if exists
        systemPrompt: `You are a helpful AI assistant communicating through Telegram.

IMPORTANT FORMATTING RULES:
- Keep responses concise and well-structured for mobile reading
- Use Telegram markdown formatting (bold with *text*, italic with _text_, code with \`text\`)
- Break long responses into digestible paragraphs
- Use bullet points and numbered lists when appropriate
- Remember this is a chat conversation, so be conversational and friendly
- When using tools or doing research, you can be thorough, but present results clearly

CRITICAL: For better user experience on Telegram, split your response into multiple messages when appropriate.
- Use the separator "---SPLIT---" (on its own line) to indicate where messages should be split
- Split long responses into logical chunks (e.g., intro, main content, conclusion)
- Split after tool use results to show progress
- Each chunk should be self-contained but flow naturally
- Don't split unnecessarily for short responses

Example:
"Here's what I found:
---SPLIT---
The weather in SF is 66°F and cloudy.
---SPLIT---
Would you like more details?"

You have access to tools like WebSearch and file reading capabilities. Use them when needed to provide accurate, up-to-date information.`,
      },
    });

    let responseText = '';
    let toolsUsed: string[] = [];
    let currentSessionId: string | undefined;

    // Stream messages from agent
    for await (const message of agentQuery) {
      console.log(`[${new Date().toISOString()}] Agent message type: ${message.type}`);

      // Capture session ID from init message
      if (message.type === 'system') {
        const systemMsg = message as SDKSystemMessage;
        if (systemMsg.subtype === 'init') {
          currentSessionId = systemMsg.session_id;
          console.log(`[${new Date().toISOString()}] Session ID: ${currentSessionId}`);
        }
      }

      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;

        // Extract text from content blocks
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          } else if (block.type === 'tool_use') {
            const toolName = block.name;
            toolsUsed.push(toolName);
            console.log(`[${new Date().toISOString()}] Agent using tool: ${toolName}`);
          }
        }
      }
    }

    // Store session ID for this chat
    if (currentSessionId) {
      chatSessions.set(chatId, currentSessionId);
      console.log(`[${new Date().toISOString()}] Stored session ${currentSessionId} for chat ${chatId}`);
    }

    console.log(`[${new Date().toISOString()}] Agent query completed`);
    if (toolsUsed.length > 0) {
      console.log(`[${new Date().toISOString()}] Tools used: ${toolsUsed.join(', ')}`);
    }
    console.log(`[${new Date().toISOString()}] Response length: ${responseText.length} characters`);

    // Split response by separator and send as multiple messages
    if (responseText) {
      const messages = responseText
        .split('---SPLIT---')
        .map(msg => msg.trim())
        .filter(msg => msg.length > 0);

      console.log(`[${new Date().toISOString()}] Sending ${messages.length} message(s)`);

      for (const [index, message] of messages.entries()) {
        await ctx.reply(message);
        console.log(`[${new Date().toISOString()}] Sent message ${index + 1}/${messages.length}`);

        // Small delay between messages to avoid rate limiting and improve readability
        if (index < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      console.log(`[${new Date().toISOString()}] All messages sent successfully`);
    } else {
      await ctx.reply('Sorry, I couldn\'t generate a response.');
      console.log(`[${new Date().toISOString()}] No response generated`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing message:`, error);
    await ctx.reply('Sorry, there was an error processing your request.');
  }
});

// Start the bot
bot.start();
console.log('Bot is running...');
