import type { Context } from 'grammy';
import { markdownToTelegramHtml } from './telegram-markdown';

export async function sendTelegramMessage(ctx: Context, text: string): Promise<boolean> {
  try {
    const htmlText = markdownToTelegramHtml(text);
    console.log(`[${new Date().toISOString()}] Converting markdown to HTML. Input length: ${text.length}, Output length: ${htmlText.length}`);
    console.log(`[${new Date().toISOString()}] HTML preview:`, htmlText.substring(0, 300));
    await ctx.reply(htmlText, { parse_mode: 'HTML' });
    console.log(`[${new Date().toISOString()}] Sent message successfully with HTML formatting`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] HTML conversion or send error, sending as plain text:`, error);
    console.error(`[${new Date().toISOString()}] Original text that failed:`, text.substring(0, 500));
    await ctx.reply(text);
    return true;
  }
}

export function startTypingIndicator(ctx: Context): NodeJS.Timeout {
  const interval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction('typing');
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error sending typing indicator:`, error);
    }
  }, 4000); // Send every 4 seconds (Telegram typing lasts 5 seconds)

  return interval;
}

export function stopTypingIndicator(interval: NodeJS.Timeout | null): void {
  if (interval) {
    clearInterval(interval);
  }
}

export function getCurrentSantiagoTime() {
  const now = new Date();
  const timezone = 'America/Santiago';

  const currentDateFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  });

  const currentTimeFormatted = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: timezone
  });

  // Use the Swedish locale format which gives us YYYY-MM-DD HH:mm:ss, then replace space with T
  // This ensures we get the actual local time in Santiago, not a converted UTC time
  const currentDateTime = now.toLocaleString('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(' ', 'T');

  return { currentDateFormatted, currentTimeFormatted, currentDateTime };
}
