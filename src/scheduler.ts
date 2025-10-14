import cron from 'node-cron';
import dotenv from 'dotenv';
import { db } from './db/client';
import { reminders, conversations } from './db/schema';
import { eq } from 'drizzle-orm';
import { handleSchedulerAgentQuery } from './handlers/scheduler-agent-handler';

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
  // Retrieve session ID from database for conversation continuity
  const conversationRecord = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const sessionId = conversationRecord.length > 0 ? conversationRecord[0].sessionId : undefined;

  // Use the shared scheduler agent handler
  const result = await handleSchedulerAgentQuery({
    conversationId,
    prompt,
    existingSession: sessionId ?? undefined,
  });

  // Store new session ID if we got one
  if (result.sessionId && result.sessionId !== sessionId) {
    console.log(`[Scheduler] Storing new session ID ${result.sessionId} for conversation ${conversationId}`);
    await db.insert(conversations).values({
      id: conversationId,
      sessionId: result.sessionId,
      context: [],
    }).onConflictDoUpdate({
      target: conversations.id,
      set: {
        sessionId: result.sessionId,
        updatedAt: new Date(),
      },
    });
  }

  return result.responseText;
}

// Helper to check if a cron expression matches the current time
// Based on standard cron format: minute hour day month weekday
function cronMatchesTime(cronExpression: string, date: Date): boolean {
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) {
    console.error(`[Scheduler] Invalid cron expression format: ${cronExpression}`);
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const matches = (cronPart: string, value: number): boolean => {
    // * matches everything
    if (cronPart === '*') return true;

    // */n matches every n values
    if (cronPart.startsWith('*/')) {
      const interval = parseInt(cronPart.slice(2));
      return value % interval === 0;
    }

    // Range: 1-5
    if (cronPart.includes('-')) {
      const [start, end] = cronPart.split('-').map(Number);
      return value >= start && value <= end;
    }

    // List: 1,3,5
    if (cronPart.includes(',')) {
      return cronPart.split(',').map(Number).includes(value);
    }

    // Exact match
    return parseInt(cronPart) === value;
  };

  return (
    matches(minute, date.getMinutes()) &&
    matches(hour, date.getHours()) &&
    matches(dayOfMonth, date.getDate()) &&
    matches(month, date.getMonth() + 1) && // Month is 0-indexed in JS
    matches(dayOfWeek, date.getDay()) // 0 = Sunday
  );
}

// Check if a reminder should run based on its cron expression or scheduled time
function shouldReminderRun(reminder: any, now: Date): boolean {
  // If no cron expression, it's a one-time reminder - check if it's due
  if (!reminder.cronExpression) {
    return reminder.scheduledFor <= now;
  }

  // For recurring reminders with cron expressions:

  // If this reminder was already sent in the last minute, skip it
  // (to avoid sending the same reminder multiple times within the same minute)
  if (reminder.lastSent) {
    const lastSentMinute = new Date(reminder.lastSent);
    lastSentMinute.setSeconds(0, 0);
    const currentMinute = new Date(now);
    currentMinute.setSeconds(0, 0);

    if (lastSentMinute.getTime() === currentMinute.getTime()) {
      return false; // Already sent in this minute
    }
  }

  // Check if current time is past the start time
  if (now < reminder.scheduledFor) {
    return false; // Haven't reached start time yet
  }

  // Check if we've passed the end date
  if (reminder.endDate && now > reminder.endDate) {
    return false; // Recurrence has ended
  }

  // Convert to the reminder's timezone for cron matching
  const { toZonedTime } = require('date-fns-tz');
  const zonedNow = toZonedTime(now, reminder.timezone || 'America/Santiago');

  // Check if the cron expression matches the current time
  return cronMatchesTime(reminder.cronExpression, zonedNow);
}

// Process due reminders
async function processDueReminders() {
  const now = new Date();
  console.log(`[Scheduler] Checking for due reminders at ${now.toISOString()}`);

  try {
    // Find all pending reminders (we'll filter by schedule logic below)
    const allReminders = await db
      .select()
      .from(reminders)
      .where(eq(reminders.status, 'pending'));

    console.log(`[Scheduler] Found ${allReminders.length} pending reminder(s), filtering by schedule...`);

    // Filter reminders that should run now
    const dueReminders = allReminders.filter(reminder => shouldReminderRun(reminder, now));

    console.log(`[Scheduler] ${dueReminders.length} reminder(s) should run now`);

    for (const reminder of dueReminders) {
      console.log(`[Scheduler] Processing reminder ${reminder.id}: "${reminder.message}"`);
      console.log(`[Scheduler] Process with agent: ${reminder.processWithAgent}`);
      console.log(`[Scheduler] Cron expression: ${reminder.cronExpression || 'none (one-time)'}`);

      let messageSent = false;

      if (reminder.processWithAgent) {
        // Process the message with the agent first
        const agentResponse = await processMessageWithAgent(reminder.conversationId, reminder.message);

        if (!agentResponse) {
          console.error(`[Scheduler] Failed to get agent response for reminder ${reminder.id}, will retry later`);
          continue;
        }

        // Split the agent response by ---SPLIT--- token
        const messageParts = agentResponse.split('---SPLIT---').map(part => part.trim()).filter(part => part.length > 0);

        // Send each part as a separate message
        let allSent = true;
        for (let i = 0; i < messageParts.length; i++) {
          const prefix = i === 0 ? '🔔 *Scheduled Update*\n\n' : '';
          const sent = await sendTelegramMessage(reminder.conversationId, `${prefix}${messageParts[i]}`);
          if (!sent) {
            allSent = false;
            break;
          }
        }

        if (!allSent) {
          console.error(`[Scheduler] Failed to send all message parts for reminder ${reminder.id}, will retry later`);
          continue;
        }

        messageSent = true;
      } else {
        // Send the message as-is
        const messageText = `🔔 *Reminder*\n\n${reminder.message}`;
        const sent = await sendTelegramMessage(reminder.conversationId, messageText);

        if (!sent) {
          console.error(`[Scheduler] Failed to send reminder ${reminder.id}, will retry later`);
          continue;
        }

        messageSent = true;
      }

      if (!messageSent) {
        console.error(`[Scheduler] Failed to send reminder ${reminder.id}, will retry later`);
        continue;
      }

      // Check if this is a recurring reminder or one-time
      if (reminder.cronExpression) {
        // Recurring reminder - just update lastSent timestamp
        await db
          .update(reminders)
          .set({
            lastSent: now,
            updatedAt: now,
          })
          .where(eq(reminders.id, reminder.id));

        console.log(`[Scheduler] Recurring reminder ${reminder.id} will run again according to cron: ${reminder.cronExpression}`);
      } else {
        // One-time reminder - mark as sent
        await db
          .update(reminders)
          .set({
            status: 'sent',
            lastSent: now,
            updatedAt: now,
          })
          .where(eq(reminders.id, reminder.id));

        console.log(`[Scheduler] One-time reminder ${reminder.id} marked as sent`);
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
