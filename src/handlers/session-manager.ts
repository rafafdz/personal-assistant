import { db } from '../db/client';
import { conversations } from '../db/schema';
import { eq } from 'drizzle-orm';

// Store session IDs per chat (in-memory for now)
// Key: chat_id, Value: session_id
const chatSessions = new Map<number, string>();

export async function getSession(chatId: number): Promise<string | undefined> {
  // Check in-memory cache first
  let existingSession = chatSessions.get(chatId);

  // If not in memory, try to load from database
  if (!existingSession) {
    const conversationRecord = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, chatId.toString()))
      .limit(1);

    if (conversationRecord.length > 0 && conversationRecord[0].sessionId) {
      existingSession = conversationRecord[0].sessionId;
      chatSessions.set(chatId, existingSession); // Cache in memory
      console.log(`[${new Date().toISOString()}] Loaded session from database: ${existingSession}`);
    }
  }

  return existingSession;
}

export async function saveSession(chatId: number, sessionId: string): Promise<void> {
  chatSessions.set(chatId, sessionId);

  // Update or insert conversation with session ID
  await db.insert(conversations).values({
    id: chatId.toString(),
    sessionId: sessionId,
    context: [],
  }).onConflictDoUpdate({
    target: conversations.id,
    set: {
      sessionId: sessionId,
      updatedAt: new Date(),
    },
  });

  console.log(`[${new Date().toISOString()}] Stored session ${sessionId} for chat ${chatId} in database`);
}

export function clearSession(chatId: number): boolean {
  return chatSessions.delete(chatId);
}
