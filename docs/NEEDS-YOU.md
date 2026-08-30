# Dialy Needs-You Ledger

This is the short list of things only you can provide. The code is prepared to run without these values; live capabilities stay dormant or alert through the fallback path until credentials exist.

**Never paste secrets into chat or git.** Put them only in Render → dialyone → Environment, then redeploy.

## Hosting

- [x] Render web service live: **https://dialyone.onrender.com**
  - Health: https://dialyone.onrender.com/health (`bootOk: true`)
  - **Build command:** `cd apps/x && npx pnpm@9.15.9 install --no-frozen-lockfile && npx pnpm@9.15.9 --filter @x/spaces-protocol build && npm run shared && npx pnpm@9.15.9 --filter @x/core build`
  - **Start command:** `cd brain && BRAIN_HOST=0.0.0.0 BRAIN_PORT=$PORT node dist/host/main.js`
  - Do **not** use `corepack enable` on Render (EROFS / read-only `/usr/bin`).
- [x] `RENDER_API_KEY` / `RENDER_SERVICE_ID` / `HEALTH_URL` set on the Render service env.
- [x] Uptime monitor on `https://dialyone.onrender.com/health` (HEAD+GET both 200).
- Optional `BRAIN_TOKEN` if the hosted HTTP routes should require `Authorization: Bearer <token>`.

## GitHub (Scene A draft PR)

- [ ] Hosted `flags.github` true (paste env below, redeploy)
1. GitHub → Settings → Developer settings → Personal access tokens.
2. Classic: enable `repo`. Fine-grained: Contents + Pull requests on `dv7453/DialyOne`.
3. On Render env set:
   - `GITHUB_TOKEN` = the PAT (or `gh auth token`)
   - `GITHUB_REPO` = `dv7453/DialyOne`
4. Redeploy. Confirm: `curl -s https://dialyone.onrender.com/v1/operator/capabilities | jq .flags`

Smoke approve of `code.draft_pr` is **dry-run by default** (no real PR). Local dry-run already proven.

## Composio / Gmail (Scene B draft)

- [ ] Hosted `flags.mail` true
1. Composio dashboard → API key (or copy from local `~/.rowboat/config/composio.json`).
2. Connect **Gmail** for your entity/user (use your real Gmail for this first pass).
3. On Render env set: `COMPOSIO_API_KEY` = that key.
4. Redeploy. `mail.draft` approve returns a draft payload (`sent: false`); live Composio send stays disabled.

## Notifications (Scene A oom escalate)

- [ ] Hosted `flags.telegram` true
1. BotFather → token for `@Dialy_thebot` (local `channels.json` already has a working token).
2. Chat id: first `allowFrom` entry, or message the bot then `getUpdates`.
3. On Render env set:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_NOTIFY_CHAT_ID`
4. Redeploy. OOM deploy signals should DM you via Telegram (local escalate already delivered).

## Already Done Without These

- Headless brain host with `/health` and `/v1/status`.
- Operator playbook boot and seed from `brain/playbooks`.
- Operator HTTP routes for signal ingestion, playbook listing, and pending approvals.
- External watchdog process with health polling and alert fallback.
- Render blueprint and Dockerfile for the monorepo build shape.
- Local lab path with launchd remains available.
- **Hosted service:** https://dialyone.onrender.com (`bootOk: true`, playbooks loaded).
