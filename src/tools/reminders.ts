import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { db } from '../db/client';
import { reminders, conversations } from '../db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { parseISO, formatISO } from 'date-fns';
import { fromZonedTime, toZonedTime, format } from 'date-fns-tz';
import cron from 'node-cron';

// Tool to create a reminder
const createReminderTool = tool(
  'create_reminder',
  'Create a reminder for a specific time. The reminder will be sent to the conversation as a message. Supports one-time and recurring reminders using cron expressions. Can optionally process the message through the agent before sending (useful for dynamic content like "tell me my events today").',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    message: z.string().describe('What to remind the user about (or a prompt for the agent if processWithAgent is true)'),
    scheduledFor: z.string().describe('When to send the reminder in ISO format (e.g., 2025-10-07T13:00:00). For recurring reminders, this is the start time.'),
    timezone: z.string().optional().default('America/Santiago').describe('Timezone for the reminder'),
    processWithAgent: z.boolean().optional().default(false).describe('If true, the message will be sent to the AI agent for processing before being sent to the user. Use this for dynamic content like "What are my events today?" or "Summarize my calendar"'),
    cronExpression: z.string().optional().describe('Cron expression for recurring reminders (e.g., "0 9 * * 1-5" for weekdays at 9am, "0 */2 * * *" for every 2 hours). If not provided, it\'s a one-time reminder. Format: minute hour day month weekday'),
    endDate: z.string().optional().describe('End date for recurring reminders in ISO format'),
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

      // Validate cron expression if provided
      if (args.cronExpression && !cron.validate(args.cronExpression)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid cron expression: "${args.cronExpression}". Please use standard cron format (minute hour day month weekday). Examples:\n- "0 9 * * 1-5" = Weekdays at 9am\n- "0 */2 * * *" = Every 2 hours\n- "30 8 * * 0" = Sundays at 8:30am`,
          }],
          isError: true,
        };
      }

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

      // Check if the scheduled time is in the past (compare in UTC) - only for one-time reminders
      if (!args.cronExpression && scheduledDate < new Date()) {
        return {
          content: [{
            type: 'text',
            text: `Cannot schedule a reminder in the past. The scheduled time (${args.scheduledFor} ${timezone}) has already passed.`,
          }],
          isError: true,
        };
      }

      // Parse end date if provided
      let endDate: Date | undefined;
      if (args.endDate) {
        try {
          endDate = fromZonedTime(args.endDate, timezone);
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Invalid end date format. Please provide a valid ISO date string.`,
            }],
            isError: true,
          };
        }
      }

      // Insert reminder into database
      const result = await db.insert(reminders).values({
        conversationId: args.conversationId,
        message: args.message,
        scheduledFor: scheduledDate,
        timezone: args.timezone || 'America/Santiago',
        status: 'pending',
        processWithAgent: args.processWithAgent || false,
        cronExpression: args.cronExpression || null,
        endDate: endDate || null,
      }).returning();

      const reminder = result[0];

      // Format the scheduled time in the user's timezone for display
      const scheduledInUserTz = format(scheduledDate, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: timezone });

      let responseText = `Reminder created successfully!\n\n${args.processWithAgent ? 'Prompt' : 'Message'}: ${args.message}\nScheduled for: ${scheduledInUserTz}`;

      if (args.processWithAgent) {
        responseText += `\nProcessing: Will be processed by AI agent before sending`;
      }

      if (args.cronExpression) {
        responseText += `\nRecurrence: ${args.cronExpression}`;
        if (args.endDate) {
          responseText += `\nEnds on: ${args.endDate}`;
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
        const recurrenceInfo = reminder.cronExpression
          ? ` (Recurring: ${reminder.cronExpression})`
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
  'Edit an existing reminder. You can update the message, scheduled time, or cron expression for recurring reminders.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    reminderId: z.string().describe('UUID of the reminder to edit'),
    message: z.string().optional().describe('New reminder message'),
    scheduledFor: z.string().optional().describe('New scheduled time in ISO format'),
    cronExpression: z.string().optional().describe('New cron expression for recurring reminders (e.g., "0 9 * * 1-5" for weekdays at 9am). Set to null to convert to one-time reminder.'),
    endDate: z.string().optional().describe('New end date for recurring reminders in ISO format'),
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

      // Validate cron expression if provided
      if (args.cronExpression && !cron.validate(args.cronExpression)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid cron expression: "${args.cronExpression}". Please use standard cron format.`,
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

      if (args.cronExpression !== undefined) {
        updates.cronExpression = args.cronExpression;
      }

      if (args.endDate !== undefined) {
        if (args.endDate) {
          const timezone = existing[0].timezone || 'America/Santiago';
          try {
            updates.endDate = fromZonedTime(args.endDate, timezone);
          } catch (error) {
            return {
              content: [{
                type: 'text',
                text: `Invalid end date format. Please provide a valid ISO date string.`,
              }],
              isError: true,
            };
          }
        } else {
          updates.endDate = null;
        }
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

      let responseText = `Reminder updated successfully!\n\nMessage: ${result[0].message}\nScheduled for: ${formatISO(result[0].scheduledFor)}`;

      if (result[0].cronExpression) {
        responseText += `\nRecurrence: ${result[0].cronExpression}`;
      }

      return {
        content: [{
          type: 'text',
          text: responseText,
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
