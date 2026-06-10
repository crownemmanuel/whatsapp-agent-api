# Gateway Cron Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a gateway-owned scheduler that can run general step-based jobs, expose them in the Web UI, and let Codex operate job config through validated scheduler APIs.

**Architecture:** Add `src/cron-jobs.js` for config normalization, schedule calculation, job execution, run history, and Codex chat operations. Wire it through `src/config-store.js`, `src/index.js`, `src/api-server.js`, and `src/openapi.js` using the existing plain-Node patterns. Use focused `node:test` tests and avoid a separate image API client; Codex artifact generation is a Codex step pattern.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `fetch`, `child_process`, `Intl.DateTimeFormat`, existing `@openai/codex-sdk`, existing Baileys bridge.

---

### Task 1: Scheduler Core

**Files:**
- Create: `src/cron-jobs.js`
- Create: `test/cron-jobs.test.js`

- [x] Write failing tests for default config normalization, job normalization, cron next-run calculation, env placeholder redaction, transform filtering, preview-only WhatsApp steps, and no-overlap locking.
- [x] Implement the smallest `src/cron-jobs.js` API to pass those tests:
  - `defaultCronJobsConfig()`
  - `normalizeCronJobsConfig(input)`
  - `normalizeCronJob(input)`
  - `getNextCronRun(expression, timezone, afterDate)`
  - `getNextCronRuns(expression, timezone, afterDate, count)`
  - `resolveTemplate(value, context)`
  - `redactSecrets(value, envMap)`
  - `CronJobScheduler`
- [x] Run `npm test test/cron-jobs.test.js` and then `npm test`.

### Task 2: Runtime Step Execution

**Files:**
- Modify: `src/cron-jobs.js`
- Modify: `test/cron-jobs.test.js`

- [x] Add tests for HTTP, script, Codex, and WhatsApp step execution using fake executors/bridge.
- [x] Implement step handlers:
  - `http`: call `fetch`, save body/status/headers.
  - `transform`: path + equals filter.
  - `script`: run command in workspace with timeout.
  - `codex`: run SDK thread in the job workspace with optional output schema.
  - `whatsapp`: send text/media unless `previewOnly`.
- [x] Store sanitized run records under `data/cron-jobs/<job>/runs/<run>.json`.
- [x] Run focused and full tests.

### Task 3: Config, API, And Index Wiring

**Files:**
- Modify: `src/config-store.js`
- Modify: `src/index.js`
- Modify: `src/api-server.js`
- Modify: `src/openapi.js`
- Modify: `package.json`

- [x] Add `cronJobs` to default/normalized config and add `getCronJobsRoot()`.
- [x] Instantiate `CronJobScheduler` in `src/index.js`, start it after the API server is created, and stop it on shutdown.
- [x] Add REST endpoints:
  - `GET /api/cron/status`
  - `GET/PUT /api/cron/config`
  - `GET/POST /api/cron/jobs`
  - `GET/PUT/DELETE /api/cron/jobs/:id`
  - `POST /api/cron/jobs/:id/run`
  - `GET/PUT /api/cron/jobs/:id/memory`
  - `POST /api/cron/chat`
- [x] Add `src/cron-jobs.js` to `npm run check`.
- [x] Run `npm run check` and `npm test`.

### Task 4: Management UI

**Files:**
- Modify: `src/openapi.js`

- [x] Add a top-level `Cron` tab with scheduler toggle, timezone, job list, job editor, step JSON editor, run history, memory editor, and Codex scheduler chat.
- [x] Keep the UI dense and operational, matching the current dark management UI.
- [x] Add client-side functions for loading/saving config, creating/updating/deleting/running jobs, loading/saving memory, and sending chat prompts.
- [x] Verify with the in-app browser on `/ui`.

### Task 5: Docs And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `skills/whatsapp-api/SKILL.md`
- Modify: `skills/whatsapp-api/references/API_REFERENCE.md`

- [x] Document scheduler concepts, endpoints, `.env` secret handling, preview-only mode, and the birthday template flow.
- [x] Run `npm run check`.
- [x] Run `npm test`.
- [x] Start a temporary `createApiServer` UI on port 3401 because port 3399 was already occupied, verify `/ui` Cron tab loads with no browser console errors, then stop the server.
- [x] Commit implementation.
