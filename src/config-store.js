import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { defaultCodexAgentConfig, normalizeCodexAgentConfig } from "./codex-agent.js"
import { defaultCronJobsConfig, normalizeCronJobsConfig } from "./cron-jobs.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "..")
const DATA_DIR = path.join(ROOT, "data")
const CONFIG_PATH = path.join(DATA_DIR, "config.json")

export function defaultConfig() {
  return {
    apiPort: 3399,
    openDocsOnStart: true,
    webhooks: [],
    codexAgent: defaultCodexAgentConfig(),
    cronJobs: defaultCronJobsConfig(),
  }
}

export async function loadConfig() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8")
    return normalizeConfig(JSON.parse(raw))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const config = defaultConfig()
      await saveConfig(config)
      return config
    }
    throw error
  }
}

export async function saveConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const normalized = normalizeConfig(config)
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  return normalized
}

export function getSessionDir() {
  return path.join(ROOT, "baileys-auth")
}

export function getAccountsRoot() {
  return path.join(DATA_DIR, "accounts")
}

export function getMediaDir() {
  return path.join(DATA_DIR, "media")
}

export function getQrPath() {
  return path.join(ROOT, "wa-qr.png")
}

export function getCodexWorkspaceRoot() {
  return path.join(DATA_DIR, "codex-workspaces")
}

export function getCronJobsRoot() {
  return path.join(DATA_DIR, "cron-jobs")
}

export function normalizeConfig(input) {
  const defaults = defaultConfig()
  const safe = input && typeof input === "object" ? input : {}

  return {
    apiPort: toPositiveInt(safe.apiPort, defaults.apiPort),
    openDocsOnStart: safe.openDocsOnStart !== false,
    webhooks: normalizeWebhooks(safe.webhooks),
    codexAgent: normalizeCodexAgentConfig(safe.codexAgent || defaults.codexAgent),
    cronJobs: normalizeCronJobsConfig(safe.cronJobs || defaults.cronJobs),
  }
}

export function normalizeWebhook(input) {
  if (!input || typeof input !== "object") return null
  const url = String(input.url || "").trim()
  if (!/^https?:\/\//i.test(url)) return null

  const chatId = String(input.chatId || "").trim()
  const eventsRaw = Array.isArray(input.events) ? input.events : []
  const events = eventsRaw.map((e) => String(e || "").trim()).filter(Boolean)

  return {
    id: String(input.id || "").trim() || randomUUID(),
    accountId: String(input.accountId || "default").trim() || "default",
    url,
    chatId: chatId || null,
    events: events.length ? events : ["message"],
    secret: typeof input.secret === "string" ? input.secret.trim() : "",
    enabled: input.enabled !== false,
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

function normalizeWebhooks(input) {
  if (!Array.isArray(input)) return []
  return input.map(normalizeWebhook).filter(Boolean)
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}
