import cron from 'node-cron';
import dotenv from 'dotenv';
import { db } from './db/client';
import { reminders, conversations } from './db/schema';
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
    // Retrieve session ID from database for conversation continuity
    const conversationRecord = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const sessionId = conversationRecord.length > 0 ? conversationRecord[0].sessionId : undefined;

    if (sessionId) {
      console.log(`[Scheduler] Using existing session ID: ${sessionId}`);
    } else {
      console.log(`[Scheduler] No existing session ID found, will create new session`);
    }

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
        resume: sessionId ?? undefined, // Use existing session for conversation continuity
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
    let newSessionId: string | undefined;

    // Collect text from complete assistant messages only (no streaming)
    for await (const message of agentQuery) {
      // Capture session ID from init message
      if (message.type === 'system') {
        const systemMsg = message as any;
        if (systemMsg.subtype === 'init') {
          newSessionId = systemMsg.session_id;
          console.log(`[Scheduler] Captured session ID: ${newSessionId}`);
        }
      }

      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      }
    }

    // Store new session ID if we got one
    if (newSessionId && newSessionId !== sessionId) {
      console.log(`[Scheduler] Storing new session ID ${newSessionId} for conversation ${conversationId}`);
      await db.insert(conversations).values({
        id: conversationId,
        sessionId: newSessionId,
        context: [],
      }).onConflictDoUpdate({
        target: conversations.id,
        set: {
          sessionId: newSessionId,
          updatedAt: new Date(),
        },
      });
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

// Helper to check if a cron expression matches the current time
// Based on standard cron format: minute hour day month weekday
function cronMatchesTime(cronExpression: string, date: Date): boolean {
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) {
    console.error(`[Scheduler] Invalid cron expression format: ${cronExpression}`);
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const matches = (cronPart: string, value: number, max: number): boolean => {
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
    matches(minute, date.getMinutes(), 59) &&
    matches(hour, date.getHours(), 23) &&
    matches(dayOfMonth, date.getDate(), 31) &&
    matches(month, date.getMonth() + 1, 12) && // Month is 0-indexed in JS
    matches(dayOfWeek, date.getDay(), 6) // 0 = Sunday
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
