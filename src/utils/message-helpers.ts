import type { Context } from 'grammy';

/**
 * Check if bot should respond in a group chat
 * Returns true if bot is mentioned or replied to, false otherwise
 */
export function shouldRespondInGroup(
  ctx: Context,
  messageText?: string
): boolean {
  const chatType = ctx.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    return true; // Always respond in private chats
  }

  const botUsername = ctx.me.username;
  const isReply = ctx.message?.reply_to_message?.from?.id === ctx.me.id;

  // For text/caption, check if bot is mentioned
  if (messageText) {
    const isMentioned = messageText.includes(`@${botUsername}`);
    return isMentioned || isReply;
  }

  // For voice/media without text, only check reply
  return isReply;
}

/**
 * Get user info for logging
 */
export function getUserInfo(ctx: Context) {
  return {
    username: ctx.from?.username || ctx.from?.first_name || 'Unknown',
    userId: ctx.from?.id,
    chatId: ctx.chat!.id,
    chatType: ctx.chat?.type,
  };
}
