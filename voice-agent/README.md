# Dialy voice agent

Standalone realtime voice worker for Dialy. It speaks Gujarati, Hindi, and Indian English (including Gujarati–English code-mix) over LiveKit Cloud, with Sarvam for STT/TTS. Intelligence stays in the **brain** — this process does not own prompts, tools, or memory.

This directory is **not** part of the `apps/x` pnpm workspace. Install and run with **npm** here so the workspace lockfile is untouched.

## What runs

```
browser / phone
    │  LiveKit Cloud (media + rooms)
    ▼
this worker  ──Sarvam──►  STT (saaras:v3, codemix) / TTS (bulbul:v3, shubh)
    │
    └──POST $BRAIN_URL/v1/chat/stream──►  Dialy brain (SSE text deltas)
```

The worker is self-hosted. It opens an **outbound** WebSocket to `{LIVEKIT_URL}/agent` and needs no inbound port. `dev` is for local iteration; `start` is production (`start` drains jobs on SIGINT — voice calls may need a long grace period; this package sets 5 minutes).

## Setup

```bash
cd voice-agent
cp .env.example .env   # fill in keys
npm install            # already done if you just cloned a lockfile
```

Required env (see `.env.example`):

| Variable | Purpose |
|---|---|
| `LIVEKIT_URL` | Cloud WebSocket URL (`wss://…`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Cloud API credentials |
| `SARVAM_API_KEY` | Sarvam STT/TTS (`api-subscription-key`) |
| `BRAIN_URL` | Brain base URL, no trailing path |
| `BRAIN_TOKEN` | Bearer token for `POST /v1/chat/stream` |

Do **not** set `LIVEKIT_WORKER_TOKEN`.

## Scripts

```bash
npm run typecheck
npm run build
npm run dev          # tsx src/agent.ts dev
npm start            # node dist/agent.js start  (build first)
npm test
npm run token        # tiny HTTP server: POST /token
```

## Starting a call from a browser

1. Run the worker (`dev` or `start`) so it registers with LiveKit Cloud.
2. Run `npm run token`.
3. `POST http://127.0.0.1:7890/token` with:

```json
{
  "room_name": "dialy-call-1",
  "participant_identity": "user-42",
  "language": "gu-IN"
}
```

Response: `{ "server_url", "participant_token", "room_name", "language" }`. The join token includes `roomJoin` plus explicit dispatch of agent `dialy-voice`, and writes the language onto participant attributes (`language` and `user.language`) and room/job metadata.

`language` may also be `hi-IN` or `en-IN`. That single value is the only switch; STT/TTS stay on the same Sarvam models.

## Per-session language

Default: **`gu-IN`**.

Resolved once at job start, after `ctx.connect()` and `waitForParticipant()`, in this order (LiveKit does not specify precedence — this is ours):

1. Remote participant attributes: `language`, then `user.language` (LiveKit docs key), then `languageCode`
2. Room metadata — bare code or JSON `{ "language": "hi-IN" }`
3. Job metadata (explicit dispatch)
4. `gu-IN`

STT: `new sarvam.STT({ languageCode, model: "saaras:v3", mode: "codemix" })`  
TTS: `new sarvam.TTS({ targetLanguageCode, model: "bulbul:v3", speaker: "shubh" })`

`mode` stays `codemix` for all three languages. The Node Sarvam plugin uses Sarvam's legacy WebSocket and sets `interimResults: false` (no true partials). That is an accepted first-cut limitation; do not replace the plugin.

Turn taking is **Silero VAD only**. Gujarati is not in LiveKit's 14-language turn detector (Hindi is; behaviour on unsupported languages is undefined). VAD is loaded in `prewarm` and stashed on `proc.userData`. Node VAD durations are **milliseconds** (`minSpeechDuration: 50`, `minSilenceDuration: 550`, …). Do not copy Python's second-scale numbers.

## Provisional brain SSE protocol

`POST ${BRAIN_URL}/v1/chat/stream`  
`Authorization: Bearer ${BRAIN_TOKEN}`  
Body: `{ "sessionId": "<room name or job id>", "text": "<latest user transcript>" }`

Named events are constants in `src/brain-client.ts` so they are trivial to correct:

| Constant | Assumed event name | Assumed `data` |
|---|---|---|
| `SSE_EVENT_DELTA` | `delta` | `{"text":"…"}` (`delta` / `content` also accepted) |
| `SSE_EVENT_DONE` | `done` | `{}` |
| `SSE_EVENT_ERROR` | `error` | `{"message":"…"}` |

**These names are guessed.** The brain stream is being built in parallel. Reconcile before a live call. Opening `generateReply` (no user speech yet) sends `text: ""`; the brain should treat that as a join/greet. Deltas are forwarded to LiveKit TTS as they arrive — time to first audio is the latency that matters on a phone call.

## Layout

```
src/agent.ts          LiveKit worker (defineAgent + AgentSession)
src/brain-llm.ts      llm.LLM that delegates each turn to BrainClient
src/brain-client.ts   BrainClient + SseBrainClient + FakeBrainClient
src/language.ts       per-session language resolution
src/token.ts          mintAccessToken helper
src/token-server.ts   tiny HTTP server (direct-run only)
```
