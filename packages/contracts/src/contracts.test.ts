import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  ApiErrorBody, AUTH_COOKIE_NAME, ClientCommand, CloseAck, CoachSignal,
  EndReason, Profile, ProfilePatch, RealtimeEvent, SessionReplay,
  SessionSnapshot, StartSessionRequest, TranscriptEntry, WorkerBootstrap,
  WorkerCheckpoint, sessionKeys,
} from "./index.js";
import { loadCourse } from "./load.js";
import { ApiError, fetcher } from "./fetcher.js";
import {
  getMe, patchMe, startSession, endSession,
  getGetMeQueryOptions, getPatchMeMutationOptions,
} from "./generated/api.js";
import type { Debrief, SessionStart } from "./index.js";

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
  const ack = {
    v: 1, sessionId: "session-1", commandId: "close-1", workerId: "worker-1",
    epoch: 1, finalSeq: 1,
    record: {
      sessionId: "session-1", courseId: course.id, transcript: [], findings: [],
      signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0, endReason: "user",
    },
  };
  assert.equal(CloseAck.safeParse(ack).success, true);
  assert.equal(CloseAck.safeParse({ ...ack, sessionId: "other" }).success, false);
  assert.equal(sessionKeys("session-1").events, "rehearsal:{session-1}:events");
  assert.throws(() => sessionKeys("bad{id}"));
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
  for (const operation of ["GetMe", "ListCourses", "GetCourse", "GetDebrief"]) {
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
  let operations = 0;
  for (const path of Object.values(spec.paths)) {
    for (const operation of Object.values(path as Record<string, { responses: Record<string, unknown> }>)) {
      for (const status of ["401", "500", "503"]) assert.ok(operation.responses[status]);
      operations++;
    }
  }
  assert.equal(operations, 7);
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
