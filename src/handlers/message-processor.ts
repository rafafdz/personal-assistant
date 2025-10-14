import type { Context } from 'grammy';
import { handleAgentQuery } from './agent-handler';
import { getSession, saveSession } from './session-manager';

interface ProcessMessageOptions {
  ctx: Context;
  chatId: number;
  userMessage: string;
  imagePaths?: string[];
}

/**
 * Process a message with the agent and handle session management
 */
export async function processMessage(options: ProcessMessageOptions): Promise<void> {
  const { ctx, chatId, userMessage, imagePaths } = options;

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
    imagePaths,
  });

  // Store session ID if returned
  if (result.sessionId) {
    await saveSession(chatId, result.sessionId);
  }

  // Log completion
  console.log(`[${new Date().toISOString()}] Message processing completed`);
  if (result.toolsUsed.length > 0) {
    console.log(`[${new Date().toISOString()}] Tools used: ${result.toolsUsed.join(', ')}`);
  }

  // If no messages were sent and no error was already handled, send error
  if (result.sentMessages === 0 && !result.hadError) {
    await ctx.reply('Sorry, I couldn\'t generate a response.');
    console.log(`[${new Date().toISOString()}] No response generated`);
  }
}
