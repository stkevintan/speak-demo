import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableServerEvent, SessionSnapshot } from "@rehearsal/contracts";
import { EventStream } from "./protocol";
import { emptySnapshot, reduceEvent, useSessionStore } from "./store";
import { turnPresentation } from "./turnState";

function event(seq: number, state: "listening" | "thinking" | "speaking" = "listening"): DurableServerEvent {
  return { v: 1, sessionId: "session-1", id: `event-${seq}`, seq, type: "agent.state", payload: { state } };
}

function harness() {
  let snapshot = emptySnapshot();
  const applied: number[] = [];
  const requests: number[] = [];
  const stream = new EventStream("session-1", {
    event: item => { snapshot = reduceEvent(snapshot, item); applied.push(item.seq); },
    snapshot: next => { snapshot = next; },
    sync: after => { requests.push(after); return `sync-${requests.length}`; },
  });
  return { stream, applied, requests, snapshot: () => snapshot };
}

test("live events advance only a contiguous cursor and duplicate delivery is harmless", () => {
  const h = harness();
  h.stream.receive(event(1));
  h.stream.receive(event(1));
  h.stream.receive(event(2, "thinking"));
  assert.equal(h.stream.cursor, 2);
  assert.deepEqual(h.applied, [1, 2]);
  assert.equal(h.snapshot().state, "thinking");
});

test("gap triggers sync, buffering live events until ordered replay reaches high-watermark", () => {
  const h = harness();
  h.stream.receive(event(1));
  h.stream.receive(event(4, "speaking"));
  assert.deepEqual(h.requests, [1]);
  assert.equal(h.stream.cursor, 1);
  const id = h.stream.receive({
    v: 1, sessionId: "session-1", id: "replay-1", seq: 3, type: "session.replay",
    payload: { mode: "events", commandId: "sync-1", afterSeq: 1, events: [event(2), event(3)] },
  });
  assert.equal(id, "sync-1");
  assert.equal(h.stream.cursor, 4);
  assert.deepEqual(h.applied, [1, 2, 3, 4]);
  assert.equal(h.snapshot().state, "speaking");
});

test("invalid or uncorrelated replay cannot jump the cursor", () => {
  const h = harness();
  h.stream.sync();
  h.stream.receive({
    v: 1, sessionId: "session-1", id: "replay", seq: 1, type: "session.replay",
    payload: { mode: "events", commandId: "unrelated", afterSeq: 0, events: [event(1)] },
  });
  assert.equal(h.stream.cursor, 0);
  assert.throws(() => h.stream.receive({
    v: 1, sessionId: "session-1", id: "replay", seq: 8, type: "session.replay",
    payload: { mode: "events", commandId: "sync-1", afterSeq: 0, events: [event(1)] },
  }));
  assert.equal(h.stream.cursor, 0);
});

test("trimmed history snapshot replaces public state and ended snapshot terminates session", () => {
  const h = harness();
  h.stream.receive(event(1, "speaking"));
  h.stream.sync();
  const snapshot: SessionSnapshot = {
    ...emptySnapshot(false), state: "ended", endReason: "network",
    transcript: [{ role: "learner", source: "typed", turnId: "turn-7", text: "Hello", tStart: 1, tEnd: 2 }],
  };
  h.stream.receive({
    v: 1, sessionId: "session-1", id: "snapshot", seq: 300, type: "session.replay",
    payload: { mode: "snapshot", commandId: "sync-1", snapshot },
  });
  assert.equal(h.stream.cursor, 300);
  assert.deepEqual(h.snapshot(), snapshot);
});

test("wrong version/session/direction and backwards timing are rejected", () => {
  const h = harness();
  for (const invalid of [
    { ...event(1), v: 2 },
    { ...event(1), sessionId: "another" },
    { ...event(1), unknown: true },
    { v: 1, sessionId: "session-1", id: "cmd", seq: 0, type: "learner.text", payload: { text: "Hello" } },
    { ...event(1), type: "transcript.final", payload: { turnId: "t", role: "learner", source: "asr", text: "Hello", tStart: 5, tEnd: 2 } },
  ]) assert.throws(() => h.stream.receive(invalid));
  assert.equal(h.stream.cursor, 0);
});

test("event ID reuse and replay/live sequence disagreement fail visibly", () => {
  const h = harness();
  h.stream.receive(event(1));
  assert.throws(() => h.stream.receive({ ...event(2), id: "event-1" }));
  h.stream.receive(event(3));
  assert.throws(() => h.stream.receive({
    v: 1, sessionId: "session-1", id: "replay", seq: 3, type: "session.replay",
    payload: { mode: "events", commandId: "sync-1", afterSeq: 1, events: [event(2), { ...event(3), id: "different" }] },
  }));
});

test("replay already buffered at the same sequence is not applied twice", () => {
  const h = harness();
  h.stream.sync();
  h.stream.receive(event(1));
  h.stream.receive({
    v: 1, sessionId: "session-1", id: "replay", seq: 1, type: "session.replay",
    payload: { mode: "events", commandId: "sync-1", afterSeq: 0, events: [event(1)] },
  });
  assert.deepEqual(h.applied, [1]);
});

test("sync timeout permits retry and disposed streams cannot accept late updates", () => {
  const h = harness();
  h.stream.sync();
  h.stream.syncFailed("sync-1");
  h.stream.sync();
  assert.deepEqual(h.requests, [0, 0]);
  h.stream.dispose();
  h.stream.receive(event(1));
  assert.equal(h.stream.cursor, 0);
});

test("typed turns preserve provenance; interruption preserves all transcript text", () => {
  let snapshot = reduceEvent(emptySnapshot(), {
    ...event(1), type: "transcript.final",
    payload: { turnId: "typed", role: "learner", source: "typed", text: "Can I get a refund?", tStart: 0, tEnd: 1 },
  });
  snapshot = reduceEvent(snapshot, event(2, "speaking"));
  snapshot = reduceEvent(snapshot, event(3, "listening"));
  assert.equal(snapshot.transcript[0]?.source, "typed");
  assert.equal(snapshot.transcript[0]?.text, "Can I get a refund?");
});

test("praise is retained, cards deduplicate by finding ID rather than quote", () => {
  const h = harness();
  const payload = { findingId: "f1", turnId: "t1", kind: "nice" as const, category: "politeness", quote: "Please", en: "Polite", zh: "Chinese explanation" };
  h.stream.receive({ ...event(1), type: "coach.card", payload });
  h.stream.receive({ ...event(2), type: "coach.card", payload: { ...payload, findingId: "f2", turnId: "t2" } });
  assert.equal(h.snapshot().cards.length, 2);
});

test("ending is terminal for the UI even if a stale state transition arrives", () => {
  let snapshot = reduceEvent(emptySnapshot(), { ...event(1), type: "session.ended", payload: { reason: "user" } });
  snapshot = reduceEvent(snapshot, event(2, "speaking"));
  assert.equal(snapshot.state, "ended");
  assert.equal(snapshot.endReason, "user");
});

test("turn presentation never claims listening for muted, typed or disconnected input", () => {
  assert.match(turnPresentation("listening", "connected", "voice", false, "Dana").label, /muted/);
  assert.match(turnPresentation("listening", "connected", "typing", false, "Dana").label, /typing/);
  assert.match(turnPresentation("listening", "disconnected", "voice", true, "Dana").label, /lost/);
  assert.equal(turnPresentation("speaking", "connected", "voice", true, "Dana").tone, "coral");
});

test("reset clears sensitive session state and room credentials", () => {
  useSessionStore.setState({ snapshot: { ...emptySnapshot(), transcript: [{ turnId: "t", role: "learner", source: "typed", text: "Private", tStart: 0, tEnd: 1 }] } });
  useSessionStore.getState().reset();
  assert.equal(useSessionStore.getState().active, null);
  assert.deepEqual(useSessionStore.getState().snapshot.transcript, []);
});
