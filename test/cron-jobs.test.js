import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CronJobScheduler,
  defaultCronJobsConfig,
  getNextCronRun,
  getNextCronRuns,
  normalizeCronJobsConfig,
  redactSecrets,
  resolveTemplate,
} from "../src/cron-jobs.js"

test("normalizes cron job config with default timezone and step values", () => {
  const config = normalizeCronJobsConfig({
    enabled: true,
    defaultTimezone: "America/New_York",
    jobs: [
      {
        name: "Daily birthdays",
        schedule: { expression: "0 6 * * *" },
        env: { API_KEY: "BIRTHDAY_API_KEY" },
        steps: [{ type: "http", url: "https://example.com", saveAs: "birthdays" }],
      },
    ],
  })

  assert.equal(config.enabled, true)
  assert.equal(config.defaultTimezone, "America/New_York")
  assert.equal(config.jobs.length, 1)
  assert.equal(config.jobs[0].enabled, true)
  assert.equal(config.jobs[0].schedule.expression, "0 6 * * *")
  assert.equal(config.jobs[0].schedule.timezone, "America/New_York")
  assert.equal(config.jobs[0].steps[0].id, "step-1")
})

test("calculates next cron runs in a timezone", () => {
  const next = getNextCronRun("0 6 * * *", "America/New_York", new Date("2026-06-10T09:55:00.000Z"))
  assert.equal(next.toISOString(), "2026-06-10T10:00:00.000Z")

  const runs = getNextCronRuns("30 9 * * 1-5", "UTC", new Date("2026-06-12T09:31:00.000Z"), 2)
  assert.deepEqual(runs.map((date) => date.toISOString()), [
    "2026-06-15T09:30:00.000Z",
    "2026-06-16T09:30:00.000Z",
  ])
})

test("resolves templates from env, steps, workspace, and job", () => {
  const out = resolveTemplate("Bearer ${env:API_KEY} ${steps.user.name} ${workspace:artifacts/a.png} ${job.id}", {
    env: { API_KEY: "secret-token" },
    steps: { user: { name: "Ada" } },
    workspaceDir: "/tmp/job",
    job: { id: "job-1" },
  })

  assert.equal(out, "Bearer secret-token Ada /tmp/job/artifacts/a.png job-1")
})

test("redacts env secrets in nested outputs", () => {
  const redacted = redactSecrets(
    {
      headers: { authorization: "Bearer secret-token" },
      body: "secret-token appears twice secret-token",
      nested: ["safe", "other-secret"],
    },
    { API_KEY: "secret-token", OTHER: "other-secret" },
  )

  assert.deepEqual(redacted, {
    headers: { authorization: "Bearer [redacted:API_KEY]" },
    body: "[redacted:API_KEY] appears twice [redacted:API_KEY]",
    nested: ["safe", "[redacted:OTHER]"],
  })
})

test("WhatsApp steps send through the selected account", async () => {
  const calls = []
  const scheduler = new CronJobScheduler({
    config: defaultCronJobsConfig(),
    getBridge: (accountId) => {
      calls.push(["select", accountId])
      return { sendText: async (to, text) => ({ to, text, accountId }) }
    },
  })
  const step = { type: "whatsapp", accountId: "work", to: "123@s.whatsapp.net", text: "hello" }
  const result = await scheduler.runWhatsAppStep(step, { previewOnly: false }, {}, {})
  assert.deepEqual(calls, [["select", "work"]])
  assert.equal(result.sent[0].accountId, "work")
})

test("runs HTTP, transform, Codex artifact, and preview WhatsApp steps", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-jobs-test-"))
  const config = normalizeCronJobsConfig({
    enabled: true,
    jobs: [
      {
        id: "birthdays",
        name: "Birthdays",
        previewOnly: true,
        schedule: { expression: "0 6 * * *", timezone: "UTC" },
        env: { API_KEY: "API_KEY" },
        steps: [
          {
            type: "http",
            id: "fetch",
            method: "GET",
            url: "https://example.com/birthdays",
            headers: { authorization: "Bearer ${env:API_KEY}" },
            saveAs: "birthdays",
          },
          {
            type: "transform",
            id: "people",
            from: "birthdays.body.people",
            filter: { path: "birthdayIsToday", equals: true },
            saveAs: "people",
          },
          {
            type: "codex",
            id: "draft",
            prompt: "Draft for ${steps.people[0].name}",
            saveAs: "draft",
          },
          {
            type: "whatsapp",
            id: "send",
            to: "120363@g.us",
            text: "${steps.draft.text}",
            mediaPath: "${steps.draft.imagePath}",
            mediaType: "image",
          },
        ],
      },
    ],
  })
  const sent = []
  const scheduler = new CronJobScheduler({
    config,
    rootDir,
    env: { API_KEY: "secret-token" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () =>
        JSON.stringify({
          people: [
            { id: "ada", name: "Ada", birthdayIsToday: true },
            { id: "grace", name: "Grace", birthdayIsToday: false },
          ],
        }),
    }),
    codexRunner: async ({ prompt, workspaceDir }) => {
      assert.match(prompt, /Ada/)
      const imagePath = path.join(workspaceDir, "artifacts", "ada.png")
      await fs.mkdir(path.dirname(imagePath), { recursive: true })
      await fs.writeFile(imagePath, "png")
      return { text: "Happy birthday Ada!", imagePath }
    },
    bridge: {
      sendText: async (...args) => sent.push(["text", ...args]),
      sendMedia: async (...args) => sent.push(["media", ...args]),
    },
  })

  const run = await scheduler.runJobNow("birthdays")

  assert.equal(run.ok, true)
  assert.equal(run.previewOnly, true)
  assert.equal(run.outputs.people.length, 1)
  assert.equal(run.outputs.draft.text, "Happy birthday Ada!")
  assert.deepEqual(sent, [])
  assert.equal(run.steps.find((step) => step.id === "send").preview, true)
  assert.match(JSON.stringify(run), /\[redacted:API_KEY\]/)
  assert.doesNotMatch(JSON.stringify(run), /secret-token/)
})

test("prevents overlapping runs unless allowOverlap is enabled", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-overlap-test-"))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const scheduler = new CronJobScheduler({
    config: normalizeCronJobsConfig({
      jobs: [
        {
          id: "slow",
          name: "Slow",
          schedule: { expression: "* * * * *", timezone: "UTC" },
          steps: [{ type: "codex", id: "wait", prompt: "Wait", saveAs: "wait" }],
        },
      ],
    }),
    rootDir,
    codexRunner: async () => {
      await gate
      return { done: true }
    },
  })

  const first = scheduler.runJobNow("slow")
  const second = await scheduler.runJobNow("slow")
  release()
  const finished = await first

  assert.equal(second.ok, false)
  assert.match(second.error, /already running/i)
  assert.equal(finished.ok, true)
})

test("tick assigns the next future run for new jobs instead of firing immediately", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-next-run-test-"))
  let runCount = 0
  const scheduler = new CronJobScheduler({
    config: normalizeCronJobsConfig({
      enabled: true,
      jobs: [
        {
          id: "future",
          name: "Future",
          schedule: { expression: "0 6 * * *", timezone: "UTC" },
          steps: [{ type: "codex", id: "draft", prompt: "Draft", saveAs: "draft" }],
        },
      ],
    }),
    rootDir,
    codexRunner: async () => {
      runCount += 1
      return { text: "done" }
    },
  })

  const earlyRuns = await scheduler.tick(new Date("2026-06-10T05:00:00.000Z"))
  assert.equal(earlyRuns.length, 0)
  assert.equal(runCount, 0)
  assert.equal(scheduler.getJob("future").nextRunAt, "2026-06-10T06:00:00.000Z")

  const dueRuns = await scheduler.tick(new Date("2026-06-10T06:00:00.000Z"))
  assert.equal(dueRuns.length, 1)
  assert.equal(runCount, 1)
  assert.equal(dueRuns[0].ok, true)
})

test("default config is disabled with no jobs", () => {
  assert.deepEqual(defaultCronJobsConfig(), {
    enabled: false,
    defaultTimezone: "America/New_York",
    jobs: [],
  })
})
