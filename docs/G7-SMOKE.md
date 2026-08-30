# G7 smoke results (2026-08-30)

## Hosted brain — https://dialyone.onrender.com

| Check | Result |
|-------|--------|
| `GET /v1/operator/capabilities` | Live |
| `flags.render` | **true** (Render API env present) |
| `flags.github` | false — add `GITHUB_TOKEN` + `GITHUB_REPO` on Render |
| `flags.mail` | false — add `COMPOSIO_API_KEY` on Render |
| `flags.telegram` | false — add `TELEGRAM_BOT_TOKEN` + `TELEGRAM_NOTIFY_CHAT_ID` on Render |
| Scene A minor (`deploy.failed` attempt=1) | matched `deploy-sentinel` → pending `deploy.restart` + `code.draft_pr` |
| Approve restart | safe block (no live restart) |
| Approve draft_pr (hosted) | unavailable until GitHub env set |
| Scene A oom | `needs_human` → `notify.escalate` auto → delivered **console** (Telegram when env set) |
| Scene B inbox | matched `inbox-draft` → pending `mail.draft`; approve unavailable until Composio env set |

## Local adapter proof (keys from `~/.rowboat`, never committed)

| Adapter | Result |
|---------|--------|
| `code.draft_pr` | ok, `dryRun: true`, repo `dv7453/DialyOne` (via `gh auth token`) |
| `mail.draft` | ok, `provider: composio`, `sent: false` |
| `notify.escalate` | ok, delivered `console` + **telegram** |

## Finish hosted G7 (you)

On Render → dialyone → Environment, copy from local / dashboards (see [`NEEDS-YOU.md`](NEEDS-YOU.md)):

```text
GITHUB_TOKEN=<gh pat or gh auth token>
GITHUB_REPO=dv7453/DialyOne
COMPOSIO_API_KEY=<from ~/.rowboat/config/composio.json>
TELEGRAM_BOT_TOKEN=<from ~/.rowboat/config/channels.json telegram>
TELEGRAM_NOTIFY_CHAT_ID=<first allowFrom chat id>
```

Redeploy, then:

```bash
curl -s https://dialyone.onrender.com/v1/operator/capabilities | jq .flags
# expect github/mail/telegram true
```
