# Dialy 7-Minute Demo Script

## 0:00-0:45 — Open

"Dialy is a personal AI operator. It does not wait for me to open a dashboard. It watches what matters, acts inside policy, and only wakes me when it needs a decision."

Show the public Render health URL on phone cellular:

```bash
curl -s $HEALTH_URL | jq .
```

Point: the brain is hosted and awake without the laptop.

## 0:45-2:15 — Operator Loop

Show the operator routes:

```bash
curl -s $BRAIN_URL/v1/operator/playbooks | jq .
```

Explain that behavior comes from playbooks, not hardcoded scenario code.

Inject a controlled Render failure signal:

```bash
curl -s $BRAIN_URL/v1/operator/signal \
  -H 'content-type: application/json' \
  -d '{"source":"render","type":"webhook","payload":{"event":"deploy.failed","reason":"oom","attempt":1}}' | jq .
```

Point out triage, policy, and approval-gated actions.

## 2:15-3:45 — Trust Boundary

Show pending approvals:

```bash
curl -s $BRAIN_URL/v1/operator/approvals | jq .
```

"This is the trust mechanic. Dialy can decide and prepare the action, but restart or draft-PR behavior stays approval-gated until I promote it."

## 3:45-5:00 — Watchdog

Show the external watchdog running against the hosted health URL:

```bash
cd brain
HEALTH_URL=$HEALTH_URL npm run watchdog
```

Explain: "A brain cannot narrate its own death. The watchdog is a separate process that alerts me if the hosted brain goes quiet."

## 5:00-6:15 — Daily Operator Story

Narrate the next live connectors:

- Render: service health and deploy status.
- GitHub: draft PRs or comments, never silent merges.
- Gmail: daily brief and draft replies through Composio.
- Telegram now, in-app chat later: escalation and approve/deny surface.

"The same loop handles inbox and calendar: signal, triage, policy, action, approval, journal."

## 6:15-7:00 — Close

Show `docs/NEEDS-YOU.md`.

"The only missing pieces are credentials and the Render service creation. The code path is ready, the fallbacks are explicit, and nothing requires babysitting a Mac on local Wi-Fi."
