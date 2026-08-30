# How the brain works (multi-app + graph)

Read this before adding a voice or hardware layer.

The agent lives in **`brain/`** (npm package `@x/core`). Electron in `apps/x` is one client of that package.

## 1. One inference, many apps (the efficiency trick)

The model is **not** given 500 Gmail/Slack/GitHub tools.

Always-on tools are tiny (`COPILOT_BASE_TOOLS` in `brain/src/runtime/assembly/copilot/base-tools.ts`): files, search, `loadSkill`, spawn-agent, etc.

Third-party apps go through **four meta-tools** (`brain/src/runtime/tools/domains/composio.ts`):

| Tool | Job |
|------|-----|
| `composio-list-toolkits` | What can I connect? |
| `composio-search-tools` | “send email” → slug + JSON schema |
| `composio-execute-tool` | Run that slug |
| `composio-connect-toolkit` | OAuth in the browser |

Playbook: `brain/src/runtime/assembly/skills/composio-integration/skill.ts`

`loadSkill` attaches extra tools **mid-turn**. One user message can search Gmail, then GitHub, then send something. Independent work: several `spawn-agent` calls in one model response.

Turn loop (model → tools → model → …): `brain/docs/turn-runtime-design.md`

Composio HTTP is always `https://backend.composio.dev/api/v3` with `x-api-key`. No Rowboat proxy.

Native Gmail (this app’s inbox UI + graph ingest) still wins over Composio Gmail when Google is connected locally.

## 2. Knowledge graph

`brain/src/knowledge/`

1. `sync_gmail.ts` / calendar / slack → markdown dumps
2. `build_graph.ts` — LLM extracts people/orgs/projects into `knowledge/` notes
3. `graph_state.ts` — skip unchanged files (mtime + hash)
4. UI: **Brain** (`graph-view.tsx`, `knowledge-view.tsx`) and **Email** (`email-view.tsx`)

Notes are plain Markdown on disk (`~/.rowboat/…`). That is the memory you would ship on device.

## 3. Connection frontend

- Settings → Connections → Primary accounts = Gmail/Outlook/Slack/… (`connected-accounts-settings.tsx`)
- Settings → Connections → App library = Composio toolkits (`ToolsLibrarySettings` in `settings-dialog.tsx`)
- Sidebar **Connect Accounts** opens the same dialog

Google: your OAuth client (`google-setup.md`). Not Rowboat’s cloud client.

## 4. Adding voice (hardware)

Keep STT/TTS **local keys**:

- `brain/src/voice/voice.ts` — ElevenLabs TTS, Deepgram ASR
- Same agent turn loop; voice is just another I/O skin on chat

Do not reintroduce `api.x.rowboatlabs.com`.

## 5. Headless API (web / Expo / device)

`brain/api/server.ts` is a loopback HTTP stub (`npm run api` in `brain/`). `/health` and `/v1/status` work; chat/graph/connections return 501 until you call the turn runtime from that process instead of Electron IPC.

## Leftover code (not in the sidebar)

The Electron app still contains Code mode, Spaces, billing, video-call, and mini-apps **source** so the IPC contract compiles. The sidebar no longer links to them. Do not study those folders for the hardware product. Study `brain/src/runtime/`, `brain/src/composio/`, `brain/src/knowledge/`, and the connection UI instead.
