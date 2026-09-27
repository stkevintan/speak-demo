import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createClient } from "redis";
import { loadCourse, sessionKeys, WorkerCheckpoint } from "@rehearsal/contracts";
import { RedisLiveSessionStore, RECOVER } from "../src/storage/redis.js";
import { FakeRooms, fixtureConfig } from "./fixtures.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { SessionService } from "../src/sessions.js";
import { CourseService } from "../src/catalog.js";
import { MemoryService, ProfileService } from "../src/memory.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("real Redis adapter: initialization, first-wins close, expiry fencing, ack CAS and retention", async (t) => {
  const { config, cleanup } = await fixtureConfig();
  const port = await freePort();
  const child = spawn(process.env.REDIS_SERVER_BIN ?? "redis-server", [
    "--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no",
    "--dir", config.dataDir,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let spawnError: Error | undefined;
  let closeClients = async () => {};
  child.on("error", (error) => { spawnError = error; });
  t.after(async () => {
    await closeClients();
    if (child.exitCode === null && !spawnError) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await stopped;
    }
    await cleanup();
  });
  for (let i = 0; i < 100 && !output.includes("Ready to accept connections"); i++) {
    if (spawnError) throw new Error("Install redis-server or set REDIS_SERVER_BIN for adapter tests", { cause: spawnError });
    if (child.exitCode !== null) throw new Error(`Test Redis exited: ${output}`);
    await sleep(20);
  }
  assert.ok(output.includes("Ready to accept connections"), "isolated Redis must become ready");
  const url = `redis://127.0.0.1:${port}`;
  const client = createClient({ url, socket: { reconnectStrategy: false } });
  client.on("error", () => {});
  await client.connect();
  const store = new RedisLiveSessionStore({ ...config, REDIS_URL: url });
  await store.onModuleInit();
  closeClients = async () => { await store.onModuleDestroy(); await client.quit(); };

  const course = loadCourse(await readFile(join(config.coursesDir, "refund.yaml"), "utf8"));
  const id = "redis-test-session";
  const keys = sessionKeys(id);
  await store.initialize({
    v: 1, sessionId: id, userId: "dev", roomName: "room", learnerIdentity: "learner",
    course, profile: { level: "B1", chinese: true, suggestions: true }, recalled: [],
  });
  const initialized = await store.read(id);
  assert.equal(initialized.checkpoint?.snapshot.state, "idle");
  assert.ok(await client.ttl(keys.checkpoint) >= 120);
  const winner = await store.requestClose({ v: 1, sessionId: id, commandId: "first", reason: "user" });
  const loser = await store.requestClose({ v: 1, sessionId: id, commandId: "second", reason: "network" });
  assert.deepEqual(winner, loser);
  const checkpoint = WorkerCheckpoint.parse({
    ...initialized.checkpoint, workerId: "worker", epoch: 2,
  });
  await client.set(keys.checkpoint, JSON.stringify(checkpoint));
  const lease = JSON.stringify({
    v: 1, sessionId: id, workerId: "worker", epoch: 2, heartbeatAt: new Date().toISOString(),
  });
  await client.set(keys.lease, lease, { PX: 15000 });
  assert.ok(await client.pTTL(keys.lease) > 14000);
  assert.equal(await store.recover(id, course.id), undefined);
  assert.equal(await client.exists(keys.closeAck), 0);

  await client.pExpire(keys.lease, 1);
  await sleep(5);
  // A stale recovery cannot freeze after another checkpoint write.
  assert.equal(await client.eval(RECOVER, {
    keys: [keys.closeAck, keys.lease, keys.checkpoint, keys.closeRequest],
    arguments: ["stale-checkpoint", JSON.stringify(winner), "invalid-ack", "100"],
  }), null);
  const ack = await store.recover(id, course.id);
  assert.equal(ack?.commandId, "first");
  assert.equal(ack?.epoch, 2);
  assert.equal(ack?.record.endReason, "user");
  assert.ok(await client.exists(keys.checkpoint));
  assert.deepEqual(await store.recover(id, course.id), ack);

  await store.cleanup(id);
  for (const key of Object.values(keys)) assert.equal(await client.exists(key), 0);
  await assert.rejects(store.recover(id, course.id), /missing/);

  let sqlite = new SqliteStorage(config);
  const closeRedisClients = closeClients;
  closeClients = async () => { sqlite.onModuleDestroy(); await closeRedisClients(); };
  await sqlite.replaceCatalog([course]);
  const rooms = new FakeRooms();
  const service = () => {
    const memory = new MemoryService(sqlite);
    return new SessionService(
      sqlite, store, rooms, new ProfileService(sqlite, memory), new CourseService(sqlite, config),
      sqlite, memory, { ...config, SESSION_START_GRACE_MS: 1 },
    );
  };
  const started = await service().start("dev-user", course.id);
  const liveKeys = sessionKeys(started.sessionId);
  const startedState = await store.read(started.sessionId);
  await client.set(liveKeys.checkpoint, JSON.stringify({
    ...startedState.checkpoint, workerId: "worker-2", epoch: 2,
    goalMet: true,
    findings: [{
      findingId: "f1", turnId: "t1", kind: "nit", category: "articles",
      quote: "a apple", better: "an apple", en: "Use an.", zh: "Use an.",
    }],
    signal: { nice: 0, total: 1 },
  }));
  await client.set(liveKeys.lease, JSON.stringify({
    v: 1, sessionId: started.sessionId, workerId: "worker-2", epoch: 2, heartbeatAt: new Date().toISOString(),
  }), { PX: 15000 });
  await sleep(5);
  await service().sweep();
  assert.equal(await sqlite.debrief(started.sessionId), undefined);
  sqlite.onModuleDestroy();
  sqlite = new SqliteStorage(config);
  await client.pExpire(liveKeys.lease, 1);
  await sleep(5);
  await service().sweep();
  assert.equal((await sqlite.debrief(started.sessionId))?.won, true);
  assert.equal((await sqlite.recall("dev-user"))[0]?.count, 1);
  assert.equal(await client.exists(liveKeys.checkpoint), 0);
  await service().sweep();
  assert.equal((await sqlite.recall("dev-user"))[0]?.count, 1);
});
