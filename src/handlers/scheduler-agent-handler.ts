import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { getAgentConfig } from '../config/agent-config';
import { isSessionLimitError, getSessionLimitMessage, handleSessionLimitError } from '../utils/agent-error-handler';

interface SchedulerAgentHandlerOptions {
  conversationId: string;
  prompt: string;
  existingSession?: string;
}

interface SchedulerAgentHandlerResult {
  responseText: string | null;
  sessionId?: string | null;
}

/**
 * Process message with AI agent for scheduled reminders
 * This is a simplified version of handleAgentQuery that doesn't require Grammy Context
 */
export async function handleSchedulerAgentQuery(options: SchedulerAgentHandlerOptions): Promise<SchedulerAgentHandlerResult> {
  const { conversationId, prompt, existingSession } = options;

  console.log(`[Scheduler] Processing message with agent for conversation ${conversationId}`);
  console.log(`[Scheduler] Prompt: "${prompt}"`);

  if (existingSession) {
    console.log(`[Scheduler] Using existing session ID: ${existingSession}`);
  } else {
    console.log(`[Scheduler] No existing session ID found, will create new session`);
  }

  try {
    const schedulerInstructions = `SCHEDULER CONTEXT:
This is an automated reminder that was scheduled by the user. Process the request and provide a clear, concise response.

IMPORTANT: Keep responses concise and focused. This is a scheduled reminder, so get straight to the point.`;

    // Call Claude Agent SDK with shared configuration
    const agentQuery = query({
      prompt,
      options: {
        ...getAgentConfig({
          additionalInstructions: schedulerInstructions,
          includePartialMessages: false, // No streaming for scheduler
          maxTurns: 50, // Fewer turns for scheduler
        }),
        resume: existingSession ?? undefined,
      },
    });

    let responseText = '';
    let newSessionId: string | undefined;
    let sessionLimitReached = false;

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

      // Check for session limit error
      if (message.type === 'result' && isSessionLimitError(message)) {
        const errorMessage = getSessionLimitMessage(message);
        console.log(`[Scheduler] Session limit error detected: ${errorMessage}`);
        await handleSessionLimitError(null, errorMessage, conversationId);
        sessionLimitReached = true;
        break;
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

    // If session limit was reached, return null
    if (sessionLimitReached) {
      return { responseText: null, sessionId: newSessionId };
    }

    const trimmedResponse = responseText.trim();

    if (!trimmedResponse) {
      console.warn(`[Scheduler] Agent returned empty response for conversation ${conversationId}`);
      return { responseText: null, sessionId: newSessionId };
    }

    console.log(`[Scheduler] Agent response length: ${trimmedResponse.length} characters`);
    console.log(`[Scheduler] Agent response preview: "${trimmedResponse.substring(0, 200)}..."`);

    return {
      responseText: trimmedResponse,
      sessionId: newSessionId,
    };
  } catch (error: any) {
    console.error(`[Scheduler] Error processing message with agent for conversation ${conversationId}`);
    console.error(`[Scheduler] Error details:`, {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });

    return { responseText: null };
  }
}
