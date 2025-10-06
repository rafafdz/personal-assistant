#!/bin/bash

# Deploy script for VPS
# This script will be executed on the VPS after files are transferred

set -e  # Exit on error

echo "=========================================="
echo "Starting deployment..."
echo "=========================================="

# Navigate to app directory
cd /home/debian/personal-assistant

# Stop existing containers
echo "Stopping existing containers..."
docker compose -f docker-compose.prod.yml down || true

# Build the application
echo "Building application..."
docker compose -f docker-compose.prod.yml build --no-cache

# Run database migrations
echo "Running database migrations..."
docker compose -f docker-compose.prod.yml run --rm app node dist/db/migrate.js || echo "Migration failed or no migrations to run"

# Start services
echo "Starting services..."
docker compose -f docker-compose.prod.yml up -d

# Check container status
echo "Checking container status..."
docker compose -f docker-compose.prod.yml ps

# Show logs
echo "Recent logs:"
docker compose -f docker-compose.prod.yml logs --tail=50

echo "=========================================="
echo "Deployment completed!"
echo "=========================================="
echo ""
echo "To view logs, run:"
echo "  docker compose -f docker-compose.prod.yml logs -f"
echo ""
echo "To restart services, run:"
echo "  docker compose -f docker-compose.prod.yml restart"
echo ""
echo "To stop services, run:"
echo "  docker compose -f docker-compose.prod.yml down"

