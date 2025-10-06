import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { google } from 'googleapis';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';

// Store user tokens (in production, use a database)
const userTokens = new Map<number, any>();

// Initialize OAuth2 client
const getOAuth2Client = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // e.g., http://localhost:3000/oauth/callback
  );
};

// Get calendar client with user's OAuth token
const getCalendarClient = (userId: number) => {
  const oauth2Client = getOAuth2Client();
  const tokens = userTokens.get(userId);

  if (!tokens) {
    throw new Error('User not authenticated. Please authenticate first with /auth command');
  }

  oauth2Client.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth: oauth2Client });
};

// Generate OAuth URL (you'd expose this via a /auth command in the bot)
export const generateAuthUrl = (userId: number) => {
  const oauth2Client = getOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    state: userId.toString(), // Pass user ID to link token to user
  });
};

// Exchange code for tokens (called from OAuth callback endpoint)
export const handleOAuthCallback = async (code: string, userId: number) => {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  userTokens.set(userId, tokens);

  return tokens;
};

// Custom tool to get calendar events (OAuth version)
const getCalendarEventsTool = tool(
  'get_calendar_events',
  'Get events from user\'s Google Calendar within a date range',
  {
    startDate: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
    endDate: z.string().describe('End date in ISO format (YYYY-MM-DD)'),
    userId: z.number().describe('Telegram user ID'),
    calendarId: z.string().default('primary').describe('Calendar ID (default: primary)'),
  },
  async (args) => {
    try {
      const calendar = getCalendarClient(args.userId);

      const startDateTime = new Date(args.startDate).toISOString();
      const endDateTime = new Date(args.endDate + 'T23:59:59').toISOString();

      const response = await calendar.events.list({
        calendarId: args.calendarId,
        timeMin: startDateTime,
        timeMax: endDateTime,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];

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
      if (error.message.includes('not authenticated')) {
        return {
          content: [{
            type: 'text',
            text: `Please authenticate with Google Calendar first. Use /auth command to get started.`,
          }],
          isError: true,
        };
      }

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

export const calendarOAuthServer = createSdkMcpServer({
  name: 'google-calendar-oauth-tools',
  version: '1.0.0',
  tools: [getCalendarEventsTool],
});
