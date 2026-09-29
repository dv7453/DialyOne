# Dialy

Dialy is a personal AI operator. It stays on in the background, notices what matters (mail, deploys, calendar, a message you send), and only interrupts when a decision is yours.

Chat is the face. The product is the loop underneath: **signal → triage → policy → approve or act → journal**. Consequential work (send, deploy, pay, draft a PR) waits for a preview. The model does not get to be the policy.

You can type or talk. Speech is ear and mouth only: **ElevenLabs Scribe (STT) → your LLM → Sarvam (TTS)**. Deepgram and ElevenLabs TTS are fallbacks when that stage’s key is missing. Hindi, Gujarati, and Hinglish are first-class on the speak path (`hi-IN`, `gu-IN`, `en-IN`).

Bring your own keys. Nothing secret belongs in git.

---

## What it does

- **Presence.** The brain process stays up when the browser is closed. The model stays idle until a message or an event arrives.
- **Chat.** One thread in `apps/web`. Attach an email, PDF, or pasted text so the turn has the object, not only the instruction.
- **Approvals.** Send, restart, or draft a PR shows up in the thread. Approve or deny. The executor does not skip that gate.
- **Operator playbooks.** Twenty example lives (founder inbox, deploy sentinel, baker orders, school mail, …) as config. Rules decide first; a model runs only when a rule cannot.
- **Connectors.** A curated catalog of **67** Composio toolkits sits behind the approval layer, plus direct adapters for Render, GitHub, mail, and Telegram. Catalog membership is not 67 live OAuth sessions. A toolkit still has to be connected before it runs.
- **Eval.** A scoring harness, not a second agent. It grades task success, hallucination, and latency, and it refuses to let an LLM-as-judge overwrite the number you trust.

---

## Architecture

```text
apps/web (chat, mic, approvals)
        │  HTTP
        ▼
brain host  ── POST /v1/chat          assistant model (you bring it)
            ── POST /v1/voice/transcribe   ElevenLabs Scribe  (Deepgram fallback)
            ── POST /v1/voice/speak         Sarvam TTS         (ElevenLabs fallback)
            ── operator
                 signal → match playbook → triage → policy
                       → auto | approve | escalate | log
                       → capability adapter → journal
```

| Layer | Responsibility |
|-------|----------------|
| Web (`apps/web`) | Login, one thread, mic, attachments, approval cards. No connector marketplace on the home screen. |
| Host (`brain/src/host`) | HTTP, sessions, voice routes, status. Same chat path the Telegram bridge uses. |
| Operator (`brain/src/operator`) | Playbooks, rules-first triage, policy, approvals, journal, trust ramp. |
| Capabilities | Render, GitHub, mail, calendar, notify/Telegram, journal, and `composio.<toolkit>` for all 67 curated slugs. |
| Voice (`brain/src/voice`) | One function per stage. STT and TTS pick a vendor independently. Voice never decides an action. |
| Eval (`brain/src/eval`) | Offline scoring by default. Optional live chat and optional Grok judge when you add keys. |

**Why the split holds up**

- Rules and policy run before the model, so overnight events do not burn tokens on heartbeats.
- Approvals are a typed gate (`auto` / `approve` / `escalate` / `log`), not a prompt instruction the model can talk its way past.
- `composio.*` is classified consequential. Execution still needs an active connected account.
- The eval’s trusted metric is computed from required facts and forbidden claims. A judge that flatters a confident lie is logged as a disagreement; it does not move the score.

Electron (`apps/x`) is a local lab shell. You do not need it to run chat.

---

## Speech, model, speech

Voice is three vendors on purpose. One “voice agent” SKU would couple hearing, thinking, and speaking. Dialy picks a provider **per stage**.

| Stage | Default | Fallback | Role |
|-------|---------|----------|------|
| STT | ElevenLabs Scribe (`scribe_v1`) | Deepgram `nova-3` if ElevenLabs is unset | Transcript only |
| LLM | `assistantModel` in `models.json` | — | Draft, classify, answer. Does not send. |
| TTS | Sarvam `bulbul:v2` | ElevenLabs if Sarvam is unset | Audio only |

Web speech sends a language code with the reply: `gu-IN` for Gujarati UI, `hi-IN` if you add Hindi, otherwise `en-IN`. Sarvam REST chunks long text (~2400 characters) and returns audio the browser plays.

Config (all under `~/.dialy/config/`, or `DIALY_WORKDIR`):

```json
// elevenlabs.json — STT, and TTS only if sarvam.json is absent
{ "apiKey": "...", "voiceId": "optional" }

// sarvam.json — TTS
{ "apiKey": "...", "speaker": "anushka", "languageCode": "en-IN" }

// deepgram.json — STT only if ElevenLabs is absent
{ "apiKey": "..." }
```

Env equivalents: `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`, `DEEPGRAM_API_KEY`.

`GET /v1/status` reports `voice.stages` (the intended pipeline) and `voice.active` (what keys actually armed).

---

## LLM

The assistant model is yours. `models.json` accepts `openai`, `anthropic`, `google`, `openrouter`, `ollama`, and `openai-compatible`. There is no hosted Dialy model proxy in this repo.

Operator triage prefers deterministic rules. The model is a later step, and only for the turn that needs language: a draft, a brief, a chat reply.

The eval judge is a **separate** call. Default CI uses a scripted judge with no network. A Grok transport (`api.x.ai`, `XAI_API_KEY` or `GROK_API_KEY`) exists for when you want a real grader. It is off unless you pass `--judge grok`.

---

## Eval harness and LLM-as-judge

`brain/src/eval` runs N text tasks and writes one number a team can argue about.

**Axes**

| Axis | How it is scored |
|------|------------------|
| Task success | Every required fact is in the reply. Empty replies fail. |
| Hallucination | Any forbidden claim appears (for example “I sent”, “I signed”, “I restarted”). Negation (“not signed”, “nothing about DNS”) does not count as the claim. |
| Latency | Wall time of the agent call. The trusted metric also requires it under the suite budget (8s). |

**Trusted metric: `successAtLatency`**

Share of tasks that are fact-complete, not hallucinated, and inside the latency budget. Programmatic. The judge cannot override it.

**Judge, and where judges fail**

An optional judge returns JSON: `taskSuccess`, `hallucinated`, `rationale`, `confidence`. Bad JSON fails closed (treated as unusable, not as a pass). The harness records `judgeDisagreed` when the judge and the facts diverge.

Failure modes called out in code (`JUDGE_FAILURE_MODES`):

- sycophancy — “I sent it” sounds finished, so the judge says success
- verbosity bias — longer prose scores higher than a short correct answer
- invalid JSON — fences, prose, missing fields
- uncalibrated confidence — 0.95 while contradicting required facts
- self-preference — a model grading its own family
- position bias — avoided here by grading one reply at a time, not a pair

The suite includes a deliberately bad judge (`sycophantic`) so tests prove disagreement shows up and the trusted metric stays at zero.

```bash
cd brain
npm run eval                  # 16 tasks, good fixture agent
npm run eval -- --agent bad   # same tasks, replies that invent actions
npm run eval -- --compare     # bad → good, per-task regressions
npm run eval -- --voice       # 20 utterances, STT and TTS bakeoff (stubs, no spend)
npm run eval -- --judge grok  # optional; needs XAI_API_KEY or GROK_API_KEY
npm run eval -- --live http://127.0.0.1:8787   # optional; needs a running brain + model key
```

Reports land in `brain/eval-out/` (gitignored).

Operator scenarios are a different harness: playbook match, triage class, and action list, offline, no model.

```bash
cd brain && npm run scenarios
```

---

## How this was checked

The numbers below are the automated gate. They are not the only check, and they are not a substitute for using the product.

I ran Dialy myself. I talked to the live model, then read the reply against what it had actually retrieved — the mail, the log line, the calendar fact, the number in front of it — instead of trusting a confident paragraph. If retrieval did not contain a send, a restart, a signature, or a meeting, and the model still claimed one, that was a miss. I did the same pass on the operator path: a signal comes in, the playbook picks an action, and the consequential step waits for approval instead of disappearing into the model. The harness exists so that bar cannot go green in CI while the behavior I already rejected by hand sneaks back in.

The 16/16 figure is the fixture suite. The thing I am willing to stand behind is the running system I reviewed: model output, retrieval, and the approval gate, not a table by itself.

## Benchmarks

The table is what CI asserts, with **no paid APIs**. The rows are fixture agents (known-good and known-bad replies), not a leaderboard for one hosted model. I used them to lock the scoring rules after the manual review above, so a later prompt or model change has something to regress against.

**Text eval** (`npm run eval`, scripted judge, latency budget 8000 ms)

| Run | successAtLatency | Task success | Hallucination | p50 latency | Judge vs facts |
|-----|------------------|--------------|---------------|-------------|----------------|
| Good fixture agent | **1.000 (16/16)** | 1.000 | 0.000 | 15 ms | 0 disagreements |
| Bad fixture agent | **0.000 (0/16)** | 0.000 | 1.000 | 12 ms | 0 disagreements |
| Compare bad → good | **delta +1.000** | 16 improved, 0 regressed | | | |

Tasks cover investor drafts, OOM deploys, calendar holds, newsletters, supplier delay, school forms, scope creep, flaky CI, Hinglish and Gujarati briefs, empty nights, exact seat counts, refusing to sign a SAFE, invented citations, invoice send, and identity. A correct reply must not claim it already sent, signed, restarted, or paid.

**Voice bakeoff** (`npm run eval -- --voice`, 20 utterances)

These figures come from **deterministic stubs** keyed off utterance length and language. They are labeled estimates so a clone never calls ElevenLabs, Deepgram, or Sarvam. Do not quote them as live vendor invoices.

| Stage | Provider | p50 latency | Estimated cost (this set) | Mean quality |
|-------|----------|-------------|---------------------------|--------------|
| STT | ElevenLabs Scribe | 292 ms | ~$0.00512 | 1.000 |
| STT | Deepgram | 224 ms | ~$0.00367 | 0.948 |
| TTS | Sarvam | 168 ms | ~$0.0142 | 0.860 |
| TTS | ElevenLabs | 367 ms | ~$0.1278 | 0.870 |

Reading that table the way the harness does: Deepgram is cheaper and a bit faster on English-shaped audio; the stub drops tokens on Hindi and Gujarati, which is why Scribe stays the product STT. Sarvam is the cheaper mouth and the Indic default; ElevenLabs TTS is the fallback, not the primary speak path. Plug real audio into `runStt` / `runTts` when you have keys if you need wall-clock.

---

## Run it

**Requirements:** Node.js 20+, pnpm (workspace build), an LLM key only if you want live chat.

### Build

```bash
cd apps/x
pnpm install
npm run deps
```

`brain/dist/host/main.js` should exist afterward. Eval and scenarios also build from `brain/`:

```bash
cd brain
npm install
npm test
npm run eval
```

### Brain

```bash
cd brain
npm run start
```

- Health: http://127.0.0.1:8787/health
- Status (no secrets): http://127.0.0.1:8787/v1/status
- Connectors: http://127.0.0.1:8787/v1/connectors
- Loopback only: `npm run start:local`
- Optional lock: `BRAIN_TOKEN=secret` and `Authorization: Bearer secret`

### Web

```bash
cd apps/web
npm install
npm run dev
```

Open http://localhost:5180. Brain URL `http://127.0.0.1:8787`. Leave the token blank unless you set `BRAIN_TOKEN`.

### Model config

`~/.dialy/config/models.json`:

```json
{
  "version": 2,
  "providers": {
    "openai": { "flavor": "openai", "apiKey": "sk-..." }
  },
  "assistantModel": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

### Other config

| File | Purpose |
|------|---------|
| `composio.json` | `{ "apiKey": "..." }` — catalog available; each toolkit still needs OAuth |
| `elevenlabs.json` | STT (Scribe); TTS fallback |
| `sarvam.json` | TTS |
| `deepgram.json` | STT fallback |
| `channels.json` | Optional Telegram |
| `mcp.json` | Optional MCP servers; empty means none |

---

## HTTP surface (the parts you will actually hit)

| Method | Path | What you get |
|--------|------|----------------|
| GET | `/health` | Process is up |
| GET | `/v1/status` | Idle/wake, playbook count, adapter flags, voice pipeline, which config files exist |
| GET | `/v1/connectors` | 67-toolkit catalog vs connected accounts vs direct Render / GitHub / Mail / Telegram |
| POST | `/v1/chat` | One turn. Reply text, or an approval / ask-human pause |
| POST | `/v1/chat/answer` | Continue after a question |
| POST | `/v1/voice/transcribe` | `{ audioBase64 }` → `{ transcript }` |
| POST | `/v1/voice/speak` | `{ text, languageCode? }` → `{ audioBase64, mimeType }` |
| POST | `/v1/operator/signal` | Inject an operator event |
| GET | `/v1/operator/approvals` | Pending previews |
| POST | `/v1/operator/approvals/resolve` | Approve or deny |

---

## Layout

```text
apps/web          Browser client
brain             Agent, HTTP host, operator, voice, eval
  src/eval        Scoring harness and fixtures
  src/operator    Playbooks, policy, approvals, adapters
  src/voice       Per-stage STT / TTS
  playbooks       Example operator configs
apps/x            Optional Electron workspace used to build @x/core
```

---

## What this repository will not do for you

It will not spend money, send mail, or restart a service without credentials you add and an approval the policy requires. Missing keys make a capability dormant; they do not crash the host. The eval suite is the path that stays green with zero API keys.
