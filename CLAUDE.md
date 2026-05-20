# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

---

## Architecture

Monorepo (pnpm workspaces + Turborepo). Only `apps/web` is in production.

```
apps/web/          # Next.js 16 (App Router) — main application
apps/unsubscriber/ # Fastify + Playwright — automated unsubscribe service
packages/          # Shared libs: tinybird, resend, loops, tsconfig, eslint-config
prisma/            # PostgreSQL schema + migrations (schema at apps/web/prisma/schema.prisma)
```

### apps/web key directories

```
app/
  (app)/[emailAccountId]/   # All authenticated per-account routes
  api/                      # REST endpoints (GET only — mutations use server actions)
utils/
  actions/        # Server actions (mutations via next-safe-action)
  ai/             # AI rule engine, prompts, LLM provider abstraction (Vercel AI SDK)
  gmail/          # Gmail API client wrappers
  middleware.ts   # withError / withAuth / withEmailAccount HOFs
store/            # Jotai atoms + background queues (AI, archive, categorize)
```

### Email processing flow

1. Gmail webhook → `POST /api/google/webhook`
2. Fetch email details via Gmail API
3. `utils/ai/choose-rule` — find matching user rule
4. Execute rule actions (archive, label, reply, forward…) via Gmail API
5. Persist execution log to Postgres via Prisma

### AI personal assistant

Rules are stored in the database (not the prompt file). The prompt file and DB rules have a two-way sync that is intentionally messy — changing the prompt file does **not** directly feed the LLM; it syncs to DB first. The `about` field in Settings is how global style guidance reaches the LLM.

### Authentication

Better Auth (`utils/auth.ts`). API middleware hierarchy:
- `withError` — no auth, error handling only
- `withAuth` — validates session, attaches `req.auth.userId`
- `withEmailAccount` — validates session + email account, attaches `req.auth.{ userId, emailAccountId, email }`

---

## Local CLI Scripts

All scripts run from `apps/web` with:
```bash
cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/<script>.ts
```

| Script | Purpose |
|--------|---------|
| `dailySummary.ts <email> [--hours N]` | AI digest of last N hours of inbox |
| `catchUpHistory.ts` | Replay missed Gmail webhooks after downtime |
| `exportRules.ts <email>` | Export rules to YAML |
| `importRules.ts <email> rules.yaml` | Bulk import/update rules by name |
| `deleteRules.ts <email>` | Delete all rules |

Catch-up history shell wrapper (also supports `--send-summary`):
```bash
./scripts/catch-up-history.sh chou.amen@gmail.com
```

---

## Environment Variables

Add every new env var to three places: `.env.example`, `env.ts` (with Zod validation), and `turbo.json`. Prefix client-side vars with `NEXT_PUBLIC_`.

Key required vars: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT`, `DEFAULT_LLM_PROVIDER`.

---

## New Workspace Packages

When adding a package, also add its `package.json` COPY line to both `docker/Dockerfile.prod` and `docker/Dockerfile.local`.
