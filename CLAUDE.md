# Hardware brain slice — agent context

**Dialy** foundation (personal AI OS for phone). Local agent + Composio + knowledge engine + channels + voice primitives. No hosted third-party cloud API for the agent. Product UIs (Email/Brain/Code/Spaces/etc.) removed. **Electron (`apps/x`) = temporary test / reference UI only — will be deleted**; real product is iOS/Android.

## Read first (mandatory for Dialy work)

**[`DIALY.md`](DIALY.md)** — product + gates + what is done.  
**[`PLAN.md`](PLAN.md)** — what we are going to do (scenarios, sequencing).  
**[`STRATEGY.md`](STRATEGY.md)** — why / moat / competitive (companion).  
**Update `DIALY.md` after every completed stage / gate approval.** Update `PLAN.md` when the forward plan changes.

Also: [`BRAIN.md`](BRAIN.md) (architecture), [`brain/README.md`](brain/README.md) (run / config).

## Commands

```bash
cd apps/x && pnpm install
cd apps/x && npm run deps # shared → @x/core (brain/) → preload
cd apps/x && npm run dev
cd apps/x && npm run typecheck
cd brain && npm run start   # headless host (LAN); prefer over stub api
# always-on: bash brain/deploy/install-launchd.sh  (com.dialy.brain KeepAlive)
cd brain && npm run api     # loopback stub only
```

## Layout

```
DIALY.md             # product + stage log (what is done)
PLAN.md              # forward plan + persona scenarios
STRATEGY.md          # why / moat / competitive (companion)
brain/               # agent (package @x/core)
  src/host/          # headless boot + HTTP
  api/               # stub HTTP
apps/x/packages/shared/
apps/x/apps/renderer/ # TEMP test/reference UI (delete later — not product)
apps/x/apps/main/     # TEMP Electron shell (delete later)
google-setup.md
BRAIN.md
```

## Sidebar (current)

New chat · Chats · Connect Accounts · Settings · Sync Activity

## Do not re-add

- Hosted cloud proxies for `/v1/composio` / `/v1/llm` / `/v1/voice`
- Third-party cloud sign-in, billing, credits
- Composio via Bearer token; always `x-api-key` to `backend.composio.dev`
- Email/Graph/Notes/Code/Spaces product UIs (memory/connector engines stay in brain/)

## Voice later

`brain/src/voice/voice.ts` is BYOK ElevenLabs + Deepgram. Use it; don’t proxy.
