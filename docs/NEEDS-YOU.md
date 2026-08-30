# Dialy Needs-You Ledger

This is the short list of things only you can provide. The code is prepared to run without these values; live capabilities stay dormant or alert through the fallback path until credentials exist.

## Hosting

- [x] Render web service live: **https://dialyone.onrender.com**
  - Health: https://dialyone.onrender.com/health (`bootOk: true`)
  - **Build command:** `cd apps/x && npx pnpm@9.15.9 install --no-frozen-lockfile && npx pnpm@9.15.9 --filter @x/spaces-protocol build && npm run shared && npx pnpm@9.15.9 --filter @x/core build`
  - **Start command:** `cd brain && BRAIN_HOST=0.0.0.0 BRAIN_PORT=$PORT node dist/host/main.js`
  - Do **not** use `corepack enable` on Render (EROFS / read-only `/usr/bin`).
- `RENDER_API_KEY` for the watchdog/provider checks.
- `RENDER_SERVICE_ID` for the watchdog to inspect the deployed service.
- Public `HEALTH_URL` = `https://dialyone.onrender.com/health` (set this in env where the watchdog runs).
- Optional `BRAIN_TOKEN` if the hosted HTTP routes should require `Authorization: Bearer <token>`.

## GitHub

- `GITHUB_TOKEN` with access to the allowlisted repo.
- `GITHUB_REPO` in `owner/name` form.
- Confirm the repo Dialy may inspect and draft PRs against.

## Composio / Gmail

- `COMPOSIO_API_KEY`.
- Connect Gmail in Composio.
- Confirm whether Dialy should use your real Gmail account or a demo account first.
- Calendar is optional for this phase, but it will need Google Calendar access later.

## Notifications

- `TELEGRAM_BOT_TOKEN`.
- `TELEGRAM_NOTIFY_CHAT_ID`.
- Optional `WATCHDOG_ALERT_FILE` if the watchdog should append alerts to a file instead of Telegram or console.

## Already Done Without These

- Headless brain host with `/health` and `/v1/status`.
- Operator playbook boot and seed from `brain/playbooks`.
- Operator HTTP routes for signal ingestion, playbook listing, and pending approvals.
- External watchdog process with health polling and alert fallback.
- Render blueprint and Dockerfile for the monorepo build shape.
- Local lab path with launchd remains available.
- **Hosted service:** https://dialyone.onrender.com (`bootOk: true`, playbooks loaded).
