import fs from "node:fs/promises"
import path from "node:path"
import pino from "pino"
import QRCode from "qrcode"
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"

const LOG = pino({ name: "whatsapp-api-gateway", level: process.env.LOG_LEVEL || "info" })

const MAX_BUFFERED_PER_CHAT = 200

export class WhatsAppBridge {
  constructor({ sessionDir, mediaDir, qrPath, accountId = "default", onMessage, onConnectionChange, onSessionExpired }) {
    this.sessionDir = sessionDir
    this.mediaDir = mediaDir
    this.qrPath = qrPath
    this.accountId = accountId
    this.onMessage = onMessage
    this.onConnectionChange = onConnectionChange
    this.onSessionExpired = onSessionExpired
    this.sock = null
    this.connecting = null
    this.isReady = false
    this.reconnecting = false
    this.readyWaiters = []
    this.shouldReconnect = true
    this.lastQr = ""

    // In-memory directories, rebuilt from WhatsApp events.
    this.groups = new Map() // jid -> { id, name, participantCount }
    this.contacts = new Map() // jid -> { id, name, number }
    this.messagesByChat = new Map() // jid -> [message,...]
    this.outboundMessageIds = new Set()
    this.typingSessions = new Map() // jid -> { session, timer }
    this.me = null
  }

  async start() {
    if (!this.connecting) {
      this.connecting = this.connect()
    }
    await this.connecting
  }

  async waitUntilReady() {
    if (this.isReady) return
    await new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject })
    })
  }

  async stop() {
    this.shouldReconnect = false
    this.isReady = false
    this.reconnecting = false
    this.resolveWaiters(new Error("WhatsApp bridge stopped"))
    if (this.onConnectionChange) this.onConnectionChange(false)
    if (this.sock) {
      try {
        this.sock.end(undefined)
      } catch {
        // ignore close errors
      }
      this.sock = null
    }
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      auth: state,
      version,
      logger: LOG.child({ module: "baileys", level: "warn" }),
      markOnlineOnConnect: false,
    })

    this.sock = sock
    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("messages.upsert", (payload) => {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      for (const msg of messages) {
        void this.processIncomingMessage(msg)
      }
    })

    sock.ev.on("contacts.upsert", (contacts) => this.ingestContacts(contacts))
    sock.ev.on("contacts.update", (contacts) => this.ingestContacts(contacts))
    sock.ev.on("messaging-history.set", ({ contacts }) => this.ingestContacts(contacts))

    sock.ev.on("groups.upsert", (groups) => this.ingestGroups(groups))
    sock.ev.on("groups.update", (groups) => this.ingestGroups(groups))

    sock.ev.on("connection.update", (update) => {
      if (update.qr && update.qr !== this.lastQr) {
        this.lastQr = update.qr
        void this.handleQr(update.qr)
      }

      if (update.connection === "open") {
        this.isReady = true
        this.reconnecting = false
        this.lastQr = ""
        if (this.qrPath) void this.removeQrFile()
        this.me = sock.user || null
        this.resolveWaiters()
        if (this.onConnectionChange) this.onConnectionChange(true)
        LOG.info("WhatsApp connected")
        void this.refreshGroups()
        return
      }

      if (update.connection !== "close") return

      const statusCode = update?.lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      this.isReady = false
      this.reconnecting = this.shouldReconnect && !loggedOut
      this.resolveWaiters(new Error("WhatsApp connection closed"))
      if (this.onConnectionChange) this.onConnectionChange(false)
      LOG.warn({ statusCode, loggedOut }, "WhatsApp connection closed")

      if (loggedOut && this.shouldReconnect && this.onSessionExpired) {
        void this.onSessionExpired()
      }

      if (!this.shouldReconnect || loggedOut) {
        if (loggedOut) {
          console.error(this.onSessionExpired
            ? "WhatsApp session logged out. Starting a fresh QR link."
            : "WhatsApp session logged out. Re-link with: npm start -- --rescan")
        }
        return
      }

      setTimeout(() => {
        this.connecting = this.connect()
      }, 2500)
    })
  }

  async handleQr(qr) {
    try {
      await writeQrPng(qr, this.qrPath || path.join(this.sessionDir, "latest-qr.png"))
    } catch (err) {
      LOG.warn({ err }, "Failed to write QR png")
    }
    await printTerminalQr(qr)
  }

  async removeQrFile() {
    if (!this.qrPath) return
    try {
      await fs.unlink(this.qrPath)
    } catch (err) {
      if (err?.code !== "ENOENT") LOG.warn({ err }, "Failed to remove QR png")
    }
  }

  // ---- Directory ingestion --------------------------------------------------

  ingestContacts(contacts) {
    if (!Array.isArray(contacts)) return
    for (const contact of contacts) {
      const id = String(contact?.id || "").trim()
      if (!id || !id.endsWith("@s.whatsapp.net")) continue
      const name = String(contact?.name || contact?.notify || contact?.verifiedName || "").trim()
      const existing = this.contacts.get(id)
      this.contacts.set(id, {
        id,
        name: name || existing?.name || "",
        number: id.split("@")[0],
      })
    }
  }

  ingestGroups(groups) {
    if (!Array.isArray(groups)) return
    for (const group of groups) {
      const id = String(group?.id || "").trim()
      if (!id || !id.endsWith("@g.us")) continue
      const existing = this.groups.get(id)
      this.groups.set(id, {
        id,
        name: String(group?.subject || existing?.name || id).trim(),
        participantCount: Array.isArray(group?.participants)
          ? group.participants.length
          : existing?.participantCount ?? null,
      })
    }
  }

  async refreshGroups() {
    if (!this.sock) return
    try {
      const groupsMap = await this.sock.groupFetchAllParticipating()
      this.ingestGroups(Object.values(groupsMap))
    } catch (err) {
      LOG.warn({ err }, "Failed to fetch groups")
    }
  }

  // ---- Queries --------------------------------------------------------------

  listGroups() {
    return Array.from(this.groups.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  findGroups(query, limit = 50) {
    const q = String(query || "").toLowerCase().trim()
    let list = this.listGroups()
    if (q) {
      list = list.filter(
        (g) => g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q),
      )
    }
    return list.slice(0, limit)
  }

  listContacts() {
    return Array.from(this.contacts.values()).sort((a, b) =>
      (a.name || a.number).localeCompare(b.name || b.number),
    )
  }

  findContacts(query, limit = 50) {
    const q = String(query || "").toLowerCase().trim()
    let list = this.listContacts()
    if (q) {
      list = list.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          c.number.includes(q.replace(/\D/g, "")),
      )
    }
    return list.slice(0, limit)
  }

  getMessages(chatId, limit = 50) {
    const list = this.messagesByChat.get(chatId) || []
    return list.slice(-limit)
  }

  // ---- Group management -----------------------------------------------------

  async resolveGroupParticipants(participants) {
    if (!Array.isArray(participants) || participants.length === 0) {
      throw badRequest("`participants` must be a non-empty array")
    }
    // Validate the entire request before making any WhatsApp calls.
    const values = participants.map((value) => {
      if (typeof value !== "string") throw badRequest("Participants must be strings")
      const trimmed = value.trim()
      if (!/^(?:[0-9]+@(?:s\.whatsapp\.net|lid)|\+?[0-9][0-9 ()-]*)$/.test(trimmed)) {
        throw badRequest("Participants must be international phone numbers or individual WhatsApp JIDs")
      }
      return trimmed
    })
    const jids = []
    for (const value of values) jids.push(await this.resolveJid(value))
    return [...new Set(jids)]
  }

  async createGroup(subject, participants) {
    this.assertReady()
    if (typeof subject !== "string" || !subject.trim() || Array.from(subject.trim()).length > 100) {
      throw badRequest("`subject` must contain 1–100 characters")
    }
    const jids = await this.resolveGroupParticipants(participants)
    const group = await this.sock.groupCreate(subject.trim(), jids)
    this.ingestGroups([group])
    return group
  }

  async addGroupParticipants(groupId, participants) {
    this.assertReady()
    if (typeof groupId !== "string" || !/^[0-9]+(?:-[0-9]+)?@g\.us$/.test(groupId)) {
      throw badRequest("`groupId` must be a group JID ending in @g.us")
    }
    const jids = await this.resolveGroupParticipants(participants)
    const results = await this.sock.groupParticipantsUpdate(groupId, jids, "add")
    // Never turn a successful mutation into a failure if the directory refresh fails.
    await this.refreshGroups()
    return { groupId, participants: results }
  }

  async getGroupParticipants(groupId) {
    this.assertReady()
    if (typeof groupId !== "string" || !/^[0-9]+(?:-[0-9]+)?@g\.us$/.test(groupId)) {
      throw badRequest("`groupId` must be a group JID ending in @g.us")
    }
    const group = await this.sock.groupMetadata(groupId)
    this.ingestGroups([group])
    return { groupId, participants: group.participants }
  }

  // ---- Sending --------------------------------------------------------------

  /**
   * Resolve a `to` value (JID or phone number) into a WhatsApp JID.
   * Verifies plain numbers against WhatsApp via onWhatsApp.
   */
  async resolveJid(to) {
    const value = String(to || "").trim()
    if (!value) throw badRequest("`to` is required")
    if (value.includes("@")) return value

    const digits = value.replace(/\D/g, "")
    if (!digits) throw badRequest("`to` must be a JID or phone number")

    this.assertReady()
    const results = await this.sock.onWhatsApp(digits)
    const match = Array.isArray(results) ? results.find((r) => r?.exists) : null
    if (!match) throw badRequest(`Number ${digits} is not registered on WhatsApp`)
    return match.jid
  }

  assertReady() {
    if (!this.isReady || !this.sock) {
      const err = new Error("WhatsApp is not connected. Scan the QR / wait for the link to complete.")
      err.statusCode = 503
      throw err
    }
  }

  async sendText(to, text) {
    this.assertReady()
    if (!String(text || "").trim()) throw badRequest("`text` is required")
    const jid = await this.resolveJid(to)
    const sent = await this.sock.sendMessage(jid, { text: String(text) })
    this.trackOutboundMessage(sent?.key?.id)
    return { id: sent?.key?.id, to: jid }
  }

  async sendMedia(to, { type, buffer, caption, mentions, mimetype, filename, ptt }) {
    this.assertReady()
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw badRequest("media content is required (mediaUrl or mediaBase64)")
    }
    const jid = await this.resolveJid(to)
    const mentionedJid = this.normalizeMentionJids(mentions)

    let content
    switch (type) {
      case "image":
        content = { image: buffer, caption: caption || undefined }
        break
      case "video":
        content = { video: buffer, caption: caption || undefined }
        break
      case "audio":
        content = { audio: buffer, mimetype: mimetype || "audio/mp4", ptt: Boolean(ptt) }
        break
      case "document":
        content = {
          document: buffer,
          mimetype: mimetype || "application/octet-stream",
          fileName: filename || "file",
          caption: caption || undefined,
        }
        break
      default:
        throw badRequest("`type` must be one of: image, video, audio, document")
    }

    if (mentionedJid.length && (type === "image" || type === "video" || type === "document")) {
      content.mentions = mentionedJid
      content.contextInfo = { mentionedJid }
    }

    const sent = await this.sock.sendMessage(jid, content)
    this.trackOutboundMessage(sent?.key?.id)
    return { id: sent?.key?.id, to: jid }
  }

  normalizeMentionJids(mentions) {
    if (!Array.isArray(mentions)) return []

    return mentions
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => {
        if (value.endsWith("@s.whatsapp.net") || value.endsWith("@lid")) return value
        const digits = value.replace(/\D/g, "")
        return digits ? `${digits}@s.whatsapp.net` : ""
      })
      .filter(Boolean)
  }

  trackOutboundMessage(id) {
    const messageId = String(id || "").trim()
    if (!messageId) return
    this.outboundMessageIds.add(messageId)
    if (this.outboundMessageIds.size > 500) {
      const [oldest] = this.outboundMessageIds
      this.outboundMessageIds.delete(oldest)
    }
  }

  isGatewayOutbound(id) {
    const messageId = String(id || "").trim()
    if (!messageId || !this.outboundMessageIds.has(messageId)) return false
    this.outboundMessageIds.delete(messageId)
    return true
  }

  createTypingSession(chatId) {
    let jid = null
    let timer = null
    let active = false

    const refresh = async () => {
      if (!active || !this.sock) return
      try {
        if (!jid) {
          jid = await this.resolveJid(chatId)
          // WhatsApp drops "composing" updates unless the account is online.
          await this.sock.sendPresenceUpdate("available")
        }
        await this.sock.sendPresenceUpdate("composing", jid)
      } catch (err) {
        jid = null
        LOG.debug({ err, chatId }, "Failed to refresh typing indicator")
      }
    }

    return {
      // Typing is cosmetic: never throw, so a presence failure can't abort the caller.
      start: async () => {
        if (active) return
        active = true
        await refresh()
        timer = setInterval(() => {
          void refresh()
        }, 8000)
      },
      stop: async () => {
        active = false
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        if (!this.sock || !jid) return
        try {
          await this.sock.sendPresenceUpdate("paused", jid)
        } catch (err) {
          LOG.debug({ err, chatId }, "Failed to stop typing indicator")
        }
      },
    }
  }

  async setTyping(chatId, state, durationMs) {
    if (state !== "composing" && state !== "paused") {
      throw badRequest('`state` must be "composing" or "paused"')
    }
    const jid = await this.resolveJid(chatId)

    const existing = this.typingSessions.get(jid)
    if (existing) {
      clearTimeout(existing.timer)
      this.typingSessions.delete(jid)
    }

    if (state === "paused") {
      if (existing) await existing.session.stop()
      return { chatId: jid, state: "paused" }
    }

    const ms = clampTypingDuration(durationMs)
    const session = existing?.session || this.createTypingSession(jid)
    // Auto-stop so a crashed client can't leave the chat stuck on "typing…".
    const timer = setTimeout(() => {
      this.typingSessions.delete(jid)
      void session.stop()
    }, ms)
    timer.unref?.()
    this.typingSessions.set(jid, { session, timer })
    if (!existing) await session.start()
    return { chatId: jid, state: "composing", durationMs: ms }
  }

  // ---- Incoming -------------------------------------------------------------

  async processIncomingMessage(msg) {
    const row = toIncomingRow(msg)
    if (!row) return

    // Record the chat name if we know it.
    if (row.isGroup) {
      const group = this.groups.get(row.chatId)
      row.chatName = group?.name || row.chatId
    } else {
      const contact = this.contacts.get(row.chatId)
      row.chatName = contact?.name || row.sender || row.chatId
    }

    if (row.hasMedia && this.mediaDir) {
      try {
        const buf = await downloadMediaMessage(msg, "buffer")
        const safeId = (row.id || "").replace(/[^a-zA-Z0-9-_]/g, "_") || "media"
        const ext = mediaExtension(row.mediaType, row.mimetype)
        const filename = safeId + ext
        await fs.mkdir(this.mediaDir, { recursive: true })
        await fs.writeFile(path.join(this.mediaDir, filename), buf)
        row.mediaUrl = "/api/media/" + encodeURIComponent(filename) +
          (this.accountId === "default" ? "" : "?accountId=" + encodeURIComponent(this.accountId))
      } catch (err) {
        LOG.warn({ err }, "Failed to download incoming media")
      }
    }

    const buffer = this.messagesByChat.get(row.chatId) || []
    buffer.push(row)
    if (buffer.length > MAX_BUFFERED_PER_CHAT) buffer.splice(0, buffer.length - MAX_BUFFERED_PER_CHAT)
    this.messagesByChat.set(row.chatId, buffer)

    if (this.onMessage) this.onMessage(row)
  }

  resolveWaiters(error) {
    const waiters = [...this.readyWaiters]
    this.readyWaiters = []
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
}

export async function resetWhatsAppSession(sessionDir) {
  await fs.rm(sessionDir, { recursive: true, force: true })
}

// ---- Helpers ----------------------------------------------------------------

function toIncomingRow(msg) {
  const remoteJid = msg.key?.remoteJid || ""
  if (!remoteJid || remoteJid === "status@broadcast") return null

  const isGroup = remoteJid.endsWith("@g.us")
  const { text, mediaType, mimetype, mentionedJids } = describeMessage(msg.message)
  if (!text && !mediaType) return null

  return {
    id: msg.key?.id || `${Date.now()}-${Math.random()}`,
    chatId: remoteJid,
    isGroup,
    sender: msg.pushName || (msg.key?.participant || remoteJid).split("@")[0],
    senderId: isGroup ? msg.key?.participant || null : remoteJid,
    text: text || "",
    mediaType: mediaType || null,
    mimetype: mimetype || null,
    hasMedia: Boolean(mediaType),
    mentionedJids,
    ts: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
    fromMe: Boolean(msg.key?.fromMe),
  }
}

function describeMessage(message) {
  if (!message || typeof message !== "object") return describeText("")
  if (message.conversation) return describeText(message.conversation)
  if (message.extendedTextMessage?.text)
    return describeText(message.extendedTextMessage.text, message.extendedTextMessage.contextInfo)
  if (message.imageMessage)
    return {
      text: String(message.imageMessage.caption || ""),
      mediaType: "image",
      mimetype: message.imageMessage.mimetype || "image/jpeg",
      mentionedJids: getMentionedJids(message.imageMessage.contextInfo),
    }
  if (message.videoMessage)
    return {
      text: String(message.videoMessage.caption || ""),
      mediaType: "video",
      mimetype: message.videoMessage.mimetype || "video/mp4",
      mentionedJids: getMentionedJids(message.videoMessage.contextInfo),
    }
  if (message.audioMessage)
    return {
      text: "",
      mediaType: "audio",
      mimetype: message.audioMessage.mimetype || "audio/ogg",
      mentionedJids: getMentionedJids(message.audioMessage.contextInfo),
    }
  if (message.documentMessage)
    return {
      text: String(message.documentMessage.caption || message.documentMessage.fileName || ""),
      mediaType: "document",
      mimetype: message.documentMessage.mimetype || "application/octet-stream",
      mentionedJids: getMentionedJids(message.documentMessage.contextInfo),
    }
  if (message.stickerMessage)
    return {
      text: "",
      mediaType: "sticker",
      mimetype: "image/webp",
      mentionedJids: getMentionedJids(message.stickerMessage.contextInfo),
    }
  if (message.pollCreationMessage?.name)
    return describeText(`[Poll] ${message.pollCreationMessage.name}`, message.pollCreationMessage.contextInfo)
  return describeText("")
}

function describeText(text, contextInfo) {
  return {
    text: String(text || ""),
    mediaType: null,
    mimetype: null,
    mentionedJids: getMentionedJids(contextInfo),
  }
}

function getMentionedJids(contextInfo) {
  const mentioned = contextInfo?.mentionedJid || contextInfo?.mentionedJids || []
  return Array.isArray(mentioned) ? mentioned.map((jid) => String(jid || "").trim()).filter(Boolean) : []
}

export function mediaExtension(mediaType, mimetype) {
  const cleanMime = String(mimetype || "").split(";")[0].trim().toLowerCase()
  const mapped = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  }[cleanMime]
  if (mapped) return mapped
  const fromMime = cleanMime.split("/")[1]
  if (fromMime) return "." + fromMime.replace("jpeg", "jpg").replace(/[^a-z0-9]+/g, "-")
  if (mediaType === "image") return ".jpg"
  if (mediaType === "video") return ".mp4"
  if (mediaType === "audio") return ".ogg"
  return ".bin"
}

async function writeQrPng(qrData, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await QRCode.toFile(outPath, qrData, { margin: 1, scale: 8 })
  return outPath
}

async function printTerminalQr(qrValue) {
  const qr = await QRCode.toString(qrValue, { type: "terminal", small: true })
  console.log("\nScan this QR with WhatsApp > Linked devices:\n")
  console.log(qr)
  console.log(`(If it's hard to scan, open the larger image: ${process.cwd()}/wa-qr.png)\n`)
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function clampTypingDuration(durationMs) {
  if (durationMs === undefined || durationMs === null) return 30000
  const ms = Number(durationMs)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw badRequest("`durationMs` must be a positive number of milliseconds")
  }
  return Math.min(Math.trunc(ms), 300000)
}
