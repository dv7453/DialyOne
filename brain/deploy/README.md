# Dialy headless host — deploy runbook

**OS awake, model asleep.** Electron is optional (pairing/settings only). The always-on process is `brain/dist/host/main.js`.

WorkDir: `~/.dialy` (or `DIALY_WORKDIR`). Logs: `$WORKDIR/logs/brain.jsonl`.

---

## 1. Build once

```bash
cd apps/x && npm run deps
# or: pnpm --filter @x/core build
```

Confirm: `brain/dist/host/main.js` exists.

---

## 1.5. Render hosting (G5)

Blueprint: `brain/deploy/render.yaml`.

Render should run from the repository root because `brain/package.json` depends on workspace package `@x/shared` from `apps/x/packages/shared`.

Native Node build/start (Render — no `corepack enable`, filesystem is read-only for /usr/bin):

```bash
cd apps/harbor/packages/protocol && npm install && npm run build
cd apps/x && npx pnpm@9.15.9 install --no-frozen-lockfile && npm run shared && npx pnpm@9.15.9 --filter @x/core build
cd brain && BRAIN_HOST=0.0.0.0 BRAIN_PORT=${PORT:-8787} node dist/host/main.js
```

Docker option: `brain/deploy/Dockerfile` also assumes the Docker build context is the repository root:

```bash
docker build -f brain/deploy/Dockerfile .
```

Render still needs your account and secrets. See `docs/NEEDS-YOU.md`.

---

## 2. Manual start (dev)

Quit Electron first so Telegram polling isn’t dual-owned.

```bash
cd brain
npm run start          # BRAIN_HOST defaults to 0.0.0.0 (LAN)
# npm run start:local  # 127.0.0.1 only
```

Checks:

```bash
curl -s http://127.0.0.1:8787/health | jq .
curl -s http://127.0.0.1:8787/v1/status | jq '{bootOk, model_idle, lastInboundChannel, services}'
```

Phone (same Wi‑Fi as Mac — **not** phone-as-hotspot):

`http://<mac-lan-ip>:8787/health`

Optional auth:

```bash
BRAIN_TOKEN=secret npm run start
curl -H "Authorization: Bearer secret" http://127.0.0.1:8787/health
```

---

## 3. launchd KeepAlive (G4 — preferred on this Mac)

Installs `~/Library/LaunchAgents/com.dialy.brain.plist`, frees `:8787` if needed, loads with **KeepAlive**.

```bash
bash brain/deploy/install-launchd.sh
```

Uses absolute `$(which node)` (nvm-safe). Stdout/stderr → `$WORKDIR/logs/brain.launchd.{out,err}.log`.

| Action | Command |
|--------|---------|
| Status | `launchctl print gui/$(id -u)/com.dialy.brain \| head` |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.dialy.brain` |
| Unload | `launchctl bootout gui/$(id -u)/com.dialy.brain` |
| Health | `curl -s http://127.0.0.1:8787/health` |

Legacy launch agents (if any) are unloaded by the install script. Prefer Dialy’s install script over hand-editing old plists.

---

## 4. Prevent sleep while proving overnight

```bash
caffeinate -dims &
# or: System Settings → Battery → prevent sleep on power adapter
```

Lid-close still often sleeps the Mac — leave lid open on power, or move host later.

---

## 5. Telegram

Config: `$WORKDIR/config/channels.json` — `telegram.enabled`, bot token, `allowFrom` chat ids.

With host up (`model_idle: true`):

1. Message `@Dialy_thebot` from an allowlisted chat  
2. Expect a reply on the phone  
3. `curl -s http://127.0.0.1:8787/v1/status | jq '{model_idle, lastInboundChannel, lastWakeAt, lastIdleAt}'`  
   → `model_idle: true`, `lastInboundChannel: "telegram"`

Channel commands: `help`, `status`, `stop`, `new`, `list`, `model`.

---

## 6. Light stress (G4)

**Stop the host / unload launchd first** (same WorkDir must not be dual-owned):

```bash
launchctl bootout gui/$(id -u)/com.dialy.brain 2>/dev/null || true
lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true

cd brain && npm run build && npm run stress
# defaults: 20× help (no LLM) + 3× short model pings
# STRESS_HELP=20 STRESS_PINGS=5 npm run stress
```

Then restore:

```bash
bash brain/deploy/install-launchd.sh
```

Optional phone stress: send ~10–20 short Telegram pings; confirm replies and final `model_idle: true`.

---

## 7. Logs / troubleshooting

| Symptom | Check |
|---------|--------|
| Health down | `tail -f $WORKDIR/logs/brain.launchd.err.log` and `brain.jsonl` |
| Port in use | `lsof -iTCP:8787 -sTCP:LISTEN` — quit Electron / old `npm run start` |
| Telegram silent | Electron also polling? Unload duplicate host. Check `allowFrom`. `status` → channels |
| Phone can’t hit LAN | Same Wi‑Fi; not phone hotspot. `ipconfig getifaddr en0` |
| Model errors | `$WORKDIR/config/models.json` — OpenRouter key + `assistantModel` |
| launchd flapping | `ThrottleInterval` 10s; check node path in plist |

---

## 8. Template only

`launchd/com.dialy.brain.plist.template` — filled by `install-launchd.sh`.
