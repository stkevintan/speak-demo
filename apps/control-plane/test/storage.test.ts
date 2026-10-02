import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCourse, type SessionRecord } from "@rehearsal/contracts";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { buildDebrief } from "../src/debrief.js";
import { attemptMetrics, fixtureConfig } from "./fixtures.js";
import { parseConfig } from "../src/config.js";

test("SQLite persists onboarding, pinned courses, one debrief and once-only category memory", async () => {
  const { config, cleanup } = await fixtureConfig();
  let storage = new SqliteStorage(config);
  try {
    const course = loadCourse(await readFile(join(config.coursesDir, "refund.yaml"), "utf8"));
    const profile = await storage.getOrCreate("dev");
    const selected = await storage.patch("dev", { level: "B2" });
    assert.equal(selected.onboarded, true);
    await storage.patch("dev", { chinese: false });
    assert.equal((await storage.getOrCreate("dev")).level, "B2");
    await storage.replaceCatalog([course]);
    await storage.create({
      id: "session", userId: "dev", roomName: "room", course, profile,
      status: "starting", startedAt: 0, cleanupNeeded: true,
    });
    await storage.setStatus("session", "closing");
    await storage.setStatus("session", "live");
    assert.equal((await storage.get("session"))?.status, "closing");
    const record: SessionRecord = {
      sessionId: "session", courseId: course.id, transcript: [], findings: [],
      signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0, endReason: "network",
    };
    const { debrief } = buildDebrief(record, course, profile, []);
    const first = await storage.complete("session", debrief, [{ category: "tense", count: 3 }], "network", attemptMetrics({ learnerTurns: 4, suggestionsOffered: 2, suggestionsAdopted: 1, nice: 1, nit: 1, durationMs: 120_000 }));
    const second = await storage.complete("session", { ...debrief, won: true }, [{ category: "tense", count: 99 }], "user", attemptMetrics({ learnerTurns: 9 }));
    assert.deepEqual(first, second);
    assert.equal((await storage.get("session"))?.endReason, "network");
    // A repeated completion is a no-op, so the metrics of the attempt that
    // actually completed stand and the later ones are discarded with it.
    const [attempt] = await storage.attempts("dev");
    assert.equal(attempt?.sessionId, "session");
    assert.equal(attempt?.courseId, course.id);
    assert.equal(attempt?.won, false);
    assert.equal(attempt?.endReason, "network");
    assert.equal(attempt?.learnerTurns, 4);
    assert.ok((attempt?.endedAt ?? 0) > 0);
    assert.deepEqual(attempt?.metrics, {
      durationMs: 120_000, suggestionsOffered: 2, suggestionsAdopted: 1, nice: 1, nit: 1,
    });
    assert.deepEqual(await storage.attempts("other"), []);
    await storage.applyPending();
    await storage.applyPending();
    assert.equal((await storage.recall("dev"))[0]?.count, 3);
    assert.equal((await storage.recall("other")).length, 0);
    await storage.replaceCatalog([{ ...course, version: course.version + 1, title: "Edited" }]);
    assert.equal((await storage.get("session"))?.course.title, course.title);
    storage.onModuleDestroy();
    storage = new SqliteStorage(config);
    assert.deepEqual(await storage.debrief("session"), first);
    assert.equal((await storage.getOrCreate("dev")).onboarded, true);
    assert.equal((await storage.recall("dev"))[0]?.count, 3);
  } finally { storage.onModuleDestroy(); await cleanup(); }
});

test("debrief verdict depends only on goal; empty and coach-free sessions are truthful", async () => {
  const { config, cleanup } = await fixtureConfig();
  const storage = new SqliteStorage(config);
  try {
    const course = loadCourse(await readFile(join(config.coursesDir, "refund.yaml"), "utf8"));
    const profile = await storage.getOrCreate("dev");
    const record: SessionRecord = {
      sessionId: "s", courseId: course.id, transcript: [], findings: [],
      signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0, endReason: "quit",
    };
    assert.equal(buildDebrief(record, course, profile, []).debrief.won, false);
    assert.equal(buildDebrief(record, course, profile, []).debrief.worked.length, 1);
    const nit = { kind: "nit" as const, category: "articles", quote: "a apple", better: "an apple", en: "Use an.", zh: "用 an。" };
    const won = buildDebrief({
      ...record, goalMet: true, findings: [nit, nit], signal: { nice: 0, total: 2 },
    }, course, profile, []);
    assert.equal(won.debrief.won, true);
    assert.equal(won.debrief.corrections.length, 2);
    assert.equal(won.deltas[0]?.count, 2);
    assert.deepEqual(won.debrief.watch, ["articles: 2 times."]);
    assert.equal(buildDebrief({
      ...record, signal: { nice: 5, total: 5 },
    }, course, profile, []).debrief.won, false);
  } finally { storage.onModuleDestroy(); await cleanup(); }
});

test("configuration rejects secrets/defaults that would silently weaken authentication", async () => {
  const { config, cleanup } = await fixtureConfig();
  try {
    const env = {
      JWT_SECRET: config.JWT_SECRET, REDIS_URL: config.REDIS_URL, LIVEKIT_URL: config.LIVEKIT_URL,
      LIVEKIT_API_KEY: config.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: config.LIVEKIT_API_SECRET,
    };
    assert.throws(() => parseConfig({ ...env, JWT_SECRET: "short" }, "/tmp"), /JWT_SECRET/);
    assert.throws(() => parseConfig({ ...env, NODE_ENV: "production", DEV_AUTH_ENABLED: "true" }, "/tmp"), /forbidden/);
    assert.throws(() => parseConfig({ ...env, WEB_ORIGIN: "http://localhost:5173/path" }, "/tmp"), /origin/);
    assert.equal(parseConfig({ ...env, DATA_DIR: "relative-data" }, "/tmp").dataDir, "/tmp/relative-data");
  } finally { await cleanup(); }
});
