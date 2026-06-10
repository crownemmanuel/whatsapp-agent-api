---
name: whatsapp-api
description: >
  Send WhatsApp messages (text, images, video, audio, documents), read recent
  messages from a group or contact, search for groups and contacts by name to
  get their IDs, resolve a phone number to a WhatsApp ID, and manage webhooks
  that fire when messages arrive. Also manage Codex routing rules that forward
  matching WhatsApp messages into Codex and return replies, plus gateway cron
  jobs that can run APIs/scripts/Codex and send WhatsApp output. Use this skill
  whenever the user asks to send a WhatsApp, message a group, find a group ID,
  read WhatsApp messages, set up a webhook for WhatsApp, connect WhatsApp to
  Codex, manage WhatsApp-triggered Codex memory/rules, or do anything involving this project's WhatsApp API
  Gateway running at http://localhost:3399.
compatibility: Requires the WhatsApp API Gateway (npm start) to be running locally on port 3399
metadata:
  version: "1.0"
  project: whatsapp-api-gateway
---

# WhatsApp API Gateway Skill

API base URL: `http://localhost:3399`
Swagger docs: `http://localhost:3399/docs`
Management UI (groups, contacts, webhooks, Cron, Codex): `http://localhost:3399/ui`

See [full API reference](references/API_REFERENCE.md) for all endpoints, parameters, and response shapes.

---

## Always start here — check the connection

```
GET /api/status
```

If `connected` is `false`, tell the user WhatsApp needs to be re-linked:
```
npm start -- --rescan
```

---

## Finding IDs (always search before sending)

You never know a JID upfront. Search by name first.

**Find a group:**
```
GET /api/groups?q=<name fragment>&limit=10
```
Returns `[{ "id": "120363204563219847@g.us", "name": "Operations Team", "participantCount": 14 }]`

**Find a contact:**
```
GET /api/contacts?q=<name or number>&limit=10
```
Returns `[{ "id": "14155550123@s.whatsapp.net", "name": "John Smith", "number": "14155550123" }]`

**Resolve a phone number:**
```
GET /api/contacts/resolve?number=14155550123
```
Returns `{ "id": "14155550123@s.whatsapp.net" }` or `400` if not on WhatsApp.

Use the `id` value for all send/read operations.

---

## Sending messages

### Text
```
POST /api/messages
{ "to": "<JID or phone number>", "text": "Your message" }
```

### Image / video / audio / document
```
POST /api/messages/media
{
  "to": "<JID>",
  "type": "image",          // image | video | audio | document
  "mediaUrl": "https://...", // OR mediaBase64: "<base64 string>"
  "caption": "optional"
}
```

Extra fields for document: `"filename"`, `"mimetype"`.
Extra field for audio: `"ptt": true` to send as a voice note.

`to` accepts: group JID (`...@g.us`), contact JID (`...@s.whatsapp.net`), or plain phone number.

---

## Reading messages

```
GET /api/chats/<chatId>/messages?limit=20
```

URL-encode `@` as `%40` in the chatId path segment.
Returns up to 200 buffered messages per chat (since the gateway started).

---

## Typing indicator

```
POST /api/chats/<chatId>/typing
{ "state": "composing", "durationMs": 30000 }
```

Shows the WhatsApp "typing…" indicator while you work on a reply (auto-refreshed; stops after `durationMs`, default 30 s, max 5 min). Post `{ "state": "paused" }` to hide it early. URL-encode `@` as `%40` in the chatId.

---

## Webhooks

**Register:**
```
POST /api/webhooks
{ "url": "https://my-agent.example.com/hook", "chatId": "<optional JID>", "secret": "optional" }
```
Omit `chatId` to receive all messages. The gateway POSTs `{ "event": "message", "message": {...} }` to your URL. The `secret` is echoed as `X-Webhook-Secret`.

**List:** `GET /api/webhooks`
**Delete:** `DELETE /api/webhooks/<id>`

---

## Codex routing

**Status:** `GET /api/codex/status`

**Enable/update config:**
```
PUT /api/codex/config
{ "enabled": true, "defaultSandbox": "full-access", "autoReply": true }
```

**Create a rule:**
```
POST /api/codex/rules
{
  "name": "Ops mentions",
  "chatType": "group",
  "chatId": "<optional group JID>",
  "allowedSenderIds": ["<optional sender JID or phone>"],
  "keywords": ["optional keyword"],
  "requireMention": true,
  "sandbox": "full-access",
  "autoReply": true
}
```

Use `full-access` only for trusted chats/senders. The gateway ignores outgoing messages from the linked WhatsApp account to avoid reply loops.

**Memory:** `GET /api/codex/memory?chatId=<JID>` and `PUT /api/codex/memory`

---

## Cron jobs

**Status/config:** `GET /api/cron/status`, `GET /api/cron/config`, `PUT /api/cron/config`

**Create a job:**
```
POST /api/cron/jobs
{
  "name": "Daily birthdays",
  "schedule": { "expression": "0 6 * * *", "timezone": "America/New_York" },
  "previewOnly": false,
  "env": { "API_KEY": "BIRTHDAY_API_KEY" },
  "steps": [
    { "type": "http", "id": "fetch", "url": "https://example.com/birthdays", "headers": { "authorization": "Bearer ${env:API_KEY}" }, "saveAs": "birthdays" },
    { "type": "codex", "id": "draft", "prompt": "Draft and create artifacts from ${steps.birthdays.body}", "saveAs": "draft" },
    { "type": "whatsapp", "id": "send", "to": "<group JID>", "text": "${steps.draft.text}", "mediaPath": "${steps.draft.imagePath}", "mediaType": "image" }
  ]
}
```

Secrets are stored as environment variable names only. The gateway resolves `${env:ALIAS}` at runtime. Job workspaces live under `data/cron-jobs/<job-id>/` with `memory.md`, `artifacts/`, `runs/`, and `thread.json`.

**Operate jobs:** `GET/PUT/DELETE /api/cron/jobs/<id>`, `POST /api/cron/jobs/<id>/run`, `GET/PUT /api/cron/jobs/<id>/memory`

**Ask Codex to manage jobs:**
```
POST /api/cron/chat
{ "message": "Set up a weekday 6 AM birthday job that sends the result to the media group." }
```

---

## Quick decision table

| Goal | Endpoint |
|---|---|
| Send text to a group/contact | Search → get ID → `POST /api/messages` |
| Send a photo/file | Search → get ID → `POST /api/messages/media` |
| Read recent messages | Search → get ID → `GET /api/chats/{id}/messages` |
| Watch a chat for new messages | Search → get ID → `POST /api/webhooks` with `chatId` |
| Show "typing…" while working | `POST /api/chats/{id}/typing` with `{"state": "composing"}` |
| Let Codex handle matching messages | `PUT /api/codex/config` → `POST /api/codex/rules` |
| Edit per-chat Codex memory | `GET/PUT /api/codex/memory` |
| Create a scheduled WhatsApp automation | `POST /api/cron/jobs` or `POST /api/cron/chat` |
| Run or review a scheduled automation | `POST /api/cron/jobs/{id}/run`, `GET /api/cron/runs` |
| Check if WhatsApp is online | `GET /api/status` |

---

## Error codes

| Code | Meaning |
|---|---|
| 503 | WhatsApp not connected — needs to be re-linked |
| 400 | Bad input — read `error` field (invalid JID, number not on WA, missing field) |
| 404 | Webhook not found |
