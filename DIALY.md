# Dialy — Living project trace

**Product name: Dialy** — a **personal AI operator**.  
(“Jarvis” was only an example of the vibe — not the product name.)

**This file is the source of truth for product definition, gates, and what is already done.**  
**Forward plan / scenarios / what we will do next:** [`PLAN.md`](PLAN.md).  
**Why / moat / competitive thesis:** [`STRATEGY.md`](STRATEGY.md).  
After every completed stage (or gate approval), **update this file**. Do not rely on chat memory alone.

Last updated: **2026-08-30** (G7 hosted connectors armed — next G6 webapp)

---

## 1. Product north star

**One-line:** *It doesn't sleep, so you don't have to.*

Dialy is a **personal AI operator** — push-based presence (notices → acts → escalates only when needed), not a pull-based chatbot and not a dashboard.

| Principle | Meaning |
|-----------|---------|
| Thesis | **Operator presence** — you are not babysitting; unsupervised async work |
| Product surface (now) | **Validation webapp** with in-app messaging (accelerator demos / mentors) |
| Product surface (later) | Phone AI OS (iOS/Android); delete Electron |
| Brain location | Dialy-hosted always-on — **not** the user’s Mac |
| Setup | Anti-fragmentation: who you are → few connectors → plug and play (catalog in Settings) |
| Cost | **OS awake, model asleep** — wake on events only |
| Trust | Preview-then-approve; progressive autonomy; explain why; written escalation rules |
| Reliability | Few connectors, one primitive per capability — breadth multiplies failure |

### Lab vs product

| Lab (G0–G4 proven) | Product / validation |
|--------------------|----------------------|
| Brain on this Mac + launchd | Hosted brain (URL anyone can hit) |
| Telegram bot | In-app chat (Telegram = optional side channel) |
| Electron = test/reference → **delete later** | Webapp now → store apps later |

### Explicit non-goals (current)

- Shipping Mac/Electron as the product  
- Generic “AI OS for everyone” head-on vs Instinct/Apple-scale players  
- Merchant registry / UCP land-grab (consume later; see STRATEGY §8)  
- Snap-style Dialy phone number (defer)  
- Expo/store polish before unsupervised proof  
- BYOK Settings theater; third-party cloud/billing  

Full strategy: [`STRATEGY.md`](STRATEGY.md).  
Forward plan + persona scenarios: [`PLAN.md`](PLAN.md).

---

## 2. Foundation (this repo)

**brain** (`brain/`, `@x/core`) + disposable Electron (`apps/x`) → Dialy foundation.

Architecture: [`BRAIN.md`](BRAIN.md) · Agent shortcuts: [`CLAUDE.md`](CLAUDE.md) · Runbook: [`brain/README.md`](brain/README.md) · Deploy: [`brain/deploy/README.md`](brain/deploy/README.md)

**WorkDir:** `~/.dialy` preferred. Override: `DIALY_WORKDIR`. Legacy home dirs still accepted if present.

---

## 3. Operating rules

1. **One gate at a time** → agent tests → manual script → you approve → next.  
2. **Presence proof > UI polish.** Unsupervised / phone/web proof beats dashboards.  
3. Don’t prune connector ecosystem; don’t rebuild removed product UIs.  
4. Don’t polish Electron (delete later).  
5. Update this file + STRATEGY when decisions land.  
6. Park shiny visions (registry, telephony, multi-agent rebuild) until narrow unsupervised loop is real.

---

## 4. Stage board

| Gate | Stage | Status | Proof |
|------|--------|--------|-------|
| G0 | Stabilize lab | **DONE** | Rebuild + slim shell |
| G1 | Headless + LAN health | **DONE** | Phone `/health` |
| G2 | Telegram wake → idle | **DONE** | Reply + `model_idle` |
| G3 | One tool side-effect | **DONE** | File on disk |
| G4 | Hardening | **DONE** | launchd + Telegram idle |
| **G5** | **Operator kernel + hosted brain** | **DONE** | https://dialyone.onrender.com/health `bootOk: true`; scenarios 20/20; operator routes |
| G6 | Validation webapp (in-app chat) | PENDING | Message Dialy; preview-approve UI |
| **G7** | **Live connectors Scene A+B** | **DONE** | Hosted flags render/github/mail/telegram true; Scene A/B smoke pass ([`docs/G7-SMOKE.md`](docs/G7-SMOKE.md)) |
| G8 | Unsupervised stretch | PENDING | Real week after hosted brain live |

### Locked defaults

- Validation face: **webapp chat** (not store apps yet)  
- Brain host: **Render** (always-on; not Mac Wi‑Fi)  
- MVP connectors: **Render + GitHub + Gmail** (+ Calendar optional); Telegram until web chat  
- Messaging feel: normal chat in-app  
- Model: wake only on turn / event; triage cheap, act expensive  

---

## 5. Stage log (append-only)

### G0–G4 — DONE

See prior log entries below for detail. Lab loop proven: headless → Telegram wake/idle → disk side-effect → launchd KeepAlive.

### G0 — Phase 0 Stabilize — DONE

**Goal:** Reliable rebuild; golden config documented; Electron = settings/pairing shell.

**Shipped:** `npm run deps` / typechecks green; golden checklist in `brain/README.md`; slim sidebar.

**Approve:** G0.

---

### G1 — Spike A Headless host — DONE

**Goal:** Brain without Electron; model idle; LAN health.

**You verified:** Phone `http://192.168.31.205:8787/health` on shared Wi‑Fi.

**Lesson:** Phone-as-hotspot ≠ LAN test.

---

### G2 — Spike B Telegram wake — DONE

**You verified:** `@Dialy_thebot` reply; chat `8597127620`; then `model_idle`.

---

### G3 — Spike C Tool side-effect — DONE

**You verified:** WorkDir `g3-proof.txt` = `DIALY-G3-OK`.

---

### G4 — Hardening — DONE

**Shipped:** `com.dialy.brain` launchd; `brain/deploy/README.md`; `npm run stress`.

**You verified:** `/health` + Telegram wake→idle under launchd.

---

### Operator scenario library + harness — DONE

**Shipped:** 20 JSON playbooks in `brain/playbooks/`, one fixture per playbook, `npm run scenarios`, and Vitest coverage for fixture replay.

**Extras beyond PLAN examples:** `invoice-followup` for unpaid invoice follow-up with an approve-gated draft.

---

### G5 — Operator kernel + hosted brain — DONE

**Goal:** Config-driven operator (not hardcoded personas); scenario harness; host routes; always-on hosted brain.

**Shipped:**
- `brain/src/operator/` — signals → match → triage (rules-first) → policy → journal → executor + approvals
- Capability adapters (dormant without env): Render, GitHub, mail/Composio, calendar, notify (console + Telegram)
- 20 example playbooks + `invoice-followup` extra; all green via `cd brain && npm run scenarios`
- Host: seeds playbooks into WorkDir; `POST /v1/operator/signal`, `GET /v1/operator/playbooks`, `GET /v1/operator/approvals`, `POST /v1/operator/approvals/resolve`
- Watchdog: `npm run watchdog` (external to brain)
- **Live:** [https://dialyone.onrender.com](https://dialyone.onrender.com) — `/health` `bootOk: true`, operator playbooks loaded
- Docs: [`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md), [`docs/OPERATOR.md`](docs/OPERATOR.md), [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md)

**Agent verified:** typecheck green; scenarios 20/20 PASS; live `/health` + `/v1/status` + `/v1/operator/playbooks` on cellular/public URL.

**You do next:** paste GitHub / Composio / Telegram onto Render ([`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md) · [`docs/G7-SMOKE.md`](docs/G7-SMOKE.md)), then **G6** webapp.

**Escalation rules v0 (Scene A / B):**
- **A deploy:** `oom` → needs_human + notify; early attempt → minor → approve-gated restart + draft PR
- **B inbox:** important mail → minor → approve-gated `mail.draft`; else escalate/log per playbook policy YAML

---

### G7 — Live connectors Scene A+B — DONE

**Goal:** Hosted operator loop with Render / GitHub / Gmail / Telegram adapters armed.

**Verified on https://dialyone.onrender.com:**
- `flags`: render, github, mail, telegram all **true**
- Scene A minor → approvals; draft_pr dry-run against `dv7453/DialyOne`; restart safely blocked
- Scene A oom → Telegram + console escalate
- Scene B → `mail.draft` approve (`sent: false`)
- Docs: [`docs/G7-SMOKE.md`](docs/G7-SMOKE.md), [`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md)

**Next:** G6 validation webapp.

---

### G6 — Validation webapp — PENDING

In-app chat + preview-approve UI on top of operator HTTP API.

### G7 — Live connectors — PENDING

Activate adapters via Needs-you credentials; no code rewrite expected.

### G8 — Unsupervised stretch — PENDING

≥ several days with hosted brain + watchdog.

---

## 6. Pointers (planning lives elsewhere)

- **What we’re going to do / scenarios / MVP slice / blocking Qs:** [`PLAN.md`](PLAN.md)  
- **Why / threshold / token rules detail:** [`STRATEGY.md`](STRATEGY.md) §12  

Do not duplicate long forward plans here — append **done** work to §5 and flip §4.

---

## 7. Commands cheat sheet

```bash
cd apps/x && npm run deps
cd brain && npm run start          # lab Mac host (includes operator)
cd brain && npm run scenarios      # 20 playbooks offline
cd brain && npm run watchdog       # external health alerter
bash brain/deploy/install-launchd.sh
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/operator/playbooks
# POST signal example:
# curl -s -X POST http://127.0.0.1:8787/v1/operator/signal -H 'content-type: application/json' \
#   -d '{"source":"render","type":"deploy.failed","payload":{"attempt":1}}'
tail -f ~/.dialy/logs/brain.jsonl
```

Docs: [`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md) · [`docs/OPERATOR.md`](docs/OPERATOR.md) · [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md)  
Deploy: [`brain/deploy/README.md`](brain/deploy/README.md)

---

## 8. Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-08 | Operator not dashboard / not Mac app | Presence thesis; phone/web face |
| 2026-08 | Electron = test → delete later | Not product |
| 2026-08 | Validation = webapp first | Accelerator/mentors; no store yet |
| 2026-08 | Chat in the app | Normal messaging UI; Telegram = lab side channel |
| 2026-08 | Minimality / anti-1000-connector funnel | Fragmentation is the setup problem |
| 2026-08 | Snap Dialy ID deferred | Cost/compliance; in-app chat enough |
| 2026-08 | Merchant registry deferred | Platform land-grab; consume protocols later |
| 2026-08-30 | **Merge STRATEGY + DIALY gates** | Unsupervised self-proof + accelerator demo share G5→G8 |
| 2026-08-30 | **Next = G5 hosted brain** | Enables demos *and* real unsupervised runs |
| 2026-08-30 | Trust patterns before connector sprawl | Preview-approve + escalation rules are load-bearing |
| 2026-08-30 | Self as first user | “Would I trust this unsupervised today?” |
| 2026-08-30 | **MVP threshold = 5–8 min tape + you’d use it a week** | Not Series A; presence + escalate + preview-approve |
| 2026-08-30 | **Hero scenes A+B; connectors Render+GitHub+Gmail** | Calendar optional; Docs/Sheets/WhatsApp parked |
| 2026-08-30 | **Host = Render** | Always-on demos; avoid Vercel Hobby API limits for Scene A |
| 2026-08-30 | **PLAN.md = forward plan; DIALY = product + done** | Clear split for planning vs shipped truth |
| 2026-08-30 | **20 persona scenarios noted in PLAN** | Pitch palette; build only MVP scenes A/B/C |
| 2026-08-30 | **All personas via shared primitives + waves** | CEO/founder = first proof; W2–W4 cover the rest |
| 2026-08-30 | **Scenario library is config + fixtures** | Playbook coverage now replays offline with `npm run scenarios` |
| 2026-08-30 | **Approve executed: operator kernel G5** | Playbooks not hardcoded; Needs-you ledger for live APIs |
| 2026-08-30 | **Extra playbook invoice-followup** | Adjacent SMB pain beyond the example 20 |
| 2026-08-30 | **Hosted brain live** | https://dialyone.onrender.com — G5 closed; G6 webapp / G7 creds next |
| 2026-08-30 | **G7 loop smoke** | Capabilities endpoint; Scene A/B on hosted; adapters local-proven; Render env paste remaining for GH/mail/TG |
| 2026-08-30 | **G7 hosted DONE** | All connector env on Render; draft_pr dry-run + Telegram escalate + mail draft pass |
---

## 9. How to update

1. Flip status in **§4**  
2. Append/complete **§5**  
3. Row in **§8** if decision  
4. Strategy “why” → [`STRATEGY.md`](STRATEGY.md); forward plan/scenarios → [`PLAN.md`](PLAN.md)  

Agents: read `DIALY.md` + `PLAN.md` + `STRATEGY.md` at session start for Dialy work.
