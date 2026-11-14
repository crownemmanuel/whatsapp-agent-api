import { exec } from "node:child_process"
import pino from "pino"
import {
  getMediaDir,
  getCodexWorkspaceRoot,
  getCronJobsRoot,
  getQrPath,
  getSessionDir,
  getAccountsRoot,
  loadConfig,
  normalizeWebhook,
  saveConfig,
} from "./config-store.js"
import { createApiServer } from "./api-server.js"
import {
  checkCodexInstallStatus,
  CodexAgentRouter,
  ensureCodexWorkspace,
  normalizeCodexAgentConfig,
  normalizeCodexRule,
  readCodexMemory,
  writeCodexMemory,
} from "./codex-agent.js"
import { CronJobScheduler } from "./cron-jobs.js"
import { WhatsAppBridge, resetWhatsAppSession } from "./whatsapp.js"
import { AccountRegistry } from "./accounts.js"
import path from "node:path"

const LOG = pino({ name: "whatsapp-api-gateway", level: process.env.LOG_LEVEL || "info" })

async function main() {
  let config = await loadConfig()
  const sessionDir = getSessionDir()
  const mediaDir = getMediaDir()
  const qrPath = getQrPath()
  const defaultCodexWorkspaceRoot = getCodexWorkspaceRoot()
  const cronJobsRoot = getCronJobsRoot()

  if (process.argv.includes("--rescan")) {
    console.log("Rescan requested: clearing WhatsApp session so you can scan the QR code again...")
    await resetWhatsAppSession(sessionDir)
  }

  // Webhook store backed by config.json.
  const webhooks = {
    list: () => config.webhooks,
    add: async (input) => {
      const normalized = normalizeWebhook(input)
      if (!normalized) return null
      accounts.get(normalized.accountId)
      config = await saveConfig({ ...config, webhooks: [...config.webhooks, normalized] })
      return config.webhooks.find((w) => w.id === normalized.id)
    },
    remove: async (id) => {
      const next = config.webhooks.filter((w) => w.id !== id)
      if (next.length === config.webhooks.length) return false
      config = await saveConfig({ ...config, webhooks: next })
      return true
    },
  }

  const routers = new Map()
  const createBridge = (accountId, paths) => {
    const bridge = new WhatsAppBridge({
      mediaDir,
      ...paths,
      accountId,
      onConnectionChange: (connected) => LOG.info({ accountId, connected }, "WhatsApp connection changed"),
      onSessionExpired: () => accounts.relink(accountId).catch((err) =>
        LOG.error({ accountId, err }, "Could not start a new WhatsApp link after logout")),
      onMessage: (message) => {
        const scopedMessage = { ...message, accountId }
        dispatchWebhooks(config.webhooks, scopedMessage)
        void routers.get(accountId)?.handleMessage(scopedMessage)
      },
    })
    routers.set(accountId, new CodexAgentRouter({
      config: config.codexAgent,
      bridge,
      workspaceRoot: accountId === "default"
        ? resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot)
        : path.join(resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot), "accounts", accountId),
    }))
    return bridge
  }
  const bridge = createBridge("default", { sessionDir, qrPath })
  const accounts = new AccountRegistry({ rootDir: getAccountsRoot(), defaultBridge: bridge, defaultSessionDir: sessionDir, defaultQrPath: qrPath, defaultMediaDir: mediaDir, createBridge })
  await accounts.load()

  const codexAgent = {
    get: () => config.codexAgent,
    save: async (input) => {
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({ ...config.codexAgent, ...(input || {}) }),
      })
      updateCodexRouters(routers, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent
    },
    addRule: async (input) => {
      const rule = normalizeCodexRule(input)
      if (!rule) return null
      accounts.get(rule.accountId)
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({
          ...config.codexAgent,
          rules: [...config.codexAgent.rules, rule],
        }),
      })
      updateCodexRouters(routers, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent.rules.find((item) => item.id === rule.id)
    },
    updateRule: async (id, input) => {
      const existing = config.codexAgent.rules.find((rule) => rule.id === id)
      if (!existing) return null
      const nextRule = normalizeCodexRule({ ...existing, ...(input || {}), id })
      accounts.get(nextRule.accountId)
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({
          ...config.codexAgent,
          rules: config.codexAgent.rules.map((rule) => (rule.id === id ? nextRule : rule)),
        }),
      })
      updateCodexRouters(routers, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent.rules.find((rule) => rule.id === id)
    },
    removeRule: async (id) => {
      const next = config.codexAgent.rules.filter((rule) => rule.id !== id)
      if (next.length === config.codexAgent.rules.length) return false
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({ ...config.codexAgent, rules: next }),
      })
      updateCodexRouters(routers, config.codexAgent, defaultCodexWorkspaceRoot)
      return true
    },
    status: async () => ({
      ...(await checkCodexInstallStatus()),
      enabled: config.codexAgent.enabled,
      ruleCount: config.codexAgent.rules.length,
      workspaceRoot: resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot),
      recentRuns: Array.from(routers.entries()).flatMap(([accountId, router]) =>
        router.listRuns().map((run) => ({ ...run, accountId }))),
    }),
    readMemory: async ({ chatId, chatName, isGroup, accountId = "default" }) => {
      accounts.get(accountId)
      const root = routers.get(accountId).workspaceRoot
      const workspace = await ensureCodexWorkspace(
        root,
        { chatId, chatName, isGroup: Boolean(isGroup) },
      )
      return { workspaceName: workspace.workspaceName, workspaceDir: workspace.workspaceDir, text: await readCodexMemory(workspace.memoryPath) }
    },
    writeMemory: async ({ chatId, chatName, isGroup, text, accountId = "default" }) => {
      accounts.get(accountId)
      const workspace = await ensureCodexWorkspace(
        routers.get(accountId).workspaceRoot,
        { chatId, chatName, isGroup: Boolean(isGroup) },
      )
      await writeCodexMemory(workspace.memoryPath, text)
      return { workspaceName: workspace.workspaceName, workspaceDir: workspace.workspaceDir, text: await readCodexMemory(workspace.memoryPath) }
    },
  }

  const cronScheduler = new CronJobScheduler({
    config: config.cronJobs,
    rootDir: cronJobsRoot,
    bridge,
    getBridge: (accountId) => accounts.get(accountId).bridge,
    saveConfig: async (cronJobsConfig) => {
      config = await saveConfig({ ...config, cronJobs: cronJobsConfig })
      return config.cronJobs
    },
  })

  const cronJobs = {
    get: () => config.cronJobs,
    save: async (input) => cronScheduler.saveSchedulerConfig(input),
    listJobs: () => cronScheduler.listJobs(),
    getJob: (id) => cronScheduler.getJob(id),
    addJob: async (input) => cronScheduler.upsertJob(input),
    updateJob: async (id, input) => {
      if (!cronScheduler.getJob(id)) return null
      return cronScheduler.upsertJob({ ...(input || {}), id })
    },
    removeJob: async (id) => cronScheduler.removeJob(id),
    runJob: async (id) => cronScheduler.runJobNow(id, "manual"),
    status: async () => ({
      ...cronScheduler.status(),
      rootDir: cronJobsRoot,
      codex: await checkCodexInstallStatus(),
    }),
    readMemory: async ({ jobId }) => cronScheduler.readMemory(jobId),
    writeMemory: async ({ jobId, text }) => cronScheduler.writeMemory(jobId, text),
    chat: async (input) => cronScheduler.chat(input),
  }

  createApiServer({ port: config.apiPort, mediaDir, qrPath, bridge, accounts, webhooks, codexAgent, cronJobs })
  cronScheduler.start()

  if (config.openDocsOnStart) {
    openInBrowser(`http://localhost:${config.apiPort}/ui`)
  }

  console.log("Starting WhatsApp API Gateway...")
  console.log(`Management UI: http://localhost:${config.apiPort}/ui`)
  console.log(`Swagger docs: http://localhost:${config.apiPort}/docs`)

  await accounts.startAll()

  const shutdown = async (signal) => {
    LOG.info({ signal }, "Shutting down")
    cronScheduler.stop()
    await accounts.stopAll()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

function updateCodexRouters(routers, codexConfig, defaultCodexWorkspaceRoot) {
  const root = resolveCodexWorkspaceRoot(codexConfig, defaultCodexWorkspaceRoot)
  for (const [accountId, router] of routers) {
    router.updateConfig(codexConfig)
    router.workspaceRoot = accountId === "default" ? root : path.join(root, "accounts", accountId)
  }
}

function resolveCodexWorkspaceRoot(codexConfig, fallback) {
  return codexConfig?.workspaceRoot || fallback
}

function dispatchWebhooks(webhookList, message) {
  if (!Array.isArray(webhookList) || webhookList.length === 0) return

  for (const hook of webhookList) {
    if (!hook.enabled) continue
    if ((hook.accountId || "default") !== message.accountId) continue
    if (hook.chatId && hook.chatId !== message.chatId) continue
    if (Array.isArray(hook.events) && hook.events.length && !hook.events.includes("message")) continue

    const headers = { "Content-Type": "application/json" }
    if (hook.secret) headers["X-Webhook-Secret"] = hook.secret

    fetch(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "message", message }),
    }).catch((err) => {
      LOG.warn({ err: err?.message, url: hook.url }, "Webhook delivery failed")
    })
  }
}

function openInBrowser(url) {
  if (process.env.WA_OPEN_DOCS === "0") return

  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`

  exec(cmd, (error) => {
    if (error) LOG.warn({ err: error }, "Could not auto-open docs")
  })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  LOG.error({ err: error }, "Startup failed")
  console.error(`Startup failed: ${message}`)
  process.exit(1)
})
