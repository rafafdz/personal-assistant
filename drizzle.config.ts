import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config();

const isDevelopment = process.env.NODE_ENV !== 'production';
const DEFAULT_DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/telegram_agent';
const DATABASE_URL = process.env.DATABASE_URL || (isDevelopment ? DEFAULT_DEV_DATABASE_URL : '');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
