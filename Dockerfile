# Multi-stage build for production deployment
# Stage 1: Builder - Build the TypeScript application
FROM node:20-bullseye AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm
RUN npm install -g pnpm@latest

# Install dependencies (ignore scripts to skip lefthook install)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN pnpm run build

# Stage 2: Production - Create final runtime image
FROM debian:bullseye-slim

# Install runtime dependencies:
# - Node.js (for running the app)
# - Python3 (for agent tools)
# - curl, wget (for HTTP requests)
# - git (for potential agent needs)
# - build-essential (gcc, g++, make for native modules)
# - ca-certificates (for HTTPS)
# - ffmpeg (for audio processing)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    ca-certificates \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm and Claude Code
RUN npm install -g pnpm@latest && \
    npm install -g @anthropic-ai/claude-code

# Install only production dependencies (ignore scripts to skip lefthook install)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy database migrations
COPY src/db/migrations ./src/db/migrations

# Create a non-root user for security
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app

# Copy Claude Code configuration
COPY --chown=appuser:appuser .claude.json /home/appuser/.claude.json

USER appuser

# Expose port (if needed for health checks)
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Health check (optional - adjust if you add a health endpoint)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "process.exit(0)"

# Start the application
CMD ["node", "dist/index.js"]

