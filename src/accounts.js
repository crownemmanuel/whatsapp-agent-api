import fs from "node:fs/promises"
import path from "node:path"
import { resetWhatsAppSession } from "./whatsapp.js"

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export class AccountRegistry {
  constructor({ rootDir, defaultBridge, defaultSessionDir, defaultQrPath, defaultMediaDir, createBridge }) {
    this.rootDir = rootDir
    this.defaultSessionDir = defaultSessionDir
    this.createBridge = createBridge
    this.relinking = new Set()
    this.accounts = new Map([["default", { id: "default", bridge: defaultBridge, qrPath: defaultQrPath, mediaDir: defaultMediaDir }]])
  }

  get(id = "default") {
    const account = this.accounts.get(id)
    if (!account) {
      const error = new Error(`Unknown WhatsApp account: ${id}`)
      error.statusCode = 404
      throw error
    }
    return account
  }

  list() {
    return Array.from(this.accounts.values(), ({ id, bridge }) => ({
      id,
      connected: bridge.isReady,
      reconnecting: Boolean(bridge.reconnecting),
      user: bridge.me || null,
      awaitingLink: !bridge.isReady && Boolean(bridge.lastQr),
      groupCount: bridge.groups.size,
    }))
  }

  async load() {
    await fs.mkdir(this.rootDir, { recursive: true })
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && ACCOUNT_ID.test(entry.name) && entry.name !== "default") {
        this.register(entry.name)
      }
    }
  }

  register(id) {
    const root = path.join(this.rootDir, id)
    const qrPath = path.join(root, "qr.png")
    const mediaDir = path.join(root, "media")
    const bridge = this.createBridge(id, { sessionDir: path.join(root, "auth"), qrPath, mediaDir })
    const account = { id, bridge, qrPath, mediaDir }
    this.accounts.set(id, account)
    return account
  }

  async add(id) {
    if (typeof id !== "string" || !ACCOUNT_ID.test(id) || id === "default") {
      const error = new Error("Account ID must be 1-32 lowercase letters, digits, or hyphens and cannot be default")
      error.statusCode = 400
      throw error
    }
    if (this.accounts.has(id)) {
      const error = new Error(`WhatsApp account already exists: ${id}`)
      error.statusCode = 409
      throw error
    }
    await fs.mkdir(path.join(this.rootDir, id), { recursive: false })
    const account = this.register(id)
    await account.bridge.start()
    return this.list().find((item) => item.id === id)
  }

  async relink(id) {
    const old = this.get(id)
    if (this.relinking.has(id)) {
      const error = new Error(`WhatsApp account is already relinking: ${id}`)
      error.statusCode = 409
      throw error
    }
    this.relinking.add(id)
    try {
      const sessionDir = id === "default" ? this.defaultSessionDir : path.join(this.rootDir, id, "auth")
      await old.bridge.stop()
      await fs.rm(old.qrPath, { force: true })
      await resetWhatsAppSession(sessionDir)
      const bridge = this.createBridge(id, { sessionDir, qrPath: old.qrPath, mediaDir: old.mediaDir })
      this.accounts.set(id, { ...old, bridge })
      await bridge.start()
      return this.list().find((item) => item.id === id)
    } finally {
      this.relinking.delete(id)
    }
  }

  async startAll() {
    for (const account of this.accounts.values()) await account.bridge.start()
  }

  async stopAll() {
    await Promise.all(Array.from(this.accounts.values(), ({ bridge }) => bridge.stop()))
  }
}
