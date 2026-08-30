# Dialy — PLAN (what we are going to build)

**This file is the plan of record.** Read this one.  
[`DIALY.md`](DIALY.md) = product + what is already done. [`STRATEGY.md`](STRATEGY.md) = why / moat.

Last updated: **2026-08-30** — **APPROVED & EXECUTED** through operator kernel + scenarios (live Render/creds = Needs-you)

---

## Status after approve

| Phase | Status |
|-------|--------|
| 1 Kernel + harness | **DONE** |
| 2 Capabilities + approvals + executor | **DONE** |
| 3 Render prep + watchdog + host routes | **DONE** (deploy needs your account) |
| 4 Example playbooks + extra | **DONE** (20/20 scenarios PASS) |
| 5 Docs + NEEDS-YOU + DIALY | **DONE** |
| 6 Web UI | **NOT in this approve** — decide later |

Your only blocker to *live* demos: [`docs/NEEDS-YOU.md`](docs/NEEDS-YOU.md).

## 0. The deal

You say **approve**, close the laptop, and leave. I execute the whole backend without babysitting.

When you come back you get:

1. A **scenario-driven operator engine** — example personas + any adjacent problems we discover, all as config, none hardcoded
2. **Scenario harness** (`npm run scenarios`) — the example library **plus** any extras that were covered during build, offline, no real accounts needed
3. **Live adapters** for Render / GitHub / Gmail / Calendar behind a capability interface — dormant until you paste credentials
4. A **deployable hosted brain** + **external watchdog** (deploy needs your Render token — I prepare everything and leave one step)
5. A written **verification script** + a **Needs-you ledger** (credentials / Render / GitHub / etc. — process never stalled waiting on these)
6. `DIALY.md` updated with what actually shipped

**Needs-you items never block the plan.** If something needs your API key, Render account, or GitHub token, I finish everything around it end-to-end (config, adapters, fixtures, docs), write it into `docs/NEEDS-YOU.md`, and keep going. When you return, you read that list and do the needful — not mid-build.

What I will **not** do without you: spend money, push to your GitHub, send real email, or connect your personal accounts. Those need credentials you hold. Everything is built and proven in simulation so wiring them is a 5-minute step, not a rewrite.

---

## 1. Non-negotiable engineering principles

This is a company, not a demo script. Every decision below follows these.

| Principle | Consequence in the build |
|-----------|--------------------------|
| **No hardcoded scenarios** | A persona = a YAML playbook + connector config. Adding "home baker" (or any new life) must require **zero** TypeScript changes |
| **Examples ≠ closed set** | The 20 scenarios are **illustrative** of who Dialy is for — not the entire product surface. Related real problems that fit the operator loop get covered when noticed (see §5.1) |
| **No hardcoded credentials or IDs** | Everything from `$WorkDir/config/*` or env. No repo names, chat IDs, or emails in source |
| **Capability interface, not connector spaghetti** | Actions go through typed capability adapters (`deploy`, `code`, `mail`, `calendar`, `notify`). Swapping Render→Fly = new adapter, not new engine |
| **Deterministic before probabilistic** | Rules filter first; the model runs only when a rule can't decide. Cheap on tokens, easier to debug, more reliable |
| **Every act is auditable** | Signal → decision → action → outcome is one journal record. This is the reliability track record that becomes the moat |
| **Nothing consequential without policy** | Auto / approve / escalate is decided by policy config, never by the model's mood |
| **Testable without the internet** | Every scenario replayable from fixtures with mock adapters |
| **Reuse the existing brain** | We build a thin operator layer on proven runtime, not a second agent framework |
| **Needs-you never stalls the build** | Missing secrets → dormant capability + ledger entry; continue end-to-end |

---

## 2. What already exists (I verified this in the codebase)

I am not starting from zero. `brain/` (package `@x/core`) already has:

| Existing | Where | We reuse it for |
|----------|-------|-----------------|
| Durable file event queue (5s poll) | `brain/src/events/` | Signal ingestion backbone |
| Background tasks with cron/window/event triggers, YAML-defined | `brain/src/background-tasks/` | Scheduled briefs, recurring playbooks |
| Agent schedule (cron / window / once) + state | `brain/src/agent-schedule/` | Time-based playbook triggers |
| Turn runtime with **suspend + resume**, `ask-human`, permission gates | `brain/src/runtime/turns/` | Preview-then-approve, human-in-the-loop |
| Skills = declarative tool bundles, hot-reloaded from disk | `brain/src/runtime/assembly/skills/` | Per-playbook tool scoping (token discipline) |
| Composio **meta-tools** (search → execute, no schema dumping) | `brain/src/runtime/tools/domains/composio.ts` | Connectors without 67 schemas in context |
| Channels bridge (Telegram live, WhatsApp code path) | `brain/src/channels/` | Escalation + operate channel |
| Model routing with per-task models | `brain/src/models/` (`taskModels`) | Cheap triage vs expensive draft |
| Vitest, 67 test files, in-memory repos, fixture patterns | `brain/src/**/*.test.ts` | Scenario harness plugs into existing conventions |

**Gap I am building:** there is no *operator layer* — nothing that turns a signal into a policy-governed action with escalation and an audit trail. That is the product. That is what I build.

---

## 3. Target architecture — the Operator Kernel

New code lives in `brain/src/operator/`. One layer, clear seams.

```
signal → normalize → match playbooks → triage → policy → act | approve | escalate → journal → digest
```

### 3.1 Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| **Signals** | `operator/signals/` | Normalize inbound facts into one `Signal` type. Sources: HTTP webhook, poller, cron, existing event queue |
| **Playbooks** | `operator/playbooks/` | Load + validate YAML from `$WorkDir/playbooks/`, hot reload (mirrors skills watcher) |
| **Matcher** | `operator/match/` | Which playbooks care about this signal (source/type/predicates) |
| **Triage** | `operator/triage/` | Rules first; cheap model only if unresolved. Returns a class + reason + confidence |
| **Policy** | `operator/policy/` | class + action risk → `auto` \| `approve` \| `escalate` \| `log`. Pure function, fully testable |
| **Capabilities** | `operator/capabilities/` | Typed adapters: `deploy`, `code`, `mail`, `calendar`, `notify`, `web`. Registry-based |
| **Approvals** | `operator/approvals/` | Pending approvals with expiry, one-tap confirm/deny, resume the paused act |
| **Escalation** | `operator/escalate/` | Channel-agnostic delivery (Telegram now → in-app → voice later) |
| **Digest** | `operator/digest/` | Stack non-urgent items; emit one scheduled brief |
| **Journal** | `operator/journal/` | Append-only JSONL: every signal, decision, action, outcome |
| **Budget** | `operator/budget/` | Per-playbook caps: model calls, tool rounds, spend guard |
| **Watchdog** | `brain/watchdog/` | Separate process — pings health, alerts if the brain dies |
| **Harness** | `operator/testing/` | Fixture replay + mock capabilities → example library (+ any extras covered) green offline |

### 3.2 Why the watchdog is a separate process

A brain cannot narrate its own death. The watchdog runs outside the brain (own process / own schedule), pings `/health` and the deploy provider, and alerts you directly. If the brain is dead, the alert still arrives. This is the STRATEGY §6 lesson, implemented — and it doubles as demo Scene A.

---

## 4. The Playbook — how a persona becomes config

**One file per scenario. No code.** Stored in `$WorkDir/playbooks/<id>.yaml`, hot-reloaded, Zod-validated, versioned.

```yaml
id: deploy-sentinel
title: Deploy sentinel
enabled: true

triggers:
  - type: webhook
    source: render
    match: { event: ["deploy.failed", "service.unhealthy"] }
  - type: probe
    every: 60s
    capability: deploy.health          # deterministic, no model

context:                                # what to fetch before thinking
  - capability: deploy.logs
    args: { lines: 200 }

triage:
  rules:                                # deterministic wins, zero tokens
    - when: "signal.payload.reason == 'oom'"
      class: needs_human
    - when: "signal.payload.attempt < 2"
      class: minor
  model: triage                         # taskModels.triage — cheap, only if rules miss
  classes: [minor, needs_human, ignore]

policy:
  minor:
    - capability: deploy.restart
      mode: approve                     # auto | approve | escalate | log
    - capability: code.draft_pr
      mode: approve
  needs_human:
    - capability: notify.escalate
      mode: auto
  ignore:
    - capability: journal.log
      mode: auto

digest:
  stack: [minor]
  deliver: "0 8 * * *"

budget:
  max_model_calls: 3
  max_tool_rounds: 6
  on_exceed: escalate
```

### Why this satisfies "not hardcoded"

- **New persona** = new YAML. Home baker, CA, parent — all config.
- **New connector** = one adapter implementing a capability interface + register it. Playbooks reference `mail.draft`, not "Gmail".
- **Policy changes** = edit YAML. No redeploy of logic.
- **Investor-legible**: "our operator is configuration-driven; onboarding a vertical is authoring a playbook, not a sprint."

---

## 5. Scenario coverage — example library + open edge

### 5.1 The 20 are examples, not a cage

The table below is a **starter catalog** of target lives (CEO, baker, café, indie hacker, parent, real-estate, …). It shows how Dialy helps *those kinds of people*. It is **not**:

- the full set of problems Dialy will ever solve  
- a whitelist that forbids covering anything else  
- a reason to ignore a real daily pain that fits the operator loop  

**During build and design, if a related problem shows up** — an edge case, a daily friction those personas (or adjacent ones) actually hit, that Dialy can help with using presence + triage + approve/escalate + existing capabilities — **cover it**. Do not drop it because “it wasn’t in the original 20.”

How to cover an extra without chaos:

1. Prefer a **new playbook YAML** (or an extension of an existing playbook’s triggers/rules) — still zero hardcoded persona logic in TypeScript  
2. Add a **fixture + harness case** so it stays testable  
3. Note it under **“Extras covered beyond the example 20”** in the harness output / `DIALY.md` stage log  
4. If it needs a **new capability** (e.g. payments), only add the adapter if it clearly unlocks real operator value; otherwise escalate/log and ledger it  

What still stays parked (§11): merchant registry land-grab, Snap telephony, Expo, Electron polish, landing page — those are product-direction parks, not “extra baker edge cases.”

### 5.2 Example library (illustrative personas)

Every row maps to shared capabilities. Nothing needs a bespoke engine per persona.

| # | Persona | Playbook id | Capabilities | Phase |
|---|---------|-------------|--------------|-------|
| 1 | Solo founder — deploy sentinel | `deploy-sentinel` | deploy, code, notify | **P2 live** |
| 2 | Technical co-founder — CI red | `ci-triage` | code, notify | P4 |
| 3 | Fundraising founder — investor mail | `inbox-draft` | mail, notify | **P2 live** |
| 4 | CEO — morning decision stack | `morning-brief` | mail, calendar, digest | P4 |
| 5 | EA-less exec — calendar move | `calendar-hold` | calendar, notify | P4 |
| 6 | Agency owner — client status | `inbox-draft` (+profile) | mail | P4 |
| 7 | Home baker — 11am orders brief | `orders-brief` | mail, digest, notify | P4 |
| 8 | Café — supplier delay impact | `supply-watch` | mail, digest | P4 |
| 9 | CA — client docs + deadline | `docs-intake` | mail, calendar (strict approve) | P4 |
| 10 | Freelance designer — scope + block | `scope-reply` | mail, calendar | P4 |
| 11 | Indie hacker — weekly digest | `weekly-digest` | deploy, mail, digest | P4 |
| 12 | Content creator — brand deal | `deal-intake` | mail, calendar | P4 |
| 13 | Grad student — advisor + deadlines | `deadline-stack` | mail, digest | P4 |
| 14 | Busy parent — school/doctor | `family-brief` | mail, calendar, digest | P4 |
| 15 | Couples — book dinner | `book-request` | calendar, web | P4 |
| 16 | Real-estate — lead qualify | `lead-qualify` | mail, calendar | P5 |
| 17 | Clinic — no-show reschedule | `reschedule` | mail, calendar | P5 |
| 18 | E-comm — dispute pack | `dispute-pack` | mail, payments | P5 |
| 19 | OSS maintainer — issue triage | `issue-triage` | code, notify | P5 |
| 20 | Consultant — flight change | `travel-shift` | mail, calendar | P5 |

**"Live" vs "authored":** every example playbook above is **authored and passing the scenario harness** by the time you return, **plus** any extras covered under §5.1. Playbooks marked *live* additionally run against real APIs once you paste credentials. The rest are one credential away — by design, not by shortcut.

**Minimum bar:** the example 20 are green in the harness. **Success bar:** if we found coverable daily problems along the way, those are green too — and listed as extras, not silently skipped.

---

## 6. Execution phases (what I do while you're gone)

I work in order. Each phase ends with tests green and a note in `DIALY.md`. If a phase is blocked by a missing secret, I finish everything around it in simulation and move on — **I do not stall waiting for you.**

### Phase 1 — Operator kernel + harness *(the foundation)*
- `Signal`, `Playbook`, `TriageResult`, `PolicyDecision`, `ActionRequest`, `JournalEntry` types + Zod schemas
- Playbook loader with validation, hot reload, clear error messages on bad YAML
- Matcher, rules-first triage, pure policy engine
- Journal (JSONL, one line per decision) + budget guard
- Mock capability adapters
- **Scenario harness**: `npm run scenarios` replays fixtures for the example library (+ extras under §5.1)
- Unit tests for policy, matcher, triage rules, budget, playbook validation

**Done when:** example library (+ any covered extras) run offline, deterministic, green.

### Phase 2 — Real capabilities + hero scenes
- Capability registry + adapters: `deploy` (Render API), `code` (GitHub), `mail` (Gmail via Composio meta-tools), `calendar`, `notify` (Telegram → later in-app)
- Credential resolution from config/env with **graceful dormancy** (missing creds = capability reports unavailable, playbook degrades to escalate, nothing crashes)
- Approvals store + Telegram approve/deny flow wired to the existing suspend/resume machinery
- Scene A (`deploy-sentinel`) and Scene B (`inbox-draft`) runnable end-to-end against mocks **and** against live APIs when credentials exist

**Done when:** approve/deny round-trips work; live adapters pass contract tests against recorded responses.

### Phase 3 — Hosting + watchdog
- Render service definition (`render.yaml`) + Dockerfile/build config for the brain
- Config/secrets documented as env, nothing baked into the image
- Watchdog process: health ping + deploy status → direct alert, independent of the brain
- Deliberate failure drill: kill the service, confirm the alert fires

**Done when:** everything is one `render.yaml` + token away. **Deploy itself needs your Render account** — that's the single step I leave you.

### Phase 4 — Full example library + adjacent coverage
- Author remaining example playbooks (#2, 4–15) with fixtures
- Author any **extra** playbooks discovered under §5.1 (real daily problems that fit; don’t ignore)
- Digest/brief engine (stacking + scheduled delivery)
- Profile/onboarding config: "who are you" → recommended playbook set + connector list (anti-fragmentation; data not code)

**Done when:** `npm run scenarios` covers the example library + extras and stays green.

### Phase 5 — Hardening + evidence
- Vertical example playbooks #16–20 authored (harness only)
- Failure-path tests: API down, rate limited, bad credentials, malformed webhook, model timeout, budget exceeded
- Idempotency + replay protection (a webhook delivered twice must not act twice)
- Redaction: no secrets or full email bodies in the journal
- `docs/` runbook + demo script + verification steps + **`docs/NEEDS-YOU.md`** (everything that waited on your credentials/accounts)
- `DIALY.md` updated: gates, what shipped, extras covered beyond the 20

**Done when:** you can run the verification script cold and clear the Needs-you ledger.

### Phase 6 — *Optional, only if time allows*
Minimal local web chat + approvals UI reading the same operator API. Nothing decided about the real product UI — that conversation is yours when you're back.

---

## 7. How I test without your accounts

This is the part that makes "ready for all scenarios testing" true rather than a promise.

| Layer | Method |
|-------|--------|
| Playbook validation | Schema tests — every YAML in the library must parse and typecheck |
| Matcher / policy / triage rules | Pure unit tests, no I/O, no model |
| Model-dependent triage | Stubbed model returning canned classifications; prompts snapshot-tested |
| Capability adapters | Contract tests against recorded fixtures (request → recorded response) |
| Whole scenario | Fixture replay: inject signal → assert decision, actions attempted, escalation text, journal entries |
| Approvals | Simulated approve **and** deny paths; expiry; double-approve safety |
| Failure modes | Injected faults per phase-5 list |
| Live sanity (only where creds exist) | Read-only calls first; writes stay behind approval |

**`npm run scenarios`** is the deliverable you'll run: it prints each scenario, the decision path, and pass/fail. That's your proof, and it's also the skeleton of the demo tape.

---

## 8. Decisions I am making so I don't stall

You said don't babysit. So these are my defaults. Override any of them in one line when you're back and the config absorbs it.

| Question | My default | Why |
|----------|-----------|-----|
| Hero scene | **A (deploy sentinel)** built first, B (inbox) right behind | Matches the co-founder/technical tape; uses infra you control |
| GitHub write access | **Draft PR only, always approval-gated**; no auto-merge, no push to `main` | Trust boundary is the product; unsupervised push is how you lose a mentor's confidence |
| Render actions | Restart = **approval-gated by default**; policy flag exists to make it auto later | Progressive autonomy is a design principle, not a limitation |
| Gmail | Adapter built + tested against fixtures; **not connected** to your account | Your credentials, your call |
| Vercel | **Not used** for Scene A | You flagged the $20 plan API limits — Render is the host of truth |
| Escalation channel | **Telegram** (already proven) with a channel-agnostic interface | In-app chat drops in later without touching playbooks |
| Model routing | Cheap `triage` task model; assistant model only for drafts/fixes | Token discipline from STRATEGY |
| Secrets | Config/env only, `.gitignore`d, never in the journal | Non-negotiable for a fundable codebase |
| WorkDir | Prefer `~/.dialy` / `DIALY_WORKDIR`; keep existing home dir if already set | Don't break a working setup while you're away |

---

## 9. What only you can do (the short list I leave for you)

1. **Render:** create the service + paste the API token → hosted brain goes live (everything else is prepared)
2. **GitHub:** name the allowlisted repo + token → draft PRs go live
3. **Gmail/Calendar:** connect the account → Scene B/C go live
4. Decide the **web app** direction (Phase 6 is deliberately not decided for you)

Until then those capabilities report *unavailable* and playbooks degrade to escalate — the engine still runs, still tests, still demos on fixtures.

---

## 10. Risks, and how I'm handling them

| Risk | Handling |
|------|----------|
| I over-build and you get a maze | Hard cap: kernel + adapters + playbooks. No new agent framework, no UI rebuild, no Electron work |
| Playbooks become a fake DSL that's really code-in-YAML | Keep the schema small and boring: triggers, context, triage, policy, digest, budget. Anything exotic goes in a capability adapter |
| Scenario library becomes untested filler | Every playbook ships with a fixture and a harness assertion, or it doesn't ship |
| Live API surprises (rate limits, auth quirks) | Adapters are contract-tested; failures degrade to escalate rather than crash |
| Token burn during my own testing | Rules-first triage, stubbed models in tests, budget caps enforced in code |
| Scope creep (registry, telephony, Expo) | Explicitly parked — see §11 |

---

## 11. Parked (I will not touch these)

Merchant registry / UCP land-grab · Snap-style Dialy phone number · Expo or store apps · Electron polish (it gets deleted later) · Landing page · Billing · Multi-tenant SaaS · WhatsApp (Telegram + in-app is enough for now) · Docs/Sheets/Slack/Notion connectors

---

## 12. Your verification script (10 minutes, when you're back)

1. `cd brain && npm test` — unit suite green
2. `cd brain && npm run scenarios` — example library (+ any extras) listed with decision paths, green  
3. Open `docs/` runbook + **`docs/NEEDS-YOU.md`** → do the credential/deploy steps  
4. Inspect playbooks — example personas are YAML; extras (if any) are YAML too  
5. Edit one playbook (flip a policy from `approve` to `escalate`), rerun scenarios → behavior changes with **no code edit**. *Proof nothing is hardcoded.*  
6. Read a journal run — signal → decision → action → outcome  
7. Then decide: deploy to Render / wire live APIs, or review the web app question

---

## 13. Say the word

**"approve"** → I start Phase 1 and work through Phase 5, updating `DIALY.md` as gates close.

If you want any default in §8 changed, say it in the same message — otherwise I proceed exactly as written above.
