import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { google } from 'googleapis';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../db/client';
import { calendarTokens, calendars, conversations, accounts } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// Load OAuth credentials from base64-encoded JSON in environment variable
const loadOAuthCredentials = () => {
  const credentialsBase64 = process.env.GOOGLE_OAUTH_CREDENTIALS;
  console.log(`[OAuth] Loading credentials from GOOGLE_OAUTH_CREDENTIALS env variable`);

  if (!credentialsBase64) {
    throw new Error('GOOGLE_OAUTH_CREDENTIALS not set in environment');
  }

  try {
    const credentialsJson = Buffer.from(credentialsBase64, 'base64').toString('utf8');
    const credentials = JSON.parse(credentialsJson);
    console.log(`[OAuth] Credentials loaded, keys: ${Object.keys(credentials).join(', ')}`);

    // Support both web and installed app credential formats
    const clientConfig = credentials.installed || credentials.web;
    if (!clientConfig) {
      console.error(`[OAuth] Invalid credentials format. Available keys: ${Object.keys(credentials).join(', ')}`);
      throw new Error('Invalid OAuth credentials file format');
    }

    console.log(`[OAuth] Using client config type: ${credentials.installed ? 'installed' : 'web'}`);
    console.log(`[OAuth] Client ID: ${clientConfig.client_id?.substring(0, 20)}...`);
    console.log(`[OAuth] Redirect URIs: ${JSON.stringify(clientConfig.redirect_uris)}`);

    return {
      clientId: clientConfig.client_id,
      clientSecret: clientConfig.client_secret,
      redirectUri: clientConfig.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob',
    };
  } catch (error: any) {
    console.error(`[OAuth] Error loading credentials:`, error);
    throw error;
  }
};

// Initialize OAuth2 client
const getOAuth2Client = () => {
  const { clientId, clientSecret, redirectUri } = loadOAuthCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

// Database helper functions
const getCalendarTokens = async (accountId: string) => {
  const result = await db
    .select()
    .from(calendarTokens)
    .where(eq(calendarTokens.accountId, accountId))
    .limit(1);

  return result[0] || null;
};

const saveCalendarTokens = async (accountId: string, tokens: any) => {
  await db.insert(calendarTokens).values({
    accountId,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    scope: tokens.scope,
    tokenType: tokens.token_type,
  }).onConflictDoUpdate({
    target: calendarTokens.accountId,
    set: {
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      scope: tokens.scope,
      tokenType: tokens.token_type,
      updatedAt: new Date(),
    }
  });
};

const getDefaultAccount = async (conversationId: string) => {
  // Try to get default account
  let result = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.conversationId, conversationId),
        eq(accounts.isDefault, true)
      )
    )
    .limit(1);

  // Fallback to first account if no default
  if (!result[0]) {
    result = await db
      .select()
      .from(accounts)
      .where(eq(accounts.conversationId, conversationId))
      .limit(1);
  }

  return result[0] || null;
};

const getDefaultCalendar = async (accountId: string) => {
  // Try to get default calendar
  let result = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.accountId, accountId),
        eq(calendars.isDefault, true)
      )
    )
    .limit(1);

  // Fallback to first calendar if no default
  if (!result[0]) {
    result = await db
      .select()
      .from(calendars)
      .where(eq(calendars.accountId, accountId))
      .limit(1);
  }

  return result[0]?.calendarId || 'primary';
};

// Get calendar client with account's OAuth token
const getCalendarClient = async (accountId: string) => {
  const oauth2Client = getOAuth2Client();
  const tokenData = await getCalendarTokens(accountId);

  if (!tokenData) {
    throw new Error('NOT_AUTHENTICATED');
  }

  const tokens = {
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken || undefined,
    expiry_date: tokenData.expiryDate || undefined,
    scope: tokenData.scope || undefined,
    token_type: tokenData.tokenType || undefined,
  };

  oauth2Client.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth: oauth2Client });
};

// Generate OAuth URL
export const generateAuthUrl = (conversationId: string) => {
  console.log(`[OAuth] Generating auth URL for conversation ${conversationId}`);
  try {
    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: conversationId,
    });
    console.log(`[OAuth] Generated auth URL: ${authUrl}`);
    return authUrl;
  } catch (error: any) {
    console.error(`[OAuth] Error generating auth URL:`, error);
    throw error;
  }
};

// Exchange code for tokens and create account
export const handleOAuthCallback = async (code: string, conversationId: string) => {
  console.log(`[OAuth] Handling OAuth callback for conversation ${conversationId}`);
  console.log(`[OAuth] Code received: ${code.substring(0, 20)}...`);

  try {
    const oauth2Client = getOAuth2Client();
    console.log(`[OAuth] Exchanging code for tokens...`);

    const { tokens } = await oauth2Client.getToken(code);
    console.log(`[OAuth] Tokens received:`, {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiryDate: tokens.expiry_date,
    });

    // Get user info to retrieve email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email!;
    const displayName = userInfo.data.name || email;

    console.log(`[OAuth] Account email: ${email}`);

    // Ensure conversation exists
    await db.insert(conversations).values({
      id: conversationId,
      context: [],
    }).onConflictDoNothing();

    // Check if account already exists for this conversation
    const existingAccount = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.conversationId, conversationId),
          eq(accounts.email, email)
        )
      )
      .limit(1);

    let accountId: string;

    if (existingAccount[0]) {
      // Update existing account
      accountId = existingAccount[0].id;
      console.log(`[OAuth] Updating existing account ${accountId}`);
    } else {
      // Check if this is the first account for this conversation
      const existingAccounts = await db
        .select()
        .from(accounts)
        .where(eq(accounts.conversationId, conversationId));

      const isFirstAccount = existingAccounts.length === 0;

      // Create new account
      const newAccount = await db.insert(accounts).values({
        conversationId,
        email,
        displayName,
        isDefault: isFirstAccount, // First account is default
      }).returning();

      accountId = newAccount[0].id;
      console.log(`[OAuth] Created new account ${accountId} for ${email}`);
    }

    // Save tokens for this account
    await saveCalendarTokens(accountId, tokens);
    console.log(`[OAuth] Stored tokens for account ${accountId}`);

    return { accountId, email, displayName };
  } catch (error: any) {
    console.error(`[OAuth] Error exchanging code for tokens:`, error);
    console.error(`[OAuth] Error details:`, {
      message: error.message,
      code: error.code,
      response: error.response?.data,
    });
    throw error;
  }
};

// Input schema for calendar events
const calendarEventsSchema = {
  conversationId: z.string().describe('Conversation/chat ID'),
  accountId: z.string().optional().describe('Account ID (if not specified, uses default account for this conversation)'),
  startDate: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
  endDate: z.string().describe('End date in ISO format (YYYY-MM-DD)'),
  calendarId: z.string().optional().describe('Calendar ID (if not specified, uses default calendar)'),
};

// Tool to get current date and time
const getCurrentDateTimeTool = tool(
  'get_current_datetime',
  'Get current date/time in Santiago timezone. Use this if you need to calculate relative times (e.g., "in 5 minutes", "in 2 hours"). Returns ISO format without timezone suffix, suitable for use in create_calendar_event.',
  {},
  async () => {
    const now = new Date();
    const iso = now.toLocaleString('sv-SE', {
      timeZone: 'America/Santiago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(' ', 'T');

    return {
      content: [{
        type: 'text',
        text: `Current time in Santiago: ${iso}\n\nYou can use this as a base for calculating relative times. For example, if the user says "in 5 minutes", add 5 minutes to this time.`,
      }],
    };
  }
);

// Tool to list available calendars
const listCalendarsTool = tool(
  'list_calendars',
  'List all calendars available to the user from their Google account. Use this to find calendar IDs for other operations. If accountId is not provided, uses the default account.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().optional().describe('Account ID (if not specified, uses default account)'),
  },
  async (args) => {
    console.log(`[Calendar] Listing calendars for conversation ${args.conversationId}`);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
        console.log(`[Calendar] Using default account: ${defaultAccount.email}`);
      }

      const calendar = await getCalendarClient(accountId);

      const response = await calendar.calendarList.list();
      const calendars = response.data.items || [];

      console.log(`[Calendar] Found ${calendars.length} calendars`);

      if (calendars.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No calendars found.',
          }],
        };
      }

      const calendarList = calendars.map((cal) => {
        const isPrimary = cal.primary ? ' (Primary)' : '';
        const summary = cal.summary || 'Untitled Calendar';
        return `• ${summary}${isPrimary}\n  ID: ${cal.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Available calendars:\n\n${calendarList}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error listing calendars:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `User is not authenticated with Google Calendar. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error listing calendars: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to get authentication URL
const getAuthUrlTool = tool(
  'get_calendar_auth_url',
  'Get Google Calendar authentication URL for this conversation. Call this when user needs to connect their calendar. The URL will be provided in the response for you to send to the user.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Calendar] Getting auth URL for conversation ${args.conversationId}`);
    try {
      const authUrl = generateAuthUrl(args.conversationId);
      return {
        content: [{
          type: 'text',
          text: `Authentication URL: ${authUrl}\n\nPlease send this link to the user and ask them to:\n1. Click the link to authorize with Google Calendar\n2. Copy the authorization code they receive\n3. Send you the code so you can complete the connection using set_calendar_auth_token`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error generating auth URL:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error generating authentication URL: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to set authentication token
const setAuthTokenTool = tool(
  'set_calendar_auth_token',
  'Set Google Calendar authentication token for this conversation after the user provides the authorization code. Call this after the user has authorized and sent you their code. This will create a new Google account connection for this conversation.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    authCode: z.string().describe('Authorization code provided by the user after they authorized'),
  },
  async (args) => {
    console.log(`[Calendar] Setting auth token for conversation ${args.conversationId}`);
    try {
      const result = await handleOAuthCallback(args.authCode, args.conversationId);
      return {
        content: [{
          type: 'text',
          text: `Calendar successfully connected!\n\nAccount: ${result.displayName} (${result.email})\nAccount ID: ${result.accountId}\n\nThe user can now ask about their calendar events. This account has been ${result.accountId ? 'added to' : 'set as the default for'} this conversation.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error setting auth token:`, error);
      return {
        content: [{
          type: 'text',
          text: `Failed to connect calendar: ${error.message}. Please ask the user to try the authentication process again.`,
        }],
        isError: true,
      };
    }
  }
);

// Custom tool to get calendar events
const getCalendarEventsTool = tool(
  'get_calendar_events',
  'Get events from Google Calendar within a date range. If accountId is not provided, uses the default account for the conversation. If the account is not authenticated, you will get a NOT_AUTHENTICATED error - in that case, use get_calendar_auth_url tool to start the authentication process.',
  calendarEventsSchema,
  async (args) => {
    console.log(`[Calendar] Raw args received:`, JSON.stringify(args, null, 2));
    console.log(`[Calendar] Getting events for conversation ${args.conversationId} from ${args.startDate} to ${args.endDate}`);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
        console.log(`[Calendar] Using default account: ${defaultAccount.email}`);
      }

      const calendar = await getCalendarClient(accountId);

      // Use provided calendarId or get default
      const calendarId = args.calendarId || await getDefaultCalendar(accountId);

      const startDateTime = new Date(args.startDate).toISOString();
      const endDateTime = new Date(args.endDate + 'T23:59:59').toISOString();

      console.log(`[Calendar] Fetching events from ${startDateTime} to ${endDateTime} for calendar ${calendarId}`);

      const response = await calendar.events.list({
        calendarId: calendarId,
        timeMin: startDateTime,
        timeMax: endDateTime,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];
      console.log(`[Calendar] Found ${events.length} events`);

      if (events.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No events found between ${args.startDate} and ${args.endDate}.`,
          }],
        };
      }

      const eventsList = events.map((event) => {
        const start = event.start?.dateTime || event.start?.date || 'No start time';
        const end = event.end?.dateTime || event.end?.date || 'No end time';
        const summary = event.summary || 'Untitled Event';
        const location = event.location ? `\nLocation: ${event.location}` : '';
        const description = event.description ? `\nDescription: ${event.description}` : '';

        return `• ${summary}
  Time: ${start} - ${end}${location}${description}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${events.length} event(s) between ${args.startDate} and ${args.endDate}:\n\n${eventsList}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error getting events:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        console.log(`[Calendar] Conversation ${args.conversationId} not authenticated`);
        return {
          content: [{
            type: 'text',
            text: `This conversation is not authenticated with Google Calendar. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      console.error(`[Calendar] Error details:`, {
        message: error.message,
        code: error.code,
        response: error.response?.data,
      });

      return {
        content: [{
          type: 'text',
          text: `Error fetching calendar events: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to create calendar event
const createCalendarEventTool = tool(
  'create_calendar_event',
  'Create a new event in Google Calendar. If accountId is not provided, uses the default account for this conversation. IMPORTANT: All times must be in Santiago timezone (America/Santiago). When the user says "in 5 minutes" or "at 3pm", calculate relative to the current Santiago time provided in your system prompt.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().optional().describe('Account ID (if not specified, uses default account)'),
    summary: z.string().describe('Event title/summary'),
    startDateTime: z.string().describe('Event start time in Santiago timezone, ISO format WITHOUT timezone suffix (e.g., 2025-01-15T10:00:00). Do NOT use UTC. Calculate times relative to current Santiago time from your system prompt.'),
    endDateTime: z.string().describe('Event end time in Santiago timezone, ISO format WITHOUT timezone suffix (e.g., 2025-01-15T11:00:00). Do NOT use UTC. Calculate times relative to current Santiago time from your system prompt.'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    calendarId: z.string().optional().describe('Calendar ID (if not specified, uses default calendar)'),
  },
  async (args) => {
    console.log(`[Calendar] Creating event for conversation ${args.conversationId}:`, args.summary);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
      }

      const calendar = await getCalendarClient(accountId);

      // Use provided calendarId or get default
      const calendarId = args.calendarId || await getDefaultCalendar(accountId);

      const event = {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: {
          dateTime: args.startDateTime,
          timeZone: 'America/Santiago',
        },
        end: {
          dateTime: args.endDateTime,
          timeZone: 'America/Santiago',
        },
      };

      const response = await calendar.events.insert({
        calendarId: calendarId,
        requestBody: event,
      });

      console.log(`[Calendar] Event created with ID: ${response.data.id}`);

      return {
        content: [{
          type: 'text',
          text: `Event created successfully!\n\nTitle: ${args.summary}\nStart: ${args.startDateTime}\nEnd: ${args.endDateTime}${args.location ? `\nLocation: ${args.location}` : ''}${args.description ? `\nDescription: ${args.description}` : ''}\n\nEvent ID: ${response.data.id}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error creating event:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `This conversation is not authenticated with Google Calendar. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error creating calendar event: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to edit calendar event
const editCalendarEventTool = tool(
  'edit_calendar_event',
  'Update an existing event in Google Calendar. You can update any fields. If accountId is not provided, uses the default account. IMPORTANT: All times must be in Santiago timezone (America/Santiago).',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().optional().describe('Account ID (if not specified, uses default account)'),
    eventId: z.string().describe('Event ID to update'),
    summary: z.string().optional().describe('New event title/summary'),
    startDateTime: z.string().optional().describe('New start time in Santiago timezone, ISO format WITHOUT timezone suffix (e.g., 2025-01-15T10:00:00). Calculate relative to current Santiago time from system prompt.'),
    endDateTime: z.string().optional().describe('New end time in Santiago timezone, ISO format WITHOUT timezone suffix (e.g., 2025-01-15T11:00:00). Calculate relative to current Santiago time from system prompt.'),
    description: z.string().optional().describe('New event description'),
    location: z.string().optional().describe('New event location'),
    calendarId: z.string().optional().describe('Calendar ID (if not specified, uses default calendar)'),
  },
  async (args) => {
    console.log(`[Calendar] Editing event ${args.eventId} for conversation ${args.conversationId}`);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
      }

      const calendar = await getCalendarClient(accountId);

      // Use provided calendarId or get default
      const calendarId = args.calendarId || await getDefaultCalendar(accountId);

      // First, get the existing event
      const existingEvent = await calendar.events.get({
        calendarId: calendarId,
        eventId: args.eventId,
      });

      // Update only provided fields
      const updatedEvent = {
        summary: args.summary ?? existingEvent.data.summary,
        description: args.description ?? existingEvent.data.description,
        location: args.location ?? existingEvent.data.location,
        start: args.startDateTime ? {
          dateTime: args.startDateTime,
          timeZone: 'America/Santiago',
        } : existingEvent.data.start,
        end: args.endDateTime ? {
          dateTime: args.endDateTime,
          timeZone: 'America/Santiago',
        } : existingEvent.data.end,
      };

      const response = await calendar.events.update({
        calendarId: calendarId,
        eventId: args.eventId,
        requestBody: updatedEvent,
      });

      console.log(`[Calendar] Event ${args.eventId} updated successfully`);

      return {
        content: [{
          type: 'text',
          text: `Event updated successfully!\n\nTitle: ${response.data.summary}\nStart: ${response.data.start?.dateTime || response.data.start?.date}\nEnd: ${response.data.end?.dateTime || response.data.end?.date}${response.data.location ? `\nLocation: ${response.data.location}` : ''}${response.data.description ? `\nDescription: ${response.data.description}` : ''}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error editing event:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `This conversation is not authenticated with Google Calendar. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error editing calendar event: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to delete calendar event
const deleteCalendarEventTool = tool(
  'delete_calendar_event',
  'Delete an event from Google Calendar. This action cannot be undone. If accountId is not provided, uses the default account.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().optional().describe('Account ID (if not specified, uses default account)'),
    eventId: z.string().describe('Event ID to delete'),
    calendarId: z.string().optional().describe('Calendar ID (if not specified, uses default calendar)'),
  },
  async (args) => {
    console.log(`[Calendar] Deleting event ${args.eventId} for conversation ${args.conversationId}`);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
      }

      const calendar = await getCalendarClient(accountId);

      // Use provided calendarId or get default
      const calendarId = args.calendarId || await getDefaultCalendar(accountId);

      // Get event details before deleting for confirmation message
      const event = await calendar.events.get({
        calendarId: calendarId,
        eventId: args.eventId,
      });

      const eventSummary = event.data.summary || 'Untitled Event';

      await calendar.events.delete({
        calendarId: calendarId,
        eventId: args.eventId,
      });

      console.log(`[Calendar] Event ${args.eventId} deleted successfully`);

      return {
        content: [{
          type: 'text',
          text: `Event "${eventSummary}" has been deleted successfully.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error deleting event:`, error);

      if (error.message === 'NOT_AUTHENTICATED') {
        return {
          content: [{
            type: 'text',
            text: `This conversation is not authenticated with Google Calendar. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Error deleting calendar event: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to add calendar to conversation
const addCalendarTool = tool(
  'add_calendar_to_conversation',
  'Add a Google Calendar to track in this conversation. The calendar must exist in the authenticated Google account. If accountId is not provided, uses the default account.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().optional().describe('Account ID (if not specified, uses default account)'),
    calendarId: z.string().describe('Google Calendar ID (e.g., "primary" or email address)'),
    displayName: z.string().describe('Friendly display name for this calendar'),
    setAsDefault: z.boolean().optional().default(false).describe('Set this as the default calendar for this account'),
  },
  async (args) => {
    console.log(`[Calendar] Adding calendar ${args.calendarId} to conversation ${args.conversationId}`);

    try {
      // Get account ID (use provided or get default)
      let accountId = args.accountId;
      if (!accountId) {
        const defaultAccount = await getDefaultAccount(args.conversationId);
        if (!defaultAccount) {
          return {
            content: [{
              type: 'text',
              text: `This conversation has no authenticated Google accounts. Use the get_calendar_auth_url tool to get an authentication link to send to the user.`,
            }],
            isError: true,
          };
        }
        accountId = defaultAccount.id;
      }

      // If setting as default, unset other defaults for this account first
      if (args.setAsDefault) {
        await db.update(calendars)
          .set({ isDefault: false })
          .where(eq(calendars.accountId, accountId));
      }

      await db.insert(calendars).values({
        accountId,
        conversationId: args.conversationId,
        calendarId: args.calendarId,
        displayName: args.displayName,
        isDefault: args.setAsDefault,
      });

      return {
        content: [{
          type: 'text',
          text: `Calendar "${args.displayName}" has been added to this conversation${args.setAsDefault ? ' and set as default' : ''}.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error adding calendar:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error adding calendar: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to list calendars in conversation
const listConversationCalendarsTool = tool(
  'list_conversation_calendars',
  'List all calendars configured for this conversation.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Calendar] Listing calendars for conversation ${args.conversationId}`);

    try {
      const result = await db
        .select()
        .from(calendars)
        .where(eq(calendars.conversationId, args.conversationId));

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No calendars configured for this conversation. Use add_calendar_to_conversation to add one.',
          }],
        };
      }

      const calendarList = result.map((cal) => {
        const defaultMark = cal.isDefault ? ' (Default)' : '';
        return `• ${cal.displayName}${defaultMark}\n  ID: ${cal.calendarId}\n  UUID: ${cal.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Calendars in this conversation:\n\n${calendarList}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error listing calendars:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error listing calendars: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to set default calendar
const setDefaultCalendarTool = tool(
  'set_default_calendar',
  'Set which calendar should be the default for this conversation.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    calendarUuid: z.string().describe('UUID of the calendar to set as default (from list_conversation_calendars)'),
  },
  async (args) => {
    console.log(`[Calendar] Setting default calendar ${args.calendarUuid} for conversation ${args.conversationId}`);

    try {
      // Unset all defaults first
      await db.update(calendars)
        .set({ isDefault: false })
        .where(eq(calendars.conversationId, args.conversationId));

      // Set the new default
      const result = await db.update(calendars)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(calendars.conversationId, args.conversationId),
            eq(calendars.id, args.calendarUuid)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Calendar not found in this conversation.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Calendar "${result[0].displayName}" is now the default.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error setting default calendar:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error setting default calendar: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to remove calendar from conversation
const removeCalendarTool = tool(
  'remove_calendar_from_conversation',
  'Remove a calendar from this conversation.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    calendarUuid: z.string().describe('UUID of the calendar to remove (from list_conversation_calendars)'),
  },
  async (args) => {
    console.log(`[Calendar] Removing calendar ${args.calendarUuid} from conversation ${args.conversationId}`);

    try {
      const result = await db.delete(calendars)
        .where(
          and(
            eq(calendars.conversationId, args.conversationId),
            eq(calendars.id, args.calendarUuid)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Calendar not found in this conversation.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Calendar "${result[0].displayName}" has been removed from this conversation.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error removing calendar:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error removing calendar: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to list all Google accounts connected to a conversation
const listAccountsTool = tool(
  'list_accounts',
  'List all Google accounts that are connected to this conversation. Shows which account is the default.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
  },
  async (args) => {
    console.log(`[Calendar] Listing accounts for conversation ${args.conversationId}`);

    try {
      const result = await db
        .select()
        .from(accounts)
        .where(eq(accounts.conversationId, args.conversationId));

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No Google accounts connected to this conversation. Use get_calendar_auth_url to connect an account.',
          }],
        };
      }

      const accountList = result.map((acc) => {
        const defaultMark = acc.isDefault ? ' ⭐ (Default)' : '';
        return `• ${acc.displayName}${defaultMark}\n  Email: ${acc.email}\n  Account ID: ${acc.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Connected Google accounts:\n\n${accountList}`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error listing accounts:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error listing accounts: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to set default account
const setDefaultAccountTool = tool(
  'set_default_account',
  'Set which Google account should be the default for this conversation. The default account is used when accountId is not specified in other tools.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().describe('Account ID to set as default (from list_accounts)'),
  },
  async (args) => {
    console.log(`[Calendar] Setting default account ${args.accountId} for conversation ${args.conversationId}`);

    try {
      // Unset all defaults first
      await db.update(accounts)
        .set({ isDefault: false })
        .where(eq(accounts.conversationId, args.conversationId));

      // Set the new default
      const result = await db.update(accounts)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(accounts.conversationId, args.conversationId),
            eq(accounts.id, args.accountId)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Account not found in this conversation.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Account "${result[0].displayName}" (${result[0].email}) is now the default.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error setting default account:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error setting default account: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Tool to remove account
const removeAccountTool = tool(
  'remove_account',
  'Disconnect a Google account from this conversation. This will also remove all associated calendars and authentication tokens.',
  {
    conversationId: z.string().describe('Conversation/chat ID'),
    accountId: z.string().describe('Account ID to remove (from list_accounts)'),
  },
  async (args) => {
    console.log(`[Calendar] Removing account ${args.accountId} from conversation ${args.conversationId}`);

    try {
      const result = await db.delete(accounts)
        .where(
          and(
            eq(accounts.conversationId, args.conversationId),
            eq(accounts.id, args.accountId)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Account not found in this conversation.',
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Account "${result[0].displayName}" (${result[0].email}) has been disconnected from this conversation.`,
        }],
      };
    } catch (error: any) {
      console.error(`[Calendar] Error removing account:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error removing account: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

// Create MCP server with calendar tools
export const calendarServer = createSdkMcpServer({
  name: 'google-calendar-tools',
  version: '1.0.0',
  tools: [
    getCurrentDateTimeTool,
    listCalendarsTool,
    getCalendarEventsTool,
    getAuthUrlTool,
    setAuthTokenTool,
    createCalendarEventTool,
    editCalendarEventTool,
    deleteCalendarEventTool,
    addCalendarTool,
    listConversationCalendarsTool,
    setDefaultCalendarTool,
    removeCalendarTool,
    listAccountsTool,
    setDefaultAccountTool,
    removeAccountTool,
  ],
});

console.log('[Calendar] MCP server created with tools:', calendarServer);
