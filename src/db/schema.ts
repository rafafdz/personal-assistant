import { pgTable, text, timestamp, bigint, jsonb, uuid, boolean } from 'drizzle-orm/pg-core';

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(), // Telegram chat ID (works for both private chats and groups)
  sessionId: text('session_id'), // Claude Agent SDK session ID for conversation continuity
  context: jsonb('context').$type<any[]>().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(), // Google account email
  displayName: text('display_name').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const calendarTokens = pgTable('calendar_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().unique().references(() => accounts.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiryDate: bigint('expiry_date', { mode: 'number' }),
  scope: text('scope'),
  tokenType: text('token_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const calendars = pgTable('calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull(), // Google Calendar ID (e.g., "primary" or email)
  displayName: text('display_name').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  message: text('message').notNull(), // What to remind (or agent prompt if processWithAgent=true)
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(), // When to trigger (or start time for recurring reminders)
  timezone: text('timezone').default('America/Santiago').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'sent', 'cancelled'
  processWithAgent: boolean('process_with_agent').default(false).notNull(), // If true, send message to agent for processing
  cronExpression: text('cron_expression'), // Standard cron expression for recurring reminders (e.g., '0 9 * * 1-5' for weekdays at 9am). If null, it's a one-time reminder.
  endDate: timestamp('end_date', { withTimezone: true }), // Optional end date for recurring reminders
  lastSent: timestamp('last_sent', { withTimezone: true }), // For tracking recurring reminders
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
