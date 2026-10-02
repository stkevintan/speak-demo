import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  ApiErrorBody, AUTH_COOKIE_NAME, attemptMark, attemptPoints, ClientCommand, CloseAck, CoachSignal,
  EndReason, GoalProgress, Profile, ProfilePatch, Progress, ProgressAttempt, RealtimeEvent,
  SCORE_POINTS, SCORE_TARGETS, SessionMetrics, SessionReplay, SessionSnapshot, StartSessionRequest,
  TranscriptEntry, WorkerBootstrap, WorkerCheckpoint, overallPoints, progressView, sessionKeys,
} from "./index.js";
import { loadCourse } from "./load.js";
import { ApiError, fetcher } from "./fetcher.js";
import {
  getMe, patchMe, startSession, endSession,
  getGetMeQueryOptions, getPatchMeMutationOptions,
} from "./generated/api.js";
import type { AttemptRow, Debrief, SessionStart } from "./index.js";

const course = loadCourse(readFileSync(new URL("./fixtures/valid/refund.yaml", import.meta.url), "utf8"));
const profile: Profile = {
  userId: "dev", level: "B1", onboarded: false,
  chinese: true, suggestions: true, patterns: [],
};
const envelope = { v: 1, sessionId: "session-1", id: "message-1", seq: 0 };
const event = {
  ...envelope, seq: 1, type: "agent.state", payload: { state: "listening" },
};
const snapshot = {
  state: "listening", learnerTurn: null, transcript: [], cards: [],
  suggestions: null, preferences: { suggestions: true }, endReason: null,
};

test("profile onboarding and HTTP request/error shapes are strict", () => {
  assert.deepEqual(Profile.parse(profile), profile);
  const { onboarded: _, ...oldProfile } = profile;
  assert.equal(Profile.safeParse(oldProfile).success, false);
  assert.deepEqual(ProfilePatch.parse({}), {});
  assert.deepEqual(ProfilePatch.parse({ level: "A2" }), { level: "A2" });
  for (const patch of [{ onboarded: true }, { userId: "other" }, { level: "C1" }]) {
    assert.equal(ProfilePatch.safeParse(patch).success, false);
  }
  assert.deepEqual(StartSessionRequest.parse({ courseId: "refund" }), { courseId: "refund" });
  assert.equal(StartSessionRequest.safeParse({ courseId: "refund", userId: "other" }).success, false);
  assert.equal(ApiErrorBody.safeParse({ code: "", message: "bad" }).success, false);
  assert.equal(ApiErrorBody.safeParse({ code: "bad", message: "bad", secret: "no" }).success, false);
  for (const reason of ["user", "quit", "network", "goal", "budget"]) {
    assert.equal(EndReason.parse(reason), reason);
  }
  assert.equal(CoachSignal.safeParse({ nice: 2, total: 1 }).success, false);
});

test("all learner commands require v1, stable IDs, seq zero and exact payloads", () => {
  const commands = [
    { type: "learner.commit", payload: { turnId: "turn-1" } },
    { type: "learner.text", payload: { text: "Hello" } },
    { type: "learner.interrupt", payload: {} },
    { type: "suggestions.adopted", payload: { optionIndex: 1 } },
    { type: "preferences.update", payload: { suggestions: false } },
    { type: "session.sync", payload: { afterSeq: 0 } },
    { type: "session.end", payload: { reason: "user" } },
  ];
  for (const command of commands) {
    const valid = { ...envelope, ...command };
    assert.equal(ClientCommand.safeParse(valid).success, true, command.type);
    assert.equal(ClientCommand.safeParse({ ...valid, seq: 1 }).success, false);
    assert.equal(ClientCommand.safeParse({ ...valid, v: 2 }).success, false);
    assert.equal(ClientCommand.safeParse({ ...valid, id: "" }).success, false);
    assert.equal(ClientCommand.safeParse({ ...valid, extra: true }).success, false);
  }
  assert.equal(ClientCommand.safeParse(event).success, false);
  assert.equal(RealtimeEvent.safeParse(event).success, true);
  for (const text of ["   ", "a".repeat(4001)]) {
    assert.equal(ClientCommand.safeParse({ ...envelope, type: "learner.text", payload: { text } }).success, false);
  }
  assert.equal(ClientCommand.safeParse({
    ...envelope, type: "session.end", payload: { reason: "goal" },
  }).success, false);
  for (const payload of [
    {}, { optionIndex: -1 }, { optionIndex: 1.5 },
    { optionIndex: 0, suggestionId: "suggestion-1" },
    { optionIndex: 0, text: "extra" },
  ]) {
    assert.equal(ClientCommand.safeParse({
      ...envelope, type: "suggestions.adopted", payload,
    }).success, false);
  }
});

test("transcript provenance and snapshot terminal state agree", () => {
  const turn = { turnId: "t1", role: "learner", source: "typed", text: "Hi", tStart: 0, tEnd: 1 };
  assert.equal(TranscriptEntry.safeParse(turn).success, true);
  assert.equal(TranscriptEntry.safeParse({ ...turn, source: "character" }).success, false);
  assert.equal(TranscriptEntry.safeParse({ ...turn, tEnd: -1 }).success, false);
  assert.equal(TranscriptEntry.safeParse({ ...turn, tStart: 2 }).success, false);
  assert.equal(SessionSnapshot.safeParse(snapshot).success, true);
  assert.equal(SessionSnapshot.safeParse({ ...snapshot, state: "ended" }).success, false);
  assert.equal(SessionSnapshot.safeParse({ ...snapshot, state: "ended", endReason: "goal" }).success, true);
});

test("replay requires contiguous same-session events through a bounded high-watermark", () => {
  const replay = {
    ...envelope, seq: 1, type: "session.replay",
    payload: { mode: "events", commandId: "sync-1", afterSeq: 0, events: [event] },
  };
  assert.equal(SessionReplay.safeParse(replay).success, true);
  assert.equal(SessionReplay.safeParse({ ...replay, seq: 2 }).success, false);
  assert.equal(SessionReplay.safeParse({
    ...replay, payload: { ...replay.payload, events: [{ ...event, sessionId: "other" }] },
  }).success, false);
  assert.equal(SessionReplay.safeParse({
    ...replay, seq: 2, payload: { ...replay.payload, events: [event, { ...event, seq: 2 }] },
  }).success, false);
  const events = Array.from({ length: 256 }, (_, i) => ({ ...event, id: `e${i}`, seq: i + 1 }));
  assert.equal(SessionReplay.safeParse({
    ...replay, seq: 256, payload: { ...replay.payload, events },
  }).success, true);
  assert.equal(SessionReplay.safeParse({
    ...replay, seq: 257, payload: {
      ...replay.payload, events: [...events, { ...event, id: "e256", seq: 257 }],
    },
  }).success, false);
  assert.equal(SessionReplay.safeParse({
    ...replay, seq: 0, payload: { mode: "snapshot", commandId: "sync-1", snapshot },
  }).success, true);
});

test("worker bootstrap, checkpoints, close acknowledgements and Redis keys validate", () => {
  assert.equal(WorkerBootstrap.safeParse({
    v: 1, sessionId: "session-1", userId: "dev", roomName: "room-1",
    learnerIdentity: "learner-1", course,
    profile: { level: "B1", chinese: true, suggestions: true }, recalled: [],
  }).success, true);
  assert.equal(WorkerCheckpoint.safeParse({
    v: 1, sessionId: "session-1", workerId: "worker-1", epoch: 1, seq: 0,
    snapshot, findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0,
  }).success, true);
  const metrics = {
    durationMs: 90_000, suggestionsOffered: 3, suggestionsAdopted: 1, nice: 2, nit: 1,
  };
  assert.equal(WorkerCheckpoint.safeParse({
    v: 1, sessionId: "session-1", workerId: "worker-1", epoch: 1, seq: 0,
    snapshot, findings: [], signal: { nice: 2, total: 3 }, goalMet: true, learnerTurns: 6, metrics,
  }).success, true);
  // Metrics are optional for a checkpoint recovered from before the field
  // existed, but a contradictory pair is never valid.
  assert.equal(SessionMetrics.safeParse(metrics).success, true);
  assert.equal(SessionMetrics.safeParse({ ...metrics, suggestionsAdopted: 4 }).success, false);
  const ack = {
    v: 1, sessionId: "session-1", commandId: "close-1", workerId: "worker-1",
    epoch: 1, finalSeq: 1,
    record: {
      sessionId: "session-1", courseId: course.id, transcript: [], findings: [],
      signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0, endReason: "user",
      metrics,
    },
  };
  assert.equal(CloseAck.safeParse(ack).success, true);
  assert.equal(CloseAck.safeParse({ ...ack, sessionId: "other" }).success, false);
  assert.equal(sessionKeys("session-1").events, "rehearsal:{session-1}:events");
  assert.throws(() => sessionKeys("bad{id}"));
});

test("an attempt's score is 0-100 and a win always outranks a miss", () => {
  const idle = { won: false, durationMs: 0, suggestionsAdopted: 0, nice: 0, nit: 0 };
  assert.equal(attemptPoints(idle), 0);
  assert.equal(attemptPoints({
    won: true, durationMs: SCORE_TARGETS.durationMs,
    suggestionsAdopted: SCORE_TARGETS.suggestionsAdopted, nice: SCORE_TARGETS.cards, nit: 0,
  }), 100);

  // Every component stops paying at its target, so a marathon cannot buy a 100.
  assert.equal(attemptPoints({
    won: true, durationMs: 45 * 60_000, suggestionsAdopted: 40, nice: 40, nit: 40,
  }), 100);

  // The invariant the whole feature rests on. An even split would let a long,
  // talkative failure outrank a short success, and a number that disagrees with
  // the badge beside it is worse than no number (`PRODUCT.md`, "Never demoralising").
  const bestMiss = attemptPoints({ ...idle, durationMs: 60 * 60_000, suggestionsAdopted: 40, nice: 40, nit: 40 });
  const worstWin = attemptPoints({ ...idle, won: true });
  assert.equal(bestMiss, SCORE_POINTS.time + SCORE_POINTS.suggestions + SCORE_POINTS.cards);
  assert.equal(worstWin, SCORE_POINTS.goal);
  assert.ok(worstWin > bestMiss);

  // Monotonic and symmetric: more of any one thing never lowers the score, and
  // nice and nit are the same currency.
  assert.ok(attemptPoints({ ...idle, durationMs: SCORE_TARGETS.durationMs }) > attemptPoints({ ...idle, durationMs: SCORE_TARGETS.durationMs / 2 }));
  assert.equal(attemptPoints({ ...idle, nice: SCORE_TARGETS.cards }), attemptPoints({ ...idle, nit: SCORE_TARGETS.cards }));

  for (const points of [bestMiss, worstWin]) {
    assert.ok(points >= 0 && points <= 100);
  }
});

test("progress view derives marks, states and ordering from attempts", () => {
  const text = readFileSync(new URL("./fixtures/valid/refund.yaml", import.meta.url), "utf8");
  const rename = (id: string) => loadCourse(text.replace(/^id: refund$/mu, `id: ${id}`));
  const later = rename("refund-2");
  const unfinished = rename("refund-3");
  const fresh = rename("refund-4");
  const row = (courseId: string, sessionId: string, over: Partial<AttemptRow> = {}): AttemptRow => ({
    courseId, sessionId, startedAt: 0, endedAt: 1, won: false, endReason: "user",
    learnerTurns: 0, metrics: null, ...over,
  });
  const counted = {
    durationMs: 90_000, suggestionsOffered: 3, suggestionsAdopted: 1, nice: 2, nit: 1,
  };
  const view = progressView([course, later, unfinished, fresh], [
    row(course.id, "a1", { startedAt: 100, endedAt: 200, endReason: "budget", learnerTurns: 5, metrics: counted }),
    row(course.id, "a2", { startedAt: 300, endedAt: 400, won: true, endReason: "goal", learnerTurns: 6, metrics: counted }),
    row(course.id, "a3", { startedAt: 450, endedAt: 500, learnerTurns: 4, metrics: counted }),
    row(later.id, "b1", { startedAt: 900, endedAt: 1_000, won: true, endReason: "goal", metrics: counted }),
    // Abandoned before `end()`, so it reported no metrics at all.
    row(unfinished.id, "c1", { startedAt: 500, endedAt: 600, learnerTurns: 2 }),
  ]);

  // The derivation is checked against its own contract, so an ordering or a
  // score that disagrees with §5.8 fails here rather than on the screen.
  assert.deepEqual(Progress.parse(view), view);
  assert.deepEqual(
    view.goals.map((goal) => goal.courseId),
    [unfinished.id, fresh.id, later.id, course.id],
  );
  assert.deepEqual(view.totals, { met: 2, unfinished: 1, notStarted: 1 });

  const met = view.goals[3] as GoalProgress;
  assert.equal(met.state, "met");
  assert.equal(met.attempts, 3);
  assert.deepEqual(met.history.map((entry) => entry.mark), ["missed", "met", "ended_early"]);
  // A worse attempt after the win neither demotes the goal nor moves the score.
  assert.equal(met.wonOnAttempt, 2);
  assert.equal(met.score?.sessionId, "a2");
  // The scene's score is the scored attempt's, not the best or the latest.
  assert.equal(met.points, met.score?.points);
  assert.equal(met.history[1]?.points, met.points);
  // The goal (55), plus a quarter of the time (3.75), a third of the suggestions
  // (5) and half the cards (7.5): 71.25 rounded. Pins the wiring, not the formula.
  assert.equal(met.history[1]?.points, 71);
  // The miss that preceded the win scores under the win, as the badge implies.
  assert.ok((met.history[0]?.points ?? 0) < (met.history[1]?.points ?? 0));
  // The worker-reported span wins over the wall clock, which includes reconnect gaps.
  assert.equal(met.history[2]?.durationMs, counted.durationMs);

  const abandoned = view.goals[0] as GoalProgress;
  const onlyAttempt = abandoned.history[0] as ProgressAttempt;
  assert.equal(abandoned.state, "unfinished");
  assert.equal(abandoned.wonOnAttempt, null);
  assert.equal(abandoned.score?.sessionId, "c1");
  assert.equal(abandoned.points, onlyAttempt.points);
  // Wall-clock fallback, not a zero duration the screen would print as "0s".
  assert.equal(onlyAttempt.durationMs, 100);
  assert.equal(onlyAttempt.mark, "ended_early");
  assert.equal(onlyAttempt.suggestionsOffered, 0);
  assert.equal(onlyAttempt.nice, 0);
  assert.equal(onlyAttempt.points, 0);

  assert.deepEqual(view.goals[1], {
    courseId: fresh.id, title: fresh.title, goal: fresh.goal,
    state: "not_started", attempts: 0, wonOnAttempt: null, score: null, points: 0, history: [],
  });

  // The recap bar's number averages the scenes actually tried: the untouched
  // scene is excluded, not counted as a zero that would drag the learner down.
  assert.equal(overallPoints(view.goals), Math.round((met.points + (view.goals[2]?.points ?? 0) + 0) / 3));
  assert.equal(overallPoints([view.goals[1] as GoalProgress]), null);
  assert.equal(overallPoints([]), null);

  assert.equal(attemptMark(true, "budget"), "met");
  assert.equal(attemptMark(false, "budget"), "missed");
  for (const reason of ["user", "quit", "network"] as const) {
    assert.equal(attemptMark(false, reason), "ended_early");
  }

  // A body that drifts from the rule is rejected, not rendered.
  assert.equal(Progress.safeParse({ ...view, totals: { ...view.totals, met: 1 } }).success, false);
  assert.equal(Progress.safeParse({
    ...view, goals: [view.goals[0], view.goals[1], view.goals[3], view.goals[2]],
  }).success, false);
  assert.equal(Progress.safeParse({
    ...view, goals: [view.goals[1], view.goals[0], view.goals[2], view.goals[3]],
  }).success, false);
  assert.equal(Progress.safeParse({ ...view, goals: [view.goals[0], view.goals[0]] }).success, false);
  assert.equal(GoalProgress.safeParse({ ...met, score: met.history[2] }).success, false);
  assert.equal(GoalProgress.safeParse({ ...met, points: met.history[2]?.points }).success, false);
  assert.equal(GoalProgress.safeParse({ ...met, points: 101 }).success, false);
  assert.equal(GoalProgress.safeParse({ ...met, wonOnAttempt: null }).success, false);
  assert.equal(GoalProgress.safeParse({ ...met, state: "unfinished" }).success, false);
  assert.equal(GoalProgress.safeParse({
    ...met, history: [met.history[1], met.history[0], met.history[2]],
  }).success, false);
  assert.equal(ProgressAttempt.safeParse({ ...onlyAttempt, won: true }).success, false);
  assert.equal(ProgressAttempt.safeParse({ ...onlyAttempt, attempt: 0 }).success, false);
  assert.equal(ProgressAttempt.safeParse({ ...onlyAttempt, points: -1 }).success, false);
  assert.equal(ProgressAttempt.safeParse({ ...onlyAttempt, points: 101 }).success, false);
});

test("generated functions return raw success types and correct operation hooks", () => {
  const read: () => Promise<Profile> = getMe;
  const patch: (body: ProfilePatch) => Promise<Profile> = patchMe;
  const start: (body: { courseId: string }) => Promise<SessionStart> = startSession;
  const end: (id: string) => Promise<Debrief> = endSession;
  assert.equal(read, getMe);
  assert.equal(patch, patchMe);
  assert.equal(start, startSession);
  assert.equal(end, endSession);
  assert.ok(getGetMeQueryOptions().queryFn);
  assert.ok(getPatchMeMutationOptions().mutationFn);
  const generated = readFileSync(new URL("./generated/api.ts", import.meta.url), "utf8");
  for (const operation of ["GetMe", "ListCourses", "GetCourse", "GetDebrief", "GetProgress"]) {
    assert.ok(generated.includes(`get${operation}QueryOptions`));
    assert.ok(!generated.includes(`get${operation}MutationOptions`));
  }
  for (const operation of ["PatchMe", "StartSession", "EndSession"]) {
    assert.ok(generated.includes(`get${operation}MutationOptions`));
    assert.ok(!generated.includes(`get${operation}QueryOptions`));
  }
  assert.ok(generated.includes("ErrorType<"));
  assert.ok(!generated.includes("ResponseSuccess"));
});

test("OpenAPI documents cookie bootstrap and all operation errors", () => {
  const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
  assert.equal(spec.info.version, "0.2.0");
  assert.equal(spec.components.securitySchemes.SessionCookie.name, AUTH_COOKIE_NAME);
  assert.deepEqual(spec.paths["/api/me"].get.security, [{ SessionCookie: [] }, {}]);
  assert.equal(spec.paths["/api/progress"].get.operationId, "getProgress");
  assert.equal(
    spec.paths["/api/progress"].get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/Progress",
  );
  let operations = 0;
  for (const path of Object.values(spec.paths)) {
    for (const operation of Object.values(path as Record<string, { responses: Record<string, unknown> }>)) {
      for (const status of ["401", "500", "503"]) assert.ok(operation.responses[status]);
      operations++;
    }
  }
  assert.equal(operations, 9);
});

test("fetcher sends cookies/Headers and returns unwrapped JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(init.credentials, "include");
    assert.equal(new Headers(init.headers).get("x-test"), "yes");
    return Response.json(profile);
  });
  assert.deepEqual(await fetcher<Profile>("/api/me", {
    headers: new Headers({ "x-test": "yes" }),
  }), profile);
});

test("fetcher throws typed errors, including invalid server error bodies", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "not_found", message: "No session." }, { status: 404 }));
  await assert.rejects(fetcher("/api/me"), (error: unknown) =>
    error instanceof ApiError && error.status === 404 && error.code === "not_found");
  mock.mock.mockImplementation(async () => Response.json({ unexpected: true }, { status: 500 }));
  await assert.rejects(fetcher("/api/me"), { code: "invalid_error_response", status: 500 });
  mock.mock.mockImplementation(async () => new Response("<html>error</html>", { status: 502 }));
  await assert.rejects(fetcher("/api/me"), { code: "invalid_error_response", status: 502 });
});
