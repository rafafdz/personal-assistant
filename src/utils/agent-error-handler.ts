import type { Context } from 'grammy';
import { sendTelegramMessage } from './telegram-helpers';

interface SessionLimitError {
  type: 'result';
  subtype: 'success';
  is_error: true;
  result: string;
}

/**
 * Checks if an agent message indicates a session limit error
 */
export function isSessionLimitError(message: any): message is SessionLimitError {
  return (
    message.type === 'result' &&
    message.subtype === 'success' &&
    message.is_error === true &&
    typeof message.result === 'string' &&
    message.result.toLowerCase().includes('session limit')
  );
}

/**
 * Extracts the session limit message from the error
 */
export function getSessionLimitMessage(message: SessionLimitError): string {
  return message.result;
}

/**
 * Sends a formatted session limit error message via Telegram
 * @param ctx - Grammy context (can be null for scheduler)
 * @param errorMessage - The session limit error message
 * @param chatId - Chat ID (required when ctx is null)
 */
export async function handleSessionLimitError(
  ctx: Context | null,
  errorMessage: string,
  chatId?: string
): Promise<void> {
  const formattedMessage = `⚠️ *Session Limit Reached*\n\n${errorMessage}\n\nPlease try again later.`;

  if (ctx) {
    await sendTelegramMessage(ctx, formattedMessage);
  } else if (chatId) {
    // For scheduler - use direct Telegram API
    await sendDirectTelegramMessage(chatId, formattedMessage);
  } else {
    console.error('[AgentErrorHandler] Cannot send session limit error: no context or chatId provided');
  }
}

/**
 * Sends a message directly via Telegram API (for scheduler)
 */
async function sendDirectTelegramMessage(chatId: string, message: string): Promise<void> {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('[AgentErrorHandler] TELEGRAM_BOT_TOKEN not set');
    return;
  }

  const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

  try {
    const response = await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    const data = await response.json() as { ok: boolean };

    if (!data.ok) {
      console.error(`[AgentErrorHandler] Failed to send error message to chat ${chatId}:`, data);
    } else {
      console.log(`[AgentErrorHandler] Session limit error message sent to chat ${chatId}`);
    }
  } catch (error) {
    console.error(`[AgentErrorHandler] Error sending error message to chat ${chatId}:`, error);
  }
}
