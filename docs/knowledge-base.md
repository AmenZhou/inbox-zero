# Knowledge Base

The Knowledge Base lets you teach the AI facts about yourself, your business, or your preferences. When the AI drafts a reply, it automatically pulls in relevant entries to produce more accurate, personalised responses.

## What it's for

Store anything the AI wouldn't otherwise know:

- Company policies (refund policy, SLA, support hours)
- Standard answers to common questions ("Our API rate limit is 1,000 req/min")
- Your preferences ("Always sign off with Best regards, Haiming")
- Product or pricing details
- Instructions for specific scenarios ("If someone asks about X, always mention Y")

## How to add entries

### Via the UI

**Settings → Assistant → Knowledge Base → Add**

Each entry has:
- **Title** — a short label, e.g. `Refund Policy`
- **Content** — free text or markdown, e.g. `We offer full refunds within 30 days of purchase.`

### Via the AI Assistant chat

Tell the assistant to remember something directly:

> *"Remember that our API rate limit is 1,000 requests per minute"*

It will save a new knowledge entry automatically.

## How it works in the AI pipeline

When the AI drafts a reply, the following happens:

1. All your knowledge entries are fetched from the database
2. `aiExtractRelevantKnowledge` uses an LLM to select only the entries relevant to the incoming email
3. The relevant excerpt is injected into the `aiDraftReply` prompt as additional context

This call is **skipped entirely if your knowledge base is empty** — no LLM cost if there's nothing to extract from.

## Limits

| Plan | Max entries | Max characters per entry |
|---|---|---|
| Free / Basic | 1 | 2,000 |
| Plus and above | Unlimited | Unlimited |

### Self-hosted: bypass all limits

Add the following to your `.env` file to remove all premium checks:

```
NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true
```

This grants full access to unlimited entries and unlimited content length.

## Related

- [AI Processing Pipeline](ai-processing.md) — how the knowledge base fits into the full multi-step AI flow
