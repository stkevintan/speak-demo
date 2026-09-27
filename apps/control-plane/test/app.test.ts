import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { Profile, CourseCard, Debrief, SessionStart, AUTH_COOKIE_NAME } from "@rehearsal/contracts";
import { z } from "zod";
import { AppModule, configureApp } from "../src/app.module.js";
import { LiveSessionStore, SessionRepo } from "../src/storage/ports.js";
import { RoomGateway } from "../src/livekit.js";
import { SessionService } from "../src/sessions.js";
import { FakeLiveStore, FakeRooms, fixtureConfig } from "./fixtures.js";

test("Nest routes enforce contracts, auth, ownership, onboarding and durable completion", async (t) => {
  const { config, cleanup } = await fixtureConfig();
  const live = new FakeLiveStore();
  const rooms = new FakeRooms();
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(LiveSessionStore).useValue(live)
    .overrideProvider(RoomGateway).useValue(rooms)
    .compile();
  const app = module.createNestApplication();
  configureApp(app, config);
  await app.init();
  t.after(async () => { await app.close(); await cleanup(); });
  const server = app.getHttpServer();
  const origin = config.WEB_ORIGIN;

  await request(server).get("/api/courses").expect(401);
  const bootstrap = await request(server).get("/api/me").expect(200);
  assert.equal(Profile.parse(bootstrap.body).onboarded, false);
  const [setCookie] = z.array(z.string()).parse(bootstrap.headers["set-cookie"]);
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0]!;
  assert.ok(setCookie.includes("HttpOnly"));
  await request(server).get("/api/me").set("Cookie", `${AUTH_COOKIE_NAME}=invalid`).expect(401);
  await request(server).patch("/api/me").set("Cookie", cookie).send({ level: "A2" }).expect(403);
  await request(server).patch("/api/me").set("Cookie", cookie).set("Origin", "https://evil.example")
    .send({ level: "A2" }).expect(403);
  const preference = await request(server).patch("/api/me").set("Cookie", cookie).set("Origin", origin)
    .send({ chinese: false }).expect(200);
  assert.equal(preference.body.onboarded, false);
  const selected = await request(server).patch("/api/me").set("Cookie", cookie).set("Origin", origin)
    .send({ level: "A2" }).expect(200);
  assert.equal(Profile.parse(selected.body).onboarded, true);
  assert.equal(selected.body.chinese, false);
  await request(server).patch("/api/me").set("Cookie", cookie).set("Origin", origin)
    .send({ onboarded: false }).expect(400);
  await request(server).patch("/api/me").set("Cookie", cookie).set("Origin", origin).send({}).expect(200);
  const catalog = await request(server).get("/api/courses").set("Cookie", cookie).expect(200);
  assert.equal(z.array(CourseCard).parse(catalog.body).length, 6);
  assert.equal(catalog.body[0].fit, "on_level");
  await request(server).get("/api/courses/refund").set("Cookie", cookie).expect(200);
  await request(server).get("/api/courses/missing").set("Cookie", cookie).expect(404);
  await request(server).post("/api/sessions").set("Cookie", cookie).set("Origin", origin)
    .send({ courseId: "refund", userId: "other" }).expect(400);

  const start = await request(server).post("/api/sessions").set("Cookie", cookie).set("Origin", origin)
    .send({ courseId: "refund" }).expect(201);
  const { sessionId } = SessionStart.parse(start.body);
  assert.equal(live.bootstrap.get(sessionId)?.profile.level, "A2");
  assert.equal(live.bootstrap.get(sessionId)?.learnerIdentity, `learner-${sessionId}`);
  await request(server).get(`/api/sessions/${sessionId}/debrief`).set("Cookie", cookie).expect(409);
  const foreign = await new JwtService().signAsync({ sub: "other-user" }, {
    secret: config.JWT_SECRET, algorithm: "HS256", issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE, expiresIn: 100,
  });
  const expired = await new JwtService().signAsync({ sub: "dev-user" }, {
    secret: config.JWT_SECRET, algorithm: "HS256", issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE, expiresIn: -1,
  });
  await request(server).get("/api/me").set("Cookie", `${AUTH_COOKIE_NAME}=${expired}`).expect(401);
  await request(server).get(`/api/sessions/${sessionId}/debrief`).set("Cookie", `${AUTH_COOKIE_NAME}=${foreign}`).expect(404);
  const ended = await Promise.all([1, 2].map(() => request(server).post(`/api/sessions/${sessionId}/end`)
    .set("Cookie", cookie).set("Origin", origin).expect(200)));
  assert.deepEqual(ended[0]!.body, ended[1]!.body);
  assert.ok(Debrief.parse(ended[0]!.body).worked.length);
  const history = await request(server).get(`/api/sessions/${sessionId}/debrief`).set("Cookie", cookie).expect(200);
  assert.deepEqual(history.body, ended[0]!.body);
  assert.equal(live.data.has(sessionId), false);
  assert.equal(rooms.created.size, 0);

  rooms.failCreate = true;
  await request(server).post("/api/sessions").set("Cookie", cookie).set("Origin", origin)
    .send({ courseId: "refund" }).expect(503);
  assert.equal(rooms.created.size, 0);
  assert.equal(live.data.size, 0);
  rooms.failCreate = false;
  live.unavailable = true;
  await request(server).post("/api/sessions").set("Cookie", cookie).set("Origin", origin)
    .send({ courseId: "refund" }).expect(503);
});

test("reaper respects active leases, natural end, first-wins close and missing data", async (t) => {
  const { config, cleanup } = await fixtureConfig();
  const live = new FakeLiveStore();
  const rooms = new FakeRooms();
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(LiveSessionStore).useValue(live).overrideProvider(RoomGateway).useValue(rooms).compile();
  const app = module.createNestApplication();
  await app.init();
  t.after(async () => { await app.close(); await cleanup(); });
  const service = app.get(SessionService);
  const repo = app.get(SessionRepo);
  const start = await service.start("dev-user", "refund");
  const state = live.data.get(start.sessionId)!;
  state.lease = { v: 1, sessionId: start.sessionId, workerId: "worker", epoch: 2, heartbeatAt: new Date().toISOString() };
  state.checkpoint!.workerId = "worker";
  state.checkpoint!.epoch = 2;
  await service.sweep();
  assert.equal(await repo.debrief(start.sessionId), undefined);
  await assert.rejects(service.end("dev-user", start.sessionId), (error: unknown) =>
    error instanceof Error && "getStatus" in error);
  assert.equal(state.closeRequest?.reason, "user");
  await live.requestClose({ v: 1, sessionId: start.sessionId, commandId: "natural", reason: "goal" });
  assert.equal(state.closeRequest?.reason, "user");
  delete state.lease;
  await service.sweep();
  assert.ok(await repo.debrief(start.sessionId));

  const natural = await service.start("dev-user", "refund");
  const final = live.data.get(natural.sessionId)!;
  final.checkpoint!.goalMet = true;
  final.checkpoint!.snapshot.state = "ended";
  final.checkpoint!.snapshot.endReason = "goal";
  await live.requestClose({ v: 1, sessionId: natural.sessionId, commandId: "goal", reason: "goal" });
  await live.recover(natural.sessionId, "refund");
  await service.sweep();
  assert.equal((await repo.debrief(natural.sessionId))?.won, true);

  const missing = await service.start("dev-user", "refund");
  delete live.data.get(missing.sessionId)!.checkpoint;
  await assert.rejects(service.end("dev-user", missing.sessionId));
  assert.equal(await repo.debrief(missing.sessionId), undefined);

  const mismatch = await service.start("dev-user", "refund");
  await live.requestClose({ v: 1, sessionId: mismatch.sessionId, commandId: "match", reason: "budget" });
  const badAck = await live.recover(mismatch.sessionId, "refund");
  assert.ok(badAck);
  badAck.epoch++;
  await service.sweep();
  assert.equal(await repo.debrief(mismatch.sessionId), undefined);
  badAck.epoch--;
  await service.sweep();
  assert.ok(await repo.debrief(mismatch.sessionId));
});
