# Inbox Zero — Architecture

## Overview

Inbox Zero is an open-source AI-powered email management platform. It automates inbox organization through user-defined rules, AI classification, bulk operations, and integrations with Gmail and Outlook.

## Monorepo Layout

```
inbox-zero/
├── apps/
│   ├── web/                 # Main Next.js application
│   └── unsubscriber/        # Fastify service for automated unsubscribing
├── packages/
│   ├── cli/                 # Setup CLI tool
│   ├── loops/               # Loops email marketing integration
│   ├── resend/              # Resend transactional email
│   ├── slack/               # Slack integration
│   ├── tinybird/            # Real-time analytics
│   ├── tinybird-ai-analytics/ # AI usage analytics
│   └── tsconfig/            # Shared TypeScript config
├── docker/                  # Dockerfiles (prod + local)
├── sanity/                  # Sanity CMS (blog/content)
├── qa/browser-flows/        # Playwright QA flows
└── docs/                    # Documentation
```

Managed with **pnpm workspaces** and **Turborepo**.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS + shadcn/ui (Radix) |
| State | Jotai (client), SWR (data fetching) |
| Forms | React Hook Form + Zod |
| Auth | Better Auth (OAuth: Google, Microsoft) |
| Database | PostgreSQL 16 via Prisma 7 |
| Cache/Queue | Upstash Redis + QStash |
| AI | Vercel AI SDK (multi-provider) |
| Payments | Lemon Squeezy (primary), Stripe |
| Analytics | Tinybird, PostHog, Sentry |
| Testing | Vitest, Playwright |
| Linting | Biome |

## Application Structure (`apps/web`)

```
apps/web/
├── app/
│   ├── (app)/                   # Authenticated routes
│   │   ├── [emailAccountId]/    # Per-account views (inbox, rules, stats, etc.)
│   │   ├── admin/               # Admin dashboard
│   │   ├── settings/            # User settings
│   │   ├── premium/             # Billing/subscription
│   │   └── organization/        # Multi-org management
│   ├── (landing)/               # Public pages (login, onboarding, pricing)
│   ├── (marketing)/             # Marketing/SEO pages
│   └── api/                     # API routes
├── components/                  # Shared React components
├── hooks/                       # Custom React hooks
├── providers/                   # Context providers
├── store/                       # Jotai atoms (client-side queues)
├── utils/                       # Server actions, AI logic, helpers
│   ├── actions/                 # Server actions (next-safe-action)
│   ├── ai/                      # AI/LLM logic (rules, chat, classification)
│   ├── gmail/                   # Gmail API client
│   ├── outlook/                 # Outlook/Graph API client
│   └── ...
├── prisma/                      # Schema + migrations
└── env.ts                       # Environment variable validation (t3-env)
```

## Key API Route Groups

| Route | Purpose |
|-------|---------|
| `/api/auth/[...all]` | Better Auth (OAuth, sessions) |
| `/api/google/webhook` | Gmail push notification handler |
| `/api/outlook/webhook` | Outlook webhook handler |
| `/api/ai/*` | AI operations (summarize, categorize, compose) |
| `/api/chat/*` | AI chat interface |
| `/api/user/rules` | Rule CRUD |
| `/api/user/stats/*` | Email analytics |
| `/api/clean/*` | Bulk archive/cleanup |
| `/api/unsubscribe/*` | Unsubscription management |
| `/api/cron/*` | Scheduled tasks |
| `/api/stripe/*`, `/api/lemon-squeezy/*` | Payment webhooks |
| `/api/slack/*` | Slack OAuth and events |
| `/api/v1/*` | Versioned external API (OpenAPI) |

API route middleware: `withError` (public), `withAuth` (user-level), `withEmailAccount` (account-level).

Mutations use **server actions** (`next-safe-action`), not POST API routes.

## Database Schema (Prisma)

### Core Models

```
User ──< Account ──< EmailAccount
  │
  ├──< Rule ──< Action
  │      └──< ExecutedRule ──< ExecutedAction
  │
  ├──< Group ──< GroupItem
  ├──< Category
  ├──< Newsletter
  │
  ├──< EmailMessage
  ├──< ThreadTracker          (reply/follow-up tracking)
  ├──< CleanupJob ──< CleanupThread
  │
  ├──< Chat ──< ChatMessage
  │     └──< ChatMemory
  ├──< Knowledge
  │
  ├──< CalendarConnection ──< Calendar
  ├──< DriveConnection ──< FilingFolder ──< DocumentFiling
  ├──< MessagingChannel       (Slack)
  ├──< McpConnection ──< McpTool
  │
  ├──< Premium ──< Payment
  └──< Referral

Organization ──< Member ──< User
             ──< Invitation
```

OAuth tokens are stored encrypted (`EMAIL_ENCRYPT_SECRET` + `EMAIL_ENCRYPT_SALT`).

## Authentication

- **Better Auth** with Google and Microsoft OAuth providers
- Sessions stored in the database with 30-day expiration
- Cookie-based session tokens (`__Secure-better-auth.session_token`)
- Multi-account: one `User` can link multiple `EmailAccount` records (Gmail + Outlook)
- SSO support for organizations

## Email Processing Flow

```
┌─────────────┐    webhook     ┌──────────────┐
│ Gmail /      │──────────────>│ Webhook       │
│ Outlook      │               │ Handler       │
└─────────────┘               └──────┬───────┘
                                      │
                                      v
                              ┌──────────────┐
                              │ Fetch Full    │
                              │ Email         │
                              └──────┬───────┘
                                      │
                                      v
                              ┌──────────────┐
                              │ Parse &       │
                              │ Store         │
                              │ (EmailMessage)│
                              └──────┬───────┘
                                      │
                                      v
                              ┌──────────────┐
                              │ Rule Engine   │
                              │ (static +     │
                              │  AI matching) │
                              └──────┬───────┘
                                      │
                                      v
                              ┌──────────────┐
                              │ Execute       │
                              │ Actions       │
                              │ (archive,     │
                              │  label, reply,│
                              │  draft, etc.) │
                              └──────┬───────┘
                                      │
                                      v
                              ┌──────────────┐
                              │ Record in     │
                              │ ExecutedRule / │
                              │ ExecutedAction│
                              └──────────────┘
```

### Rule Types

- **Static**: regex patterns on from/to/subject/body with AND/OR logic
- **AI-based**: natural language conditions evaluated by LLM
- **Group-based**: sender groups with inclusion/exclusion patterns

### Available Actions

Archive, Label, Reply, Draft, Forward, Send Email, Mark Spam, Mark Read, Call Webhook

## AI Architecture

### Multi-Provider Support (via Vercel AI SDK)

| Provider | Use Case |
|----------|----------|
| Anthropic (Claude) | Primary reasoning |
| Google (Gemini) | Alternative provider |
| OpenAI (GPT) | Alternative provider |
| AWS Bedrock | Enterprise deployments |
| Groq | Fast inference |
| OpenRouter | Multi-model routing |
| Perplexity | Web-aware queries |
| Ollama | Self-hosted/local models |

Configured via `DEFAULT_LLM_PROVIDER` / `DEFAULT_LLM_MODEL` env vars. Separate model tiers:
- **Default**: primary rule evaluation and AI tasks
- **Economy**: cheaper model for basic classification
- **Chat**: fast model for conversational AI

### AI Features

- **Rule Matching**: LLM evaluates whether an email matches a natural-language rule condition
- **Email Categorization**: classify senders into user-defined categories
- **Chat Assistant**: conversational interface for inbox management (with tool calling)
- **Compose Autocomplete**: AI-assisted email drafting
- **Meeting Briefs**: summarize relevant emails before calendar events
- **Cold Email Detection**: identify unsolicited outreach
- **MCP Integration**: extensible tool framework via Model Context Protocol

## Background Jobs

### Client-Side Queues (Jotai atoms in `store/`)

- `ai-queue` — AI analysis tasks
- `archive-queue` — email archiving
- `archive-sender-queue` — bulk sender archiving
- `ai-categorize-sender-queue` — sender categorization
- `sender-queue` — sender operations
- `mark-read-sender-queue` — mark-as-read operations

### Server-Side Cron Jobs

| Endpoint | Interval | Purpose |
|----------|----------|---------|
| `/api/cron/scheduled-actions` | 60s | Execute delayed actions |
| `/api/follow-up-reminders` | 30min | Send follow-up reminders |
| `/api/resend/digest/all` | 30min | Compile and send digest emails |
| `/api/meeting-briefs` | 15min | Generate meeting briefings |
| `/api/watch/all` | 6h | Renew email watch subscriptions |

In Docker, a dedicated `cron` service calls these endpoints via HTTP, authenticated with `CRON_SECRET`. In serverless environments, **Upstash QStash** handles scheduling.

## Infrastructure (Docker Compose)

```
┌──────────┐     ┌──────────┐     ┌──────────────────┐
│ PostgreSQL│     │  Redis   │     │ Serverless Redis  │
│   :5432   │     │  :6380   │     │ HTTP :8079        │
└─────┬────┘     └────┬─────┘     └────────┬─────────┘
      │               │                     │
      └───────┬───────┘─────────────────────┘
              │
        ┌─────┴─────┐         ┌──────────┐
        │  Web App   │         │  Cron    │
        │   :3000    │         │ Service  │
        └────────────┘         └──────────┘
```

- **PostgreSQL 16**: primary data store
- **Redis 7**: caching and rate limiting
- **Serverless Redis HTTP**: HTTP wrapper for Redis (local dev)
- **Web**: Next.js standalone build (Node 22 Alpine)
- **Cron**: Alpine container running scheduled HTTP calls

Production images use multi-stage builds for minimal size.

## Payment & Billing

- **Lemon Squeezy**: primary payment processor (SaaS-focused)
- **Stripe**: secondary option
- Subscription model with tiered access
- Seat-based organization licensing
- Credit system for AI usage and unsubscribe operations

## Observability

- **Sentry**: error tracking and performance monitoring
- **Tinybird**: real-time email analytics and AI token usage
- **PostHog**: product analytics and feature flags
- **Axiom**: log aggregation
- **Vercel Analytics**: web performance

## Key Conventions

- Path aliases: `@/` for imports from `apps/web/`
- Server actions for mutations, SWR for data fetching
- Zod schemas for validation (`utils/actions/*.validation.ts`)
- `LoadingContent` component for async data states
- Helper functions at the bottom of files
- Co-located test files (e.g., `utils/example.test.ts`)
- Env vars validated at build time via `env.ts` (t3-env)
