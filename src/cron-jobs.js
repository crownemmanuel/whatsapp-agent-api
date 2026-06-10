import fs from "node:fs/promises"
import path from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import pino from "pino"

import {
  checkCodexInstallStatus,
  readThreadState,
  toCodexSdkSandboxMode,
  writeThreadState,
} from "./codex-agent.js"

const execAsync = promisify(exec)
const LOG = pino({ name: "whatsapp-cron-jobs", level: process.env.LOG_LEVEL || "info" })

const DEFAULT_TIMEZONE = "America/New_York"
const DEFAULT_CRON = "0 9 * * *"
const VALID_STEP_TYPES = new Set(["http", "transform", "script", "codex", "whatsapp"])
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "full-access"])
const MEDIA_TYPE_BY_EXT = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"],
  ".mp4": ["video", "video/mp4"],
  ".mov": ["video", "video/quicktime"],
  ".webm": ["video", "video/webm"],
  ".mp3": ["audio", "audio/mpeg"],
  ".m4a": ["audio", "audio/mp4"],
  ".ogg": ["audio", "audio/ogg; codecs=opus"],
  ".pdf": ["document", "application/pdf"],
}

export function defaultCronJobsConfig() {
  return {
    enabled: false,
    defaultTimezone: DEFAULT_TIMEZONE,
    jobs: [],
  }
}

export function normalizeCronJobsConfig(input) {
  const defaults = defaultCronJobsConfig()
  const safe = input && typeof input === "object" ? input : {}
  const defaultTimezone = safeTimezone(cleanString(safe.defaultTimezone) || defaults.defaultTimezone)
  return {
    enabled: safe.enabled === true,
    defaultTimezone,
    jobs: Array.isArray(safe.jobs)
      ? safe.jobs.map((job) => normalizeCronJob(job, defaultTimezone)).filter(Boolean)
      : [],
  }
}

export function normalizeCronJob(input, defaultTimezone = DEFAULT_TIMEZONE) {
  if (!input || typeof input !== "object") return null
  const id = slug(cleanString(input.id) || cleanString(input.name) || "job")
  const steps = Array.isArray(input.steps) ? input.steps : []
  const createdAt = cleanString(input.createdAt) || new Date().toISOString()
  return {
    id,
    name: cleanString(input.name) || id,
    enabled: input.enabled !== false,
    description: cleanString(input.description),
    schedule: normalizeSchedule(input.schedule, defaultTimezone),
    previewOnly: input.previewOnly === true,
    allowOverlap: input.allowOverlap === true,
    workspaceSubdir: slug(cleanString(input.workspaceSubdir) || id),
    env: normalizeEnvMap(input.env),
    steps: steps.map(normalizeStep).filter(Boolean),
    lastRunAt: cleanString(input.lastRunAt),
    nextRunAt: cleanString(input.nextRunAt),
    createdAt,
    updatedAt: cleanString(input.updatedAt) || createdAt,
  }
}

export function getNextCronRun(expression, timezone = DEFAULT_TIMEZONE, afterDate = new Date()) {
  const parsed = parseCronExpression(expression)
  const timeZone = safeTimezone(timezone)
  let candidate = new Date(afterDate)
  candidate.setUTCSeconds(0, 0)
  candidate = new Date(candidate.getTime() + 60000)

  const maxMinutes = 366 * 2 * 24 * 60
  for (let i = 0; i < maxMinutes; i += 1) {
    const parts = getZonedParts(candidate, timeZone)
    if (cronMatches(parsed, parts)) return candidate
    candidate = new Date(candidate.getTime() + 60000)
  }
  throw new Error(`Could not find next run for cron expression: ${expression}`)
}

export function getNextCronRuns(expression, timezone = DEFAULT_TIMEZONE, afterDate = new Date(), count = 5) {
  const runs = []
  let cursor = afterDate
  const total = Math.max(0, Math.min(Number(count) || 0, 20))
  for (let i = 0; i < total; i += 1) {
    const next = getNextCronRun(expression, timezone, cursor)
    runs.push(next)
    cursor = next
  }
  return runs
}

export function resolveTemplate(value, context = {}) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, context)]))
  }
  if (typeof value !== "string") return value

  return value.replace(/\$\{([^}]+)\}/g, (_match, token) => {
    const expression = String(token).trim()
    if (expression.startsWith("env:")) return stringifyTemplateValue(context.env?.[expression.slice(4)])
    if (expression.startsWith("workspace:")) return path.join(context.workspaceDir || "", expression.slice(10))
    if (expression.startsWith("job.")) return stringifyTemplateValue(getPath(context.job, expression.slice(4)))
    if (expression === "job") return stringifyTemplateValue(context.job)
    if (expression.startsWith("steps.")) return stringifyTemplateValue(getPath(context.steps, expression.slice(6)))
    if (expression === "steps") return stringifyTemplateValue(context.steps)
    return ""
  })
}

export function redactSecrets(value, envMap = {}) {
  const secrets = Object.entries(envMap)
    .map(([name, secret]) => [name, String(secret ?? "")])
    .filter(([, secret]) => secret.length > 0)
  return redactValue(value, secrets)
}

export class CronJobScheduler {
  constructor({
    config,
    rootDir,
    bridge = null,
    env = process.env,
    fetchImpl = globalThis.fetch,
    codexRunner = null,
    logger = LOG,
    saveConfig = null,
    tickMs = 30000,
  }) {
    this.config = normalizeCronJobsConfig(config)
    this.rootDir = rootDir
    this.bridge = bridge
    this.env = env
    this.fetchImpl = fetchImpl
    this.codexRunner = codexRunner
    this.logger = logger
    this.saveConfig = saveConfig
    this.tickMs = tickMs
    this.timer = null
    this.running = new Map()
    this.recentRuns = []
  }

  updateConfig(config) {
    this.config = normalizeCronJobsConfig(config)
    if (this.config.enabled) this.start()
    else this.stop()
  }

  start() {
    if (this.timer || !this.config.enabled) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(now = new Date()) {
    return {
      enabled: this.config.enabled,
      defaultTimezone: this.config.defaultTimezone,
      jobCount: this.config.jobs.length,
      runningJobIds: Array.from(this.running.keys()),
      jobs: this.config.jobs.map((job) => this.summarizeJob(job, now)),
      recentRuns: this.listRuns(),
    }
  }

  listJobs() {
    return this.config.jobs
  }

  getJob(jobId) {
    return this.config.jobs.find((item) => item.id === jobId) || null
  }

  listRuns() {
    return this.recentRuns.slice(-100).reverse()
  }

  async saveSchedulerConfig(input) {
    const safe = input && typeof input === "object" ? input : {}
    this.config = normalizeCronJobsConfig({
      ...this.config,
      ...safe,
      jobs: safe.jobs === undefined ? this.config.jobs : safe.jobs,
    })
    return this.persistConfig()
  }

  async upsertJob(input) {
    const safe = input && typeof input === "object" ? input : {}
    const existing = cleanString(safe.id) ? this.getJob(slug(safe.id)) : null
    const job = normalizeCronJob(
      {
        ...(existing || {}),
        ...safe,
        id: safe.id || existing?.id,
        createdAt: existing?.createdAt || safe.createdAt,
        updatedAt: new Date().toISOString(),
      },
      this.config.defaultTimezone,
    )
    if (!job) return null

    const jobs = this.config.jobs.slice()
    const index = jobs.findIndex((item) => item.id === job.id)
    if (index >= 0) jobs[index] = job
    else jobs.push(job)
    this.config = normalizeCronJobsConfig({ ...this.config, jobs })
    await this.persistConfig()
    return this.getJob(job.id)
  }

  async removeJob(jobId) {
    const id = slug(jobId)
    const jobs = this.config.jobs.filter((job) => job.id !== id)
    if (jobs.length === this.config.jobs.length) return false
    this.config = normalizeCronJobsConfig({ ...this.config, jobs })
    await this.persistConfig()
    return true
  }

  async applyChatOperation(operation = {}) {
    const action = cleanString(operation.action || operation.operation || "review").toLowerCase()
    const message = cleanString(operation.message)
    const rawJobId = cleanString(operation.jobId || operation.id || operation.job?.id || "")
    const jobId = rawJobId ? slug(rawJobId) : ""

    if (action === "create_job") {
      const job = await this.upsertJob(operation.job || {})
      return job
        ? { changed: true, message: message || `Created cron job ${job.name}.`, job }
        : { changed: false, message: message || "I could not create that cron job." }
    }

    if (action === "update_job") {
      const existing = this.getJob(jobId)
      if (!existing) return { changed: false, message: `Cron job not found: ${jobId}` }
      const job = await this.upsertJob({ ...existing, ...(operation.patch || operation.job || {}), id: existing.id })
      return { changed: true, message: message || `Updated cron job ${job.name}.`, job }
    }

    if (action === "delete_job") {
      const removed = await this.removeJob(jobId)
      return {
        changed: removed,
        message: removed ? message || `Deleted cron job ${jobId}.` : `Cron job not found: ${jobId}`,
      }
    }

    if (action === "enable_job" || action === "disable_job") {
      const existing = this.getJob(jobId)
      if (!existing) return { changed: false, message: `Cron job not found: ${jobId}` }
      const job = await this.upsertJob({ ...existing, enabled: action === "enable_job" })
      return { changed: true, message: message || `${job.enabled ? "Enabled" : "Disabled"} ${job.name}.`, job }
    }

    if (action === "set_scheduler") {
      const config = await this.saveSchedulerConfig(operation.config || {})
      return { changed: true, message: message || "Updated scheduler settings.", config }
    }

    if (action === "run_job") {
      const run = await this.runJobNow(jobId, "chat")
      return { changed: false, message: message || `Ran ${jobId}.`, run }
    }

    if (action === "update_memory") {
      if (!jobId) return { changed: false, message: "Choose a job before updating memory." }
      const memory = await this.writeMemory(jobId, operation.memoryText || "")
      return { changed: true, message: message || `Updated memory for ${jobId}.`, memory }
    }

    return {
      changed: false,
      message:
        message ||
        "I reviewed the scheduler. Use create_job, update_job, delete_job, enable_job, disable_job, run_job, set_scheduler, or update_memory to make changes.",
      status: this.status(),
    }
  }

  async chat({ message } = {}) {
    const userMessage = cleanString(message)
    if (!userMessage) return { ok: false, message: "Message is required." }

    const status = await checkCodexInstallStatus()
    if (!status.ready) {
      return {
        ok: false,
        message: `Codex is not ready. Install it with: ${status.installCommand}`,
        status,
      }
    }

    const workspace = await ensureSchedulerChatWorkspace(this.rootDir)
    const threadState = await readThreadState(workspace.threadPath)
    const memoryText = await readTextFile(workspace.memoryPath)
    const { Codex } = await import("@openai/codex-sdk")
    const codex = new Codex()
    const threadOptions = {
      workingDirectory: workspace.workspaceDir,
      skipGitRepoCheck: true,
      sandboxMode: toCodexSdkSandboxMode("workspace-write"),
      approvalPolicy: "never",
      networkAccessEnabled: true,
    }
    const thread = threadState.threadId ? codex.resumeThread(threadState.threadId, threadOptions) : codex.startThread(threadOptions)
    const result = await thread.run(buildSchedulerChatPrompt(userMessage, this.config, this.status(), memoryText), {
      outputSchema: schedulerChatOutputSchema(),
    })
    if (thread.id) await writeThreadState(workspace.threadPath, { threadId: thread.id, updatedAt: new Date().toISOString() })
    const operation = parseChatOperation(result.finalResponse)
    if (!operation) {
      return {
        ok: true,
        changed: false,
        message: cleanString(result.finalResponse) || "Codex reviewed the scheduler but did not return an operation.",
        finalResponse: cleanString(result.finalResponse),
      }
    }
    const applied = await this.applyChatOperation(operation)
    return {
      ok: true,
      changed: applied.changed === true,
      message: applied.message,
      operation,
      applied,
      finalResponse: cleanString(result.finalResponse),
    }
  }

  async tick(now = new Date()) {
    if (!this.config.enabled) return []
    const runs = []
    let assignedNextRun = false
    for (const job of this.config.jobs) {
      if (!job.enabled) continue
      let nextRunAt = job.nextRunAt
      if (!nextRunAt) {
        const basis = job.lastRunAt ? new Date(job.lastRunAt) : now
        nextRunAt = getNextCronRun(job.schedule.expression, job.schedule.timezone, basis).toISOString()
        job.nextRunAt = nextRunAt
        assignedNextRun = true
      }
      if (new Date(nextRunAt).getTime() <= now.getTime()) {
        runs.push(await this.runJobNow(job.id, "schedule", now))
      }
    }
    if (assignedNextRun) await this.persistConfig()
    return runs
  }

  async runJobNow(jobId, trigger = "manual", now = new Date()) {
    const job = this.config.jobs.find((item) => item.id === jobId)
    if (!job) return failedRun(jobId, trigger, `Cron job not found: ${jobId}`, now)

    if (this.running.has(job.id) && !job.allowOverlap) {
      return failedRun(job.id, trigger, `Cron job is already running: ${job.name}`, now, job.name)
    }

    const promise = this.executeJob(job, trigger, now)
    this.running.set(job.id, promise)
    try {
      return await promise
    } finally {
      if (this.running.get(job.id) === promise) this.running.delete(job.id)
    }
  }

  async executeJob(job, trigger = "manual", now = new Date()) {
    const workspace = await ensureJobWorkspace(this.rootDir, job)
    const env = resolveJobEnv(job.env, this.env)
    const run = {
      id: runId(),
      jobId: job.id,
      jobName: job.name,
      trigger,
      startedAt: now.toISOString(),
      finishedAt: null,
      ok: false,
      previewOnly: job.previewOnly,
      workspaceDir: workspace.workspaceDir,
      steps: [],
      outputs: {},
      error: "",
    }

    try {
      const context = { env, steps: run.outputs, job, workspaceDir: workspace.workspaceDir, run }
      for (const step of job.steps) {
        const result = await this.executeStep(step, job, workspace, context)
        run.steps.push(redactSecrets(result.stepRecord, env))
        if (step.saveAs) run.outputs[step.saveAs] = result.output
        if (!result.stepRecord.ok && !step.continueOnError) {
          throw new Error(result.stepRecord.error || `Step failed: ${step.id}`)
        }
      }
      run.ok = true
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err)
    } finally {
      run.finishedAt = new Date().toISOString()
      const sanitized = redactSecrets(run, env)
      this.rememberRun(sanitized)
      await writeRunRecord(workspace.runsDir, sanitized)
      await this.markJobRun(job, sanitized, new Date(run.finishedAt))
      return sanitized
    }
  }

  async executeStep(step, job, workspace, context) {
    const startedAt = new Date().toISOString()
    const stepRecord = { id: step.id, type: step.type, startedAt, finishedAt: null, ok: false, error: "" }
    try {
      const output = await this.runStep(step, job, workspace, context)
      stepRecord.ok = true
      stepRecord.output = output
      if (output?.preview === true) stepRecord.preview = true
      return { output, stepRecord }
    } catch (err) {
      stepRecord.error = err instanceof Error ? err.message : String(err)
      return { output: null, stepRecord }
    } finally {
      stepRecord.finishedAt = new Date().toISOString()
    }
  }

  async runStep(step, job, workspace, context) {
    if (step.type === "http") return this.runHttpStep(step, context)
    if (step.type === "transform") return runTransformStep(step, context)
    if (step.type === "script") return runScriptStep(step, workspace, context)
    if (step.type === "codex") return this.runCodexStep(step, workspace, context)
    if (step.type === "whatsapp") return this.runWhatsAppStep(step, job, workspace, context)
    throw new Error(`Unsupported step type: ${step.type}`)
  }

  async runHttpStep(step, context) {
    if (!this.fetchImpl) throw new Error("fetch is not available")
    const url = resolveTemplate(step.url, context)
    const headers = resolveTemplate(step.headers || {}, context)
    const body = step.body === undefined ? undefined : resolveTemplate(step.body, context)
    const resp = await this.fetchImpl(url, {
      method: step.method || "GET",
      headers,
      body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    })
    const text = await resp.text()
    const contentType = getHeader(resp.headers, "content-type")
    return {
      request: {
        url,
        method: step.method || "GET",
        headers,
      },
      ok: Boolean(resp.ok),
      status: resp.status,
      headers: headersToObject(resp.headers),
      body: contentType.includes("application/json") ? safeJson(text) : text,
    }
  }

  async runCodexStep(step, workspace, context) {
    const prompt = resolveTemplate(step.prompt, context)
    if (this.codexRunner) {
      return this.codexRunner({ step, prompt, workspaceDir: workspace.workspaceDir, context })
    }

    const status = await checkCodexInstallStatus()
    if (!status.ready) throw new Error(`Codex is not ready. Install it with: ${status.installCommand}`)

    const { Codex } = await import("@openai/codex-sdk")
    const threadState = await readThreadState(workspace.threadPath)
    const codex = new Codex()
    const options = {
      workingDirectory: workspace.workspaceDir,
      skipGitRepoCheck: true,
      sandboxMode: toCodexSdkSandboxMode(step.sandbox || "workspace-write"),
      approvalPolicy: step.approvalPolicy || "never",
      networkAccessEnabled: step.networkAccessEnabled !== false,
    }
    if (step.model) options.model = step.model
    const thread = threadState.threadId ? codex.resumeThread(threadState.threadId, options) : codex.startThread(options)
    const result = await thread.run(prompt, step.outputSchema ? { outputSchema: step.outputSchema } : {})
    if (thread.id) await writeThreadState(workspace.threadPath, { threadId: thread.id, updatedAt: new Date().toISOString() })
    return parseCodexOutput(result.finalResponse)
  }

  async runWhatsAppStep(step, job, workspace, context) {
    const to = resolveTemplate(step.to, context)
    const text = resolveTemplate(step.text, context)
    const mediaPath = resolveTemplate(step.mediaPath, context)
    const caption = resolveTemplate(step.caption, context)
    const preview = job.previewOnly === true || step.previewOnly === true
    if (preview) return { preview: true, to, text, mediaPath, caption }
    if (!this.bridge) throw new Error("WhatsApp bridge is not available")

    const sent = []
    if (text) sent.push({ kind: "text", ...(await this.bridge.sendText(to, text)) })
    if (mediaPath) {
      const filePath = resolveWorkspaceFile(workspace.workspaceDir, mediaPath)
      const buffer = await fs.readFile(filePath)
      const [type, mimetype] = mediaKind(filePath, step.mediaType)
      sent.push({
        kind: "media",
        ...(await this.bridge.sendMedia(to, {
          type,
          buffer,
          caption: caption || undefined,
          mimetype,
          filename: path.basename(filePath),
        })),
      })
    }
    return { preview: false, sent }
  }

  summarizeJob(job, now = new Date()) {
    return {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      description: job.description,
      schedule: job.schedule,
      previewOnly: job.previewOnly,
      allowOverlap: job.allowOverlap,
      stepCount: job.steps.length,
      lastRunAt: job.lastRunAt,
      nextRunAt: safeNextRun(job, now),
    }
  }

  async markJobRun(job, run, afterDate = new Date()) {
    job.lastRunAt = run.startedAt
    job.nextRunAt = run.ok ? getNextCronRun(job.schedule.expression, job.schedule.timezone, afterDate).toISOString() : job.nextRunAt
    job.updatedAt = new Date().toISOString()
    await this.persistConfig()
  }

  async persistConfig() {
    if (this.saveConfig) {
      const saved = await this.saveConfig(this.config)
      if (saved) this.config = normalizeCronJobsConfig(saved)
    }
    if (this.config.enabled) this.start()
    else this.stop()
    return this.config
  }

  rememberRun(run) {
    this.recentRuns.push(run)
    if (this.recentRuns.length > 100) this.recentRuns.splice(0, this.recentRuns.length - 100)
  }

  async readMemory(jobId) {
    const job = this.config.jobs.find((item) => item.id === jobId)
    if (!job) throw new Error(`Cron job not found: ${jobId}`)
    const workspace = await ensureJobWorkspace(this.rootDir, job)
    return {
      workspaceDir: workspace.workspaceDir,
      text: await readTextFile(workspace.memoryPath),
    }
  }

  async writeMemory(jobId, text) {
    const job = this.config.jobs.find((item) => item.id === jobId)
    if (!job) throw new Error(`Cron job not found: ${jobId}`)
    const workspace = await ensureJobWorkspace(this.rootDir, job)
    await fs.writeFile(workspace.memoryPath, `${String(text || "").trim()}\n`, "utf8")
    return this.readMemory(jobId)
  }
}

async function runScriptStep(step, workspace, context) {
  const command = resolveTemplate(step.command, context)
  if (!command) throw new Error("Script step requires `command`")
  const { stdout, stderr } = await execAsync(command, {
    cwd: workspace.workspaceDir,
    timeout: step.timeoutMs,
    env: { ...process.env, ...context.env },
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout, stderr }
}

function runTransformStep(step, context) {
  let value = getPath(context.steps, step.from)
  if (Array.isArray(value) && step.filter) {
    value = value.filter((item) => getPath(item, step.filter.path) === step.filter.equals)
  }
  if (step.pick) value = getPath(value, step.pick)
  return value
}

export async function ensureJobWorkspace(rootDir, job) {
  const workspaceDir = path.join(rootDir, job.workspaceSubdir || job.id)
  const artifactsDir = path.join(workspaceDir, "artifacts")
  const runsDir = path.join(workspaceDir, "runs")
  await fs.mkdir(artifactsDir, { recursive: true })
  await fs.mkdir(runsDir, { recursive: true })
  const memoryPath = path.join(workspaceDir, "memory.md")
  try {
    await fs.access(memoryPath)
  } catch {
    await fs.writeFile(memoryPath, `# Memory\n\nDurable notes for ${job.name || job.id}.\n`, "utf8")
  }
  return {
    workspaceDir,
    artifactsDir,
    runsDir,
    memoryPath,
    threadPath: path.join(workspaceDir, "thread.json"),
  }
}

async function ensureSchedulerChatWorkspace(rootDir) {
  const workspaceDir = path.join(rootDir, "_scheduler-chat")
  await fs.mkdir(workspaceDir, { recursive: true })
  const memoryPath = path.join(workspaceDir, "memory.md")
  try {
    await fs.access(memoryPath)
  } catch {
    await fs.writeFile(
      memoryPath,
      "# Scheduler Chat Memory\n\nDurable notes for managing gateway cron jobs.\n",
      "utf8",
    )
  }
  return {
    workspaceDir,
    memoryPath,
    threadPath: path.join(workspaceDir, "thread.json"),
  }
}

function buildSchedulerChatPrompt(userMessage, config, status, memoryText) {
  return `You are Codex helping manage cron jobs inside a WhatsApp API gateway.

The gateway will apply only the JSON operation you return. Do not edit data/config.json directly.
Secrets must stay in environment variables. Job config may store env aliases like { "API_KEY": "BIRTHDAY_API_KEY" }, but never store secret values.
Scheduled jobs run only while the gateway process is running. WhatsApp sending is normally automatic; use previewOnly only when the user asks for review/dry-run behavior.
Use codex steps for drafting, file generation, image/artifact work, API analysis, and computer tasks. Files should live under the job workspace, especially artifacts/.

Supported actions:
- review
- set_scheduler with config { enabled, defaultTimezone }
- create_job with job
- update_job with jobId and patch
- delete_job with jobId
- enable_job with jobId
- disable_job with jobId
- run_job with jobId
- update_memory with jobId and memoryText

Supported job step types:
- http: { type, id, method, url, headers, body, saveAs }
- transform: { type, id, from, filter: { path, equals }, pick, saveAs }
- script: { type, id, command, timeoutMs, saveAs }
- codex: { type, id, prompt, sandbox, model, outputSchema, saveAs }
- whatsapp: { type, id, to, text, mediaPath, mediaType, caption, previewOnly }

Template tokens available inside strings:
- \${env:ALIAS}
- \${steps.stepName.path[0]}
- \${workspace:artifacts/file.png}
- \${job.id}

Current scheduler status:
${JSON.stringify(status, null, 2)}

Current config:
${JSON.stringify(config, null, 2)}

Scheduler chat memory:
${memoryText || "(empty)"}

User request:
${userMessage}

Return only JSON matching the schema. For review-only requests, use action "review" and a concise message.`
}

function schedulerChatOutputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      action: {
        type: "string",
        enum: [
          "review",
          "set_scheduler",
          "create_job",
          "update_job",
          "delete_job",
          "enable_job",
          "disable_job",
          "run_job",
          "update_memory",
        ],
      },
      message: { type: "string" },
      jobId: { type: "string" },
      config: { type: "object", additionalProperties: true },
      job: { type: "object", additionalProperties: true },
      patch: { type: "object", additionalProperties: true },
      memoryText: { type: "string" },
    },
    required: ["action", "message"],
  }
}

function parseChatOperation(text) {
  const raw = cleanString(text)
  if (!raw) return null
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim(),
    raw.match(/\{[\s\S]*\}/)?.[0] || "",
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
    } catch {}
  }
  return null
}

async function writeRunRecord(runsDir, run) {
  await fs.mkdir(runsDir, { recursive: true })
  await fs.writeFile(path.join(runsDir, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8")
}

function normalizeSchedule(input, defaultTimezone) {
  const safe = input && typeof input === "object" ? input : {}
  return {
    mode: "cron",
    expression: cleanString(safe.expression) || DEFAULT_CRON,
    timezone: safeTimezone(cleanString(safe.timezone) || defaultTimezone || DEFAULT_TIMEZONE),
  }
}

function normalizeStep(input, index) {
  if (!input || typeof input !== "object") return null
  const type = cleanString(input.type).toLowerCase()
  if (!VALID_STEP_TYPES.has(type)) return null
  const id = slug(cleanString(input.id) || `step-${index + 1}`)
  const step = {
    ...input,
    id,
    type,
    saveAs: cleanString(input.saveAs) || id,
    continueOnError: input.continueOnError === true,
  }
  if (type === "http") {
    step.method = cleanString(input.method || "GET").toUpperCase()
    step.url = cleanString(input.url)
    step.headers = input.headers && typeof input.headers === "object" ? input.headers : {}
  }
  if (type === "script") {
    step.command = cleanString(input.command)
    step.timeoutMs = clampInt(input.timeoutMs, 1000, 10 * 60 * 1000, 120000)
  }
  if (type === "codex") {
    step.prompt = cleanString(input.prompt)
    step.sandbox = normalizeSandbox(input.sandbox)
  }
  if (type === "whatsapp") {
    step.to = cleanString(input.to)
    step.mediaType = cleanString(input.mediaType)
  }
  return step
}

function parseCronExpression(expression) {
  const parts = cleanString(expression).split(/\s+/)
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: ${expression}`)
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    day: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    weekday: parseCronField(parts[4], 0, 7).map((value) => (value === 7 ? 0 : value)),
  }
}

function parseCronField(field, min, max) {
  const out = new Set()
  for (const segment of cleanString(field || "*").split(",")) {
    const [rangePart, stepPart] = segment.split("/")
    const step = Math.max(1, Number(stepPart) || 1)
    let start = min
    let end = max
    if (rangePart !== "*") {
      const [rawStart, rawEnd] = rangePart.split("-")
      start = Number(rawStart)
      end = rawEnd === undefined ? start : Number(rawEnd)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Invalid cron field: ${field}`)
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) out.add(value)
    }
  }
  return Array.from(out).sort((a, b) => a - b)
}

function cronMatches(parsed, parts) {
  return (
    parsed.minute.includes(parts.minute) &&
    parsed.hour.includes(parts.hour) &&
    parsed.day.includes(parts.day) &&
    parsed.month.includes(parts.month) &&
    parsed.weekday.includes(parts.weekday)
  )
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(date)
  const obj = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  return {
    month: Number(obj.month),
    day: Number(obj.day),
    hour: Number(obj.hour),
    minute: Number(obj.minute),
    weekday: weekdayNumber(obj.weekday),
  }
}

function safeTimezone(timezone) {
  const value = cleanString(timezone) || DEFAULT_TIMEZONE
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date())
    return value
  } catch {
    return DEFAULT_TIMEZONE
  }
}

function weekdayNumber(value) {
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[value] ?? 0
}

function normalizeEnvMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [cleanString(key), cleanString(value)])
      .filter(([key, value]) => key && value),
  )
}

function resolveJobEnv(envMap, sourceEnv) {
  const out = {}
  for (const [alias, envName] of Object.entries(envMap || {})) {
    out[alias] = sourceEnv?.[envName] || ""
  }
  return out
}

function redactValue(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, [name, secret]) => text.split(secret).join(`[redacted:${name}]`),
      value,
    )
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  }
  return value
}

function getPath(obj, pathExpression) {
  if (!pathExpression) return obj
  const parts = String(pathExpression).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)
  let cursor = obj
  for (const part of parts) {
    if (cursor == null) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function stringifyTemplateValue(value) {
  if (value == null) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function headersToObject(headers) {
  if (!headers) return {}
  if (typeof headers.forEach === "function") {
    const out = {}
    headers.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries())
  return {}
}

function getHeader(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return String(headers.get(name) || "")
  if (headers instanceof Map) return String(headers.get(name) || "")
  return String(headers[name] || headers[name.toLowerCase()] || "")
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseCodexOutput(text) {
  const raw = cleanString(text)
  if (!raw) return { text: "" }
  try {
    return JSON.parse(raw)
  } catch {
    return { text: raw }
  }
}

function mediaKind(filePath, explicitType) {
  const requested = cleanString(explicitType)
  const ext = path.extname(filePath).toLowerCase()
  const [type, mimetype] = MEDIA_TYPE_BY_EXT[ext] || ["document", "application/octet-stream"]
  return [requested || type, mimetype]
}

function resolveWorkspaceFile(workspaceDir, filePath) {
  const root = path.resolve(workspaceDir)
  const resolved = path.resolve(root, String(filePath || ""))
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`File must stay inside the job workspace: ${filePath}`)
  }
  return resolved
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (err) {
    if (err?.code === "ENOENT") return ""
    throw err
  }
}

function failedRun(jobId, trigger, error, date = new Date(), jobName = "") {
  return {
    id: runId(),
    jobId,
    jobName,
    trigger,
    startedAt: date.toISOString(),
    finishedAt: date.toISOString(),
    ok: false,
    previewOnly: false,
    workspaceDir: "",
    steps: [],
    outputs: {},
    error,
  }
}

function safeNextRun(job, now) {
  try {
    return getNextCronRun(job.schedule.expression, job.schedule.timezone, now).toISOString()
  } catch {
    return ""
  }
}

function normalizeSandbox(value) {
  const sandbox = cleanString(value)
  return VALID_SANDBOXES.has(sandbox) ? sandbox : "workspace-write"
}

function slug(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "job"
}

function cleanString(value) {
  return String(value ?? "").trim()
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function runId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
