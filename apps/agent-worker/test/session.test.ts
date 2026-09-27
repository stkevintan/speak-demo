import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientCommand, type ServerEvent } from "@rehearsal/contracts";
import { Session, type VoicePort } from "../src/session.js";
import { Coach, type TextModel } from "../src/coach.js";
import { bootstrap, FakeClock, lease, MemoryStore, settle } from "./helpers.js";

function command(type: string, payload: unknown = {}, id = type) {
  return ClientCommand.parse({ v: 1, sessionId: bootstrap.sessionId, id, seq: 0, type, payload });
}

async function setup(model: TextModel = { complete: async () => '{"findings":[]}', close: async () => {} }) {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const sent: ServerEvent[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const voice: VoicePort = {
    interrupt: async () => { calls.push("interrupt"); },
    finish: async () => { calls.push("finish"); },
    commit: () => { calls.push("commit"); },
    replyText: () => { calls.push("reply"); },
    say: () => { calls.push("opener"); },
    reengage: () => { calls.push("reengage"); },
  };
  const session = new Session(bootstrap, lease, store, voice, new Coach(bootstrap, model),
    async (event) => { sent.push(event); }, (code) => logs.push(code), 1600, clock);
  await session.initialize();
  await session.start();
  await session.state("listening");
  return { session, store, clock, sent, calls, logs, voice };
}

test("starts immediately, checkpoints before publishing, and dedupes typed commands", async () => {
  const { session, store, calls, sent } = await setup();
  assert.equal(calls[0], "opener");
  assert.equal(session.checkpoint.snapshot.learnerTurn, null);
  const text = command("learner.text", { text: "Hello" }, "typed-1");
  await session.command(text);
  await session.command(text);
  await settle();
  assert.equal(calls.filter((call) => call === "reply").length, 1);
  assert.equal(session.checkpoint.learnerTurns, 1);
  assert.equal(session.checkpoint.snapshot.transcript.length, 1);
  assert.equal(store.history.length, session.checkpoint.seq);
  assert.deepEqual(store.history.map((event) => event.seq), store.history.map((_, index) => index + 1));
  const acks = sent.filter((event) => event.type === "command.ack" && event.payload.commandId === "typed-1");
  assert.equal(acks.length, 2);
  assert.equal(acks[0]?.id, acks[1]?.id);
  assert.equal(acks[0]?.seq, acks[1]?.seq);
});

test("barge-in cancels before any asynchronous persistence and retains spoken text once", async () => {
  const { session, calls, store, clock } = await setup();
  await session.state("speaking");
  await session.character("Hello there", "character-1", clock.now());
  const writes = store.writes;
  session.speechStart();
  assert.equal(calls.at(-1), "interrupt");
  assert.equal(store.writes, writes);
  await settle();
  await session.character("Hello there", "character-1", clock.now());
  assert.equal(session.checkpoint.snapshot.transcript.length, 1);
  assert.equal(session.checkpoint.snapshot.learnerTurn?.canCommit, true);
});

test("one committed ASR turn is counted once and manual command never generates another reply", async () => {
  const { session, calls } = await setup();
  await session.command(command("learner.commit", { turnId: "missing" }));
  session.speechStart();
  session.speechEnd();
  await settle();
  const turnId = session.detector.turn!.turnId;
  await session.command(command("learner.commit", { turnId }, "commit-1"));
  await settle();
  await session.command(command("learner.commit", { turnId }, "commit-1"));
  assert.equal(calls.filter((call) => call === "commit").length, 1);
  await session.learner("I would like a refund", "asr-item");
  await session.learner("I would like a refund", "asr-item");
  assert.equal(session.checkpoint.learnerTurns, 1);
  assert.equal(calls.filter((call) => call === "reply").length, 0);
});

test("typing cannot discard a pending voice turn", async () => {
  const { session, sent, calls } = await setup();
  session.speechStart();
  await settle();
  await session.command(command("learner.text", { text: "typed" }));
  assert.equal(calls.includes("reply"), false);
  const last = sent.at(-1);
  assert.equal(last?.type, "command.ack");
  if (last?.type === "command.ack") {
    assert.deepEqual(last.payload, { commandId: "learner.text", status: "rejected", code: "not_committable" });
  }
});

test("typed barge-in commits played character prefix before the new learner turn", async () => {
  const { session, voice, clock } = await setup();
  voice.interrupt = async () => {
    await session.character("Already spoken", "interrupted-character", clock.now());
  };
  await session.command(command("learner.text", { text: "My reply" }));
  assert.deepEqual(session.checkpoint.snapshot.transcript.map((turn) => turn.role), ["character", "learner"]);
});

test("SDK end drain can persist final played text before the frozen checkpoint", async () => {
  const { session, voice, clock, store } = await setup();
  voice.finish = async () => {
    await session.character("Final played words", "drained", clock.now());
  };
  await session.end("user", "end-with-drain");
  assert.equal(store.closed?.record.transcript[0]?.text, "Final played words");
});

test("slow or failing coach never blocks the character and raw findings outlive rail filtering", async () => {
  let resolve!: (value: string) => void;
  const model: TextModel = { complete: () => new Promise<string>((done) => { resolve = done; }), close: async () => {} };
  const { session, calls } = await setup(model);
  await session.command(command("learner.text", { text: "I go and we go" }, "t1"));
  assert.equal(calls.includes("reply"), true);
  await settle();
  resolve(JSON.stringify({ findings: [
    { kind: "nit", category: "tense", quote: "I go", better: "I went", en: "Past", zh: "Past" },
    { kind: "nit", category: "tense", quote: "we go", better: "we went", en: "Past", zh: "Past" },
    { kind: "nice", category: "joining", quote: "and", en: "Good connection", zh: "Good connection" },
  ] }));
  await settle();
  assert.equal(session.checkpoint.findings.length, 3);
  assert.equal(session.checkpoint.snapshot.cards.length, 2);
  assert.deepEqual(session.checkpoint.signal, { nice: 1, total: 3 });
  assert.equal(session.checkpoint.goalMet, false);
});

test("reconnect returns replay, or a complete replacement snapshot after trimming", async () => {
  const { session, store, sent } = await setup();
  await session.command(command("session.sync", { afterSeq: 0 }, "sync-1"));
  let last = sent.at(-1);
  assert.equal(last?.type, "session.replay");
  if (last?.type === "session.replay") {
    assert.equal(last.payload.mode, "events");
    assert.equal(last.seq, store.value?.seq);
  }
  store.history = [];
  await session.command(command("session.sync", { afterSeq: 0 }, "sync-2"));
  last = sent.at(-1);
  assert.equal(last?.type, "session.replay");
  if (last?.type === "session.replay") assert.equal(last.payload.mode, "snapshot");
  assert.ok(!store.history.some((event) => String(event.type) === "session.replay"));
});

for (const state of ["listening", "thinking", "speaking"] as const) {
  test(`end from ${state} freezes a complete idempotent record and final sequence`, async () => {
    const { session, store, sent } = await setup();
    await session.state(state);
    await session.end("user", "close-1");
    const final = session.checkpoint.seq;
    assert.equal(store.closed?.finalSeq, final);
    assert.equal(store.closed?.commandId, "close-1");
    assert.equal(store.history.at(-1)?.type, "session.ended");
    assert.equal(store.closed?.record.transcript.length, 0);
    await session.end("network", "close-2");
    await session.character("late result", "late", Date.now());
    assert.equal(session.checkpoint.seq, final);
    await session.command(command("session.sync", { afterSeq: 0 }, "ended-sync"));
    assert.equal(sent.at(-1)?.type, "session.replay");
    assert.equal(session.checkpoint.seq, final);
  });
}

test("first control-plane close request wins and stale generation cannot set won", async () => {
  const { session, store } = await setup();
  await store.requestClose({ v: 1, sessionId: bootstrap.sessionId, commandId: "cp", reason: "network" });
  session.speechStart();
  await settle();
  await session.outcome({ goalMet: true, closeScene: true }, 0);
  assert.equal(session.checkpoint.goalMet, false);
  await session.end("user", "web");
  assert.equal(store.closed?.commandId, "cp");
  assert.equal(store.closed?.record.endReason, "network");
});

test("storage failure does not publish success and causes lease heartbeat to fail", async () => {
  const { session, store, sent, logs } = await setup();
  const before = sent.length;
  store.failWrites = true;
  await assert.rejects(session.command(command("learner.text", { text: "hi" })));
  assert.equal(sent.length, before);
  assert.ok(logs.includes("session.operation_failed"));
  await assert.rejects(session.heartbeat());
});

test("missing or already-used checkpoint is not replaced with an empty session", async () => {
  for (const checkpoint of [null, { ...new MemoryStore().value!, workerId: "previous-worker" }]) {
    const store = new MemoryStore();
    store.value = checkpoint;
    const voice: VoicePort = { interrupt: async () => {}, finish: async () => {}, commit() {}, replyText() {}, say() {}, reengage() {} };
    const session = new Session(bootstrap, lease, store, voice,
      new Coach(bootstrap, { complete: async () => "", close: async () => {} }), async () => {}, () => {}, 1600);
    await assert.rejects(session.initialize());
    assert.equal(store.writes, 0);
  }
});
