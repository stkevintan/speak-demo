import assert from "node:assert/strict";
import { test } from "node:test";
import { Coach } from "../src/coach.js";
import { characterInstructions, convergence } from "../src/character.js";
import { TurnDetector } from "../src/turn-detector.js";
import { loadConfig, ROOT_ENV } from "../src/config.js";
import { bootstrap, FakeClock } from "./helpers.js";

for (const threshold of [1200, 1600, 2000]) {
  test(`learner pause floor ${threshold}ms and speech-resumption reset`, () => {
    const clock = new FakeClock();
    let commits = 0;
    const detector = new TurnDetector(threshold, clock, () => "turn", () => commits++);
    assert.equal(detector.turn, null);
    assert.equal(detector.commit("turn"), "stale_turn");
    detector.speechStart();
    detector.speechEnd();
    clock.advance(500);
    assert.equal(commits, 0);
    detector.speechStart();
    detector.speechEnd();
    clock.advance(threshold - 1);
    assert.equal(commits, 0);
    clock.advance(1);
    assert.equal(commits, 1);
    clock.advance(threshold * 2);
    assert.equal(commits, 1);
  });
}

test("manual commitment bypasses pause and rejects duplicates/stale turns", () => {
  const clock = new FakeClock();
  let commits = 0;
  const detector = new TurnDetector(2000, clock, () => "turn", () => commits++);
  detector.speechStart();
  assert.equal(detector.turn?.canCommit, true);
  detector.speechEnd();
  assert.equal(detector.commit("wrong"), "stale_turn");
  assert.equal(detector.commit("turn"), "accepted");
  assert.equal(commits, 1);
  assert.equal(detector.turn?.canCommit, false);
  assert.equal(detector.commit("turn"), "not_committable");
  clock.advance(3000);
  assert.equal(commits, 1);
  detector.complete();
  assert.equal(detector.turn, null);
});

test("new speech during commitment remains a pending learner turn", () => {
  const clock = new FakeClock();
  let sequence = 0;
  const detector = new TurnDetector(1200, clock, () => `t${++sequence}`, () => {});
  detector.speechStart();
  detector.speechEnd();
  detector.commit("t1");
  detector.speechStart();
  assert.equal(detector.complete().turnId, "t1");
  assert.equal(detector.turn?.turnId, "t2");
  assert.equal(detector.turn?.canCommit, true);
});

test("coach positives always pass; nits are deduplicated and spaced by learner turns", () => {
  const coach = new Coach(bootstrap, { complete: async () => "", close: async () => {} });
  const card = { kind: "nit" as const, category: "tense", quote: "I go", better: "I went",
    en: "Past tense", zh: "Use past tense", findingId: "f", turnId: "t" };
  assert.equal(coach.admit(card, 1), true);
  assert.equal(coach.admit({ ...card, quote: "We go" }, 2), false);
  assert.equal(coach.admit({ ...card, kind: "nice" }, 2), true);
  assert.equal(coach.admit(card, 3), false);
  assert.equal(coach.admit({ ...card, quote: "We go" }, 3), true);
});

test("coach rejects non-bilingual output, missing fixes and invented quotes", async () => {
  const turn = { role: "learner" as const, source: "typed" as const, text: "I go yesterday",
    turnId: "t", tStart: 0, tEnd: 1 };
  for (const finding of [
    { kind: "nice", category: "effort", quote: "I go", en: "Good" },
    { kind: "nit", category: "tense", quote: "I go", en: "Past", zh: "Past" },
    { kind: "nice", category: "effort", quote: "invented", en: "Good", zh: "Good" },
  ]) {
    const coach = new Coach(bootstrap, { complete: async () => JSON.stringify({ findings: [finding] }), close: async () => {} });
    await assert.rejects(coach.observe([turn], turn, new AbortController().signal));
  }
});

test("character input is isolated from coach data and goal alone controls convergence", () => {
  const context = structuredClone(bootstrap);
  context.course.prompts.coach = "PRIVATE_COACH";
  context.recalled = [{ category: "PRIVATE_PATTERN", count: 3, lastSeen: "today" }];
  const prompt = characterInstructions(context);
  assert.ok(!prompt.includes("PRIVATE_COACH"));
  assert.ok(!prompt.includes("PRIVATE_PATTERN"));
  assert.equal(convergence(false, 3, 12), undefined);
  assert.ok(convergence(true, 3, 12));
  assert.ok(convergence(false, 12, 12));
});

test("configuration errors report names, not secrets; env path is module-relative", () => {
  assert.throws(() => loadConfig({ LIVEKIT_URL: "SECRET_NOT_A_URL" }), (error: Error) => {
    assert.ok(error.message.includes("LIVEKIT_URL"));
    assert.ok(!error.message.includes("SECRET_NOT_A_URL"));
    return true;
  });
  assert.ok(ROOT_ENV.endsWith("/.env"));
  assert.ok(!ROOT_ENV.includes("/apps/agent-worker/.env"));
});
