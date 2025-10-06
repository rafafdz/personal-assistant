import dotenv from 'dotenv';

dotenv.config();

const isDevelopment = process.env.NODE_ENV !== 'production';

// Default DATABASE_URL for local development with docker-compose
const DEFAULT_DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/telegram_agent';

export const env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  DATABASE_URL: process.env.DATABASE_URL || (isDevelopment ? DEFAULT_DEV_DATABASE_URL : ''),
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
} as const;

// Validate required environment variables
if (!env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production');
}
