# Google Cloud Setup Guide for Inbox Zero

## Prerequisites

- A Google Cloud account
- `gcloud` CLI installed (optional, for automated setup)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click **Select a project** → **New Project**
3. Name it (e.g., `inbox-zero`) and click **Create**
4. Note your **Project ID** (e.g., `my-gmail-app-487419`)

## Step 2: Enable Required APIs

Go to **APIs & Services** → **Library** and enable:

1. **Gmail API**
2. **People API** (Contacts)
3. **Google Calendar API**
4. **Google Drive API**
5. **Cloud Pub/Sub API**

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Select **External** user type
3. Fill in:
   - **App name**: e.g., `Inbox Zero`
   - **User support email**: your email
   - **Developer contact email**: your email
4. Add the following **scopes**:
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
   - `https://www.googleapis.com/auth/contacts` (optional)
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive.file`
5. Under **Test users**, add the Gmail addresses you'll use for testing
6. Save

> **Note:** While the app is in "Testing" mode, only listed test users can sign in.

## Step 4: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Select **Web application**
4. Set **Authorized JavaScript origins**:
   ```
   http://localhost:3000
   https://your-domain.com
   ```
5. Set **Authorized redirect URIs** — all 8 are required:

   **For localhost development:**
   ```
   http://localhost:3000/api/auth/callback/google
   http://localhost:3000/api/google/linking/callback
   http://localhost:3000/api/google/calendar/callback
   http://localhost:3000/api/google/drive/callback
   ```

   **For your public domain (e.g., Cloudflare Tunnel):**
   ```
   https://your-domain.com/api/auth/callback/google
   https://your-domain.com/api/google/linking/callback
   https://your-domain.com/api/google/calendar/callback
   https://your-domain.com/api/google/drive/callback
   ```

   Each URI serves a different purpose:
   | URI Path | Purpose |
   |----------|---------|
   | `/api/auth/callback/google` | Main sign-in |
   | `/api/google/linking/callback` | Linking additional Gmail accounts |
   | `/api/google/calendar/callback` | Connecting Google Calendar |
   | `/api/google/drive/callback` | Connecting Google Drive |

   > **Important:** If any URI is missing, that feature will fail with a redirect mismatch error.

6. Click **Create** and note the **Client ID** and **Client Secret**

## Step 5: Set Up Google Cloud Pub/Sub

Pub/Sub enables real-time Gmail push notifications.

### 5a: Create a Topic

1. Go to [Pub/Sub Topics](https://console.cloud.google.com/cloudpubsub/topic/list)
2. Click **Create Topic**
3. Name it (e.g., `inbox-zero-emails`)
4. Note the full topic path: `projects/YOUR_PROJECT_ID/topics/inbox-zero-emails`

### 5b: Grant Gmail Permission to Publish

1. On your topic, go to the **Permissions** tab
2. Click **Add Principal**
3. Add: `gmail-api-push@system.gserviceaccount.com`
4. Assign role: **Pub/Sub Publisher** (`roles/pubsub.publisher`)
5. Save

### 5c: Create a Push Subscription

1. Go to [Pub/Sub Subscriptions](https://console.cloud.google.com/cloudpubsub/subscription/list)
2. Click **Create Subscription**
3. Configure:
   - **Subscription ID**: e.g., `inbox-zero-subscription`
   - **Cloud Pub/Sub topic**: select the topic you created
   - **Delivery type**: **Push**
   - **Endpoint URL**: `https://your-domain.com/api/google/webhook`
4. Leave other settings as default
5. Click **Create**

> **Note:** For local development, use a tunnel (Cloudflare Tunnel or ngrok) to expose your localhost with a public URL.

## Step 6: Update Environment Variables

Add the following to `apps/web/.env`:

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Google Pub/Sub
GOOGLE_PUBSUB_TOPIC_NAME=projects/YOUR_PROJECT_ID/topics/inbox-zero-emails
GOOGLE_PUBSUB_VERIFICATION_TOKEN=  # Generate with: openssl rand -hex 32

# Base URL — MUST match the domain you access the app from
NEXT_PUBLIC_BASE_URL=https://your-domain.com

# Auth secret — MUST be a fixed value, not a dynamic command
# Generate once with: openssl rand -hex 32
AUTH_SECRET=your-generated-hex-value
```

### Common `.env` Pitfalls

1. **`NEXT_PUBLIC_BASE_URL` must match your access domain.**
   The auth system uses this as `baseURL` and `trustedOrigins`. If you access the app via `https://webhook.example.com` but this is set to `http://localhost:3000`, OAuth sign-in will fail silently with "sign in error" on the login page.

2. **`AUTH_SECRET` must be a fixed value.**
   Do NOT use `$(openssl rand -hex 32)` — this generates a new secret on every server restart, which invalidates all sessions and breaks the OAuth callback flow. Generate a value once and paste it in:
   ```bash
   openssl rand -hex 32
   # Copy the output and set it as AUTH_SECRET
   ```

3. **Restart the dev server after changing `NEXT_PUBLIC_*` variables.**
   These are baked in at build time. Changes won't take effect until you restart `pnpm dev`.

## Step 7: Verify Setup

1. Start the dev server: `pnpm dev`
2. Start your tunnel (if using one for local dev)
3. Visit your app URL and sign in with Google
4. Test the webhook:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/api/google/webhook
   ```
   A `405` response means the endpoint is reachable.

## Cloudflare Tunnel Setup (Optional, for Local Development)

If you need a permanent public URL for local development:

```bash
# Install
brew install cloudflared

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create inbox-zero

# Route DNS (domain must be on Cloudflare)
cloudflared tunnel route dns inbox-zero webhook.yourdomain.com

# Create config at ~/.cloudflared/config.yml
tunnel: YOUR_TUNNEL_ID
credentials-file: ~/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: webhook.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404

# Run the tunnel
cloudflared tunnel run inbox-zero
```

## Troubleshooting

| Error | Solution |
|-------|----------|
| `access_denied` / "not approved by Advanced Protection" | Use a Google account without Advanced Protection, or unenroll |
| `403: access_denied` / "not completed Google verification" | Add your email as a test user in OAuth consent screen |
| OAuth redirect mismatch | Ensure all redirect URIs are added in Credentials settings |
| Webhook not receiving events | Verify Pub/Sub subscription push endpoint URL and tunnel is running |
| `invalid_grant` on token refresh | User may have revoked access — reconnect the account |
| "Sign in with Google error" on login page | Check that `NEXT_PUBLIC_BASE_URL` matches your access domain, and `AUTH_SECRET` is a fixed value (not a dynamic command). Restart dev server after changes. |
| `please_restart_the_process` / "State mismatch: auth state cookie not found" | See **OAuth State Cookie Mismatch** section below. |

### OAuth State Cookie Mismatch

**Symptom:** After signing in with Google, you're redirected to `/login/error?error=please_restart_the_process`. Server logs show:
```
[auth]: Failed to parse state
  "State mismatch: auth state cookie not found"
```

**Root cause:** The OAuth flow stores a state cookie before redirecting to Google. When Google redirects back, the server looks for this cookie. If the cookie domain doesn't match, the cookie is missing and the flow fails.

This typically happens when `NEXT_PUBLIC_BASE_URL` doesn't match the domain you're accessing the app from. For example:
- You access the app via `https://webhook.example.com` (Cloudflare Tunnel)
- But `NEXT_PUBLIC_BASE_URL` is still set to `http://localhost:3000`
- The auth client (`utils/auth-client.ts`) uses `NEXT_PUBLIC_BASE_URL` as its `baseURL`, which controls where cookies are set and where OAuth callbacks redirect

**Fix:**

1. Set `NEXT_PUBLIC_BASE_URL` to match your access domain:
   ```bash
   NEXT_PUBLIC_BASE_URL=https://webhook.example.com
   ```

2. **Fully restart `pnpm dev`** — this is critical because `NEXT_PUBLIC_*` variables are compiled into the client JavaScript bundle at build time. A page refresh is NOT enough.

3. **Clear browser cookies** for your domain before retrying — stale cookies from previous failed attempts can interfere.

4. Make sure the Google OAuth redirect URI matches the same domain:
   ```
   https://webhook.example.com/api/auth/callback/google
   ```
