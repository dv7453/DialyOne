# Dialy

A personal AI assistant I’m building as a side project.

Chat in the browser, run a local agent with your own model keys, optionally poke at a desktop shell. Nothing fancy — just a hobby stack for talking to an always-on helper.

## What’s in the repo

| Path | What it is |
|------|------------|
| `apps/web` | Browser chat UI |
| `brain` | Agent runtime (headless HTTP host) |
| `apps/x` | Electron app used for local experiments |

## Web chat

```bash
cd apps/web
npm install
npm run dev
```

Opens on [http://localhost:5180](http://localhost:5180). Point it at a brain URL (local host or wherever you run `brain`).

## Agent (headless)

```bash
cd apps/x && pnpm install && npm run deps
cd ../../brain && npm run start
```

Health check: `http://127.0.0.1:8787/health` (or your LAN IP if you bind `0.0.0.0`).

Config lives on your machine, not in git — typically `~/.dialy/config/` (`models.json`, optional Composio / voice keys). See [`brain/README.md`](brain/README.md).

## Notes

- Bring your own API keys. Don’t commit `.env` or WorkDir files.
- Electron is optional; the web UI is the easy way to try chat.
