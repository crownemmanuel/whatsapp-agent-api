import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import pino from "pino"

const execFileAsync = promisify(execFile)
const LOG = pino({ name: "whatsapp-codex-agent", level: process.env.LOG_LEVEL || "info" })

const SANDBOXES = new Set(["read-only", "workspace-write", "full-access"])
const MAX_REPLY_ATTACHMENTS = 5

const ATTACHMENT_KINDS = {
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
  ".opus": ["audio", "audio/ogg; codecs=opus"],
  ".wav": ["audio", "audio/wav"],
  ".pdf": ["document", "application/pdf"],
  ".txt": ["document", "text/plain"],
  ".csv": ["document", "text/csv"],
  ".json": ["document", "application/json"],
  ".zip": ["document", "application/zip"],
  ".html": ["document", "text/html"],
}
const SDK_SANDBOX_BY_CONFIG = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "full-access": "danger-full-access",
}

const DEFAULT_PROMPT = `You are Codex connected to a WhatsApp API gateway.

You receive WhatsApp messages that matched a configured automation rule. Help the sender by taking practical action on this computer when requested.

Use the chat memory file for durable facts. If the sender asks you to remember, forget, or update something, edit memory.md in the workspace. Save generated files under artifacts/ unless the user asks for a different location.

Your final response will be sent back to WhatsApp. Keep it concise, mention important files you created or changed, and ask for clarification when the request is unsafe or ambiguous.`

export function defaultCodexAgentConfig() {
  return {
    enabled: false,
    model: "",
    defaultSandbox: "full-access",
    approvalPolicy: "never",
    autoReply: true,
    replyOnError: true,
    networkAccessEnabled: true,
    workspaceRoot: "",
    defaultPrompt: DEFAULT_PROMPT,
    rules: [],
  }
}

export function normalizeCodexAgentConfig(input) {
  const defaults = defaultCodexAgentConfig()
  const safe = input && typeof input === "object" ? input : {}
  return {
    enabled: safe.enabled === true,
    model: cleanString(safe.model),
    defaultSandbox: normalizeCodexSandbox(safe.defaultSandbox || defaults.defaultSandbox),
    approvalPolicy: normalizeApprovalPolicy(safe.approvalPolicy || defaults.approvalPolicy),
    autoReply: safe.autoReply !== false,
    replyOnError: safe.replyOnError !== false,
    networkAccessEnabled: safe.networkAccessEnabled !== false,
    workspaceRoot: cleanString(safe.workspaceRoot),
    defaultPrompt: cleanString(safe.defaultPrompt) || defaults.defaultPrompt,
    rules: normalizeCodexRules(safe.rules),
  }
}

export function normalizeCodexRule(input) {
  if (!input || typeof input !== "object") return null
  const chatType = normalizeChatType(input.chatType)
  const name = cleanString(input.name) || "Codex rule"
  return {
    id: cleanString(input.id) || randomId(),
    name,
    enabled: input.enabled !== false,
    chatType,
    chatId: normalizeNullableJid(input.chatId),
    allowedSenderIds: normalizeStringList(input.allowedSenderIds),
    keywords: normalizeStringList(input.keywords),
    requireMention: input.requireMention === true,
    allowFromMe: input.allowFromMe === true,
    sandbox: normalizeCodexSandbox(input.sandbox || ""),
    autoReply: input.autoReply === undefined || input.autoReply === null ? null : input.autoReply !== false,
    model: cleanString(input.model),
    prompt: cleanString(input.prompt),
    workspaceSubdir: cleanString(input.workspaceSubdir),
    createdAt: cleanString(input.createdAt) || new Date().toISOString(),
  }
}

export function normalizeCodexSandbox(value) {
  const raw = cleanString(value).toLowerCase()
  if (raw === "danger-full-access") return "full-access"
  if (SANDBOXES.has(raw)) return raw
  return "full-access"
}

export function toCodexSdkSandboxMode(value) {
  return SDK_SANDBOX_BY_CONFIG[normalizeCodexSandbox(value)]
}

export function getMatchingRule(rules, message, currentUserJid) {
  if (!Array.isArray(rules)) return null
  return rules.find((rule) => matchesCodexRule(rule, message, currentUserJid)) || null
}

export function matchesCodexRule(rule, message, currentUserJid) {
  if (!rule?.enabled || !message) return false
  if (message.fromMe && !rule.allowFromMe) return false

  const isGroup = Boolean(message.isGroup)
  if (rule.chatType === "group" && !isGroup) return false
  if (rule.chatType === "dm" && isGroup) return false

  if (rule.chatId && normalizeBareJid(rule.chatId) !== normalizeBareJid(message.chatId)) return false

  if (Array.isArray(rule.allowedSenderIds) && rule.allowedSenderIds.length > 0) {
    const senderCandidates = [
      normalizeBareJid(message.senderId),
      digitsOnly(message.senderId),
      digitsOnly(message.sender),
    ].filter(Boolean)
    const allowed = rule.allowedSenderIds.map((v) => [normalizeBareJid(v), digitsOnly(v)]).flat().filter(Boolean)
    if (!senderCandidates.some((candidate) => allowed.includes(candidate))) return false
  }

  if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
    const text = cleanString(message.text).toLowerCase()
    if (!rule.keywords.some((keyword) => text.includes(cleanString(keyword).toLowerCase()))) return false
  }

  if (rule.requireMention && !messageMentionsCurrentUser(message, currentUserJid)) return false

  return true
}

export function getChatWorkspaceName(message) {
  const label = cleanString(message?.chatName) || cleanString(message?.chatId) || "chat"
  const id = cleanString(message?.chatId)
  const base = (label === id || !id ? label : `${label}-${id}`).replace(/@/g, "-")
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return slug || "chat"
}

export function buildCodexPrompt({ config, rule, message, workspaceDir, memoryText }) {
  const artifactsDir = path.join(workspaceDir, "artifacts")
  const memory = cleanString(memoryText) || "(No saved memory yet.)"
  const parts = [
    cleanString(config?.defaultPrompt) || DEFAULT_PROMPT,
    cleanString(rule?.prompt),
    `Replying with media:
You can attach images, audio, video, and documents to your WhatsApp reply. Save each file inside the workspace (artifacts/ is preferred), then put a directive on its own line in your final response:
SEND_FILE: <path relative to the workspace> | <optional caption>
SEND_VOICE: <path to an audio file> (delivered as a voice note)
Directive lines are stripped before the rest of your response is sent as the text message. Files must stay inside the workspace. Up to ${MAX_REPLY_ATTACHMENTS} attachments per reply. Use this whenever the sender asks for something visual or downloadable — e.g. generate an image, chart, PDF, or audio — instead of describing the file or pasting its contents.`,
    `Workspace: ${workspaceDir}`,
    `Artifacts folder: ${artifactsDir}`,
    `Memory file: ${path.join(workspaceDir, "memory.md")}`,
    `Current memory:\n${memory}`,
    `WhatsApp message:
- Chat: ${message.chatName || message.chatId}
- Chat ID: ${message.chatId}
- Chat type: ${message.isGroup ? "group" : "direct message"}
- Sender: ${message.sender || "unknown"}
- Sender ID: ${message.senderId || message.chatId || "unknown"}
- Message ID: ${message.id}
- Timestamp: ${new Date(Number(message.ts) || Date.now()).toISOString()}
- Text:
${message.text || "(No text. The message may contain media.)"}`,
  ]
  if (message.mediaUrl) parts.push(`Incoming media URL on the gateway: ${message.mediaUrl}`)
  return parts.filter(Boolean).join("\n\n---\n\n")
}

export function extractMediaDirectives(text) {
  const attachments = []
  const kept = []
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^[ \t]*(?:[-*>]\s*)?`?SEND_(FILE|VOICE):\s*(.+?)`?\s*$/i)
    if (!match) {
      kept.push(line)
      continue
    }
    const payload = match[2]
    const splitAt = payload.indexOf("|")
    const filePath = cleanString(splitAt === -1 ? payload : payload.slice(0, splitAt))
    if (!filePath) continue
    attachments.push({
      path: filePath,
      caption: splitAt === -1 ? "" : cleanString(payload.slice(splitAt + 1)),
      ptt: match[1].toUpperCase() === "VOICE",
    })
  }
  return { text: kept.join("\n").trim(), attachments }
}

export function detectAttachmentKind(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase()
  const [type, mimetype] = ATTACHMENT_KINDS[ext] || ["document", "application/octet-stream"]
  return { type, mimetype }
}

export function resolveWorkspaceFile(workspaceDir, filePath) {
  const root = path.resolve(workspaceDir)
  const resolved = path.resolve(root, String(filePath || ""))
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Attachment must stay inside the chat workspace: ${filePath}`)
  }
  return resolved
}

export async function checkCodexInstallStatus() {
  const status = {
    sdkInstalled: false,
    cliAvailable: false,
    cliPath: "",
    cliVersion: "",
    ready: false,
    installCommand: "npm install @openai/codex-sdk",
    notes: [],
  }

  try {
    await import("@openai/codex-sdk")
    status.sdkInstalled = true
  } catch (err) {
    status.notes.push(`Codex SDK is not installed: ${err?.message || err}`)
  }

  try {
    const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 5000 })
    status.cliAvailable = true
    status.cliPath = "codex"
    status.cliVersion = stdout.trim()
  } catch (err) {
    if (status.sdkInstalled) {
      status.cliAvailable = true
      status.cliPath = "bundled @openai/codex"
      status.notes.push("No global codex executable was found, but @openai/codex is bundled with the SDK.")
    } else {
      status.notes.push(`Codex CLI is not available: ${err?.message || err}`)
    }
  }

  status.ready = status.sdkInstalled && status.cliAvailable
  return status
}

export async function ensureCodexWorkspace(rootDir, message, rule = {}) {
  const workspaceName = cleanString(rule.workspaceSubdir) || getChatWorkspaceName(message)
  const workspaceDir = path.join(rootDir, workspaceName)
  const artifactsDir = path.join(workspaceDir, "artifacts")
  await fs.mkdir(artifactsDir, { recursive: true })

  const memoryPath = path.join(workspaceDir, "memory.md")
  try {
    await fs.access(memoryPath)
  } catch {
    await fs.writeFile(
      memoryPath,
      `# Memory\n\nDurable notes for ${message.chatName || message.chatId}.\n`,
      "utf8",
    )
  }

  return {
    workspaceName,
    workspaceDir,
    artifactsDir,
    memoryPath,
    threadPath: path.join(workspaceDir, "thread.json"),
    transcriptPath: path.join(workspaceDir, "conversation.jsonl"),
  }
}

export async function readCodexMemory(memoryPath) {
  try {
    return await fs.readFile(memoryPath, "utf8")
  } catch (err) {
    if (err?.code === "ENOENT") return ""
    throw err
  }
}

export async function writeCodexMemory(memoryPath, text) {
  await fs.mkdir(path.dirname(memoryPath), { recursive: true })
  await fs.writeFile(memoryPath, `${String(text || "").trim()}\n`, "utf8")
}

export async function readThreadState(threadPath) {
  try {
    return JSON.parse(await fs.readFile(threadPath, "utf8"))
  } catch (err) {
    if (err?.code === "ENOENT") return {}
    throw err
  }
}

export async function writeThreadState(threadPath, state) {
  await fs.mkdir(path.dirname(threadPath), { recursive: true })
  await fs.writeFile(threadPath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

export class CodexAgentRouter {
  constructor({ config, bridge, workspaceRoot, logger = LOG }) {
    this.config = normalizeCodexAgentConfig(config)
    this.bridge = bridge
    this.workspaceRoot = workspaceRoot
    this.logger = logger
    this.chatQueues = new Map()
    this.lastRuns = []
  }

  updateConfig(config) {
    this.config = normalizeCodexAgentConfig(config)
  }

  listRuns() {
    return this.lastRuns.slice(-50).reverse()
  }

  async handleMessage(message) {
    if (!this.config.enabled || !message) return null
    if (message.fromMe && this.bridge?.isGatewayOutbound?.(message.id)) {
      this.logger.debug({ chatId: message.chatId, id: message.id }, "Ignored gateway auto-reply echo")
      return null
    }
    const currentUserJid = getBridgeUserJid(this.bridge)
    const rule = getMatchingRule(this.config.rules, message, currentUserJid)
    if (!rule) {
      if (message.fromMe) {
        this.logger.debug({ chatId: message.chatId }, "No Codex rule allows messages from the linked account")
      }
      return null
    }

    const previous = this.chatQueues.get(message.chatId) || Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.runForMessage(message, rule))
      .finally(() => {
        if (this.chatQueues.get(message.chatId) === run) this.chatQueues.delete(message.chatId)
      })
    this.chatQueues.set(message.chatId, run)
    return run
  }

  async runForMessage(message, rule) {
    const runRecord = {
      id: randomId(),
      ruleId: rule.id,
      ruleName: rule.name,
      chatId: message.chatId,
      chatName: message.chatName || message.chatId,
      senderId: message.senderId || message.chatId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      error: "",
      response: "",
      attachments: [],
      workspaceDir: "",
      threadId: "",
    }
    this.rememberRun(runRecord)

    const typing = this.bridge?.createTypingSession?.(message.chatId) || null

    try {
      if (typing) await typing.start()
      const status = await checkCodexInstallStatus()
      if (!status.ready) {
        throw new Error(`Codex is not ready. Install it with: ${status.installCommand}`)
      }

      const workspace = await ensureCodexWorkspace(this.workspaceRoot, message, rule)
      runRecord.workspaceDir = workspace.workspaceDir
      const memoryText = await readCodexMemory(workspace.memoryPath)
      const threadState = await readThreadState(workspace.threadPath)
      const prompt = buildCodexPrompt({
        config: this.config,
        rule,
        message,
        workspaceDir: workspace.workspaceDir,
        memoryText,
      })

      const { Codex } = await import("@openai/codex-sdk")
      const codex = new Codex()
      const threadOptions = this.buildThreadOptions(rule, workspace.workspaceDir)
      const thread = threadState.threadId
        ? codex.resumeThread(threadState.threadId, threadOptions)
        : codex.startThread(threadOptions)
      const result = await thread.run(prompt)
      const response = cleanString(result.finalResponse) || "Codex completed the request."
      const { text: replyText, attachments } = extractMediaDirectives(response)

      runRecord.threadId = thread.id || threadState.threadId || ""
      runRecord.response = response
      runRecord.attachments = attachments.map((attachment) => attachment.path)
      runRecord.ok = true
      if (runRecord.threadId) {
        await writeThreadState(workspace.threadPath, {
          threadId: runRecord.threadId,
          updatedAt: new Date().toISOString(),
          chatId: message.chatId,
          chatName: message.chatName || "",
          ruleId: rule.id,
        })
      }
      await appendJsonl(workspace.transcriptPath, {
        type: "codex-run",
        message,
        rule: { id: rule.id, name: rule.name },
        response,
        attachments: runRecord.attachments,
        usage: result.usage || null,
        at: new Date().toISOString(),
      })

      if (shouldAutoReply(this.config, rule)) {
        if (replyText || attachments.length === 0) {
          const sent = await this.bridge.sendText(message.chatId, replyText || response)
          this.logger.info({ chatId: message.chatId, ruleId: rule.id, messageId: sent?.id }, "Codex auto-reply sent")
        }
        const sendResults = await this.sendAttachments(message.chatId, attachments, workspace.workspaceDir)
        const failed = sendResults.filter((item) => !item.ok)
        if (failed.length > 0) {
          await this.bridge.sendText(
            message.chatId,
            `Codex could not attach: ${failed.map((item) => item.path).join(", ")}`,
          )
        }
      }
      return runRecord
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err)
      runRecord.error = messageText
      this.logger.warn({ err: messageText, chatId: message.chatId }, "Codex run failed")
      if (this.config.replyOnError && shouldAutoReply(this.config, rule)) {
        await this.bridge.sendText(message.chatId, `Codex could not run: ${messageText}`)
      }
      return runRecord
    } finally {
      if (typing) await typing.stop()
      runRecord.finishedAt = new Date().toISOString()
    }
  }

  async sendAttachments(chatId, attachments, workspaceDir) {
    const results = []
    for (const [index, attachment] of attachments.entries()) {
      if (index >= MAX_REPLY_ATTACHMENTS) {
        results.push({ path: attachment.path, ok: false, error: "attachment limit exceeded" })
        continue
      }
      try {
        const filePath = resolveWorkspaceFile(workspaceDir, attachment.path)
        const buffer = await fs.readFile(filePath)
        const kind = detectAttachmentKind(filePath)
        const sent = await this.bridge.sendMedia(chatId, {
          type: attachment.ptt ? "audio" : kind.type,
          buffer,
          caption: attachment.caption || undefined,
          mimetype: kind.mimetype,
          filename: path.basename(filePath),
          ptt: attachment.ptt,
        })
        this.logger.info({ chatId, path: attachment.path, messageId: sent?.id }, "Codex attachment sent")
        results.push({ path: attachment.path, ok: true, messageId: sent?.id })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.logger.warn({ err: reason, chatId, path: attachment.path }, "Codex attachment send failed")
        results.push({ path: attachment.path, ok: false, error: reason })
      }
    }
    return results
  }

  buildThreadOptions(rule, workspaceDir) {
    const sandbox = rule.sandbox || this.config.defaultSandbox
    const options = {
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true,
      sandboxMode: toCodexSdkSandboxMode(sandbox),
      approvalPolicy: this.config.approvalPolicy,
      networkAccessEnabled: this.config.networkAccessEnabled,
    }
    const model = cleanString(rule.model) || cleanString(this.config.model)
    if (model) options.model = model
    return options
  }

  rememberRun(runRecord) {
    this.lastRuns.push(runRecord)
    if (this.lastRuns.length > 50) this.lastRuns.splice(0, this.lastRuns.length - 50)
  }
}

function normalizeCodexRules(input) {
  if (!Array.isArray(input)) return []
  return input.map(normalizeCodexRule).filter(Boolean)
}

function normalizeChatType(value) {
  const raw = cleanString(value).toLowerCase()
  if (raw === "group" || raw === "dm" || raw === "all") return raw
  return "all"
}

function normalizeApprovalPolicy(value) {
  const raw = cleanString(value).toLowerCase()
  if (["never", "on-request", "on-failure", "untrusted"].includes(raw)) return raw
  return "never"
}

function normalizeStringList(input) {
  if (Array.isArray(input)) return input.map(cleanString).filter(Boolean)
  if (typeof input === "string") {
    return input
      .split(/[\n,]/)
      .map(cleanString)
      .filter(Boolean)
  }
  return []
}

function normalizeNullableJid(value) {
  const text = cleanString(value)
  return text || null
}

function messageMentionsCurrentUser(message, currentUserJid) {
  const current = normalizeBareJid(currentUserJid)
  if (!current) return false
  const mentioned = Array.isArray(message.mentionedJids) ? message.mentionedJids : []
  if (mentioned.some((jid) => normalizeBareJid(jid) === current)) return true
  const number = digitsOnly(current)
  return Boolean(number && cleanString(message.text).includes(`@${number}`))
}

function getBridgeUserJid(bridge) {
  return normalizeBareJid(bridge?.me?.id || bridge?.me?.jid || bridge?.me || "")
}

function normalizeBareJid(value) {
  const text = cleanString(value).toLowerCase()
  if (!text) return ""
  const [user, domain] = text.split("@")
  if (!domain) return text
  return `${user.split(":")[0]}@${domain}`
}

function digitsOnly(value) {
  return cleanString(value).replace(/\D/g, "")
}

function cleanString(value) {
  return String(value ?? "").trim()
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function shouldAutoReply(config, rule) {
  return rule.autoReply === null ? config.autoReply !== false : rule.autoReply !== false
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8")
}
