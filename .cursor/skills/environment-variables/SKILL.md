---
name: environment-variables
description: Add environment variable
---
# Environment Variables

This is how we add environment variables to the project:

  1. Add to `.env.example`:
      ```bash
      NEW_VARIABLE=value_example
      ```

  2. Add to `apps/web/env.ts`:
      ```typescript
      // For server-only variables
      server: {
        NEW_VARIABLE: z.string(),
      }
      // For client-side variables
      client: {
        NEXT_PUBLIC_NEW_VARIABLE: z.string(),
      }
      experimental__runtimeEnv: {
        NEXT_PUBLIC_NEW_VARIABLE: process.env.NEXT_PUBLIC_NEW_VARIABLE,
      }
      ```

  3. For client-side variables:
      - Must be prefixed with `NEXT_PUBLIC_`
      - Add to both `client` and `experimental__runtimeEnv` sections

  4. Add to `turbo.json` under `globalDependencies`:
      ```json
      {
        "tasks": {
          "build": {
            "env": [
              "NEW_VARIABLE"
            ]
          }
        }
      }
      ```

examples:
  - input: |
      # Adding a server-side API key
      # .env.example
      API_KEY=your_api_key_here

      # env.ts
      server: {
        API_KEY: z.string(),
      }

      # turbo.json
      "build": {
        "env": ["API_KEY"]
      }
    output: "Server-side environment variable properly added"

  - input: |
      # Adding a client-side feature flag
      # .env.example
      NEXT_PUBLIC_FEATURE_ENABLED=false

      # env.ts
      client: {
        NEXT_PUBLIC_FEATURE_ENABLED: z.coerce.boolean().default(false),
      },
      experimental__runtimeEnv: {
        NEXT_PUBLIC_FEATURE_ENABLED: process.env.NEXT_PUBLIC_FEATURE_ENABLED,
      }

      # turbo.json
      "build": {
        "env": ["NEXT_PUBLIC_FEATURE_ENABLED"]
      }
    output: "Client-side environment variable properly added"

## Common `.env` Pitfalls

### 1. Never use shell command substitution for secret values

The `.env.example` uses `$(openssl rand -hex 32)` as a hint for how to generate values. **Do NOT copy this syntax literally into `.env`** — it generates a new random value on every server restart, which:
- Invalidates all user sessions (`AUTH_SECRET`)
- Corrupts encrypted data like OAuth tokens (`EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT`)
- Breaks API key validation (`INTERNAL_API_KEY`, `API_KEY_SALT`)

**Wrong:**
```bash
AUTH_SECRET=$(openssl rand -hex 32)
```

**Correct:**
```bash
# Run once in terminal: openssl rand -hex 32
# Paste the static output:
AUTH_SECRET=abc123...your-fixed-value
```

This applies to: `AUTH_SECRET`, `EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT`, `INTERNAL_API_KEY`, `API_KEY_SALT`, `CRON_SECRET`.

### 2. `NEXT_PUBLIC_BASE_URL` must match your access domain

The auth system uses this as `baseURL` and `trustedOrigins`. If you access the app via `https://webhook.example.com` but this is set to `http://localhost:3000`, OAuth sign-in will fail silently.

### 3. Restart dev server after changing `NEXT_PUBLIC_*` variables

`NEXT_PUBLIC_*` variables are baked in at build time. Changes require restarting `pnpm dev`.

references:
  - apps/web/env.ts
  - apps/web/.env.example
  - turbo.json
