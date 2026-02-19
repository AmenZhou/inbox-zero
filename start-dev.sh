#!/bin/bash

# Start Cloudflare Tunnel and Next.js dev server together
# Usage: ./start-dev.sh

cleanup() {
  echo "Shutting down..."
  kill $TUNNEL_PID $DEV_PID 2>/dev/null
  wait $TUNNEL_PID $DEV_PID 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting Cloudflare Tunnel..."
cloudflared tunnel run inbox-zero &
TUNNEL_PID=$!

echo "Starting Next.js dev server..."
pnpm dev &
DEV_PID=$!

echo ""
echo "Cloudflare Tunnel PID: $TUNNEL_PID"
echo "Dev server PID: $DEV_PID"
echo "Public URL: https://webhook.zhouhaimeng.com"
echo "Local URL: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both services"

wait
