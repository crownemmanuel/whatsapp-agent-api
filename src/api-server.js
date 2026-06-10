import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { buildOpenApiSpec, renderManagementHtml, renderSwaggerHtml } from "./openapi.js"

const MEDIA_FILENAME_REG = /^[a-zA-Z0-9_.-]+\.(jpe?g|png|gif|webp|mp4|ogg|mp3|bin|pdf)$/

export function createApiServer({ port, mediaDir, bridge, webhooks, codexAgent, cronJobs }) {
  const openApiSpec = buildOpenApiSpec()

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { mediaDir, bridge, webhooks, codexAgent, cronJobs, openApiSpec })
    } catch (error) {
      sendJson(res, error?.statusCode || 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  server.listen(port, "0.0.0.0", () => {
    console.log(`API listening on http://localhost:${port}`)
  })

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Change apiPort in data/config.json or stop the other process.`)
    } else {
      console.error("API server error:", err.message)
    }
  })

  return { close: () => server.close() }
}

async function route(req, res, ctx) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const { pathname } = url
  const method = req.method || "GET"

  // ---- Pages ----------------------------------------------------------------
  if (method === "GET" && (pathname === "/" || pathname === "/ui")) {
    return sendHtml(res, renderManagementHtml())
  }
  if (method === "GET" && pathname === "/docs") {
    return sendHtml(res, renderSwaggerHtml())
  }
  if (method === "GET" && (pathname === "/openapi.json" || pathname === "/openapi")) {
    return sendJson(res, 200, ctx.openApiSpec)
  }

  // ---- Status ---------------------------------------------------------------
  if (method === "GET" && pathname === "/api/status") {
    return sendJson(res, 200, {
      connected: ctx.bridge.isReady,
      user: ctx.bridge.me || null,
      groupCount: ctx.bridge.groups.size,
      contactCount: ctx.bridge.contacts.size,
    })
  }

  // ---- Directory ------------------------------------------------------------
  if (method === "GET" && pathname === "/api/groups") {
    return sendJson(res, 200, ctx.bridge.findGroups(url.searchParams.get("q"), parseLimit(url)))
  }
  if (method === "GET" && pathname === "/api/contacts") {
    return sendJson(res, 200, ctx.bridge.findContacts(url.searchParams.get("q"), parseLimit(url)))
  }
  if (method === "GET" && pathname === "/api/contacts/resolve") {
    const number = url.searchParams.get("number")
    const jid = await ctx.bridge.resolveJid(number)
    return sendJson(res, 200, { id: jid, number: String(number).replace(/\D/g, "") })
  }

  // ---- Messages -------------------------------------------------------------
  const msgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/)
  if (method === "GET" && msgMatch) {
    const chatId = decodeURIComponent(msgMatch[1])
    return sendJson(res, 200, ctx.bridge.getMessages(chatId, parseLimit(url)))
  }

  const typingMatch = pathname.match(/^\/api\/chats\/([^/]+)\/typing$/)
  if (method === "POST" && typingMatch) {
    const chatId = decodeURIComponent(typingMatch[1])
    const body = await readJson(req)
    const result = await ctx.bridge.setTyping(chatId, body.state || "composing", body.durationMs)
    return sendJson(res, 200, result)
  }

  if (method === "POST" && pathname === "/api/messages") {
    const body = await readJson(req)
    const result = await ctx.bridge.sendText(body.to, body.text)
    return sendJson(res, 200, result)
  }

  if (method === "POST" && pathname === "/api/messages/media") {
    const body = await readJson(req)
    const buffer = await resolveMediaBuffer(body)
    const result = await ctx.bridge.sendMedia(body.to, {
      type: body.type,
      buffer,
      caption: body.caption,
      mimetype: body.mimetype,
      filename: body.filename,
      ptt: body.ptt,
    })
    return sendJson(res, 200, result)
  }

  // ---- Webhooks -------------------------------------------------------------
  if (method === "GET" && pathname === "/api/webhooks") {
    return sendJson(res, 200, ctx.webhooks.list())
  }
  if (method === "POST" && pathname === "/api/webhooks") {
    const body = await readJson(req)
    const created = await ctx.webhooks.add(body)
    if (!created) return sendJson(res, 400, { error: "A valid http(s) `url` is required" })
    return sendJson(res, 201, created)
  }
  const whMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/)
  if (method === "DELETE" && whMatch) {
    const removed = await ctx.webhooks.remove(decodeURIComponent(whMatch[1]))
    if (!removed) return sendJson(res, 404, { error: "Webhook not found" })
    return sendJson(res, 200, { ok: true })
  }

  // ---- Codex agent ----------------------------------------------------------
  if (method === "GET" && pathname === "/api/codex/status") {
    return sendJson(res, 200, await ctx.codexAgent.status())
  }
  if (method === "GET" && pathname === "/api/codex/config") {
    return sendJson(res, 200, ctx.codexAgent.get())
  }
  if (method === "PUT" && pathname === "/api/codex/config") {
    return sendJson(res, 200, await ctx.codexAgent.save(await readJson(req)))
  }
  if (method === "GET" && pathname === "/api/codex/rules") {
    return sendJson(res, 200, ctx.codexAgent.get().rules)
  }
  if (method === "POST" && pathname === "/api/codex/rules") {
    const created = await ctx.codexAgent.addRule(await readJson(req))
    if (!created) return sendJson(res, 400, { error: "Invalid Codex rule" })
    return sendJson(res, 201, created)
  }
  const codexRuleMatch = pathname.match(/^\/api\/codex\/rules\/([^/]+)$/)
  if (method === "PUT" && codexRuleMatch) {
    const updated = await ctx.codexAgent.updateRule(decodeURIComponent(codexRuleMatch[1]), await readJson(req))
    if (!updated) return sendJson(res, 404, { error: "Codex rule not found" })
    return sendJson(res, 200, updated)
  }
  if (method === "DELETE" && codexRuleMatch) {
    const removed = await ctx.codexAgent.removeRule(decodeURIComponent(codexRuleMatch[1]))
    if (!removed) return sendJson(res, 404, { error: "Codex rule not found" })
    return sendJson(res, 200, { ok: true })
  }
  if (method === "GET" && pathname === "/api/codex/runs") {
    return sendJson(res, 200, ctx.codexAgent.status ? (await ctx.codexAgent.status()).recentRuns : [])
  }
  if (method === "GET" && pathname === "/api/codex/memory") {
    const chatId = url.searchParams.get("chatId")
    if (!chatId) return sendJson(res, 400, { error: "`chatId` is required" })
    return sendJson(
      res,
      200,
      await ctx.codexAgent.readMemory({
        chatId,
        chatName: url.searchParams.get("chatName") || "",
        isGroup: url.searchParams.get("isGroup") === "true",
      }),
    )
  }
  if (method === "PUT" && pathname === "/api/codex/memory") {
    const body = await readJson(req)
    if (!body.chatId) return sendJson(res, 400, { error: "`chatId` is required" })
    return sendJson(res, 200, await ctx.codexAgent.writeMemory(body))
  }

  // ---- Cron jobs ------------------------------------------------------------
  if (method === "GET" && pathname === "/api/cron/status") {
    return sendJson(res, 200, await ctx.cronJobs.status())
  }
  if (method === "GET" && pathname === "/api/cron/config") {
    return sendJson(res, 200, ctx.cronJobs.get())
  }
  if (method === "PUT" && pathname === "/api/cron/config") {
    return sendJson(res, 200, await ctx.cronJobs.save(await readJson(req)))
  }
  if (method === "GET" && pathname === "/api/cron/jobs") {
    return sendJson(res, 200, ctx.cronJobs.listJobs())
  }
  if (method === "POST" && pathname === "/api/cron/jobs") {
    const created = await ctx.cronJobs.addJob(await readJson(req))
    if (!created) return sendJson(res, 400, { error: "Invalid cron job" })
    return sendJson(res, 201, created)
  }
  if (method === "GET" && pathname === "/api/cron/runs") {
    return sendJson(res, 200, (await ctx.cronJobs.status()).recentRuns || [])
  }
  if (method === "POST" && pathname === "/api/cron/chat") {
    const body = await readJson(req)
    return sendJson(res, 200, await ctx.cronJobs.chat(body))
  }
  const cronRunMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/run$/)
  if (method === "POST" && cronRunMatch) {
    return sendJson(res, 200, await ctx.cronJobs.runJob(decodeURIComponent(cronRunMatch[1])))
  }
  const cronMemoryMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/memory$/)
  if (method === "GET" && cronMemoryMatch) {
    return sendJson(res, 200, await ctx.cronJobs.readMemory({ jobId: decodeURIComponent(cronMemoryMatch[1]) }))
  }
  if (method === "PUT" && cronMemoryMatch) {
    const body = await readJson(req)
    return sendJson(
      res,
      200,
      await ctx.cronJobs.writeMemory({ jobId: decodeURIComponent(cronMemoryMatch[1]), text: body.text || "" }),
    )
  }
  const cronJobMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)$/)
  if (method === "GET" && cronJobMatch) {
    const job = ctx.cronJobs.getJob(decodeURIComponent(cronJobMatch[1]))
    if (!job) return sendJson(res, 404, { error: "Cron job not found" })
    return sendJson(res, 200, job)
  }
  if (method === "PUT" && cronJobMatch) {
    const updated = await ctx.cronJobs.updateJob(decodeURIComponent(cronJobMatch[1]), await readJson(req))
    if (!updated) return sendJson(res, 404, { error: "Cron job not found" })
    return sendJson(res, 200, updated)
  }
  if (method === "DELETE" && cronJobMatch) {
    const removed = await ctx.cronJobs.removeJob(decodeURIComponent(cronJobMatch[1]))
    if (!removed) return sendJson(res, 404, { error: "Cron job not found" })
    return sendJson(res, 200, { ok: true })
  }

  // ---- Media files ----------------------------------------------------------
  if (method === "GET" && pathname.startsWith("/api/media/")) {
    return serveMedia(res, ctx.mediaDir, decodeURIComponent(pathname.slice("/api/media/".length)))
  }

  return sendJson(res, 404, { error: "Not found" })
}

// ---- Media handling ---------------------------------------------------------

async function resolveMediaBuffer(body) {
  if (body.mediaBase64) {
    const base64 = String(body.mediaBase64).replace(/^data:[^;]+;base64,/, "")
    return Buffer.from(base64, "base64")
  }
  if (body.mediaUrl) {
    const resp = await fetch(String(body.mediaUrl))
    if (!resp.ok) {
      const err = new Error(`Failed to download mediaUrl (${resp.status})`)
      err.statusCode = 400
      throw err
    }
    return Buffer.from(await resp.arrayBuffer())
  }
  const err = new Error("Provide `mediaUrl` or `mediaBase64`")
  err.statusCode = 400
  throw err
}

async function serveMedia(res, mediaDir, filename) {
  if (!mediaDir || !MEDIA_FILENAME_REG.test(filename) || filename.includes("..")) {
    return sendJson(res, 400, { error: "Bad request" })
  }
  try {
    const buf = await fs.readFile(path.join(mediaDir, filename))
    res.writeHead(200, { "Content-Type": contentTypeFor(filename) })
    res.end(buf)
  } catch (err) {
    if (err?.code === "ENOENT") return sendJson(res, 404, { error: "Not found" })
    return sendJson(res, 500, { error: "Error reading media" })
  }
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase()
  return (
    {
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".mp4": "video/mp4",
      ".ogg": "audio/ogg",
      ".mp3": "audio/mpeg",
      ".pdf": "application/pdf",
    }[ext] || "application/octet-stream"
  )
}

// ---- HTTP helpers -----------------------------------------------------------

function parseLimit(url) {
  const n = Number(url.searchParams.get("limit"))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 500) : 50
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        const err = new Error("Invalid JSON payload")
        err.statusCode = 400
        reject(err)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(payload))
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(html)
}
