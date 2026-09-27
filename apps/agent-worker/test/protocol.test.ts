import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientCommand, DurableServerEvent, REALTIME_TOPIC, SessionReplay } from "@rehearsal/contracts";
import { decodeCommand, replay } from "../src/events.js";
import { initialCheckpoint } from "./helpers.js";

const command = ClientCommand.parse({
  v: 1, sessionId: "test-session", id: "cmd", seq: 0, type: "learner.text", payload: { text: "Hello" },
});

test("commands validate sender, session, topic, direction and payload before handling", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(command));
  assert.deepEqual(decodeCommand(bytes, "learner", "learner", "test-session", REALTIME_TOPIC), command);
  assert.throws(() => decodeCommand(bytes, "attacker", "learner", "test-session", REALTIME_TOPIC));
  assert.throws(() => decodeCommand(bytes, "learner", "learner", "foreign", REALTIME_TOPIC));
  assert.throws(() => decodeCommand(bytes, "learner", "learner", "test-session", "wrong"));
  assert.throws(() => decodeCommand(new Uint8Array(17000), "learner", "learner", "test-session", REALTIME_TOPIC));
  for (const invalid of [{ ...command, seq: 1 }, { ...command, v: 2 }, { ...command, extra: true },
    { ...command, payload: { text: "" } }, { ...command, type: "agent.state", payload: { state: "listening" } }]) {
    assert.throws(() => decodeCommand(new TextEncoder().encode(JSON.stringify(invalid)),
      "learner", "learner", "test-session", REALTIME_TOPIC));
  }
});

test("replay is consecutive, preserves event IDs, and uses non-durable high-watermark", () => {
  const checkpoint = initialCheckpoint();
  const events = [1, 2].map((seq) => DurableServerEvent.parse({
    v: 1, sessionId: checkpoint.sessionId, id: `e${seq}`, seq, type: "agent.state", payload: { state: "listening" },
  }));
  checkpoint.seq = 2;
  const result = replay(checkpoint, events, "sync", 0);
  SessionReplay.parse(result);
  assert.equal(result.seq, 2);
  assert.equal(result.payload.mode, "events");
  if (result.payload.mode === "events") assert.deepEqual(result.payload.events, events);
  assert.equal(checkpoint.seq, 2);
  assert.equal(replay(checkpoint, [events[1]!], "sync", 0).payload.mode, "snapshot");
  assert.equal(replay(checkpoint, events, "sync", 10).payload.mode, "snapshot");
  checkpoint.seq = 300;
  assert.equal(replay(checkpoint, [], "sync", 0).payload.mode, "snapshot");
});
