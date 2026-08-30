# G7 smoke results (2026-08-30)

## Hosted brain — https://dialyone.onrender.com

| Check | Result |
|-------|--------|
| `GET /v1/operator/capabilities` | Live |
| `flags.render` | **true** |
| `flags.github` | **true** |
| `flags.mail` | **true** |
| `flags.telegram` | **true** |
| Scene A minor | `deploy-sentinel` → pending restart + draft_pr |
| Approve restart | safe block (no live restart) |
| Approve draft_pr | **ok**, `dryRun: true`, repo `dv7453/DialyOne` |
| Scene A oom | escalate delivered **`console` + `telegram`** |
| Scene B inbox | `mail.draft` approve → **ok**, `provider: composio`, `sent: false` |

Calendar remains optional (`flags.calendar: false`).

## Next

**G6** — validation webapp (chat + preview-approve) against this hosted brain.
