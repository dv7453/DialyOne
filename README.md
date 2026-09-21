# Dialy

A personal AI assistant I’m building as a side project.

You talk to it in the browser (text or voice). A small **always-on agent** (the “brain”) sits in the background, uses a model you bring, can call tools you connect, and asks you to **approve** before it does anything consequential. The long-term idea is simple: it should work in **English and Indian languages** (Hindi, Gujarati, Hinglish) — not English-only.

**Voice / Indic (soon):** [Sarvam](https://www.sarvam.ai/) will be the primary speech stack for Hindi / Gujarati / Hinglish (speech-to-text and speech-to-speech). That wiring is **not in the repo yet**. Today, in-app voice uses Deepgram (STT) and ElevenLabs (TTS) when you add those keys.

---

## What it does

- **Chat** — one thread in `apps/web`. Message it like a normal assistant.
- **Voice (in-app)** — mic on the same thread: listen → transcribe → reply (and optionally speak back).
- **Share / attach** — drop in an email, PDF, or pasted text so it has the object, not just the instruction.
- **Approvals** — if an action needs you (send mail, restart a service, draft a PR), you get Approve / Deny in the thread.
- **Tools** — optional Composio connectors (Gmail, GitHub, …) plus MCP when you add servers. Empty config = chat only.
- **Always-on host** — the brain process can stay up even if the browser is closed. Model stays idle until a message or event arrives.

It is **not** a hosted ChatGPT wrapper. Keys live on your machine (or your own host). You bring the LLM.

---

## How it works

```text
You (browser)          Brain (Node, always on)           Models / tools
──────────────         ──────────────────────            ─────────────
apps/web  ──HTTP──►    POST /v1/chat                     your LLM
  chat / mic           POST /v1/voice/transcribe         Deepgram (now)
  attach / approve     POST /v1/voice/speak              ElevenLabs (now)
                       operator approvals                Composio / MCP
                                                         Sarvam (soon)
```

1. **Web UI** (`apps/web`) is a thin client: login (optional token), chat, mic, attachments, approval cards.
2. **Brain** (`brain/`) is the agent: sessions, tools, policy, journal. Run it locally or on a small VPS/Render box.
3. **Config** is JSON under `~/.dialy/config/` (or `DIALY_WORKDIR`). Nothing secret belongs in git.

Electron (`apps/x`) exists for local experiments. You don’t need it to try chat.

---

## Requirements

- **Node.js 20+**
- **pnpm** (for `apps/x` workspace + `@x/core` build)
- An **LLM API key** (OpenAI, Anthropic, OpenRouter, …)
- Optional: Composio, Deepgram, ElevenLabs
- Soon: **Sarvam** API keys for Indic STT/TTS

---

## Install

### 1. Clone and build the agent

From the repo root:

```bash
cd apps/x
pnpm install
npm run deps          # shared → brain (@x/core) → preload
```

Confirm `brain/dist/host/main.js` exists after `npm run deps`.

### 2. Model config (required for replies)

Create `~/.dialy/config/models.json`:

```json
{
  "version": 2,
  "providers": {
    "openai": { "flavor": "openai", "apiKey": "sk-..." }
  },
  "assistantModel": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

Other flavors: `anthropic`, `google`, `openrouter`, `ollama`, `openai-compatible`. More detail: [`brain/README.md`](brain/README.md).

### 3. Start the brain

```bash
cd brain
npm run start
```

- Health: [http://127.0.0.1:8787/health](http://127.0.0.1:8787/health)
- Default bind is `0.0.0.0` so a phone on the same Wi‑Fi can hit it. Loopback only: `npm run start:local`.
- Optional lock: `BRAIN_TOKEN=secret` and send `Authorization: Bearer secret` (or paste the token on the web login screen).

### 4. Start the web app

```bash
cd apps/web
npm install
npm run dev
```

Open [http://localhost:5180](http://localhost:5180).

- **Brain URL:** `http://127.0.0.1:8787` (or `http://<your-lan-ip>:8787` from a phone).
- **Access token:** leave blank unless you set `BRAIN_TOKEN`.

Send a message. If the model key is valid, you should get a reply.

---

## Optional config

All files under `~/.dialy/config/` (create the folder if needed):

| File | What it’s for |
|------|----------------|
| `models.json` | **Required** — LLM provider + `assistantModel` |
| `composio.json` | `{ "apiKey": "..." }` for Gmail / GitHub-style tools |
| `deepgram.json` | `{ "apiKey": "..." }` in-app speech-to-text (current) |
| `elevenlabs.json` | `{ "apiKey": "...", "voiceId": "optional" }` in-app TTS (current) |
| `mcp.json` | MCP servers (`mcpServers`) — empty = no extra tools |
| `sarvam.json` | **Coming soon** — Indic STT/TTS (Hindi / Gujarati / Hinglish) |
| `channels.json` | Optional Telegram bridge |

Don’t commit these files. They’re gitignored via WorkDir conventions.

---

## Voice

**Now:** mic in the web app → Deepgram → chat → optional ElevenLabs playback.

**Next:** swap/add **Sarvam** as the Indic voice layer so you can speak Hindi, Gujarati, or Hinglish and hear a matching voice back. English tool calls (mail, GitHub, etc.) stay the same; only the ear/mouth changes.

Until `sarvam.json` is wired, Indic voice is a stated direction, not a working provider in this checkout.

---

## Repo layout

```
apps/web     Browser chat UI (Vite + React)
brain        Agent + HTTP host (`npm run start`)
apps/x       Optional Electron / workspace (build the brain from here)
```

---

## License / keys

Bring your own keys. This is a personal side project — expect sharp edges, incomplete Indic voice, and no hosted “sign in with Dialy” product.
