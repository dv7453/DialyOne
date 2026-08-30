# Dialy Operator

Dialy is a push-based operator: it watches for signals, matches playbooks, decides whether to act, ask approval, escalate, or log, and records every step in the journal.

## Architecture

```text
Signal
  -> playbook match
  -> rules-first triage
  -> policy decision
  -> action request
  -> approval / escalation / journal
```

```text
Render / GitHub / Gmail / Calendar / Telegram
        |
        v
  POST /v1/operator/signal
        |
        v
  brain/src/operator
        |
        +--> WorkDir/logs/operator.jsonl
        +--> in-memory pending approvals
        +--> future live capability adapters
```

## Playbooks

Playbooks live in `DIALY_WORKDIR/playbooks`. On host boot, Dialy creates that directory and seeds it from packaged defaults in `brain/playbooks` only when it is empty. User playbooks are never overwritten.

List loaded playbooks:

```bash
curl -s http://127.0.0.1:8787/v1/operator/playbooks | jq .
```

Inject a signal:

```bash
curl -s http://127.0.0.1:8787/v1/operator/signal \
  -H 'content-type: application/json' \
  -d '{"source":"render","type":"webhook","payload":{"event":"deploy.failed","reason":"oom","attempt":1}}' | jq .
```

List pending approvals:

```bash
curl -s http://127.0.0.1:8787/v1/operator/approvals | jq .
```

## Current Playbooks

- `deploy-sentinel`: watches Render deploy or unhealthy-service signals, triages minor versus needs-human faults, and creates approval-gated deploy/code actions or escalation entries.

## Playbooks To Add Next

- `inbox-draft`: important investor/customer email -> draft reply -> approval.
- `morning-brief`: Gmail and Calendar inputs -> short decisions-only brief.
- `calendar-hold`: direct ask -> proposed calendar hold -> approval.

## Operating Policy

- Consequential actions default to `approve`.
- Missing policy escalates.
- Heartbeats never call an LLM.
- Raw secrets and full payloads should not be returned from public HTTP routes.
- The journal is append-only evidence: signal, decision, action, outcome.

## Watchdog

The watchdog is independent from the brain process:

```bash
cd brain
npm run build
HEALTH_URL=http://127.0.0.1:8787/health npm run watchdog
```

After `WATCHDOG_FAILURE_THRESHOLD` consecutive failures, it alerts through Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_NOTIFY_CHAT_ID` are set. Otherwise it appends to `WATCHDOG_ALERT_FILE`, or logs loudly to stderr.
