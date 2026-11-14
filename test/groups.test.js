import assert from "node:assert/strict"
import test from "node:test"
import { WhatsAppBridge } from "../src/whatsapp.js"
import { createApiServer } from "../src/api-server.js"
import { buildOpenApiSpec } from "../src/openapi.js"

function setup() {
  const calls = []
  const bridge = new WhatsAppBridge({})
  const group = { id: "123-456@g.us", subject: "Team", participants: [{ id: "14155550123@s.whatsapp.net", admin: "admin" }] }
  const results = [
    { jid: "14155550123@s.whatsapp.net", status: "200", content: {} },
    { jid: "14155550124@s.whatsapp.net", status: "403", content: {} },
  ]
  bridge.isReady = true
  bridge.sock = {
    onWhatsApp: async (number) => [{ exists: number !== "999", jid: number + "@s.whatsapp.net" }],
    groupCreate: async (...args) => { calls.push(args); return group },
    groupParticipantsUpdate: async (...args) => { calls.push(args); return results },
    groupMetadata: async (groupId) => { calls.push(["metadata", groupId]); return group },
    groupFetchAllParticipating: async () => ({ [group.id]: group }),
  }
  return { bridge, calls, group, results }
}

test("create normalizes and deduplicates participants and caches returned metadata", async () => {
  const { bridge, calls, group } = setup()
  assert.deepEqual(await bridge.createGroup(" Team ", ["+1 (415) 555-0123", "14155550123@s.whatsapp.net"]), group)
  assert.deepEqual(calls, [["Team", ["14155550123@s.whatsapp.net"]]])
  assert.equal(bridge.listGroups()[0].name, "Team")
})

test("add preserves individual failures and refreshes group directory", async () => {
  const { bridge, calls, results } = setup()
  const result = await bridge.addGroupParticipants("123-456@g.us", ["14155550123", "14155550124"])
  assert.deepEqual(result, { groupId: "123-456@g.us", participants: results })
  assert.equal(calls[0][2], "add")
  assert.equal(bridge.listGroups().length, 1)
})

test("list fetches current membership and updates the group directory", async () => {
  const { bridge, calls, group } = setup()
  assert.deepEqual(await bridge.getGroupParticipants(group.id), { groupId: group.id, participants: group.participants })
  assert.deepEqual(calls, [["metadata", group.id]])
  assert.equal(bridge.listGroups()[0].participantCount, 1)
})

test("invalid requests and unresolved numbers never mutate groups", async () => {
  const { bridge, calls } = setup()
  for (const participants of [undefined, [], "123", [null], [123], ["abc123"], ["123@g.us"], ["status@broadcast"]]) {
    await assert.rejects(bridge.createGroup("Team", participants), { statusCode: 400 })
  }
  for (const subject of [null, "", " ", 123, "x".repeat(101)]) {
    await assert.rejects(bridge.createGroup(subject, ["123@lid"]), { statusCode: 400 })
  }
  await assert.rejects(bridge.createGroup("Team", ["999"]), { statusCode: 400 })
  await assert.rejects(bridge.addGroupParticipants("123@s.whatsapp.net", ["123@lid"]), { statusCode: 400 })
  await assert.rejects(bridge.getGroupParticipants("123@s.whatsapp.net"), { statusCode: 400 })
  assert.deepEqual(calls, [])
  bridge.isReady = false
  await assert.rejects(bridge.createGroup("Team", ["123@lid"]), { statusCode: 503 })
  await assert.rejects(bridge.addGroupParticipants("123@g.us", ["123@lid"]), { statusCode: 503 })
  await assert.rejects(bridge.getGroupParticipants("123@g.us"), { statusCode: 503 })
})

test("HTTP group endpoints return creation, partial outcomes, validation and upstream errors", async (t) => {
  const { bridge, group, results } = setup()
  const api = createApiServer({ port: 0, bridge })
  t.after(() => api.close())
  await new Promise((resolve) => setImmediate(resolve))
  const base = "http://127.0.0.1:" + api.address().port
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  let response = await post("/api/groups", { subject: "Team", participants: ["123@lid"] })
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), group)
  response = await post("/api/groups/123-456%40g.us/participants", { participants: ["123@lid"] })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).participants, results)
  response = await fetch(base + "/api/groups/123-456%40g.us/participants")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { groupId: group.id, participants: group.participants })
  response = await fetch(base + "/api/groups/%ZZ/participants")
  assert.equal(response.status, 400)
  response = await fetch(base + "/api/groups/123%40s.whatsapp.net/participants")
  assert.equal(response.status, 400)
  for (const body of [null, [], {}, { subject: "Team", participants: [] }]) {
    response = await post("/api/groups", body)
    assert.equal(response.status, 400)
    await response.json()
  }
  response = await post("/api/groups/%ZZ/participants", { participants: ["123@lid"] })
  assert.equal(response.status, 400)
  await response.json()
  bridge.sock.groupCreate = async () => { throw new Error("WhatsApp refused creation") }
  response = await post("/api/groups", { subject: "Team", participants: ["123@lid"] })
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /refused/)
  bridge.isReady = false
  response = await fetch(base + "/api/groups/123-456%40g.us/participants")
  assert.equal(response.status, 503)
  response = await post("/api/groups", { subject: "Team", participants: ["123@lid"] })
  assert.equal(response.status, 503)
  await response.json()
  const spec = buildOpenApiSpec()
  assert.ok(spec.paths["/api/groups"].post)
  assert.ok(spec.paths["/api/groups/{groupId}/participants"].post)
  assert.ok(spec.paths["/api/groups/{groupId}/participants"].get)
})
