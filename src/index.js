import { exec } from "node:child_process"
import pino from "pino"
import {
  getMediaDir,
  getCodexWorkspaceRoot,
  getQrPath,
  getSessionDir,
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
import { WhatsAppBridge, resetWhatsAppSession } from "./whatsapp.js"

const LOG = pino({ name: "whatsapp-api-gateway", level: process.env.LOG_LEVEL || "info" })

async function main() {
  let config = await loadConfig()
  const sessionDir = getSessionDir()
  const mediaDir = getMediaDir()
  const qrPath = getQrPath()
  const defaultCodexWorkspaceRoot = getCodexWorkspaceRoot()

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

  let codexRouter = null
  const bridge = new WhatsAppBridge({
    sessionDir,
    mediaDir,
    qrPath,
    onConnectionChange: (connected) => {
      LOG.info({ connected }, "WhatsApp connection changed")
    },
    onMessage: (message) => {
      dispatchWebhooks(config.webhooks, message)
      if (codexRouter) {
        void codexRouter.handleMessage(message)
      }
    },
  })

  codexRouter = new CodexAgentRouter({
    config: config.codexAgent,
    bridge,
    workspaceRoot: resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot),
  })

  const codexAgent = {
    get: () => config.codexAgent,
    save: async (input) => {
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({ ...config.codexAgent, ...(input || {}) }),
      })
      updateCodexRouter(codexRouter, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent
    },
    addRule: async (input) => {
      const rule = normalizeCodexRule(input)
      if (!rule) return null
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({
          ...config.codexAgent,
          rules: [...config.codexAgent.rules, rule],
        }),
      })
      updateCodexRouter(codexRouter, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent.rules.find((item) => item.id === rule.id)
    },
    updateRule: async (id, input) => {
      const existing = config.codexAgent.rules.find((rule) => rule.id === id)
      if (!existing) return null
      const nextRule = normalizeCodexRule({ ...existing, ...(input || {}), id })
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({
          ...config.codexAgent,
          rules: config.codexAgent.rules.map((rule) => (rule.id === id ? nextRule : rule)),
        }),
      })
      updateCodexRouter(codexRouter, config.codexAgent, defaultCodexWorkspaceRoot)
      return config.codexAgent.rules.find((rule) => rule.id === id)
    },
    removeRule: async (id) => {
      const next = config.codexAgent.rules.filter((rule) => rule.id !== id)
      if (next.length === config.codexAgent.rules.length) return false
      config = await saveConfig({
        ...config,
        codexAgent: normalizeCodexAgentConfig({ ...config.codexAgent, rules: next }),
      })
      updateCodexRouter(codexRouter, config.codexAgent, defaultCodexWorkspaceRoot)
      return true
    },
    status: async () => ({
      ...(await checkCodexInstallStatus()),
      enabled: config.codexAgent.enabled,
      ruleCount: config.codexAgent.rules.length,
      workspaceRoot: resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot),
      recentRuns: codexRouter.listRuns(),
    }),
    readMemory: async ({ chatId, chatName, isGroup }) => {
      const workspace = await ensureCodexWorkspace(
        resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot),
        { chatId, chatName, isGroup: Boolean(isGroup) },
      )
      return { workspaceName: workspace.workspaceName, workspaceDir: workspace.workspaceDir, text: await readCodexMemory(workspace.memoryPath) }
    },
    writeMemory: async ({ chatId, chatName, isGroup, text }) => {
      const workspace = await ensureCodexWorkspace(
        resolveCodexWorkspaceRoot(config.codexAgent, defaultCodexWorkspaceRoot),
        { chatId, chatName, isGroup: Boolean(isGroup) },
      )
      await writeCodexMemory(workspace.memoryPath, text)
      return { workspaceName: workspace.workspaceName, workspaceDir: workspace.workspaceDir, text: await readCodexMemory(workspace.memoryPath) }
    },
  }

  createApiServer({ port: config.apiPort, mediaDir, bridge, webhooks, codexAgent })

  if (config.openDocsOnStart) {
    openInBrowser(`http://localhost:${config.apiPort}/ui`)
  }

  console.log("Starting WhatsApp API Gateway...")
  console.log(`Management UI: http://localhost:${config.apiPort}/ui`)
  console.log(`Swagger docs: http://localhost:${config.apiPort}/docs`)

  await bridge.start()

  const shutdown = async (signal) => {
    LOG.info({ signal }, "Shutting down")
    await bridge.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

function updateCodexRouter(router, codexConfig, defaultCodexWorkspaceRoot) {
  router.updateConfig(codexConfig)
  router.workspaceRoot = resolveCodexWorkspaceRoot(codexConfig, defaultCodexWorkspaceRoot)
}

function resolveCodexWorkspaceRoot(codexConfig, fallback) {
  return codexConfig?.workspaceRoot || fallback
}

function dispatchWebhooks(webhookList, message) {
  if (!Array.isArray(webhookList) || webhookList.length === 0) return

  for (const hook of webhookList) {
    if (!hook.enabled) continue
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
