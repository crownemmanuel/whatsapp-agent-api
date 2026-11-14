import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { AccountRegistry } from "../src/accounts.js"
import { createApiServer } from "../src/api-server.js"
import { buildOpenApiSpec } from "../src/openapi.js"
import { matchesCodexRule } from "../src/codex-agent.js"

function bridge(id) {
  return {
    isReady: true,
    me: { id },
    lastQr: "",
    groups: new Map([[id, { id, name: id }]]),
    contacts: new Map(),
    startCalls: 0,
    stopCalls: 0,
    async start() { this.startCalls++ },
    async stop() { this.stopCalls++ },
    findGroups() { return [...this.groups.values()] },
    async sendText(to, text) { return { to, text, accountId: id } },
  }
}

test("secondary accounts persist independently and relink only their own session", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-accounts-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const defaultSessionDir = path.join(rootDir, "default")
  const defaultQrPath = path.join(rootDir, "default-qr.png")
  await fs.mkdir(defaultSessionDir)
  const primary = bridge("default")
  const created = []
  const createBridge = (id, paths) => { created.push({ id, paths }); return bridge(id) }
  const accounts = new AccountRegistry({ rootDir, defaultBridge: primary, defaultSessionDir, defaultQrPath, createBridge })
  await accounts.load()
  await accounts.add("work")
  assert.equal(accounts.get("default").bridge, primary)
  assert.equal(accounts.get("work").bridge.startCalls, 1)
  assert.equal(created[0].paths.sessionDir, path.join(rootDir, "work", "auth"))
  await assert.rejects(accounts.add("work"), { statusCode: 409 })
  await assert.rejects(accounts.add("../bad"), { statusCode: 400 })
  assert.throws(() => accounts.get("missing"), { statusCode: 404 })
  await fs.mkdir(path.join(rootDir, "work", "auth"))
  await fs.writeFile(path.join(rootDir, "work", "auth", "creds.json"), "session")
  const old = accounts.get("work").bridge
  await accounts.relink("work")
  assert.equal(old.stopCalls, 1)
  assert.equal(accounts.get("work").bridge.startCalls, 1)
  await assert.rejects(fs.stat(path.join(rootDir, "work", "auth", "creds.json")), { code: "ENOENT" })
  assert.equal(primary.stopCalls, 0)
  const currentWork = accounts.get("work").bridge
  await fs.writeFile(path.join(defaultSessionDir, "creds.json"), "primary session")
  await fs.writeFile(defaultQrPath, "stale QR")
  await accounts.relink("default")
  assert.equal(primary.stopCalls, 1)
  assert.equal(accounts.get("default").bridge.startCalls, 1)
  assert.equal(created.at(-1).paths.sessionDir, defaultSessionDir)
  assert.equal(currentWork.stopCalls, 0)
  await assert.rejects(fs.stat(path.join(defaultSessionDir, "creds.json")), { code: "ENOENT" })
  await assert.rejects(fs.stat(defaultQrPath), { code: "ENOENT" })
  const restored = new AccountRegistry({ rootDir, defaultBridge: primary, defaultSessionDir, defaultQrPath, createBridge })
  await restored.load()
  assert.deepEqual(restored.list().map((account) => account.id), ["default", "work"])
})

test("API targets the selected account and keeps old calls on default", async (t) => {
  const primary = bridge("default")
  const work = bridge("work")
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-media-"))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootDir, "default"))
  await fs.mkdir(path.join(rootDir, "work"))
  await fs.writeFile(path.join(rootDir, "default", "message.txt"), "primary")
  await fs.writeFile(path.join(rootDir, "work", "message.txt"), "secondary")
  const accountEntries = Object.fromEntries([["default", primary], ["work", work]].map(([id, selected]) =>
    [id, { id, bridge: selected, qrPath: null, mediaDir: path.join(rootDir, id) }]))
  const accounts = {
    get(id) {
      const selected = accountEntries[id]
      if (!selected) throw Object.assign(new Error("Unknown account"), { statusCode: 404 })
      return selected
    },
    list() { return [{ id: "default" }, { id: "work" }] },
    async relink(id) {
      const selected = this.get(id)
      selected.bridge.isReady = false
      selected.bridge.lastQr = "qr"
      selected.qrPath = path.join(rootDir, "qr.png")
      await fs.writeFile(selected.qrPath, "fake-png")
      return { id, connected: false }
    },
  }
  const api = createApiServer({ port: 0, bridge: primary, accounts })
  t.after(() => api.close())
  await new Promise((resolve) => setImmediate(resolve))
  const base = "http://127.0.0.1:" + api.address().port
  let response = await fetch(base + "/api/accounts")
  assert.deepEqual(await response.json(), accounts.list())
  response = await fetch(base + "/api/status?accountId=work")
  assert.equal((await response.json()).user.id, "work")
  work.isReady = false
  work.reconnecting = true
  response = await fetch(base + "/api/status?accountId=work")
  assert.equal((await response.json()).reconnecting, true)
  response = await fetch(base + "/api/groups")
  assert.equal((await response.json())[0].id, "default")
  response = await fetch(base + "/api/groups?accountId=work")
  assert.equal((await response.json())[0].id, "work")
  response = await fetch(base + "/api/messages?accountId=work", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "123", text: "hi" }),
  })
  assert.equal((await response.json()).accountId, "work")
  response = await fetch(base + "/api/status?accountId=missing")
  assert.equal(response.status, 404)
  response = await fetch(base + "/api/accounts/default/relink", { method: "POST" })
  assert.equal(response.status, 200)
  response = await fetch(base + "/api/status")
  assert.equal((await response.json()).qrAvailable, true)
  response = await fetch(base + "/api/qr")
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "fake-png")
  response = await fetch(base + "/api/media/message.txt?accountId=work")
  assert.equal(await response.text(), "secondary")
  response = await fetch(base + "/api/media/message.txt")
  assert.equal(await response.text(), "primary")
  assert.ok(buildOpenApiSpec().paths["/api/accounts"].post)
})

test("Codex rules remain scoped to their WhatsApp account", () => {
  const rule = { enabled: true, accountId: "work", chatType: "all", allowedSenderIds: [] }
  assert.equal(matchesCodexRule(rule, { accountId: "work", chatId: "123@s.whatsapp.net" }), true)
  assert.equal(matchesCodexRule(rule, { accountId: "default", chatId: "123@s.whatsapp.net" }), false)
})
