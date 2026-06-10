# Gateway Cron Jobs Design

## Summary

Add a gateway-owned scheduler to the WhatsApp API Gateway. The scheduler runs only while the gateway process is running, stores jobs in the existing config/data model, exposes a sleek management UI, and lets Codex create, edit, review, and operate jobs through internal APIs.

The system must support general cron jobs, not only birthdays. The birthday automation is the benchmark use case: fetch a team birthday API every morning, draft a message with Codex, have Codex generate or edit the birthday image artifact from a template and profile photo, then send text and media to a WhatsApp group.

## Goals

- Manage scheduled jobs from `/ui` without relying on OS cron, launchd, or external process managers.
- Support recurring schedules with timezone-aware cron expressions and simple UI presets.
- Support job steps for HTTP calls, local scripts, Codex turns, JSON transforms, and WhatsApp sends.
- Let Codex chat inside the UI create, update, inspect, disable, and review scheduler jobs.
- Keep secrets out of `data/config.json`; jobs store environment variable names, and the gateway reads values from `.env`/process env at runtime.
- Persist job workspaces, memory, artifacts, run logs, and generated media under `data/cron-jobs/`.
- Default scheduled jobs to auto-send when successful, with a per-job preview-only/test mode.

## Non-Goals

- Do not install system-level cron entries in v1.
- Do not build a full workflow canvas in v1.
- Do not make birthday-specific code paths in the scheduler core.
- Do not expose secret values back through the UI or Codex chat transcript.
- Do not require a new frontend framework.

## Current Project Fit

The existing gateway already has the right primitives:

- `src/api-server.js` exposes plain-Node REST endpoints and serves the management UI.
- `src/config-store.js` stores normalized config in `data/config.json`.
- `src/whatsapp.js` can send text/media and receives normalized message rows.
- `src/codex-agent.js` already wraps the Codex SDK, manages workspaces/memory/thread state, and translates `full-access` to the SDK sandbox mode.
- `src/openapi.js` renders Swagger and the management UI without a framework.

The scheduler should follow this style: small modules, config-backed state, focused helpers with unit tests, and plain HTML/CSS/JS for the UI.

## Proposed Architecture

Create a new scheduler module, `src/cron-jobs.js`, responsible for:

- Normalizing job config.
- Calculating next run times.
- Running due jobs.
- Executing step types.
- Recording run history.
- Offering a narrow API for Codex/UI mutations.

The entry point wires the scheduler the same way it wires webhooks and the Codex router:

```text
WhatsAppBridge
  -> message APIs
  -> Codex router
  -> Cron scheduler
       -> HTTP/script/Codex/WhatsApp steps
       -> data/cron-jobs/<job-id>/
```

The scheduler starts when the gateway starts and stops when the gateway stops. It ticks every 30 seconds by default, finds due enabled jobs, and queues one run per job at a time to avoid overlapping executions unless the job explicitly allows overlap.

## Data Model

Add a `cronJobs` section to `data/config.json`:

```json
{
  "cronJobs": {
    "enabled": true,
    "defaultTimezone": "America/New_York",
    "jobs": []
  }
}
```

Each job:

```json
{
  "id": "birthday-media-team",
  "name": "Media team birthdays",
  "enabled": true,
  "description": "Daily birthday message and design workflow.",
  "schedule": {
    "mode": "cron",
    "expression": "0 6 * * *",
    "timezone": "America/New_York"
  },
  "previewOnly": false,
  "allowOverlap": false,
  "workspaceSubdir": "media-team-birthdays",
  "env": {
    "BIRTHDAY_API_KEY": "BIRTHDAY_API_KEY"
  },
  "steps": [],
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

Runtime files for each job:

```text
data/cron-jobs/<job-id>/
  memory.md
  artifacts/
  runs/<run-id>.json
  thread.json
```

`memory.md` holds durable job memory. `artifacts/` holds scripts, generated images, API responses, and intermediate files. `runs/*.json` records inputs, outputs, status, duration, errors, and WhatsApp send results. `thread.json` stores the persistent Codex thread ID for job-level Codex steps.

## Step Types

### HTTP Step

Calls an external API with method, URL, headers, query params, and body. Header/body values can reference environment variables using a safe syntax:

```json
{
  "type": "http",
  "id": "fetchBirthdays",
  "method": "GET",
  "url": "https://example.com/api/birthdays/today",
  "headers": {
    "Authorization": "Bearer ${env:BIRTHDAY_API_KEY}"
  },
  "saveAs": "birthdays"
}
```

The scheduler resolves `${env:NAME}` at runtime and never logs the secret value.

### Transform Step

Maps prior step output into a smaller object or list. V1 should support a limited JavaScript expression with a restricted input object, or a predefined `path/filter/map` model. To avoid unsafe arbitrary JS inside config, the recommended v1 is a small declarative transform:

```json
{
  "type": "transform",
  "id": "todaysBirthdays",
  "from": "birthdays.body.people",
  "filter": { "path": "birthdayIsToday", "equals": true },
  "saveAs": "people"
}
```

Script steps cover advanced custom transformations.

### Script Step

Runs a local command/script in the job workspace. It can read previous step outputs from JSON files and write outputs to a declared file.

```json
{
  "type": "script",
  "id": "normalizeStats",
  "command": "node scripts/normalize-stats.js",
  "timeoutMs": 120000,
  "saveStdoutAs": "stats"
}
```

The UI must show the command clearly before enabling the job.

### Codex Step

Runs Codex in the job workspace using the existing SDK patterns. It can use job memory, previous step outputs, and artifacts.

```json
{
  "type": "codex",
  "id": "draftMessage",
  "prompt": "Draft one warm birthday WhatsApp message for each person in ${steps.people}. Include one fact from ${steps.stats} when available.",
  "sandbox": "workspace-write",
  "model": "",
  "outputSchema": {
    "type": "object",
    "properties": {
      "messages": { "type": "array" }
    },
    "required": ["messages"],
    "additionalProperties": false
  },
  "saveAs": "drafts"
}
```

Codex can also operate the scheduler via internal APIs from the UI chat. That is separate from scheduled Codex steps.

### Codex Artifact Step Pattern

The scheduler does not need a separate image-generation step in v1. Image generation and editing should happen inside a Codex step, using the Codex SDK and the job workspace. The job prompt tells Codex where the template, profile photo, and output folder live, and Codex returns structured metadata for the produced artifact.

```json
{
  "type": "codex",
  "id": "birthdayDesign",
  "prompt": "Use artifacts/templates/birthday-template.png and ${steps.people[0].photoUrl} to create a birthday image for ${steps.people[0].name}. Save the final image under artifacts/birthday-${steps.people[0].id}.png and return its path.",
  "sandbox": "workspace-write",
  "outputSchema": {
    "type": "object",
    "properties": {
      "imagePath": { "type": "string" },
      "caption": { "type": "string" }
    },
    "required": ["imagePath", "caption"],
    "additionalProperties": false
  },
  "saveAs": "birthdayImage"
}
```

This keeps model/provider details inside Codex and avoids duplicating image generation capability in the gateway. The scheduler only needs to pass context, preserve artifacts, and let later steps reference the returned file path.

### WhatsApp Step

Sends text and/or media through the existing bridge.

```json
{
  "type": "whatsapp",
  "id": "sendBirthday",
  "to": "120363204563219847@g.us",
  "text": "${steps.drafts.messages[0].text}",
  "mediaPath": "${steps.birthdayImage.imagePath}",
  "mediaType": "image",
  "caption": "${steps.drafts.messages[0].caption}"
}
```

If `previewOnly` is true, this step records what would be sent but does not send.

## Codex Scheduler Chat

Add a “Scheduler Chat” panel in the Cron UI. It is a local operator chat backed by Codex and the job scheduler API. The chat can:

- List current jobs and recent runs.
- Create a new job from a natural-language request.
- Edit an existing job when the user says “update this cron job.”
- Explain why a job failed.
- Disable, enable, duplicate, or run a job now.

The chat should include scheduler context in the Codex prompt:

- Current job summaries.
- Recent run failures.
- Available step schemas.
- Allowed internal operations.
- A reminder that secrets must be referenced by env var name only.

Codex should mutate jobs by returning structured operation JSON that the gateway validates and applies. It should not directly edit `data/config.json`.

Example operation:

```json
{
  "operation": "upsert_job",
  "job": {
    "id": "media-team-birthdays",
    "name": "Media team birthdays",
    "enabled": true,
    "schedule": { "expression": "0 6 * * *", "timezone": "America/New_York" },
    "steps": []
  }
}
```

The UI keeps an audit trail of Codex-created and Codex-edited job changes. Jobs can be edited and reviewed after creation, but Codex is allowed to save changes directly.

## UI Design

Add a top-level `Cron` tab to `/ui`.

The tab should be dense and operational, not a marketing page. Suggested layout:

- Header row: scheduler enabled toggle, default timezone, “Run due now,” “New job.”
- Left column: searchable job list with status badges, next run, last run, enabled toggle.
- Main panel: selected job editor with tabs:
  - Overview: name, description, schedule builder, raw cron, timezone, preview-only, overlap policy.
  - Steps: ordered step editor with type-specific forms.
  - Runs: recent run table, logs, artifacts, retry button.
  - Memory: edit `memory.md`.
  - Chat: Codex scheduler chat.
- Right rail: next run preview, validation errors, env var requirements, and action buttons.

The UI should support both simple schedules and raw cron:

- Simple daily/weekly/monthly builder.
- Advanced cron expression field.
- Timezone selector/input.
- “Next 5 runs” preview calculated by the backend.

## Birthday Job Template

The birthday use case should be implemented as a sample/template job in docs or the UI, not as hard-coded scheduler behavior.

Flow:

1. `http` fetches today’s birthdays from the media team API using `${env:BIRTHDAY_API_KEY}`.
2. `transform` selects birthdays for the current date and normalizes `{ name, phone, photoUrl, role, stats }`.
3. `codex` drafts friendly birthday copy and short captions.
4. `codex` creates or edits the birthday image artifact in the job workspace using the template and profile photo.
5. `whatsapp` sends text plus the Codex-generated image to the configured WhatsApp group.
6. If there are no birthdays, the job records a successful no-op run.

This validates the scheduler against a realistic workflow while keeping the system reusable for other jobs.

## Error Handling

- A failed step stops the job unless `continueOnError` is true for that step.
- Every run records step status, timings, outputs, and sanitized errors.
- Secrets are redacted from logs with a fixed `[redacted:ENV_NAME]` marker.
- WhatsApp disconnected errors mark the run failed and visible in the UI.
- Codex unavailable errors show install/auth guidance from the existing Codex status helper.
- Codex artifact errors preserve the request context and generated logs without storing secret values.

## Security

- Secrets live in `.env` or process env only.
- Config stores env var names, not values.
- Job steps that run scripts or Codex full access are clearly labeled in the UI.
- Scheduled runs default to `workspace-write` unless a job explicitly sets `full-access`.
- The birthday template can use `full-access` only when the user chooses it.
- The scheduler ignores web/page instructions that try to reveal env vars.
- Codex scheduler chat applies validated structured operations, not raw file writes.

## Testing

Add unit tests for:

- Cron config normalization.
- Next-run calculation across timezones.
- Env placeholder resolution and redaction.
- Step execution order.
- Preview-only WhatsApp steps.
- No-overlap run locking.
- Codex chat operation validation.
- Birthday template job normalization.

Add integration-style tests using fake step executors for:

- Successful HTTP -> transform -> Codex artifact -> WhatsApp job.
- No birthdays no-op run.
- Failed API call stops job and records sanitized error.
- Disabled scheduler/job does not run.

Manual verification:

- `npm run check`
- `npm test`
- Start gateway with `WA_OPEN_DOCS=0 npm start`.
- Open `/ui`, create a preview-only job, run it now, inspect runs/artifacts, and confirm no WhatsApp send occurs.
- Enable a test WhatsApp send job to a known test chat and confirm delivery.

## OpenAI Docs Notes

- Codex SDK: use server-side `@openai/codex-sdk` threads and persistent thread IDs for job workspaces.
- Image/design work for scheduled jobs is handled by Codex inside the job workspace. The gateway does not need a separate Image API client in v1.
