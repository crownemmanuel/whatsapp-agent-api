# WhatsApp API Gateway

A general-purpose WhatsApp API for agents. Connects to WhatsApp via Baileys and exposes a REST API — search contacts and groups by name to get their IDs, send messages (with attachments), read recent messages, and register webhooks that fire when messages arrive.

## What it does

- Connects to WhatsApp using Baileys. On first run it prints a QR code in the terminal (and writes `wa-qr.png`) for you to scan.
- Exposes a REST API documented with **Swagger / OpenAPI**, opened automatically on startup.
- Ships a clean **management web UI** to browse groups and contacts (with copy-ID buttons), manage webhooks, configure Codex routing, and operate scheduled jobs.
- Lets agents find a user or group by name, then send/read messages deterministically by ID.
- Delivers incoming messages to webhook URLs you register (scoped to a chat or all chats).
- Can route selected incoming messages to **Codex** with per-group/contact rules, per-rule sandbox mode, persistent chat folders, memory files, and automatic WhatsApp replies.
- Can run gateway-owned **cron jobs** that call APIs, run scripts, wake Codex in a per-job workspace, and send results back through WhatsApp.

## Run

```bash
cd whatsapp-api-gateway
npm install
npm start
```

On first start, scan the QR shown in your terminal with **WhatsApp → Linked devices**. Once linked:

- Swagger docs: [http://localhost:3399/docs](http://localhost:3399/docs) (opened automatically)
- Management UI: [http://localhost:3399/ui](http://localhost:3399/ui)
- OpenAPI spec: [http://localhost:3399/openapi.json](http://localhost:3399/openapi.json)

Re-link (new QR) if the session is lost or logged out:

```bash
npm start -- --rescan
```

## API overview

| Method & path | Purpose |
| --- | --- |
| `GET /api/status` | Connection status, counts |
| `GET /api/groups?q=` | Search groups by name → returns IDs |
| `GET /api/contacts?q=` | Search contacts by name/number → returns IDs |
| `GET /api/contacts/resolve?number=` | Verify/resolve a phone number to a JID |
| `GET /api/chats/{chatId}/messages` | Read recent buffered messages for a chat |
| `POST /api/messages` | Send a text message |
| `POST /api/messages/media` | Send image / video / audio / document |
| `GET /api/webhooks` | List webhooks |
| `POST /api/webhooks` | Register a webhook |
| `DELETE /api/webhooks/{id}` | Remove a webhook |
| `GET /api/codex/status` | Codex SDK/CLI readiness, recent runs |
| `GET/PUT /api/codex/config` | Read/update Codex agent settings |
| `GET/POST /api/codex/rules` | List/create Codex routing rules |
| `PUT/DELETE /api/codex/rules/{id}` | Update/remove Codex routing rules |
| `GET/PUT /api/codex/memory` | Read/write per-chat memory |
| `GET/PUT /api/cron/config` | Read/update scheduler settings |
| `GET/POST /api/cron/jobs` | List/create scheduled jobs |
| `GET/PUT/DELETE /api/cron/jobs/{id}` | Read/update/remove a scheduled job |
| `POST /api/cron/jobs/{id}/run` | Run a scheduled job immediately |
| `GET/PUT /api/cron/jobs/{id}/memory` | Read/write per-job memory |
| `POST /api/cron/chat` | Ask Codex to review or modify scheduler jobs |

### Send a text

```bash
curl -X POST http://localhost:3399/api/messages \
  -H 'content-type: application/json' \
  -d '{"to":"14155550123","text":"Hello from the gateway"}'
```

`to` accepts a phone number, a contact JID (`...@s.whatsapp.net`), or a group JID (`...@g.us`).

### Send an attachment

```bash
curl -X POST http://localhost:3399/api/messages/media \
  -H 'content-type: application/json' \
  -d '{"to":"123456789@g.us","type":"image","mediaUrl":"https://example.com/photo.jpg","caption":"FYI"}'
```

Media is supplied as `mediaUrl` (downloaded server-side) or `mediaBase64`. `type` is one of `image`, `video`, `audio`, `document`.

### Webhooks

Register a URL; incoming messages are POSTed to it as `{ "event": "message", "message": { ... } }`. Omit `chatId` for all chats, or scope it to one group/contact. An optional `secret` is sent as the `X-Webhook-Secret` header.

```bash
curl -X POST http://localhost:3399/api/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://my-agent.example.com/wa-hook","chatId":"123456789@g.us"}'
```

### Codex agent routing

The **Codex** tab in `/ui` lets you enable Codex routing and create rules such as:

- all DMs
- one trusted group
- one group only when a sender is allowed
- messages containing specific keywords
- group messages where the linked WhatsApp user is mentioned

Each rule can set `read-only`, `workspace-write`, or `full-access` sandbox mode. The UI labels full access as `full-access`; the gateway translates it to Codex SDK `danger-full-access` when running.

By default, matching messages are sent to one persistent Codex thread per chat workspace and Codex’s final response is sent back to the WhatsApp chat.

Codex can also reply with media. If it ends a run with directive lines like `SEND_FILE: artifacts/chart.png | optional caption` (or `SEND_VOICE: artifacts/note.mp3` for a voice note), the gateway strips those lines, sends the remaining text, and delivers each file to the chat as an image, video, audio, or document based on its extension. Files must live inside the chat workspace; up to 5 attachments per reply. The prompt tells Codex about this ability, so asking it to "generate an image" or "make me a PDF" results in actual media in the chat.

Workspaces default to:

```text
data/codex-workspaces/<chat-name-and-id>/
```

Each workspace contains:

- `memory.md` — durable chat memory that Codex can update when asked to remember things.
- `artifacts/` — generated files and task outputs.
- `thread.json` — the persisted Codex thread ID.
- `conversation.jsonl` — local run transcript metadata.

If `/api/codex/status` reports Codex is not ready, install dependencies with:

```bash
npm install
```

### Cron jobs

The **Cron** tab in `/ui` lets you enable the scheduler, create/edit jobs, run jobs manually, edit per-job memory, and chat with Codex to create or review jobs. Jobs are general pipelines made of steps:

- `http` — call an API; headers and bodies can use templates such as `${env:API_KEY}`.
- `transform` — pull or filter data from prior step output.
- `script` — run a shell command inside the job workspace.
- `codex` — wake Codex in the persistent job workspace to draft, analyze, edit files, or generate artifacts.
- `whatsapp` — send text/media back to a group or user through the gateway.

Secrets stay out of `data/config.json`. A job stores env aliases like `{ "API_KEY": "BIRTHDAY_API_KEY" }`, and the gateway resolves `${env:API_KEY}` from the process environment at runtime. WhatsApp sends are automatic by default; set `previewOnly` on the job or step for dry runs.

Job workspaces default to:

```text
data/cron-jobs/<job-id>/
```

Each job workspace contains `memory.md`, `artifacts/`, `runs/`, and `thread.json`. For example, a birthday job can fetch today’s birthdays, ask Codex to draft the message and create the image artifact in `artifacts/`, then send the result to the media team WhatsApp group.

## Background mode

If installed as a package:

```bash
whatsappAPI            # background once linked; logs to whatsapp-api-gateway.log
whatsappAPI --foreground
whatsappAPI --rescan
```

## Notes

- Config is saved at `data/config.json` (`apiPort`, `openDocsOnStart`, `webhooks`, `codexAgent`, `cronJobs`).
- Incoming media is cached under `data/media/` and served at `/api/media/...`.
- Codex chat workspaces are stored under `data/codex-workspaces/` unless `codexAgent.workspaceRoot` is set.
- Cron job workspaces are stored under `data/cron-jobs/`.
- `wa-qr.png` is generated for easy scanning.
- Set `WA_OPEN_DOCS=0` to disable auto-opening the docs page on start.
- Recent messages are buffered in memory per chat (last 200) for the read endpoint.
