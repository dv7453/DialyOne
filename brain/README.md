# Brain

The agent: turn loop, Composio meta-tools, knowledge graph, Gmail sync, BYOK models/voice.

Package name stays `@x/core` so the Electron app (`apps/x`) can import it without rewriting IPC.

```
brain/
  src/           Agent (was apps/x/packages/core)
  api/           HTTP stub for web / Expo / hardware
  docs/          Turn + session design
apps/x/          Desktop client of this package
```

## Build (from the Electron workspace)

```bash
cd apps/x
pnpm install
npm run deps          # shared → @x/core → preload
npm run typecheck     # or: apps/main tsc + apps/renderer typecheck
cd ../brain && npm run typecheck:api
```

## HTTP stub (no agent boot)

```bash
cd brain && npm run api
# GET http://127.0.0.1:8787/health
```

## Headless host (Spike A — OS awake, model idle)

```bash
cd apps/x && npm run deps
cd ../../brain
npm run start   # binds 0.0.0.0 by default; prints phone URL(s)
```

Quit Electron. Phone on same Wi‑Fi: open `http://<mac-lan-ip>:8787/health`.  
Optional: `BRAIN_TOKEN=secret` + header `Authorization: Bearer secret`.  
Logs: `~/.rowboat/logs/brain.jsonl`. launchd / caffeinate: [`deploy/README.md`](deploy/README.md).

`GET /v1/status` → `model_idle`, `lastInboundChannel`, `lastTurnId`, services, LAN IPs (never secrets).

## Telegram wake (Spike B)

1. **One-time setup (Electron OK):** Settings → Models (add provider + assistant model). Settings / Mobile channels → enable Telegram, paste BotFather token. Or edit `~/.rowboat/config/channels.json` (host watches the file and reloads).
2. Quit Electron. Keep `npm run start` running.
3. Phone Telegram → your bot: `ping` or a short question.
4. Expect a reply on Telegram; then `/v1/status` should show `model_idle: true` again with `lastInboundChannel: "telegram"`.

Empty `allowFrom` accepts first chats and tells you the chat id to lock later.

## Golden config checklist (`~/.rowboat/config/`)

WorkDir is always `~/.rowboat`. Edit via **Electron → Settings / Connect Accounts**, or write JSON by hand. Do not commit these files.

| File | Required for | Check |
|------|----------------|-------|
| `models.json` | Any LLM turn (chat / Spike B+) | `version: 2`, at least one entry in `providers`, and `assistantModel` set |
| `composio.json` | Toolkits / Spike C | `{ "apiKey": "..." }` → `backend.composio.dev` with `x-api-key` |
| `channels.json` | Telegram (Spike B) | `telegram.enabled: true`, non-empty `botToken`, optional `allowFrom` chat ids |
| OAuth / Google | Gmail sync later | Follow repo `google-setup.md`; not needed for Phase 0 / Spike A |
| `elevenlabs.json` | STT (Scribe) | `{ "apiKey": "..." }` |
| `sarvam.json` | TTS | `{ "apiKey": "...", "languageCode": "en-IN" }` |
| `deepgram.json` | STT fallback | Skip unless ElevenLabs is unset |
| `exa-search.json` | Optional web search | Skip unless testing search |

### `models.json` shape (v2)

```json
{
  "version": 2,
  "providers": {
    "openai": { "flavor": "openai", "apiKey": "sk-..." }
  },
  "assistantModel": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

Flavors: `openai` | `anthropic` | `google` | `openrouter` | `ollama` | `openai-compatible` | …

### `channels.json` (Telegram first)

```json
{
  "whatsapp": { "enabled": false, "allowFrom": [] },
  "telegram": {
    "enabled": true,
    "botToken": "<from @BotFather>",
    "allowFrom": []
  }
}
```

First message from an unknown chat tells you the chat id; add it to `allowFrom` to lock the bridge.

### This machine (Phase 0 snapshot)

Run anytime (no secrets printed):

```bash
python3 - <<'PY'
import json
from pathlib import Path
c = Path.home() / ".rowboat" / "config"
m = json.loads((c / "models.json").read_text())
ch = json.loads((c / "channels.json").read_text())
co = json.loads((c / "composio.json").read_text())
print("providers:", list((m.get("providers") or {}).keys()))
print("assistantModel:", bool(m.get("assistantModel")))
print("composio key:", bool(co.get("apiKey")))
tg = (ch.get("telegram") or {})
print("telegram enabled:", tg.get("enabled"), "hasToken:", bool(tg.get("botToken")))
PY
```

**Expected before Spike B:** ≥1 provider + `assistantModel` + Telegram token enabled.  
**Phase 0 exit does not require Telegram or a model** — only a reproducible rebuild and a documented checklist.

## Electron role (frozen for 0→1)

Sidebar: **New chat · Chats · Connect Accounts · Settings · Sync Activity**.  
Use the app only to set models, Composio, OAuth, and channel tokens. Do not rebuild product dashboards here.

## Do not

Re-add `https://api.x.rowboatlabs.com`. Composio is `backend.composio.dev` + `x-api-key`. Voice is local ElevenLabs + Deepgram keys.
