import assert from "node:assert/strict";
import { test } from "node:test";
import { CloseAck, DurableServerEvent, sessionKeys } from "@rehearsal/contracts";
import { redisStore, LEASE_MS, type RedisPort } from "../src/store.js";
import { bootstrap, initialCheckpoint, lease } from "./helpers.js";

function setup() {
  const keys = sessionKeys(bootstrap.sessionId);
  const data = new Map<string, string>([[keys.bootstrap, JSON.stringify(bootstrap)],
    [keys.checkpoint, JSON.stringify(initialCheckpoint())]]);
  const evaluations: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  let result: unknown = 1;
  const redis: RedisPort = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { if (!data.has(key)) data.set(key, value); return "OK"; },
    hGet: async () => null, xRange: async () => [], isOpen: true, quit: async () => {},
    eval: async (script, args) => { evaluations.push({ script, ...args }); return result; },
  };
  return { keys, data, evaluations, store: redisStore(redis, bootstrap.sessionId, 86400),
    result: (value: unknown) => { result = value; } };
}

test("lease adapter passes bootstrap/closeAck/checkpoint atomically and checks returned lease shape", async () => {
  const fixture = setup();
  fixture.result(JSON.stringify(lease));
  assert.deepEqual(await fixture.store.acquire(lease.workerId), lease);
  const invocation = fixture.evaluations[0]!;
  assert.deepEqual(invocation.keys, [fixture.keys.lease, fixture.keys.checkpoint, fixture.keys.closeAck, fixture.keys.bootstrap]);
  assert.equal(invocation.arguments[1], String(LEASE_MS));
  assert.ok(invocation.script.includes("BOOTSTRAP_MISSING"));
  assert.ok(invocation.script.includes("CHECKPOINT_MISSING"));
  assert.ok(invocation.script.includes("SESSION_FROZEN"));
  assert.ok(invocation.script.includes("epoch + 1"));
  fixture.result("null");
  await assert.rejects(fixture.store.acquire(lease.workerId));
});

test("atomic write supplies exact canonical keys, checkpoint, event and previous sequence", async () => {
  const fixture = setup();
  const next = { ...initialCheckpoint(), workerId: lease.workerId, epoch: lease.epoch, seq: 1 };
  const event = DurableServerEvent.parse({ v: 1, sessionId: bootstrap.sessionId, id: "e1", seq: 1,
    type: "command.ack", payload: { commandId: "c1", status: "accepted" } });
  await fixture.store.write(next, 0, event);
  const invocation = fixture.evaluations[0]!;
  assert.deepEqual(invocation.keys, [fixture.keys.lease, fixture.keys.checkpoint, fixture.keys.events,
    fixture.keys.commands, fixture.keys.closeAck]);
  assert.deepEqual(invocation.arguments.slice(0, 3), [lease.workerId, String(lease.epoch), "0"]);
  assert.deepEqual(JSON.parse(invocation.arguments[3]!), next);
  assert.deepEqual(JSON.parse(invocation.arguments[5]!), event);
  assert.ok(invocation.script.includes("'MAXLEN', 256"));
  assert.ok(invocation.script.includes("STALE_WORKER"));
  assert.ok(invocation.script.includes("DUPLICATE_COMMAND"));
  await assert.rejects(fixture.store.write({ ...next, sessionId: "foreign" }, 0, event));
});

test("close adapter rejects foreign or nonmatching record before atomic freeze", async () => {
  const fixture = setup();
  const checkpoint = { ...initialCheckpoint(), workerId: lease.workerId, epoch: lease.epoch, seq: 2 };
  checkpoint.snapshot.state = "ended";
  checkpoint.snapshot.endReason = "user";
  checkpoint.metrics = { durationMs: 4200, suggestionsOffered: 1, suggestionsAdopted: 1, nice: 2, nit: 1 };
  fixture.data.set(fixture.keys.checkpoint, JSON.stringify(checkpoint));
  const ack = CloseAck.parse({
    v: 1, sessionId: bootstrap.sessionId, commandId: "close", workerId: lease.workerId, epoch: lease.epoch,
    finalSeq: 2, record: { sessionId: bootstrap.sessionId, courseId: bootstrap.course.id, transcript: [],
      findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0, endReason: "user",
      metrics: { durationMs: 4200, suggestionsOffered: 1, suggestionsAdopted: 1, nice: 2, nit: 1 } },
  });
  await assert.rejects(fixture.store.freeze({ ...ack, epoch: 1 }));
  await assert.rejects(fixture.store.freeze({ ...ack, record: { ...ack.record, goalMet: true } }));
  await assert.rejects(fixture.store.freeze({ ...ack, record: { ...ack.record, metrics: { ...ack.record.metrics!, durationMs: 1 } } }));
  assert.equal(fixture.evaluations.length, 0);
  await fixture.store.freeze(ack);
  const script = fixture.evaluations[0]!.script;
  assert.ok(script.includes("checkpoint.workerId ~= lease.workerId"));
  assert.ok(script.includes("checkpoint.epoch ~= lease.epoch"));
  assert.ok(script.includes("ack.workerId ~= lease.workerId"));
  assert.ok(script.includes("ack.epoch ~= lease.epoch"));
  assert.ok(script.includes("closeRequest.commandId ~= ack.commandId"));
});

test("first close request is read back, not overwritten by a second initiator", async () => {
  const fixture = setup();
  const first = { v: 1 as const, sessionId: bootstrap.sessionId, commandId: "first", reason: "network" as const };
  assert.deepEqual(await fixture.store.requestClose(first), first);
  assert.deepEqual(await fixture.store.requestClose({ ...first, commandId: "later", reason: "user" }), first);
});
