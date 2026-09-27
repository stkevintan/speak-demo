import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ClientCommand, REALTIME_TOPIC } from "@rehearsal/contracts";
import { RemoteParticipant, Room, RoomEvent } from "livekit-client";
import { LiveSession } from "./livekit";
import { useSessionStore } from "./store";

function setup(t: TestContext) {
  useSessionStore.getState().reset();
  const room = new Room();
  const commands: ClientCommand[] = [];
  t.mock.method(room, "connect", async () => {});
  t.mock.method(room, "disconnect", async () => {});
  const microphone = t.mock.method(room.localParticipant, "setMicrophoneEnabled", async () => undefined);
  t.mock.method(room.localParticipant, "publishData", async (data: Uint8Array, options: { reliable?: boolean; topic?: string; destinationIdentities?: string[] }) => {
    assert.equal(options.reliable, true);
    assert.equal(options.topic, REALTIME_TOPIC);
    assert.deepEqual(options.destinationIdentities, ["agent:session-1"]);
    commands.push(ClientCommand.parse(JSON.parse(new TextDecoder().decode(data))));
  });
  const live = new LiveSession({ sessionId: "session-1", livekit: { url: "wss://example.invalid", token: "unit-test-only" }, recalled: [] }, room);
  t.after(() => live.dispose());
  const agent = new RemoteParticipant(room.engine.client, "PA_agent", "agent:session-1");
  const receive = (value: unknown, sender = agent, topic = REALTIME_TOPIC) => {
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify(value)), sender, undefined, topic);
  };
  return { live, room, commands, microphone, receive };
}

test("commands retry with identical IDs/bodies and settle only their correlated ack", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(t);
  const promise = h.live.command({ type: "learner.text", payload: { text: "Hello" } });
  t.mock.timers.tick(4000);
  assert.equal(h.commands.length, 2);
  assert.deepEqual(h.commands[0], h.commands[1]);
  assert.equal(h.commands[0]?.seq, 0);
  h.receive({
    v: 1, sessionId: "session-1", id: "ack", seq: 1, type: "command.ack",
    payload: { commandId: h.commands[0]?.id, status: "accepted" },
  });
  await promise;
  t.mock.timers.tick(12_000);
  assert.equal(h.commands.length, 2);
});

test("only authenticated assigned agent identity and exact topic can change UI state", t => {
  const h = setup(t);
  const event = { v: 1, sessionId: "session-1", id: "state", seq: 1, type: "agent.state", payload: { state: "speaking" } };
  h.receive(event, new RemoteParticipant(h.room.engine.client, "PA_other", "other"));
  assert.equal(useSessionStore.getState().snapshot.state, "idle");
  h.receive(event, undefined, "untrusted");
  assert.equal(useSessionStore.getState().snapshot.state, "idle");
  h.receive(event);
  assert.equal(useSessionStore.getState().snapshot.state, "speaking");
});

test("sync settles on replay, not on an accepted command ack", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(t);
  h.live.sync();
  const commandId = h.commands[0]?.id;
  const ack = { v: 1, sessionId: "session-1", id: "sync-ack", seq: 1, type: "command.ack", payload: { commandId, status: "accepted" } };
  h.receive(ack);
  t.mock.timers.tick(4000);
  assert.equal(h.commands.length, 2);
  h.receive({
    v: 1, sessionId: "session-1", id: "replay", seq: 1, type: "session.replay",
    payload: { mode: "events", commandId, afterSeq: 0, events: [ack] },
  });
  t.mock.timers.tick(12_000);
  assert.equal(h.commands.length, 2);
  assert.equal(useSessionStore.getState().problem, null);
});

test("terminal command timeout is explicit and does not manufacture success", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(t);
  const pending = h.live.command({ type: "learner.text", payload: { text: "Hello" } });
  const rejected = assert.rejects(pending, /hasn't confirmed/);
  t.mock.timers.tick(4000);
  t.mock.timers.tick(4000);
  t.mock.timers.tick(4000);
  await rejected;
  assert.equal(h.commands.length, 3);
});

test("ending before connect completes never opens the microphone afterward", async t => {
  const h = setup(t);
  let complete = () => {};
  t.mock.method(h.room, "connect", () => new Promise<void>(resolve => { complete = resolve; }));
  const connecting = h.live.connect();
  h.live.stopMedia();
  complete();
  await connecting;
  assert.equal(h.microphone.mock.callCount(), 0);
  assert.equal(useSessionStore.getState().mic, false);
  await assert.rejects(h.live.command({ type: "learner.text", payload: { text: "Too late" } }), /closing/);
});

test("microphone denial offers typing without destroying the scene", async t => {
  const h = setup(t);
  t.mock.method(h.room.localParticipant, "setMicrophoneEnabled", async () => { throw new Error("NotAllowedError"); });
  await h.live.setMic(true);
  assert.equal(useSessionStore.getState().mode, "typing");
  assert.equal(useSessionStore.getState().mic, false);
  assert.match(useSessionStore.getState().micIssue ?? "", /permissions/);
});

test("disposing removes handlers and stops command retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(t);
  const pending = h.live.command({ type: "learner.interrupt", payload: {} });
  const rejected = assert.rejects(pending, /closed/);
  h.live.dispose();
  await rejected;
  h.receive({ v: 1, sessionId: "session-1", id: "late", seq: 1, type: "agent.state", payload: { state: "speaking" } });
  t.mock.timers.tick(12_000);
  assert.equal(h.commands.length, 1);
  assert.equal(useSessionStore.getState().snapshot.state, "idle");
});
