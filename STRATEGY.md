# Dialy — Product & Strategy Reference

Companion to [`DIALY.md`](DIALY.md) (living build trace / gates).  
This file is the **why**. `DIALY.md` is the **what / next gate**.

Last updated: **2026-08-30** (MVP threshold + use-case plan locked; host = Render)

---

## 1. What Dialy Is

Dialy is a **personal AI operator** — not a chatbot, not a dashboard, not an assistant you have to drive.

**One-line pitch:** *It doesn't sleep, so you don't have to.*

**One-paragraph:** Dialy runs in the background, watches what matters (inbox, logs, recurring tasks), acts within boundaries you’ve set, and only interrupts when a real decision needs a human. Jarvis-like — not a tool you open and babysit, but something that handles things and calls when a call is warranted.

**Product surface (near-term):** validation **webapp** with in-app messaging (not App Store yet; Electron is lab-only → delete later). Long-term: phone AI OS. Brain runs on Dialy-hosted always-on — **not** the user’s Mac.

---

## 2. Core Thesis

**Operator, not assistant.** Most AI tools are *pull-based* (you open, ask, do the work). Dialy is *push-based*: notices, decides, acts, surfaces only when it needs you. Labor substitution, not just augmentation.

**Presence is the differentiator, not connector count.** Browser-control agents already exist; they still need you watching. Dialy’s bet: you are *not there*. Unsupervised, async, reports back.

**Anti-fragmentation UX (setup):** thousands of connectors as step 1 is friction. Guidance in chat: who you are → few connectors → plug and play. Full catalog lives in Settings. Setup help ≠ general Q&A chatbot.

---

## 3. Efficiency vs Defensibility

**Efficiency (real, copyable):** wake-only compute; hybrid model routing. Good engineering, not a moat.

**Defensibility (actual moat):**
- Trust ramp — earns unsupervised action after proving smaller things  
- Accumulated context — relationship-specific memory  
- Reliability track record — correct on long unsupervised tasks  

**Not a moat:** connector count, LLM choice, wake/idle pattern alone.

---

## 4. Reliability Principle

Every connector multiplies failure surface. Prefer **one execution primitive per capability**, depth over breadth.

---

## 5. Trust Design Principles

- **Preview-then-approve** for consequential actions (UPI-style confirm screen)  
- **Progressive autonomy** — start read-only; visible correctness streak; user promotes to unsupervised  
- **Explain the why**, not only the what  
- **Explicit escalation policy** — written rules for “wake human” vs “log and continue” (design *before* piling on connectors)

---

## 6. Overnight Failure / Watchdog

A brain cannot narrate its own death. Deploy/host failure needs an **external watchdog** (outside the main process) that alerts if health goes quiet — plus host-provider deploy-failure hooks. Keep as pitch example of the babysitting problem.

---

## 7. Scenarios (sell the action, not a persona label)

- Overnight deploy handled → morning: “Handled. Nothing needed from you.”  
- Investor email → draft held for one-tap approve  
- “Book me a cook for 7” → book + confirm without opening apps  
- Home baker / CEO stacked briefing call  

Demo language sells **action**; persona is inferred.

---

## 8. Merchant Registry (“get me a cook”) — DEFERRED

Own discovery/registry is a big-platform land-grab (UCP/ACP/AP2/MCP already contested). Dialy should **consume** those protocols; browser-act as fallback for small locals. Hand-glue first merchants; no self-serve portal yet. **Second chapter**, after single-user proof — active scope-creep risk.

---

## 9. Business Model (sequencing)

| Path | Status |
|------|--------|
| B2D infra (sell operator engine) | Deprioritized; wake/idle orchestration maybe later |
| Generic B2C “AI OS for everyone” | Crowded / capital-heavy; don’t compete head-on |
| B2B chief-of-staff | Later expansion |
| Embedded trust-as-a-service | Promising later |

**Now:** you as first user (design answered by “would I trust this unsupervised today?”). Then organic solo/technical users; India/multilingual vertical later (build on Sarvam, not own voice model).

---

## 10. Competitive snapshot (late Aug 2026)

Instinct, Pally, Town = well-funded generalist consumer. Huper = closer enterprise analog. Apple Siri AI = structural risk to “phone is the OS.” India: M (concierge), Sarvam (infra to build on). **Read:** generic personal-AI-OS lane is saturated → wedge + reliability/trust, not “for everyone” vanity.

---

## 11. Merged build philosophy

| Claude strategy | Cursor / DIALY gates | Merge |
|-----------------|----------------------|-------|
| Prove unsupervised on self | G5 hosted brain + demo URL | Host brain so *neither* you nor mentors babysit a Mac |
| One async workflow + escalation rules | Design before connector sprawl | Lock workflow + write escalation *during* G5 |
| Preview-then-approve | Trust in product | Bake into G6/G7, not bolt on later |
| Accelerator needs a face | G6 in-app chat webapp | Chat proves **operator presence**, not only connector onboarding |
| Cut connectors | G7 one real connect | Minimal set, one primitive per capability |

**Anti-pattern:** merchant registry, Snap-number telephony, Expo polish, Electron polish, multi-agent rebuilds — park and return only after narrow unsupervised proof.

Full gate list lives in [`DIALY.md`](DIALY.md) §4–§5.  
Forward plan + persona scenarios: [`PLAN.md`](PLAN.md).

---

## 12. “Enough to show people” threshold (MVP bar)

**Audience:** co-founder / mentor / accelerator — not Series A production.

**The bar is experience, not infrastructure completeness.** Someone watches ~5–8 minutes and thinks: *I would actually use this / I get why this is an operator, not ChatGPT.*

### Pass criteria (all required)

1. **Presence** — Brain on Render (always-on URL). Demo does not need your Mac open.  
2. **One unsupervised loop you personally use** — overnight or while away: something happens → Dialy handles or escalates → you see a clear outcome.  
3. **Trust mechanic visible** — consequential actions show preview-then-approve (or a logged “I fixed X because rule Y”).  
4. **Messaging face** — talk to Dialy in-app chat (or Telegram until G6); feels like texting an operator.  
5. **Narrow connector set** — 4–6 max wired deeply; 67-catalog stays hidden.  
6. **You would leave it on for a week** — honest personal use, not only a staged click-path.

### Fail criteria (not enough yet)

- Only a landing page + slide narrative  
- Only “chat that recommends connectors” with no async act  
- 20 connectors half-connected  
- Demo requires “my laptop is on this Wi‑Fi”  
- Auto-pushing code to GitHub with no approval boundary (trust killer)

### What “watchdog + GitHub + Render” means at MVP (scoped)

**Hero use case A — Deploy sentinel (founder/dev wedge)**

| Step | Behavior | Tokens |
|------|----------|--------|
| Always | External ping `/health` + Render deploy status (no LLM) | ~0 |
| Event | Deploy failed / service unhealthy | wake once |
| Analyze | Cheap model: classify **minor vs needs human** using logs snippet + rules | small |
| Minor + allowed | e.g. restart service / revert known bad flag — **preview-approve** then act via Render API + optional GitHub comment/PR | one turn |
| Needs human | Message you: what broke, why it needs you, link | one short turn |
| Idle | Sleep until next event | 0 |

**Not MVP:** full Copilot auto-fix-and-push on every fault (too much blast radius). Optional later: open a draft PR with a suggested fix for human merge.

**Hero use case B — Daily brief (life operator wedge)**

| Step | Behavior | Tokens |
|------|----------|--------|
| Trigger | Cron morning (or stacked “when 3+ items”) | wake once |
| Inputs | Gmail (unread important) + Calendar (today) — **fetched by sync engines / targeted tools**, not dumping full mailbox into the prompt | controlled |
| Output | One short message: decisions needed vs handled/stacked | one turn |
| Act | Optional: draft reply held for approve; or log “no action” | optional second turn |

**Hero use case C — One push ask (optional spice, not the thesis)**

You text: “block 30m tomorrow afternoon for deep work” → Calendar propose → preview-approve → done. Proves operate-from-chat; **does not replace A or B.**

### Minimal connector set (MVP) — lock this, ignore the rest

| Need | Connector | Role |
|------|-----------|------|
| Host / health | **Render** (API + deploy hooks if available) | Watchdog target |
| Code / trail | **GitHub** | Issues/comments or draft PR; not silent force-push |
| Comms to you | **Telegram** (now) → in-app chat (G6) | Escalation + operate |
| Mail | **Gmail** | Brief + drafts |
| Time | **Google Calendar** | Brief + one booking-style ask |
| Docs (optional) | **Google Docs or Sheets** — pick **one** if a real workflow needs it | Else defer |

**Explicitly out of MVP connect list:** WhatsApp (API friction; Telegram/in-app is enough), Slack, Notion, 60 other Composio apps, Vercel (you flagged $20 plan API limits — **prefer Render as the host of truth**).

**Vercel:** don’t build the watchdog around it if the plan blocks API. Use Render for app + health; GitHub for code trail.

### Token optimization rules (non-negotiable for MVP)

1. **No LLM on the heartbeat** — health checks and cron “is anything new?” stay deterministic.  
2. **Wake only on event or one scheduled brief** — not continuous chat.  
3. **Never load 67 tool schemas** — meta-tools / 5–6 allowlisted tools for the active skill.  
4. **Sync engines feed summaries** — Gmail/Calendar sync → short digests into the turn, not raw threads.  
5. **Cheap model for triage; frontier only for consequential draft/fix** if needed.  
6. **One skill per wake** — deploy-sentinel OR morning-brief OR calendar-ask — not all tools every time.

### Demo tape (co-founder / mentor) — ~7 minutes

1. Phone: open health URL on cellular → “brain is up without my laptop.”  
2. Kill or break a Render deploy (controlled) → Dialy classifies → either auto-handles with approve **or** pings you with “needs you because …”  
3. Morning brief (or replay a recorded brief) from Gmail+Calendar → one message, decisions only.  
4. Optional: one calendar ask from chat with preview-approve.  
5. Close: “This ran while I wasn’t watching; here’s the log.”

Landing page: **after** this tape works — not before.

---

## 13. Open questions (need your answers to lock G5)

1. **Primary hero for fundraising tape:** Deploy sentinel (A) or Daily brief (B)? (Recommend **A as hero, B as support** if you’re technical — matches Render+GitHub story.)  
2. **Real Render service** we can break safely in a demo (this Dialy brain itself vs another app)?  
3. **Gmail + Calendar:** OK to connect your real accounts for self-use, or need a throwaway demo account?  
4. **Docs vs Sheets:** is there a concrete weekly workflow that needs either, or drop until after A+B?  
5. **Escalation channel for MVP:** keep Telegram until in-app chat exists?  

---

*Update when strategy decisions land; mirror `DIALY.md` conventions.*
