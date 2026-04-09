---
name: start-dev
description: Start the local dev server and Cloudflare tunnel together
user_invocable: true
---
# Start Dev Environment

Starts both the Next.js dev server and Cloudflare tunnel together.

## How to Run

```bash
# Kill any existing dev server first, then start both
pkill -f "next dev" 2>/dev/null; sleep 2 && ./start-dev.sh
```

Or if nothing is running:

```bash
./start-dev.sh
```

## What It Does

- Starts `cloudflared tunnel run inbox-zero` (Cloudflare Tunnel)
- Starts `pnpm dev` (Next.js on port 3000)
- Both run together; Ctrl+C stops both

## URLs

- **Local:** http://localhost:3000
- **Public:** https://webhook.zhouhaimeng.com

## Key File

- `start-dev.sh` (project root)

## Common Issue

If `next dev` fails with "Unable to acquire lock", a previous dev server is still running. Kill it first:

```bash
pkill -f "next dev"
```
