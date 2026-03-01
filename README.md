# inbox-zero (personal fork)

Forked from [elie222/inbox-zero](https://github.com/elie222/inbox-zero). The web app processes emails automatically via Gmail webhooks, but these CLI scripts fill gaps that the web app doesn't cover — running directly against the database and Gmail API with no server required.

All scripts use the same prefix:
```bash
cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/<script>.ts
```

---

## Daily Digest

**Why:** The web app processes emails as they arrive but gives no daily overview. This script fetches the last 24 hours of non-marketing inbox emails, AI-summarizes each one, and delivers an HTML digest from your Gmail to yourself — useful for catching up without opening your inbox.

```bash
# 24h digest
scripts/dailySummary.ts chou.amen@gmail.com

# Custom time window
scripts/dailySummary.ts chou.amen@gmail.com --hours 48
```

---

## Gmail History Catch-Up

**Why:** Gmail webhooks are only delivered while the server is running. After downtime, those notifications are lost and emails go unprocessed. This script replays missed webhook history so the AI rules still run on emails that arrived while the server was down. History IDs expire after ~1 week.

```bash
# Catch up missed webhooks
./scripts/catch-up-history.sh chou.amen@gmail.com

# Catch up + send daily digest in one command
./scripts/catch-up-history.sh chou.amen@gmail.com --send-summary
```

---

## Rules

**Why:** The web UI lets you create and edit rules one at a time. These scripts let you export rules to YAML for version control and bulk editing, then import them back — useful for backup, migration, or making large changes outside the UI.

```bash
# Export rules to YAML
scripts/exportRules.ts chou.amen@gmail.com

# Import rules from YAML (creates new, updates existing by name)
scripts/importRules.ts chou.amen@gmail.com rules.yaml

# Delete all rules
scripts/deleteRules.ts chou.amen@gmail.com
```

Rules can also be managed in the UI: **Settings → Assistant → Import / Export Rules**
