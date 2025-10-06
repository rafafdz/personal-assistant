import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from '../env.js';

const client = postgres(env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

async function main() {
  console.log('⚠️  WARNING: This will drop all tables!');

  // Drop all tables
  await db.execute(sql`DROP SCHEMA public CASCADE;`);
  await db.execute(sql`CREATE SCHEMA public;`);

  console.log('✅ Database reset complete!');
  console.log('Run `pnpm db:generate && pnpm db:migrate` to recreate tables.');

  await client.end();
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
