import assert from "node:assert/strict"
import test from "node:test"

import { WhatsAppBridge } from "../src/whatsapp.js"

function createBridge() {
  const calls = []
  const bridge = new WhatsAppBridge({})
  bridge.isReady = true
  bridge.sock = {
    sendPresenceUpdate: async (state, jid) => {
      calls.push({ state, jid })
    },
  }
  return { bridge, calls }
}

test("setTyping composing sends presence updates and paused clears the session", async () => {
  const { bridge, calls } = createBridge()

  const composing = await bridge.setTyping("120363000@g.us", "composing", 5000)
  assert.deepEqual(composing, { chatId: "120363000@g.us", state: "composing", durationMs: 5000 })
  assert.deepEqual(calls, [
    { state: "available", jid: undefined },
    { state: "composing", jid: "120363000@g.us" },
  ])
  assert.equal(bridge.typingSessions.size, 1)

  const paused = await bridge.setTyping("120363000@g.us", "paused")
  assert.deepEqual(paused, { chatId: "120363000@g.us", state: "paused" })
  assert.equal(calls.at(-1).state, "paused")
  assert.equal(bridge.typingSessions.size, 0)
})

test("setTyping composing again extends the existing session without restarting it", async () => {
  const { bridge, calls } = createBridge()

  await bridge.setTyping("120363000@g.us", "composing", 5000)
  const callCount = calls.length
  await bridge.setTyping("120363000@g.us", "composing", 5000)

  assert.equal(calls.length, callCount, "no extra presence updates on extend")
  assert.equal(bridge.typingSessions.size, 1)

  await bridge.setTyping("120363000@g.us", "paused")
})

test("setTyping paused with no active session is a no-op", async () => {
  const { bridge, calls } = createBridge()
  const result = await bridge.setTyping("120363000@g.us", "paused")
  assert.deepEqual(result, { chatId: "120363000@g.us", state: "paused" })
  assert.deepEqual(calls, [])
})

test("setTyping validates state and clamps durationMs", async () => {
  const { bridge } = createBridge()

  await assert.rejects(() => bridge.setTyping("120363000@g.us", "typing"), /`state` must be/)
  await assert.rejects(() => bridge.setTyping("120363000@g.us", "composing", -1), /`durationMs`/)
  await assert.rejects(() => bridge.setTyping("120363000@g.us", "composing", "soon"), /`durationMs`/)

  const capped = await bridge.setTyping("120363000@g.us", "composing", 999999999)
  assert.equal(capped.durationMs, 300000)
  const defaulted = await bridge.setTyping("120363000@g.us", "composing")
  assert.equal(defaulted.durationMs, 30000)

  await bridge.setTyping("120363000@g.us", "paused")
})
