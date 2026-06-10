import assert from "node:assert/strict"
import test from "node:test"

import {
  buildCodexPrompt,
  defaultCodexAgentConfig,
  detectAttachmentKind,
  extractMediaDirectives,
  getChatWorkspaceName,
  getMatchingRule,
  normalizeCodexAgentConfig,
  normalizeCodexSandbox,
  resolveWorkspaceFile,
  toCodexSdkSandboxMode,
} from "../src/codex-agent.js"

const baseMessage = {
  id: "msg-1",
  chatId: "120363000@g.us",
  chatName: "Ops / Triage",
  isGroup: true,
  sender: "Ada",
  senderId: "14155550100@s.whatsapp.net",
  text: "@12025550123 please inspect the failing build",
  mentionedJids: ["12025550123@s.whatsapp.net"],
  fromMe: false,
  ts: 1717858800000,
}

test("normalizes codex config with safe defaults and rule-level sandbox values", () => {
  const config = normalizeCodexAgentConfig({
    enabled: true,
    defaultSandbox: "danger-full-access",
    rules: [
      {
        name: "Ops mention",
        chatType: "group",
        requireMention: true,
        sandbox: "read-only",
        keywords: "build, deploy",
      },
    ],
  })

  assert.equal(config.enabled, true)
  assert.equal(config.defaultSandbox, "full-access")
  assert.equal(config.autoReply, true)
  assert.equal(config.rules.length, 1)
  assert.equal(config.rules[0].sandbox, "read-only")
  assert.equal(config.rules[0].autoReply, null)
  assert.deepEqual(config.rules[0].keywords, ["build", "deploy"])
})

test("matches a group rule by chat, sender, keyword, and mention", () => {
  const rule = {
    id: "rule-1",
    enabled: true,
    chatType: "group",
    chatId: "120363000@g.us",
    allowedSenderIds: ["14155550100"],
    keywords: ["failing build"],
    requireMention: true,
  }

  assert.equal(getMatchingRule([rule], baseMessage, "12025550123@s.whatsapp.net"), rule)
})

test("does not match outgoing messages or unmatched direct-message rules", () => {
  const dmRule = {
    id: "dm",
    enabled: true,
    chatType: "dm",
    allowedSenderIds: [],
    keywords: [],
    requireMention: false,
  }

  assert.equal(getMatchingRule([dmRule], { ...baseMessage, isGroup: true }, null), null)
  assert.equal(getMatchingRule([{ ...dmRule, chatType: "all" }], { ...baseMessage, fromMe: true }, null), null)
})

test("can match linked-account messages when allowFromMe is enabled", () => {
  const rule = {
    id: "mine",
    enabled: true,
    chatType: "group",
    chatId: "120363000@g.us",
    allowedSenderIds: [],
    keywords: ["codex"],
    requireMention: false,
    allowFromMe: true,
  }

  assert.equal(
    getMatchingRule([rule], { ...baseMessage, fromMe: true, text: "hey codex check logs" }, null),
    rule,
  )
  assert.equal(
    getMatchingRule([rule], { ...baseMessage, fromMe: true, text: "hello team" }, null),
    null,
  )
  assert.equal(
    getMatchingRule([{ ...rule, allowFromMe: false }], { ...baseMessage, fromMe: true, text: "hey codex" }, null),
    null,
  )
})

test("uses stable sanitized workspace names per chat", () => {
  assert.equal(getChatWorkspaceName(baseMessage), "ops-triage-120363000-g-us")
  assert.equal(
    getChatWorkspaceName({ ...baseMessage, chatName: "", chatId: "14155550100@s.whatsapp.net" }),
    "14155550100-s-whatsapp-net",
  )
})

test("translates friendly sandbox labels to Codex SDK sandbox modes", () => {
  assert.equal(normalizeCodexSandbox("danger-full-access"), "full-access")
  assert.equal(normalizeCodexSandbox("full-access"), "full-access")
  assert.equal(toCodexSdkSandboxMode("full-access"), "danger-full-access")
  assert.equal(toCodexSdkSandboxMode("workspace-write"), "workspace-write")
  assert.equal(toCodexSdkSandboxMode("read-only"), "read-only")
})

test("extracts media directives and strips them from the reply text", () => {
  const { text, attachments } = extractMediaDirectives(
    [
      "Here is the chart you asked for.",
      "SEND_FILE: artifacts/revenue.png | Q2 revenue by region",
      "- `SEND_FILE: artifacts/report.pdf`",
      "send_voice: artifacts/summary.mp3",
      "Let me know if you need changes.",
    ].join("\n"),
  )

  assert.equal(text, "Here is the chart you asked for.\nLet me know if you need changes.")
  assert.deepEqual(attachments, [
    { path: "artifacts/revenue.png", caption: "Q2 revenue by region", ptt: false },
    { path: "artifacts/report.pdf", caption: "", ptt: false },
    { path: "artifacts/summary.mp3", caption: "", ptt: true },
  ])
})

test("leaves plain text untouched when there are no directives", () => {
  const { text, attachments } = extractMediaDirectives("All done. The file SEND_FILE is mentioned inline.")
  assert.equal(text, "All done. The file SEND_FILE is mentioned inline.")
  assert.deepEqual(attachments, [])
})

test("detects attachment kinds from file extensions", () => {
  assert.deepEqual(detectAttachmentKind("artifacts/photo.PNG"), { type: "image", mimetype: "image/png" })
  assert.deepEqual(detectAttachmentKind("clip.mp4"), { type: "video", mimetype: "video/mp4" })
  assert.deepEqual(detectAttachmentKind("note.mp3"), { type: "audio", mimetype: "audio/mpeg" })
  assert.deepEqual(detectAttachmentKind("report.pdf"), { type: "document", mimetype: "application/pdf" })
  assert.deepEqual(detectAttachmentKind("data.bin"), { type: "document", mimetype: "application/octet-stream" })
})

test("rejects attachment paths that escape the workspace", () => {
  assert.equal(resolveWorkspaceFile("/tmp/ws", "artifacts/a.png"), "/tmp/ws/artifacts/a.png")
  assert.throws(() => resolveWorkspaceFile("/tmp/ws", "../../etc/passwd"))
  assert.throws(() => resolveWorkspaceFile("/tmp/ws", "/etc/passwd"))
  assert.throws(() => resolveWorkspaceFile("/tmp/ws", "."))
})

test("prompt documents the media reply ability", () => {
  const prompt = buildCodexPrompt({
    config: defaultCodexAgentConfig(),
    rule: {},
    message: baseMessage,
    workspaceDir: "/tmp/ops-workspace",
    memoryText: "",
  })

  assert.match(prompt, /SEND_FILE: <path relative to the workspace>/)
  assert.match(prompt, /SEND_VOICE: <path to an audio file>/)
})

test("prompt includes WhatsApp metadata, memory, and artifact instructions", () => {
  const prompt = buildCodexPrompt({
    config: defaultCodexAgentConfig(),
    rule: { name: "Ops", prompt: "Be decisive." },
    message: baseMessage,
    workspaceDir: "/tmp/ops-workspace",
    memoryText: "- The deploy target is production.",
  })

  assert.match(prompt, /WhatsApp message/)
  assert.match(prompt, /Ops \/ Triage/)
  assert.match(prompt, /The deploy target is production/)
  assert.match(prompt, /\/tmp\/ops-workspace\/artifacts/)
  assert.match(prompt, /Be decisive/)
})
