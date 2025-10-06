import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reminders, conversations } from '../db/schema.js';
import { eq, and, gte, lte } from 'drizzle-orm';
import { parseISO, formatISO } from 'date-fns';
import { fromZonedTime, toZonedTime, format } from 'date-fns-tz';

// Tool to create a reminder
const createReminderTool = tool(
  'create_reminder',
  'Create a reminder for a specific time. The reminder will be sent to the conversation as a message. Supports one-time and recurring reminders. Can optionally process the message through the agent before sending (useful for dynamic content like "tell me my events today").',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    message: z.string().describe('What to remind the user about (or a prompt for the agent if processWithAgent is true)'),
    scheduledFor: z.string().describe('When to send the reminder in ISO format (e.g., 2025-10-07T13:00:00)'),
    timezone: z.string().optional().default('America/Santiago').describe('Timezone for the reminder'),
    processWithAgent: z.boolean().optional().default(false).describe('If true, the message will be sent to the AI agent for processing before being sent to the user. Use this for dynamic content like "What are my events today?" or "Summarize my calendar"'),
    recurrence: z.object({
      type: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']).describe('Type of recurrence'),
      interval: z.number().optional().describe('Interval for recurrence (e.g., every 2 days)'),
      daysOfWeek: z.array(z.number().min(0).max(6)).optional().describe('Days of week for weekly recurrence (0=Sunday, 6=Saturday)'),
      endDate: z.string().optional().describe('End date for recurring reminder in ISO format'),
    }).optional().describe('Recurrence settings for the reminder'),
  },
  async (args) => {
    console.log(`[Reminders] Creating reminder for conversation ${args.conversationId}`);
    console.log(`[Reminders] Message: "${args.message}"`);
    console.log(`[Reminders] Scheduled for: ${args.scheduledFor}`);

    try {
      // Ensure conversation exists
      await db.insert(conversations).values({
        id: args.conversationId,
        context: [],
      }).onConflictDoNothing();

      // Parse and validate the scheduled time, converting from user's timezone to UTC
      const timezone = args.timezone || 'America/Santiago';
      let scheduledDate: Date;

      try {
        // Parse the ISO string and treat it as being in the specified timezone
        scheduledDate = fromZonedTime(args.scheduledFor, timezone);
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Invalid date format. Please provide a valid ISO date string (e.g., 2025-10-07T13:00:00).`,
          }],
          isError: true,
        };
      }

      // Check if the scheduled time is in the past (compare in UTC)
      if (scheduledDate < new Date()) {
        return {
          content: [{
            type: 'text',
            text: `Cannot schedule a reminder in the past. The scheduled time (${args.scheduledFor} ${timezone}) has already passed.`,
          }],
          isError: true,
        };
      }

      // Insert reminder into database
      const result = await db.insert(reminders).values({
        conversationId: args.conversationId,
        message: args.message,
        scheduledFor: scheduledDate,
        timezone: args.timezone || 'America/Santiago',
        status: 'pending',
        processWithAgent: args.processWithAgent || false,
        recurrence: args.recurrence || { type: 'none' },
      }).returning();

      const reminder = result[0];

      // Format the scheduled time in the user's timezone for display
      const scheduledInUserTz = format(scheduledDate, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: timezone });

      let responseText = `Reminder created successfully!\n\n${args.processWithAgent ? 'Prompt' : 'Message'}: ${args.message}\nScheduled for: ${scheduledInUserTz}`;

      if (args.processWithAgent) {
        responseText += `\nProcessing: Will be processed by AI agent before sending`;
      }

      if (args.recurrence && args.recurrence.type !== 'none') {
        responseText += `\nRecurrence: ${args.recurrence.type}`;
        if (args.recurrence.interval) {
          responseText += ` (every ${args.recurrence.interval})`;
        }
        if (args.recurrence.daysOfWeek && args.recurrence.daysOfWeek.length > 0) {
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const days = args.recurrence.daysOfWeek.map(d => dayNames[d]).join(', ');
          responseText += ` on ${days}`;
        }
        if (args.recurrence.endDate) {
          responseText += `\nEnds on: ${args.recurrence.endDate}`;
        }
      }

      responseText += `\n\nReminder ID: ${reminder.id}`;

      return {
        content: [{
          type: 'text',
          text: responseText,
        }],
      };
    } catch (error: any) {
      console.error(`[Reminders] Error creating reminder:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error creating reminder: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to list reminders
const listRemindersTool = tool(
  'list_reminders',
  'List all reminders for a conversation. Can filter by status (pending, sent, cancelled) or show upcoming reminders.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    status: z.enum(['pending', 'sent', 'cancelled']).optional().describe('Filter by status'),
    upcomingOnly: z.boolean().optional().default(false).describe('Show only upcoming reminders (scheduled for future)'),
    limit: z.number().optional().default(10).describe('Maximum number of reminders to return'),
  },
  async (args) => {
    console.log(`[Reminders] Listing reminders for conversation ${args.conversationId}`);

    try {
      let query = db
        .select()
        .from(reminders)
        .where(eq(reminders.conversationId, args.conversationId));

      // Add status filter if provided
      const conditions: any[] = [eq(reminders.conversationId, args.conversationId)];

      if (args.status) {
        conditions.push(eq(reminders.status, args.status));
      }

      if (args.upcomingOnly) {
        conditions.push(gte(reminders.scheduledFor, new Date()));
      }

      const result = await db
        .select()
        .from(reminders)
        .where(and(...conditions))
        .orderBy(reminders.scheduledFor)
        .limit(args.limit);

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No reminders found.',
          }],
        };
      }

      const reminderList = result.map((reminder) => {
        const recurrenceInfo = reminder.recurrence?.type !== 'none'
          ? ` (Recurring: ${reminder.recurrence?.type})`
          : '';

        return `• ${reminder.message}
  Scheduled: ${formatISO(reminder.scheduledFor)}
  Status: ${reminder.status}${recurrenceInfo}
  ID: ${reminder.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${result.length} reminder(s):\n\n${reminderList}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Reminders] Error listing reminders:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error listing reminders: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to cancel a reminder
const cancelReminderTool = tool(
  'cancel_reminder',
  'Cancel a pending reminder. This will set the reminder status to "cancelled" and it will not be sent.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    reminderId: z.string().describe('UUID of the reminder to cancel'),
  },
  async (args) => {
    console.log(`[Reminders] Cancelling reminder ${args.reminderId} for conversation ${args.conversationId}`);

    try {
      const result = await db
        .update(reminders)
        .set({
          status: 'cancelled',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reminders.conversationId, args.conversationId),
            eq(reminders.id, args.reminderId)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Reminder not found in this conversation.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Reminder cancelled successfully!\n\nMessage: ${result[0].message}\nWas scheduled for: ${formatISO(result[0].scheduledFor)}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Reminders] Error cancelling reminder:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error cancelling reminder: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to edit a reminder
const editReminderTool = tool(
  'edit_reminder',
  'Edit an existing reminder. You can update the message, scheduled time, or recurrence settings.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    reminderId: z.string().describe('UUID of the reminder to edit'),
    message: z.string().optional().describe('New reminder message'),
    scheduledFor: z.string().optional().describe('New scheduled time in ISO format'),
    recurrence: z.object({
      type: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom']),
      interval: z.number().optional(),
      daysOfWeek: z.array(z.number().min(0).max(6)).optional(),
      endDate: z.string().optional(),
    }).optional().describe('New recurrence settings'),
  },
  async (args) => {
    console.log(`[Reminders] Editing reminder ${args.reminderId} for conversation ${args.conversationId}`);

    try {
      // Get the existing reminder first
      const existing = await db
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.conversationId, args.conversationId),
            eq(reminders.id, args.reminderId)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Reminder not found in this conversation.',
          }],
          isError: true,
        };
      }

      // Prepare update object
      const updates: any = {
        updatedAt: new Date(),
      };

      if (args.message) {
        updates.message = args.message;
      }

      if (args.scheduledFor) {
        // Use the existing reminder's timezone for conversion
        const timezone = existing[0].timezone || 'America/Santiago';

        try {
          const scheduledDate = fromZonedTime(args.scheduledFor, timezone);
          updates.scheduledFor = scheduledDate;
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Invalid date format. Please provide a valid ISO date string.`,
            }],
            isError: true,
          };
        }
      }

      if (args.recurrence) {
        updates.recurrence = args.recurrence;
      }

      // Update the reminder
      const result = await db
        .update(reminders)
        .set(updates)
        .where(
          and(
            eq(reminders.conversationId, args.conversationId),
            eq(reminders.id, args.reminderId)
          )
        )
        .returning();

      return {
        content: [{
          type: 'text',
          text: `Reminder updated successfully!\n\nMessage: ${result[0].message}\nScheduled for: ${formatISO(result[0].scheduledFor)}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Reminders] Error editing reminder:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error editing reminder: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Create MCP server with reminder tools
export const reminderServer = createSdkMcpServer({
  name: 'reminder-tools',
  version: '1.0.0',
  tools: [
    createReminderTool,
    listRemindersTool,
    cancelReminderTool,
    editReminderTool,
  ],
});

console.log('[Reminders] MCP server created with tools:', reminderServer);
