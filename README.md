# Telegram Personal Agent

A Telegram bot powered by Anthropic's Claude API and built with grammY.

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

3. Add your credentials to `.env`:
   - Get your Telegram bot token from [@BotFather](https://t.me/botfather)
   - Get your Anthropic API key from [Anthropic Console](https://console.anthropic.com/)

## Development

Run in development mode with auto-reload:
```bash
pnpm dev
```

## Build & Run

Build the project:
```bash
pnpm build
```

Run the built version:
```bash
pnpm start
```

## Usage

### Basic Usage

1. Start a chat with your bot on Telegram
2. Send any message and the bot will respond using Claude Agent SDK
3. In groups, mention the bot with `@botname` or reply to its messages

### Commands

- `/reset` - Clear conversation history and start a new session

### Features

- **Conversation Memory**: The bot maintains conversation history per chat using Claude Agent SDK sessions
- **Multi-turn Reasoning**: Agent can use up to 5 turns to reason through complex queries
- **Tool Usage**: Agent can use tools like WebSearch, Read, Grep (but not Bash/Write/Edit for safety)
- **Group Support**: Works in groups when mentioned or replied to
