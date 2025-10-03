import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

async function testAgent(prompt: string) {
  console.log('\n' + '='.repeat(80));
  console.log(`Testing prompt: "${prompt}"`);
  console.log('='.repeat(80) + '\n');

  try {
    const agentQuery = query({
      prompt,
      options: {
        maxTurns: 5,
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Bash', 'Write', 'Edit'],
      },
    });

    let responseText = '';
    let toolUses: string[] = [];

    for await (const message of agentQuery) {
      // Log message type for debugging
      console.log(`[Message Type: ${message.type}]`);

      if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage;

        // Extract text and tool uses
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          } else if (block.type === 'tool_use') {
            toolUses.push(`${block.name}(${JSON.stringify(block.input)})`);
            console.log(`[Tool Use: ${block.name}]`);
          }
        }
      } else if (message.type === 'result') {
        console.log(`[Result Message]`);
      }
    }

    console.log('\n--- Response ---');
    console.log(responseText || '(No text response)');

    if (toolUses.length > 0) {
      console.log('\n--- Tools Used ---');
      toolUses.forEach(tool => console.log(`  - ${tool}`));
    }

    console.log('\n' + '='.repeat(80) + '\n');
    return responseText;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}

async function main() {
  console.log('Starting Agent SDK Tests...\n');

  // Test 1: Simple query
  await testAgent('What is 2 + 2? Just give me the answer.');

  // Test 2: Web search capability (if enabled)
  await testAgent('What is the current weather in San Francisco? Use web search if available.');

  // Test 3: Multi-turn reasoning
  await testAgent('Explain the concept of recursion with a simple example.');

  // Test 4: Complex reasoning
  await testAgent('If I have 3 apples and I buy 2 more bags with 5 apples each, how many apples do I have in total? Show your work.');

  console.log('All tests completed!');
}

main().catch(console.error);
