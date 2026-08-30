# Dialy

Personal AI operator — presence that acts, not a chatbot dashboard.

**Start here:** [`DIALY.md`](DIALY.md) (product + done) · [`PLAN.md`](PLAN.md) (what we’ll do) · [`STRATEGY.md`](STRATEGY.md) (why).  
Architecture: [`BRAIN.md`](BRAIN.md). Brain runbook: [`brain/README.md`](brain/README.md).

1. **Operator loop** — wake on events, act, idle; escalate only when needed  
2. **Multi-app efficiency** — one turn, many apps, without dumping hundreds of tool schemas  
3. **Knowledge graph** — email/calendar/… → markdown with backlinks  
4. **Voice later** — `brain/src/voice/voice.ts` (BYOK ElevenLabs + Deepgram)  

Validation face now = **webapp** (not store apps yet). `apps/x` Electron is **test/reference only → delete later**.

## Layout

```
DIALY.md                 Product + gates + what is done
PLAN.md                  Forward plan + persona scenarios
STRATEGY.md              Why / moat / competitive thesis
brain/                   Agent (package name @x/core)
  src/                   Turn loop, Composio, knowledge engine, channels, voice
  src/host/              Headless Dialy boot + HTTP
  api/                   HTTP stub (prefer npm run start)
apps/x/                  Electron — TEMP test/reference UI (delete later)
  packages/shared/
  apps/renderer/
  apps/main/
google-setup.md
BRAIN.md
```

## Run (dev UI)

```bash
cd apps/x
pnpm install
npm run deps
npm run dev
```

Then: **Settings → Models** (or edit `~/.dialy/config/models.json`) → **Settings → Connections** / **Mobile channels**.

Headless:

```bash
cd brain && npm run start
# http://<mac-lan-ip>:8787/health
```

Keys live on disk. Full **golden config checklist**: [`brain/README.md`](brain/README.md).

| File | Purpose |
|------|---------|
| `~/.dialy/config/models.json` | LLM providers (v2) |
| `~/.dialy/config/composio.json` | `{ "apiKey": "..." }` |
| `~/.dialy/config/channels.json` | Telegram / WhatsApp bridges |
| Google OAuth | follow `google-setup.md` |
| `~/.dialy/config/elevenlabs.json` | TTS when you add voice |
| `~/.dialy/config/deepgram.json` | STT when you add voice |
| `~/.dialy/config/exa-search.json` | optional web search |

## Hosted brain (Render)

See [`brain/deploy/README.md`](brain/deploy/README.md) and [`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md).

## Voice later

Do **not** wire a cloud voice proxy. Use `brain/src/voice/voice.ts`. Ignore desktop call/PTT until the hardware mic/speaker path exists.
