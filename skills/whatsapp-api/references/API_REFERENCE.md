# WhatsApp API Gateway — Full API Reference

Base URL: `http://localhost:3399`

---

## GET /api/status

Returns connection state and directory counts.

```json
{
  "connected": true,
  "user": { "id": "14155550123@s.whatsapp.net", "name": "My Name" },
  "groupCount": 42,
  "contactCount": 180
}
```

---

## GET /api/groups

Search groups by name.

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Substring match against group name |
| `limit` | integer | 50 | Max results (up to 500) |

```json
[
  {
    "id": "120363204563219847@g.us",
    "name": "Operations Team",
    "participantCount": 14
  }
]
```

---

## GET /api/contacts

Search contacts by name or phone number.

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Substring match against name or digits of number |
| `limit` | integer | 50 | Max results |

```json
[
  {
    "id": "14155550123@s.whatsapp.net",
    "name": "John Smith",
    "number": "14155550123"
  }
]
```

---

## GET /api/contacts/resolve

Verify a phone number is on WhatsApp and return its JID.

| Param | Type | Required | Description |
|---|---|---|---|
| `number` | string | Yes | International format digits, e.g. `14155550123` |

**200 OK:**
```json
{ "id": "14155550123@s.whatsapp.net", "number": "14155550123" }
```

**400 Bad Request:**
```json
{ "error": "Number 14155550123 is not registered on WhatsApp" }
```

---

## GET /api/chats/:chatId/messages

Read recent buffered messages for a chat.

`:chatId` — group JID or contact JID. **URL-encode** `@` as `%40`.

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | 50 | Max messages returned (up to 500, buffer holds last 200) |

```json
[
  {
    "id": "ABCDEF1234567890",
    "chatId": "120363204563219847@g.us",
    "chatName": "Operations Team",
    "isGroup": true,
    "sender": "Alice",
    "senderId": "14155550001@s.whatsapp.net",
    "text": "The server is back up",
    "mediaType": null,
    "mediaUrl": null,
    "hasMedia": false,
    "mentionedJids": [],
    "fromMe": false,
    "ts": 1717858800000
  }
]
```

`mediaType` values: `"image"` | `"video"` | `"audio"` | `"document"` | `"sticker"` | `null`
`mediaUrl` — relative path served by this gateway, e.g. `/api/media/filename.jpg`
`ts` — Unix timestamp in milliseconds

---

## POST /api/messages

Send a text message.

```json
{
  "to": "120363204563219847@g.us",
  "text": "Hello from the API gateway"
}
```

`to` accepts:
- Group JID: `120363204563219847@g.us`
- Contact JID: `14155550123@s.whatsapp.net`
- Phone number: `14155550123` (gateway calls `onWhatsApp` to verify and resolve)

**200 OK:**
```json
{ "id": "ABCDEF1234567890", "to": "120363204563219847@g.us" }
```

---

## POST /api/messages/media

Send a message with an attachment.

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | string | Yes | JID or phone number |
| `type` | string | Yes | `image` \| `video` \| `audio` \| `document` |
| `mediaUrl` | string | One of | URL to fetch server-side |
| `mediaBase64` | string | One of | Base64-encoded bytes (may include `data:...;base64,` prefix) |
| `caption` | string | No | Text caption (image, video, document) |
| `filename` | string | No | Display filename for documents |
| `mimetype` | string | No | MIME type override |
| `ptt` | boolean | No | `true` = send audio as a voice note |

**Image example:**
```json
{
  "to": "120363204563219847@g.us",
  "type": "image",
  "mediaUrl": "https://example.com/photo.jpg",
  "caption": "Check this out"
}
```

**Document example:**
```json
{
  "to": "14155550123@s.whatsapp.net",
  "type": "document",
  "mediaUrl": "https://example.com/report.pdf",
  "filename": "report.pdf",
  "mimetype": "application/pdf",
  "caption": "Monthly report"
}
```

**Voice note example:**
```json
{
  "to": "14155550123@s.whatsapp.net",
  "type": "audio",
  "mediaBase64": "<base64 ogg bytes>",
  "ptt": true
}
```

**200 OK:**
```json
{ "id": "ABCDEF1234567890", "to": "14155550123@s.whatsapp.net" }
```

---

## POST /api/chats/:chatId/typing

Show or hide the WhatsApp "typing…" indicator in a chat. Useful for webhook-driven agents that want to signal work in progress before sending a reply.

`:chatId` — group JID or contact JID (or a phone number). **URL-encode** `@` as `%40`.

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | string | No | `composing` (show, default) or `paused` (hide) |
| `durationMs` | integer | No | Auto-stop after this many ms (composing only). Default 30000, capped at 300000 (5 min) |

While `composing`, the gateway refreshes the indicator automatically (WhatsApp drops it after ~10 s otherwise). Posting `composing` again resets the auto-stop window; sending a message or posting `paused` ends it early.

**Show typing for 30 s (default):**
```json
{ "state": "composing" }
```

**200 OK:**
```json
{ "chatId": "120363204563219847@g.us", "state": "composing", "durationMs": 30000 }
```

**Hide typing:**
```json
{ "state": "paused" }
```

**200 OK:**
```json
{ "chatId": "120363204563219847@g.us", "state": "paused" }
```

**400:** invalid `state`/`durationMs`, or the chat ID could not be resolved.

---

## GET /api/webhooks

List all registered webhooks.

```json
[
  {
    "id": "81b66e17-43b0-4482-bd3c-ca69ba96514b",
    "url": "https://my-agent.example.com/wa-hook",
    "chatId": "120363204563219847@g.us",
    "events": ["message"],
    "secret": "my-secret",
    "enabled": true,
    "createdAt": "2026-06-08T13:00:00.000Z"
  }
]
```

---

## POST /api/webhooks

Register a new webhook.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | HTTP(S) endpoint to POST events to |
| `chatId` | string | No | Scope to one group/contact JID; omit for all chats |
| `secret` | string | No | Sent as `X-Webhook-Secret` header on every delivery |
| `events` | string[] | No | Defaults to `["message"]` |

**201 Created** — returns the created webhook object.

**Delivery payload** (POSTed to your URL on each matching message):
```json
{
  "event": "message",
  "message": {
    "id": "ABCDEF1234567890",
    "chatId": "120363204563219847@g.us",
    "chatName": "Operations Team",
    "isGroup": true,
    "sender": "Bob",
    "senderId": "14155550002@s.whatsapp.net",
    "text": "New order received",
    "mediaType": null,
    "hasMedia": false,
    "mentionedJids": [],
    "fromMe": false,
    "ts": 1717858900000
  }
}
```

---

## DELETE /api/webhooks/:id

Delete a webhook by its `id`.

**200 OK:** `{ "ok": true }`
**404:** `{ "error": "Webhook not found" }`

---

## GET /api/codex/status

Returns Codex readiness, active config summary, workspace root, install guidance, and recent runs.

```json
{
  "ready": true,
  "sdkInstalled": true,
  "cliAvailable": true,
  "cliPath": "codex",
  "cliVersion": "codex 0.139.0",
  "enabled": true,
  "ruleCount": 2,
  "workspaceRoot": "/path/to/data/codex-workspaces",
  "installCommand": "npm install @openai/codex-sdk",
  "notes": [],
  "recentRuns": []
}
```

---

## GET /api/codex/config

Returns the full Codex agent config stored in `data/config.json`.

Important fields:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enables Codex routing globally |
| `defaultSandbox` | string | `read-only`, `workspace-write`, or `full-access` |
| `autoReply` | boolean | Sends Codex final responses back to WhatsApp |
| `workspaceRoot` | string | Optional override for chat workspaces |
| `defaultPrompt` | string | Prompt prepended to Codex runs |
| `rules` | CodexRule[] | Routing rules |

---

## PUT /api/codex/config

Update Codex agent settings. Partial objects are accepted.

```json
{
  "enabled": true,
  "defaultSandbox": "full-access",
  "autoReply": true,
  "networkAccessEnabled": true
}
```

---

## GET /api/codex/rules

List Codex routing rules.

---

## POST /api/codex/rules

Create a Codex routing rule.

```json
{
  "name": "Ops mentions",
  "enabled": true,
  "chatType": "group",
  "chatId": "120363204563219847@g.us",
  "allowedSenderIds": ["14155550001@s.whatsapp.net"],
  "keywords": ["deploy", "build failed"],
  "requireMention": true,
  "sandbox": "full-access",
  "autoReply": true,
  "prompt": "Be concise and create artifacts under artifacts/."
}
```

Match behavior:

- `chatType`: `all`, `group`, or `dm`
- `chatId`: optional exact group/contact JID
- `allowedSenderIds`: optional JIDs or phone digits
- `keywords`: optional case-insensitive substring matches
- `requireMention`: requires the linked WhatsApp user to be mentioned
- outgoing messages from the linked WhatsApp account are ignored

`full-access` is translated to Codex SDK `danger-full-access`.

---

## PUT /api/codex/rules/:id

Update a Codex routing rule by ID. Partial objects are accepted.

---

## DELETE /api/codex/rules/:id

Delete a Codex routing rule by ID.

---

## GET /api/codex/memory

Read the `memory.md` file for a chat workspace.

| Param | Type | Required | Description |
|---|---|---|---|
| `chatId` | string | Yes | Group/contact JID |
| `chatName` | string | No | Used when creating a new workspace |

```json
{
  "workspaceName": "operations-team-120363204563219847-g-us",
  "workspaceDir": "/path/to/data/codex-workspaces/operations-team-120363204563219847-g-us",
  "text": "# Memory\n\nDurable notes..."
}
```

---

## PUT /api/codex/memory

Write the `memory.md` file for a chat workspace.

```json
{
  "chatId": "120363204563219847@g.us",
  "chatName": "Operations Team",
  "isGroup": true,
  "text": "# Memory\n\n- Deploy target is production.\n"
}
```

---

## GET /api/codex/runs

Returns recent in-memory Codex run records for the current gateway process.

---

## GET /api/cron/status

Returns scheduler state, next-run summaries, recent runs, workspace root, and Codex readiness.

```json
{
  "enabled": true,
  "defaultTimezone": "America/New_York",
  "jobCount": 1,
  "runningJobIds": [],
  "rootDir": "/path/to/data/cron-jobs",
  "jobs": [{ "id": "daily-birthdays", "name": "Daily birthdays", "nextRunAt": "2026-06-11T10:00:00.000Z" }],
  "recentRuns": [],
  "codex": { "ready": true, "installCommand": "npm install @openai/codex-sdk" }
}
```

---

## GET /api/cron/config

Returns the scheduler config stored in `data/config.json`.

Important fields:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enables scheduled execution while the gateway is running |
| `defaultTimezone` | string | Timezone used when a job omits one |
| `jobs` | CronJob[] | Step-based job definitions |

---

## PUT /api/cron/config

Update scheduler settings. Partial objects are accepted.

```json
{
  "enabled": true,
  "defaultTimezone": "America/New_York"
}
```

---

## GET /api/cron/jobs

List scheduled jobs.

---

## POST /api/cron/jobs

Create a scheduled job.

```json
{
  "id": "daily-birthdays",
  "name": "Daily birthdays",
  "enabled": true,
  "schedule": { "expression": "0 6 * * *", "timezone": "America/New_York" },
  "previewOnly": false,
  "allowOverlap": false,
  "env": { "API_KEY": "BIRTHDAY_API_KEY" },
  "steps": [
    {
      "type": "http",
      "id": "fetch",
      "method": "GET",
      "url": "https://example.com/birthdays",
      "headers": { "authorization": "Bearer ${env:API_KEY}" },
      "saveAs": "birthdays"
    },
    {
      "type": "transform",
      "id": "today",
      "from": "birthdays.body.people",
      "filter": { "path": "birthdayIsToday", "equals": true },
      "saveAs": "people"
    },
    {
      "type": "codex",
      "id": "draft",
      "prompt": "Use ${steps.people} and memory.md to draft copy and create artifacts/image.png.",
      "sandbox": "workspace-write",
      "saveAs": "draft"
    },
    {
      "type": "whatsapp",
      "id": "send",
      "to": "120363204563219847@g.us",
      "text": "${steps.draft.text}",
      "mediaPath": "${steps.draft.imagePath}",
      "mediaType": "image"
    }
  ]
}
```

Supported step types:

- `http`: `method`, `url`, `headers`, `body`
- `transform`: `from`, optional `filter.path`/`filter.equals`, optional `pick`
- `script`: `command`, `timeoutMs`
- `codex`: `prompt`, optional `sandbox`, `model`, `outputSchema`
- `whatsapp`: `to`, `text`, optional `mediaPath`, `mediaType`, `caption`

Template tokens inside strings:

- `${env:ALIAS}` — resolves from job `env` aliases to process env values
- `${steps.stepId.path[0]}` — prior step output
- `${workspace:artifacts/file.png}` — absolute path in the job workspace
- `${job.id}` — job metadata

Secrets stay in environment variables. The config stores env var names, not secret values. WhatsApp sends happen automatically unless `previewOnly` is true on the job or step.

---

## GET /api/cron/jobs/:id

Read one scheduled job.

---

## PUT /api/cron/jobs/:id

Update one scheduled job. Partial objects are accepted.

---

## DELETE /api/cron/jobs/:id

Delete one scheduled job.

---

## POST /api/cron/jobs/:id/run

Run a job immediately. Returns a sanitized run record.

---

## GET /api/cron/jobs/:id/memory

Read `memory.md` for a job workspace.

```json
{
  "workspaceDir": "/path/to/data/cron-jobs/daily-birthdays",
  "text": "# Memory\n\nDurable notes..."
}
```

---

## PUT /api/cron/jobs/:id/memory

Write `memory.md` for a job workspace.

```json
{ "text": "# Memory\n\n- Use the media team birthday tone.\n" }
```

---

## GET /api/cron/runs

Returns recent in-memory scheduler run records for the current gateway process.

---

## POST /api/cron/chat

Ask Codex to review, create, update, delete, enable, disable, or run scheduler jobs through validated gateway operations.

```json
{
  "message": "Set up a weekday 6 AM birthday job that pulls the birthday API, lets Codex draft copy and create the image artifact, then sends it to the media group."
}
```

If Codex is not installed, the response includes install guidance.

---

## GET /api/media/:filename

Serve a media file that was downloaded from an incoming message.
Filenames are safe strings matching `[a-zA-Z0-9_.-]+`. Links appear in message objects as `mediaUrl`.

---

## JID formats

| Type | Format | Example |
|---|---|---|
| Group | `<digits>@g.us` | `120363204563219847@g.us` |
| Contact | `<digits>@s.whatsapp.net` | `14155550123@s.whatsapp.net` |

Always use the full JID (including `@` suffix) when calling send or read endpoints.
When embedding a JID in a URL path, encode `@` as `%40`.
