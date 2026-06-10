# WhatsApp API Gateway

## Project summary

This is a Node.js WhatsApp API gateway built on [Baileys](https://github.com/WhiskeySockets/Baileys). It exposes a REST API (with OpenAPI/Swagger docs) that agents can use to send and receive WhatsApp messages without any UI layer.

Start it: `npm start`
Syntax check: `npm run check`

## Architecture

| File | Role |
|---|---|
| `src/index.js` | Entry point — wires bridge → API server, dispatches webhooks, starts scheduler |
| `src/whatsapp.js` | Baileys bridge — connection, contact/group directory, message buffer, send methods |
| `src/api-server.js` | Plain-Node HTTP REST server |
| `src/openapi.js` | OpenAPI 3 spec + Swagger UI HTML + management UI HTML |
| `src/config-store.js` | Config (apiPort, openDocsOnStart, webhooks, codexAgent, cronJobs) read/write |
| `src/codex-agent.js` | Codex routing — rule matching, per-chat workspaces/memory, SDK execution |
| `src/cron-jobs.js` | Gateway scheduler — cron parsing, job execution, per-job memory/artifacts, scheduler chat |
| `bin/whatsappCC.js` | CLI entry — foreground or background mode |

## Key ports

- API + docs: `http://localhost:3399` (configurable via `data/config.json` → `apiPort`)
- Swagger UI: `/docs`
- Management UI: `/ui`
- OpenAPI JSON: `/openapi.json`

## Using the API as an agent

See `skills/whatsapp-api/SKILL.md` — an open-standard Agent Skill (agentskills.io) that works with Codex, OpenAI Codex CLI, Gemini CLI, GitHub Copilot, and others. Load it when the user wants to send WhatsApp messages, read messages, or manage webhooks from this project. Full API reference is in `skills/whatsapp-api/references/API_REFERENCE.md`.

## Runtime data

- WhatsApp session: `baileys-auth/`
- Config + media: `data/`
- Codex workspaces: `data/codex-workspaces/`
- Cron job workspaces: `data/cron-jobs/`
- QR code (first link): `wa-qr.png`
- Log (background mode): `whatsapp-api-gateway.log`

## Env vars

| Var | Effect |
|---|---|
| `WA_OPEN_DOCS=0` | Disable auto-opening `/docs` in browser on start |
| `LOG_LEVEL` | Pino log level (default: `info`) |
