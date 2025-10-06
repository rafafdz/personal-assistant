import { Bot } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage, SDKSystemMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { calendarServer } from './tools/calendar.js';
import { mapsServer } from './tools/maps.js';
import { reminderServer } from './tools/reminders.js';
import { transcribeAudio } from './utils/speech-to-text.js';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import https from 'https';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

dotenv.config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Store session IDs per chat (in-memory for now)
// Key: chat_id, Value: session_id
const chatSessions = new Map<number, string>();

// Helper to escape MarkdownV2 special characters
function escapeMarkdownV2(text: string): string {
  // Characters that need escaping in MarkdownV2: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Register bot commands with Telegram
bot.api.setMyCommands([
  { command: 'reset', description: 'Clear conversation history and start fresh' }
]);

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

    // Get current date and time
    const now = new Date();
    const currentDateTime = now.toISOString();
    const currentDateFormatted = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const currentTimeFormatted = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    // Call Claude Agent SDK
    const agentQuery = query({
      prompt: userMessage,
      options: {
        model: 'claude-sonnet-4-5',
        maxTurns: 100,
        permissionMode: 'bypassPermissions', // Allow agent to work freely
        resume: existingSession, // Resume previous session if exists
        includePartialMessages: true, // Enable streaming events
        mcpServers: {
          'google-calendar-tools': calendarServer,
          'google-maps-tools': mapsServer,
          'reminder-tools': reminderServer,
        },
        systemPrompt: `You are a helpful AI assistant communicating through Telegram.

CURRENT CONVERSATION:
- Conversation ID: ${chatId}

IMPORTANT: When using calendar tools, you MUST pass conversationId: "${chatId}" as a parameter.

CURRENT DATE AND TIME:
- Current date: ${currentDateFormatted}
- Current time: ${currentTimeFormatted}
- ISO format: ${currentDateTime}

Use this information when the user asks about "today", "tomorrow", "this week", etc.

REMINDERS:
You can create reminders for users! Users can ask you to remind them about something at a specific time.

Key reminder tools:
1. create_reminder - Create a one-time or recurring reminder
2. list_reminders - View all reminders for this conversation
3. cancel_reminder - Cancel a pending reminder
4. edit_reminder - Update reminder message or time

When creating reminders:
- Parse natural language like "tomorrow at 1pm", "next Monday at 9am", "every day at 8am"
- Convert to ISO format (YYYY-MM-DDTHH:mm:ss) in Santiago timezone
- For recurring reminders, use the recurrence parameter with type (daily/weekly/monthly/yearly)
- Reminders will be automatically sent by the system when the time comes

SMART REMINDERS (processWithAgent):
You can create reminders that process dynamic content through the AI agent before sending!

Use processWithAgent: true when the user wants:
- Daily calendar summaries: "Every day at 8am, tell me my events for today"
- Weekly updates: "Every Monday, summarize my week's meetings"
- Dynamic queries: "Every evening, check if I have events tomorrow"

The reminder message becomes a PROMPT that will be sent to the agent for processing.
Example: message: "What are my events today?" + processWithAgent: true
→ At trigger time, agent will fetch actual events and send that response

GOOGLE CALENDAR - MULTI-ACCOUNT SUPPORT:
This conversation can connect multiple Google accounts! Each user can authenticate multiple Google Calendar accounts (e.g., personal and work).

Key tools:
1. list_accounts - See all connected Google accounts
2. get_calendar_auth_url - Get authentication link to connect a new account
3. set_calendar_auth_token - Complete authentication after user provides code
4. set_default_account - Set which account is used by default
5. remove_account - Disconnect an account
6. get_calendar_events - Get events (optionally specify accountId, otherwise uses default)
7. create_calendar_event, edit_calendar_event, delete_calendar_event - Manage events
8. list_calendars - See available calendars from Google account

Authentication flow:
1. Use get_calendar_auth_url to get the authentication URL
2. Send the URL to the user and explain they need to:
   - Click the link
   - Authorize access to their Google account
   - Copy the authorization code they receive
   - Send it back to you
3. When the user sends the code, use set_calendar_auth_token to complete authentication
4. The first account connected is automatically set as default
5. Use list_accounts to see all connected accounts

When using calendar tools:
- Most tools accept an optional accountId parameter
- If accountId is not provided, the default account is used
- Users can switch the default account using set_default_account

IMPORTANT FORMATTING RULES:
- Keep responses concise and well-structured for mobile reading
- You MUST use Telegram MarkdownV2 syntax with proper escaping
- In MarkdownV2, these characters MUST be escaped with \\ when they appear as literal text: _ * [ ] ( ) ~ \` > # + - = | { } . !
- Formatting syntax:
  * Bold: *text* (asterisk, escape literal asterisks as \\*)
  * Italic: _text_ (underscore, escape literal underscores as \\_)
  * Code: \`text\` (backtick, escape literal backticks as \\\`)
- Example: "Hello! How are you?" should be "Hello\\! How are you\\?"
- Example: "Check out *this bold text*!" should be "Check out *this bold text*\\!"
- Break long responses into digestible paragraphs
- Use bullet points and numbered lists when appropriate
- Remember this is a chat conversation, so be conversational and friendly

CRITICAL: For better user experience on Telegram, split your response into multiple messages when appropriate.
- Use the separator "---SPLIT---" (on its own line) to indicate where messages should be split
- Split long responses into logical chunks (e.g., intro, main content, conclusion)
- Each chunk should be self-contained but flow naturally
- Don't split unnecessarily for short responses
- NEVER split in the middle of a code block, bold text, or other formatting - always complete formatting before ---SPLIT---
- Example of WRONG split: "text \`code---SPLIT---more code\`" (breaks code block)
- Example of CORRECT split: "text \`code here\`---SPLIT---More text" (complete formatting)

TOOL USAGE PROTOCOL:
When you need to use a tool (like WebSearch, Read, Grep):
1. ALWAYS send a separate message BEFORE using the tool to explain what you're about to do
2. Be verbose and descriptive about your intention
3. Use ---SPLIT--- BEFORE and AFTER your explanation so it sends as a separate message
4. After getting the tool results, send another separate message with your findings

Example of proper tool usage:
"Let me search for that information for you.
---SPLIT---
[At this point you use WebSearch tool]
---SPLIT---
I found that the weather in SF is 66°F and cloudy. The forecast shows..."

WRONG approach:
"The weather is 66°F" [Don't just silently use tools and provide results]

You have access to tools like WebSearch and file reading capabilities. Use them when needed to provide accurate, up-to-date information.`,
      },
    });

    let accumulatedText = '';
    let toolsUsed: string[] = [];
    let currentSessionId: string | undefined;
    let sentMessages = 0;
    let isStreaming = false;
    let typingInterval: NodeJS.Timeout | null = null;

    // Helper to send message
    const sendMessage = async (text: string) => {
      console.log(`[${new Date().toISOString()}] sendMessage called with text:`, text.substring(0, 200));

      try {
        await ctx.reply(text, { parse_mode: 'MarkdownV2' });
        sentMessages++;
        console.log(`[${new Date().toISOString()}] Sent message successfully`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] MarkdownV2 parse error, sending as plain text:`, error);
        await ctx.reply(text);
        sentMessages++;
      }
    };

    // Helper to start typing indicator loop
    const startTypingIndicator = () => {
      if (typingInterval) return; // Already running

      typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing');
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error sending typing indicator:`, error);
        }
      }, 4000); // Send every 4 seconds (Telegram typing lasts 5 seconds)
    };

    // Helper to stop typing indicator loop
    const stopTypingIndicator = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
    };

    // Stream messages from agent and send chunks as they arrive
    for await (const message of agentQuery) {
      // Don't log stream_event messages to reduce noise
      if (message.type !== 'stream_event') {
        console.log(`[${new Date().toISOString()}] Agent message type: ${message.type}`);
        console.log(`[${new Date().toISOString()}] Full message:`, JSON.stringify(message, null, 2));
      }

      // Capture session ID from init message
      if (message.type === 'system') {
        const systemMsg = message as SDKSystemMessage;
        if (systemMsg.subtype === 'init') {
          currentSessionId = systemMsg.session_id;
          console.log(`[${new Date().toISOString()}] Session ID: ${currentSessionId}`);
        }
      }

      // Handle streaming events (character-by-character)
      if (message.type === 'stream_event') {
        isStreaming = true; // Mark that we're in streaming mode
        const streamMsg = message as SDKPartialAssistantMessage;
        const event = streamMsg.event;

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const textChunk = event.delta.text;
            accumulatedText += textChunk;

            // Check if we have a complete chunk to send (contains ---SPLIT---)
            const splitIndex = accumulatedText.indexOf('---SPLIT---');
            if (splitIndex !== -1) {
              // Extract the chunk before the split marker
              const chunkToSend = accumulatedText.substring(0, splitIndex).trim();

              if (chunkToSend.length > 0) {
                await sendMessage(chunkToSend);
                console.log(`[${new Date().toISOString()}] Sent streaming chunk #${sentMessages}`);
              }

              // Keep the remainder after the split marker
              accumulatedText = accumulatedText.substring(splitIndex + '---SPLIT---'.length).trim();
            }
          }
        }
      }

      // Handle complete assistant messages (only if NOT streaming, and only for tool tracking)
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;

        // Track tool uses and show typing indicator
        for (const block of assistantMsg.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name;
            toolsUsed.push(toolName);
            console.log(`[${new Date().toISOString()}] Agent using tool: ${toolName}`);
            console.log(`[${new Date().toISOString()}] Tool input:`, JSON.stringify(block.input, null, 2));

            // Start continuous typing indicator during tool execution
            startTypingIndicator();
          }
        }

        // If we're NOT in streaming mode, process text here
        if (!isStreaming) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              const text = block.text;
              console.log(`[${new Date().toISOString()}] Received text block (non-streaming): ${text.substring(0, 100)}...`);
              accumulatedText += text;

              // Check if we have a complete chunk to send (contains ---SPLIT---)
              const splitIndex = accumulatedText.indexOf('---SPLIT---');
              if (splitIndex !== -1) {
                // Extract the chunk before the split marker
                const chunkToSend = accumulatedText.substring(0, splitIndex).trim();

                if (chunkToSend.length > 0) {
                  await sendMessage(chunkToSend);
                  console.log(`[${new Date().toISOString()}] Sent chunk #${sentMessages}`);
                }

                // Keep the remainder after the split marker
                accumulatedText = accumulatedText.substring(splitIndex + '---SPLIT---'.length).trim();
              }
            }
          }
        }
      }

      // Stop typing when we get a result (tool execution complete)
      if (message.type === 'result') {
        console.log(`[${new Date().toISOString()}] Tool result received, stopping typing indicator`);
        console.log(`[${new Date().toISOString()}] Tool result:`, JSON.stringify(message, null, 2));
        stopTypingIndicator();
      }

      // When streaming text, also stop typing (agent is responding)
      if (message.type === 'stream_event') {
        const streamMsg = message as SDKPartialAssistantMessage;
        const event = streamMsg.event;

        if (event.type === 'content_block_start') {
          // Agent started generating response, stop typing indicator
          stopTypingIndicator();
        }
      }
    }

    // Clean up typing indicator
    stopTypingIndicator();

    // Send any remaining accumulated text
    if (accumulatedText.trim().length > 0) {
      await sendMessage(accumulatedText.trim());
      console.log(`[${new Date().toISOString()}] Sent final chunk #${sentMessages}`);
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
    console.log(`[${new Date().toISOString()}] Sent ${sentMessages} total message(s)`);

    // If no messages were sent, send error
    if (sentMessages === 0) {
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

    // Get the voice file
    const voice = ctx.message.voice;
    const fileId = voice.file_id;

    console.log(`[${new Date().toISOString()}] Downloading voice file: ${fileId}`);

    // Get file info from Telegram
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      throw new Error('Could not get file path from Telegram');
    }

    // Download the file
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const tempDir = '/tmp';
    const localFilePath = path.join(tempDir, `voice_${Date.now()}.ogg`);

    // Download file using https
    await new Promise<void>((resolve, reject) => {
      const fileStream = fs.createWriteStream(localFilePath);
      https.get(fileUrl, (response) => {
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(localFilePath, () => {});
        reject(err);
      });
    });

    console.log(`[${new Date().toISOString()}] Voice file downloaded to: ${localFilePath}`);

    // Transcribe the audio
    console.log(`[${new Date().toISOString()}] Transcribing audio...`);
    const transcribedText = await transcribeAudio(localFilePath);

    // Clean up the temp file
    await unlink(localFilePath);

    console.log(`[${new Date().toISOString()}] Transcription: "${transcribedText}"`);

    // Send the transcription to the user
    await ctx.reply(`🎤 *Transcription:*\n\n_${escapeMarkdownV2(transcribedText)}_`, { parse_mode: 'MarkdownV2' }).catch(() =>
      ctx.reply(`🎤 Transcription:\n\n${transcribedText}`)
    );

    // Now process the transcribed text as a regular message
    // Get existing session for this chat
    const existingSession = chatSessions.get(chatId);

    if (existingSession) {
      console.log(`[${new Date().toISOString()}] Resuming session: ${existingSession}`);
    } else {
      console.log(`[${new Date().toISOString()}] Starting new session`);
    }

    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    // Get current date and time
    const now = new Date();
    const currentDateTime = now.toISOString();
    const currentDateFormatted = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const currentTimeFormatted = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    // Call Claude Agent SDK with the transcribed text
    const agentQuery = query({
      prompt: transcribedText,
      options: {
        model: 'claude-sonnet-4-5',
        maxTurns: 100,
        permissionMode: 'bypassPermissions',
        resume: existingSession,
        includePartialMessages: true,
        mcpServers: {
          'google-calendar-tools': calendarServer,
          'google-maps-tools': mapsServer,
          'reminder-tools': reminderServer,
        },
        systemPrompt: `You are a helpful AI assistant communicating through Telegram.

CURRENT CONVERSATION:
- Conversation ID: ${chatId}

IMPORTANT: When using calendar tools, you MUST pass conversationId: "${chatId}" as a parameter.

CURRENT DATE AND TIME:
- Current date: ${currentDateFormatted}
- Current time: ${currentTimeFormatted}
- ISO format: ${currentDateTime}

Use this information when the user asks about "today", "tomorrow", "this week", etc.

REMINDERS:
You can create reminders for users! Users can ask you to remind them about something at a specific time.

Key reminder tools:
1. create_reminder - Create a one-time or recurring reminder
2. list_reminders - View all reminders for this conversation
3. cancel_reminder - Cancel a pending reminder
4. edit_reminder - Update reminder message or time

When creating reminders:
- Parse natural language like "tomorrow at 1pm", "next Monday at 9am", "every day at 8am"
- Convert to ISO format (YYYY-MM-DDTHH:mm:ss) in Santiago timezone
- For recurring reminders, use the recurrence parameter with type (daily/weekly/monthly/yearly)
- Reminders will be automatically sent by the system when the time comes

SMART REMINDERS (processWithAgent):
You can create reminders that process dynamic content through the AI agent before sending!

Use processWithAgent: true when the user wants:
- Daily calendar summaries: "Every day at 8am, tell me my events for today"
- Weekly updates: "Every Monday, summarize my week's meetings"
- Dynamic queries: "Every evening, check if I have events tomorrow"

The reminder message becomes a PROMPT that will be sent to the agent for processing.
Example: message: "What are my events today?" + processWithAgent: true
→ At trigger time, agent will fetch actual events and send that response

GOOGLE CALENDAR - MULTI-ACCOUNT SUPPORT:
This conversation can connect multiple Google accounts! Each user can authenticate multiple Google Calendar accounts (e.g., personal and work).

Key tools:
1. list_accounts - See all connected Google accounts
2. get_calendar_auth_url - Get authentication link to connect a new account
3. set_calendar_auth_token - Complete authentication after user provides code
4. set_default_account - Set which account is used by default
5. remove_account - Disconnect an account
6. get_calendar_events - Get events (optionally specify accountId, otherwise uses default)
7. create_calendar_event, edit_calendar_event, delete_calendar_event - Manage events
8. list_calendars - See available calendars from Google account

Authentication flow:
1. Use get_calendar_auth_url to get the authentication URL
2. Send the URL to the user and explain they need to:
   - Click the link
   - Authorize access to their Google account
   - Copy the authorization code they receive
   - Send it back to you
3. When the user sends the code, use set_calendar_auth_token to complete authentication
4. The first account connected is automatically set as default
5. Use list_accounts to see all connected accounts

When using calendar tools:
- Most tools accept an optional accountId parameter
- If accountId is not provided, the default account is used
- Users can switch the default account using set_default_account

IMPORTANT FORMATTING RULES:
- Keep responses concise and well-structured for mobile reading
- You MUST use Telegram MarkdownV2 syntax with proper escaping
- In MarkdownV2, these characters MUST be escaped with \\ when they appear as literal text: _ * [ ] ( ) ~ \` > # + - = | { } . !
- Formatting syntax:
  * Bold: *text* (asterisk, escape literal asterisks as \\*)
  * Italic: _text_ (underscore, escape literal underscores as \\_)
  * Code: \`text\` (backtick, escape literal backticks as \\\`)
- Example: "Hello! How are you?" should be "Hello\\! How are you\\?"
- Example: "Check out *this bold text*!" should be "Check out *this bold text*\\!"
- Break long responses into digestible paragraphs
- Use bullet points and numbered lists when appropriate
- Remember this is a chat conversation, so be conversational and friendly

CRITICAL: For better user experience on Telegram, split your response into multiple messages when appropriate.
- Use the separator "---SPLIT---" (on its own line) to indicate where messages should be split
- Split long responses into logical chunks (e.g., intro, main content, conclusion)
- Each chunk should be self-contained but flow naturally
- Don't split unnecessarily for short responses
- NEVER split in the middle of a code block, bold text, or other formatting - always complete formatting before ---SPLIT---
- Example of WRONG split: "text \`code---SPLIT---more code\`" (breaks code block)
- Example of CORRECT split: "text \`code here\`---SPLIT---More text" (complete formatting)

TOOL USAGE PROTOCOL:
When you need to use a tool (like WebSearch, Read, Grep):
1. ALWAYS send a separate message BEFORE using the tool to explain what you're about to do
2. Be verbose and descriptive about your intention
3. Use ---SPLIT--- BEFORE and AFTER your explanation so it sends as a separate message
4. After getting the tool results, send another separate message with your findings

Example of proper tool usage:
"Let me search for that information for you.
---SPLIT---
[At this point you use WebSearch tool]
---SPLIT---
I found that the weather in SF is 66°F and cloudy. The forecast shows..."

WRONG approach:
"The weather is 66°F" [Don't just silently use tools and provide results]

You have access to tools like WebSearch and file reading capabilities. Use them when needed to provide accurate, up-to-date information.`,
      },
    });

    let accumulatedText = '';
    let toolsUsed: string[] = [];
    let currentSessionId: string | undefined;
    let sentMessages = 0;
    let isStreaming = false;
    let typingInterval: NodeJS.Timeout | null = null;

    // Helper to send message
    const sendMessage = async (text: string) => {
      console.log(`[${new Date().toISOString()}] sendMessage called with text:`, text.substring(0, 200));

      try {
        await ctx.reply(text, { parse_mode: 'MarkdownV2' });
        sentMessages++;
        console.log(`[${new Date().toISOString()}] Sent message successfully`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] MarkdownV2 parse error, sending as plain text:`, error);
        await ctx.reply(text);
        sentMessages++;
      }
    };

    // Helper to start typing indicator loop
    const startTypingIndicator = () => {
      if (typingInterval) return; // Already running

      typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing');
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error sending typing indicator:`, error);
        }
      }, 4000); // Send every 4 seconds (Telegram typing lasts 5 seconds)
    };

    // Helper to stop typing indicator loop
    const stopTypingIndicator = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
    };

    // Stream messages from agent and send chunks as they arrive
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

      // Handle streaming events (character-by-character)
      if (message.type === 'stream_event') {
        isStreaming = true;
        const streamMsg = message as SDKPartialAssistantMessage;
        const event = streamMsg.event;

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const textChunk = event.delta.text;
            accumulatedText += textChunk;

            // Check if we have a complete chunk to send (contains ---SPLIT---)
            const splitIndex = accumulatedText.indexOf('---SPLIT---');
            if (splitIndex !== -1) {
              const chunkToSend = accumulatedText.substring(0, splitIndex).trim();

              if (chunkToSend.length > 0) {
                await sendMessage(chunkToSend);
              }

              accumulatedText = accumulatedText.substring(splitIndex + '---SPLIT---'.length).trim();
            }
          }
        }
      }

      // Handle complete assistant messages
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;

        // Track tool uses and show typing indicator
        for (const block of assistantMsg.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name;
            toolsUsed.push(toolName);
            console.log(`[${new Date().toISOString()}] Agent using tool: ${toolName}`);

            startTypingIndicator();
          }
        }

        // If we're NOT in streaming mode, process text here
        if (!isStreaming) {
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              const text = block.text;
              accumulatedText += text;

              const splitIndex = accumulatedText.indexOf('---SPLIT---');
              if (splitIndex !== -1) {
                const chunkToSend = accumulatedText.substring(0, splitIndex).trim();

                if (chunkToSend.length > 0) {
                  await sendMessage(chunkToSend);
                }

                accumulatedText = accumulatedText.substring(splitIndex + '---SPLIT---'.length).trim();
              }
            }
          }
        }
      }

      // Stop typing when we get a result
      if (message.type === 'result') {
        stopTypingIndicator();
      }

      // When streaming text, also stop typing
      if (message.type === 'stream_event') {
        const streamMsg = message as SDKPartialAssistantMessage;
        const event = streamMsg.event;

        if (event.type === 'content_block_start') {
          stopTypingIndicator();
        }
      }
    }

    // Clean up typing indicator
    stopTypingIndicator();

    // Send any remaining accumulated text
    if (accumulatedText.trim().length > 0) {
      await sendMessage(accumulatedText.trim());
    }

    // Store session ID for this chat
    if (currentSessionId) {
      chatSessions.set(chatId, currentSessionId);
      console.log(`[${new Date().toISOString()}] Stored session ${currentSessionId} for chat ${chatId}`);
    }

    console.log(`[${new Date().toISOString()}] Voice message processing completed`);
    if (toolsUsed.length > 0) {
      console.log(`[${new Date().toISOString()}] Tools used: ${toolsUsed.join(', ')}`);
    }

    // If no messages were sent (besides transcription), send error
    if (sentMessages === 0) {
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
