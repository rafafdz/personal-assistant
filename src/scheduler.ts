import cron from 'node-cron';
import dotenv from 'dotenv';
import { db } from './db/client';
import { reminders } from './db/schema';
import { eq, and, lte } from 'drizzle-orm';
import { add, parseISO } from 'date-fns';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { calendarServer } from './tools/calendar';
import { mapsServer } from './tools/maps';
import { reminderServer } from './tools/reminders';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Validate required environment variables
if (!BOT_TOKEN) {
  console.error('[Scheduler] TELEGRAM_BOT_TOKEN not set in environment');
  process.exit(1);
}

console.log('[Scheduler] Environment variables validated');
console.log('[Scheduler] Agent SDK will use Claude Code system credentials');

// Send message to Telegram chat
async function sendTelegramMessage(chatId: string, message: string) {
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
      console.error(`[Scheduler] Failed to send message to chat ${chatId}:`, data);
      return false;
    }

    console.log(`[Scheduler] Message sent successfully to chat ${chatId}`);
    return true;
  } catch (error) {
    console.error(`[Scheduler] Error sending message to chat ${chatId}:`, error);
    return false;
  }
}

// Process message with AI agent
async function processMessageWithAgent(conversationId: string, prompt: string): Promise<string | null> {
  console.log(`[Scheduler] Processing message with agent for conversation ${conversationId}`);
  console.log(`[Scheduler] Prompt: "${prompt}"`);

  try {
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

    const agentQuery = query({
      prompt: prompt,
      options: {
        model: 'claude-sonnet-4-5',
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        mcpServers: {
          'google-calendar-tools': calendarServer,
          'google-maps-tools': mapsServer,
          'reminder-tools': reminderServer,
        },
        systemPrompt: `You are a helpful AI assistant processing a scheduled reminder request.

CURRENT CONVERSATION:
- Conversation ID: ${conversationId}

IMPORTANT: When using calendar tools, you MUST pass conversationId: "${conversationId}" as a parameter.

CURRENT DATE AND TIME:
- Current date: ${currentDateFormatted}
- Current time: ${currentTimeFormatted}
- ISO format: ${currentDateTime}

CONTEXT: This is an automated reminder that was scheduled by the user. Process the request and provide a clear, concise response.

IMPORTANT: Keep responses concise and focused. This is a scheduled reminder, so get straight to the point.`,
      },
    });

    let responseText = '';

    // Collect text from complete assistant messages only (no streaming)
    for await (const message of agentQuery) {
      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      }
    }

    const trimmedResponse = responseText.trim();

    if (!trimmedResponse) {
      console.warn(`[Scheduler] Agent returned empty response for conversation ${conversationId}`);
      return null;
    }

    console.log(`[Scheduler] Agent response length: ${trimmedResponse.length} characters`);
    console.log(`[Scheduler] Agent response preview: "${trimmedResponse.substring(0, 200)}..."`);

    return trimmedResponse;
  } catch (error: any) {
    console.error(`[Scheduler] Error processing message with agent for conversation ${conversationId}`);
    console.error(`[Scheduler] Error details:`, {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });

    return null;
  }
}

// Calculate next occurrence for recurring reminders
function calculateNextOccurrence(reminder: any): Date | null {
  const recurrence = reminder.recurrence;

  if (!recurrence || recurrence.type === 'none') {
    return null;
  }

  const currentScheduled = reminder.scheduledFor;
  const interval = recurrence.interval || 1;
  let nextDate: Date;

  switch (recurrence.type) {
    case 'daily':
      nextDate = add(currentScheduled, { days: interval });
      break;

    case 'weekly':
      nextDate = add(currentScheduled, { weeks: interval });
      break;

    case 'monthly':
      nextDate = add(currentScheduled, { months: interval });
      break;

    case 'yearly':
      nextDate = add(currentScheduled, { years: interval });
      break;

    default:
      return null;
  }

  // Check if we've passed the end date
  if (recurrence.endDate) {
    const endDate = parseISO(recurrence.endDate);
    if (nextDate > endDate) {
      return null; // Recurrence has ended
    }
  }

  return nextDate;
}

// Process due reminders
async function processDueReminders() {
  const now = new Date();
  console.log(`[Scheduler] Checking for due reminders at ${now.toISOString()}`);

  try {
    // Find all pending reminders that are due
    const dueReminders = await db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.status, 'pending'),
          lte(reminders.scheduledFor, now)
        )
      );

    console.log(`[Scheduler] Found ${dueReminders.length} due reminder(s)`);

    for (const reminder of dueReminders) {
      console.log(`[Scheduler] Processing reminder ${reminder.id}: "${reminder.message}"`);
      console.log(`[Scheduler] Process with agent: ${reminder.processWithAgent}`);

      let messageText: string;

      if (reminder.processWithAgent) {
        // Process the message with the agent first
        const agentResponse = await processMessageWithAgent(reminder.conversationId, reminder.message);

        if (!agentResponse) {
          console.error(`[Scheduler] Failed to get agent response for reminder ${reminder.id}, will retry later`);
          continue;
        }

        messageText = `🔔 *Scheduled Update*\n\n${agentResponse}`;
      } else {
        // Send the message as-is
        messageText = `🔔 *Reminder*\n\n${reminder.message}`;
      }

      const sent = await sendTelegramMessage(reminder.conversationId, messageText);

      if (!sent) {
        console.error(`[Scheduler] Failed to send reminder ${reminder.id}, will retry later`);
        continue;
      }

      // Check if this is a recurring reminder
      const nextOccurrence = calculateNextOccurrence(reminder);

      if (nextOccurrence) {
        // Update for next occurrence
        await db
          .update(reminders)
          .set({
            scheduledFor: nextOccurrence,
            lastSent: now,
            updatedAt: now,
          })
          .where(eq(reminders.id, reminder.id));

        console.log(`[Scheduler] Recurring reminder ${reminder.id} rescheduled for ${nextOccurrence.toISOString()}`);
      } else {
        // Mark as sent (one-time reminder or recurring has ended)
        await db
          .update(reminders)
          .set({
            status: 'sent',
            lastSent: now,
            updatedAt: now,
          })
          .where(eq(reminders.id, reminder.id));

        console.log(`[Scheduler] Reminder ${reminder.id} marked as sent`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error processing due reminders:', error);
  }
}

// Run the scheduler
console.log('[Scheduler] Starting reminder scheduler...');
console.log('[Scheduler] Checking for reminders every minute');

// Run immediately on startup
processDueReminders();

// Schedule to run every minute
cron.schedule('* * * * *', () => {
  processDueReminders();
});

console.log('[Scheduler] Scheduler is running. Press Ctrl+C to stop.');

// Keep the process alive
process.on('SIGINT', () => {
  console.log('\n[Scheduler] Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Scheduler] Shutting down gracefully...');
  process.exit(0);
});
