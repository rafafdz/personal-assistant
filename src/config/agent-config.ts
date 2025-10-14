import { calendarServer } from '../tools/calendar';
import { mapsServer } from '../tools/maps';
import { reminderServer } from '../tools/reminders';
import { spotifyServer } from '../tools/spotify';
import { getSystemPrompt } from '../prompts/system-prompt';

/**
 * Shared MCP servers configuration
 */
export const getMCPServers = () => ({
  'google-calendar-tools': calendarServer,
  'google-maps-tools': mapsServer,
  'reminder-tools': reminderServer,
  'spotify': spotifyServer,
});

/**
 * Shared agent configuration options
 */
export interface AgentConfigOptions {
  /** Additional instructions to append to the system prompt */
  additionalInstructions?: string;
  /** Whether to include partial messages in streaming */
  includePartialMessages?: boolean;
  /** Maximum number of turns the agent can take */
  maxTurns?: number;
  /** Conversation/chat ID for this session */
  conversationId?: string;
}

/**
 * Get agent configuration with optional customizations
 */
export function getAgentConfig(options: AgentConfigOptions = {}) {
  const {
    additionalInstructions,
    includePartialMessages = true,
    maxTurns = 100,
    conversationId,
  } = options;

  // Get base system prompt
  let systemPrompt = getSystemPrompt();

  // Add conversation ID context if provided
  if (conversationId) {
    systemPrompt = `${systemPrompt}\n\nCONVERSATION CONTEXT:
You are currently in conversation ID: ${conversationId}

IMPORTANT: When using tools that require a conversationId parameter (like create_reminder, list_reminders, etc.), you MUST use this exact conversation ID: ${conversationId}`;
  }

  // Append additional instructions if provided
  if (additionalInstructions) {
    systemPrompt = `${systemPrompt}\n\n${additionalInstructions}`;
  }

  return {
    model: 'claude-sonnet-4-5' as const,
    maxTurns,
    permissionMode: 'bypassPermissions' as const,
    includePartialMessages,
    mcpServers: getMCPServers(),
    systemPrompt,
  };
}
