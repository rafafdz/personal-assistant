import type { Context } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage, SDKSystemMessage, SDKPartialAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { calendarServer } from '../tools/calendar';
import { mapsServer } from '../tools/maps';
import { reminderServer } from '../tools/reminders';
import { getSystemPrompt } from '../prompts/system-prompt';
import { sendTelegramMessage, startTypingIndicator, stopTypingIndicator } from '../utils/telegram-helpers';
import { isSessionLimitError, getSessionLimitMessage, handleSessionLimitError } from '../utils/agent-error-handler';

interface AgentHandlerOptions {
  ctx: Context;
  chatId: number;
  userMessage: string;
  existingSession?: string;
  imagePaths?: string[];
}

interface AgentHandlerResult {
  sessionId?: string;
  sentMessages: number;
  toolsUsed: string[];
  hadError?: boolean;
}

export async function handleAgentQuery(options: AgentHandlerOptions): Promise<AgentHandlerResult> {
  const { ctx, chatId, userMessage, existingSession, imagePaths } = options;

  // Build prompt - either simple string or async generator for multimodal
  let prompt: string | AsyncIterable<SDKUserMessage>;

  if (imagePaths && imagePaths.length > 0) {
    // Create an async generator that yields a single user message with images
    async function* imageMessageGenerator(): AsyncGenerator<SDKUserMessage> {
      const content: Array<any> = [];

      // Add images first
      for (const imagePath of imagePaths!) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: fs.readFileSync(imagePath).toString('base64'),
          },
        });
      }

      // Add text message
      content.push({
        type: 'text',
        text: userMessage,
      });

      yield {
        type: 'user' as const,
        session_id: existingSession || '',
        message: {
          role: 'user' as const,
          content,
        },
        parent_tool_use_id: null,
      };
    }

    prompt = imageMessageGenerator();
  } else {
    prompt = userMessage;
  }

  // Call Claude Agent SDK
  const agentQuery = query({
    prompt,
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
      systemPrompt: getSystemPrompt(),
    },
  });

  let accumulatedText = '';
  let toolsUsed: string[] = [];
  let currentSessionId: string | undefined;
  let sentMessages = 0;
  let isStreaming = false;
  let typingInterval: NodeJS.Timeout | null = null;
  let hadError = false;

  // Helper to send message
  const sendMessage = async (text: string) => {
    console.log(`[${new Date().toISOString()}] sendMessage called with text:`, text.substring(0, 200));
    await sendTelegramMessage(ctx, text);
    sentMessages++;
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
              console.log(`[${new Date().toISOString()}] Sent streaming chunk #${sentMessages}`);
            }

            accumulatedText = accumulatedText.substring(splitIndex + '---SPLIT---'.length).trim();
          }
        }
      }

      // When streaming starts, stop typing indicator
      if (event.type === 'content_block_start') {
        stopTypingIndicator(typingInterval);
        typingInterval = null;
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
          console.log(`[${new Date().toISOString()}] Tool input:`, JSON.stringify(block.input, null, 2));

          // Start continuous typing indicator during tool execution
          if (!typingInterval) {
            typingInterval = startTypingIndicator(ctx);
          }
        }
      }

      // If we're NOT in streaming mode, process text here
      if (!isStreaming) {
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            const text = block.text;
            console.log(`[${new Date().toISOString()}] Received text block (non-streaming): ${text.substring(0, 100)}...`);
            accumulatedText += text;

            const splitIndex = accumulatedText.indexOf('---SPLIT---');
            if (splitIndex !== -1) {
              const chunkToSend = accumulatedText.substring(0, splitIndex).trim();

              if (chunkToSend.length > 0) {
                await sendMessage(chunkToSend);
                console.log(`[${new Date().toISOString()}] Sent chunk #${sentMessages}`);
              }

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
      stopTypingIndicator(typingInterval);
      typingInterval = null;

      // Check for session limit error
      if (isSessionLimitError(message)) {
        const errorMessage = getSessionLimitMessage(message);
        console.log(`[${new Date().toISOString()}] Session limit error detected: ${errorMessage}`);
        // Clear accumulated text to prevent sending error message twice
        accumulatedText = '';
        hadError = true;
        await handleSessionLimitError(ctx, errorMessage);
        // Break out of the loop since we can't continue
        break;
      }
    }
  }

  // Clean up typing indicator
  stopTypingIndicator(typingInterval);

  // Send any remaining accumulated text
  if (accumulatedText.trim().length > 0) {
    await sendMessage(accumulatedText.trim());
    console.log(`[${new Date().toISOString()}] Sent final chunk #${sentMessages}`);
  }

  console.log(`[${new Date().toISOString()}] Agent query completed`);
  if (toolsUsed.length > 0) {
    console.log(`[${new Date().toISOString()}] Tools used: ${toolsUsed.join(', ')}`);
  }
  console.log(`[${new Date().toISOString()}] Sent ${sentMessages} total message(s)`);

  return {
    sessionId: currentSessionId,
    sentMessages,
    toolsUsed,
    hadError,
  };
}
