import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JwtService } from "@nestjs/jwt";
import { z } from "zod";
import { CourseService } from "../src/catalog.js";
import { LiveKitGateway } from "../src/livekit.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { fixtureConfig } from "./fixtures.js";
import { MemoryService } from "../src/memory.js";

test("catalog rejects bad documents, never hides off-level scenes, and rejects duplicate IDs", async () => {
  const { config, cleanup } = await fixtureConfig();
  const db = new SqliteStorage(config);
  try {
    const directory = join(config.dataDir, "test-courses");
    await mkdir(directory);
    const text = await readFile(join(config.coursesDir, "refund.yaml"), "utf8");
    await writeFile(join(directory, "refund.yaml"), text);
    await writeFile(join(directory, "invalid.yaml"), "unexpected: true\n");
    const catalog = new CourseService(db, { ...config, coursesDir: directory });
    await catalog.onModuleInit();
    assert.equal((await catalog.list("A2")).length, 1);
    assert.equal((await catalog.list("A2"))[0]?.fit, "stretch");
    assert.equal((await catalog.list("B2"))[0]?.fit, "easy");
    await writeFile(join(directory, "duplicate.yaml"), text);
    await assert.rejects(catalog.onModuleInit(), /Duplicate course/);
    assert.equal((await db.listCourses()).length, 1);
  } finally { db.onModuleDestroy(); await cleanup(); }
});

test("LiveKit grants are short-lived and restricted to one learner room", async () => {
  const { config, cleanup } = await fixtureConfig();
  try {
    const token = await new LiveKitGateway(config).token("room-one", "learner-one");
    const decoded: unknown = await new JwtService().verifyAsync(token, {
      secret: config.LIVEKIT_API_SECRET, algorithms: ["HS256"], issuer: config.LIVEKIT_API_KEY,
    });
    const claims = z.object({
      sub: z.string(), exp: z.number(), nbf: z.number(),
      video: z.object({
        room: z.string(), roomJoin: z.boolean(), canPublish: z.boolean(),
        canSubscribe: z.boolean(), canPublishData: z.boolean(), roomAdmin: z.boolean().optional(),
      }),
    }).parse(decoded);
    assert.equal(claims.sub, "learner-one");
    assert.equal(claims.video.room, "room-one");
    assert.equal(claims.video.roomJoin, true);
    assert.notEqual(claims.video.roomAdmin, true);
    assert.equal(claims.exp - claims.nbf, config.LIVEKIT_TOKEN_TTL_SECONDS);
  } finally { await cleanup(); }
});

test("memory failures are isolated and retried rather than blocking debriefs", async () => {
  let attempts = 0;
  const memory = new MemoryService({
    async recall() { throw new Error("database temporarily unavailable"); },
    async applyPending() { if (++attempts === 1) throw new Error("temporary failure"); },
  });
  assert.deepEqual(await memory.recall("dev"), []);
  await memory.recordPending();
  await memory.recordPending();
  assert.equal(attempts, 2);
});
