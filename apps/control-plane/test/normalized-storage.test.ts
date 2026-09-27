import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { loadCourse, type Course, type Debrief, type Profile } from "@rehearsal/contracts";
import { DATABASE_FILENAME, SCHEMA_VERSION } from "../src/storage/initialize.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import type { StoredSession } from "../src/storage/ports.js";
import * as schema from "../src/storage/schema.js";
import { fixtureConfig } from "./fixtures.js";

const debrief: Debrief = {
  won: true, headline: "Goal reached", worked: ["Second", "First", "Second"], watch: ["B", "A", "B"],
  corrections: [
    { category: "tense", quote: "I go", better: "I went", en: "Past tense", zh: "Past tense" },
    { category: "article", quote: "a apple", better: "an apple", en: "Use an", zh: "Use an" },
  ],
  next: { id: "no-longer-in-catalog", title: "Historical recommendation" },
};
function session(id: string, course: Course, profile: Profile): StoredSession {
  return {
    id, userId: profile.userId, roomName: `room-${id}`, course, profile,
    status: "live", startedAt: 42, cleanupNeeded: true,
  };
}
function count(client: Database.Database, table: keyof typeof schema): number {
  return tableCount(client, schema[table]);
}
function tableCount(client: Database.Database, table: Parameters<typeof getTableConfig>[0]): number {
  const name = getTableConfig(table).name;
  return z.object({ count: z.number() }).parse(client.prepare(`SELECT count(*) AS count FROM "${name}"`).get()).count;
}

test("normalized records round-trip nested data, order and duplicates across edits and restarts", async () => {
  const fixture = await fixtureConfig();
  let storage = new SqliteStorage(fixture.config);
  try {
    const original = loadCourse(await readFile(join(fixture.config.coursesDir, "refund.yaml"), "utf8"));
    const course: Course = { ...original, levels: ["B2", "A2", "B2"], coachHints: ["tense", "articles", "tense"] };
    delete course.budget;
    await storage.replaceCatalog([course]);
    assert.deepEqual(await storage.course(course.id), course);
    const profile: Profile = {
      ...await storage.getOrCreate("learner"),
      patterns: [
        { category: "B", count: 2, lastSeen: "2026-09-01" },
        { category: "A", count: 3, lastSeen: "2026-09-02" },
        { category: "B", count: 4, lastSeen: "2026-09-03" },
      ],
    };
    const value = session("one", course, profile);
    await storage.create(value);
    assert.deepEqual(await storage.get("one"), value);
    await storage.complete("one", debrief, [
      { category: "tense", count: 2 }, { category: "tense", count: 3 },
    ], "goal");
    await storage.replaceCatalog([{ ...course, title: "New catalog", coachHints: [], budget: { learnerTurns: 3 } }]);
    await storage.patch("learner", { level: "A2", chinese: false });
    assert.deepEqual((await storage.get("one"))?.course, course);
    assert.deepEqual((await storage.get("one"))?.profile, profile);
    assert.deepEqual(await storage.debrief("one"), debrief);
    storage.onModuleDestroy();
    storage = new SqliteStorage(fixture.config);
    assert.deepEqual(await storage.debrief("one"), debrief);
    assert.deepEqual((await storage.get("one"))?.profile, profile);
    await storage.applyPending();
    await storage.applyPending();
    assert.equal((await storage.recall("learner"))[0]?.count, 5);
    assert.deepEqual((await storage.course(course.id))?.coachHints, []);
    await storage.replaceCatalog([]);
    assert.deepEqual(await storage.listCourses(), []);
    assert.deepEqual((await storage.get("one"))?.course, course);
  } finally { storage.onModuleDestroy(); await fixture.cleanup(); }
});

test("catalog replacement cascades unused definitions and failures leave no orphan children", async () => {
  const fixture = await fixtureConfig();
  const storage = new SqliteStorage(fixture.config);
  const client = new Database(join(fixture.config.dataDir, DATABASE_FILENAME));
  try {
    const course = loadCourse(await readFile(join(fixture.config.coursesDir, "refund.yaml"), "utf8"));
    await storage.replaceCatalog([course]);
    const profile = await storage.getOrCreate("learner");
    const value = session("one", course, profile);
    await storage.create(value);
    assert.equal(count(client, "courseDefinitions"), 2);
    await storage.replaceCatalog([{ ...course, coachHints: ["replacement"] }]);
    assert.equal(count(client, "courseDefinitions"), 2);
    assert.equal(count(client, "courseHints"), course.coachHints.length + 1);
    const before = Object.values(schema).map((table) => ({ table, count: tableCount(client, table) }));
    await assert.rejects(storage.replaceCatalog([course, course]));
    assert.equal((await storage.course(course.id))?.coachHints[0], "replacement");
    await assert.rejects(storage.create(value));
    for (const entry of before) assert.equal(tableCount(client, entry.table), entry.count);
    await storage.replaceCatalog([]);
    assert.equal(count(client, "courseDefinitions"), 1);
    assert.equal(count(client, "courseHints"), course.coachHints.length);
    assert.deepEqual(client.pragma("foreign_key_check"), []);
  } finally { client.close(); storage.onModuleDestroy(); await fixture.cleanup(); }
});

test("learned and unlearn queries isolate users/courses and cascade only winning debrief children", async () => {
  const fixture = await fixtureConfig();
  const storage = new SqliteStorage(fixture.config);
  const client = new Database(join(fixture.config.dataDir, DATABASE_FILENAME));
  try {
    const course = loadCourse(await readFile(join(fixture.config.coursesDir, "refund.yaml"), "utf8"));
    const learner = await storage.getOrCreate("learner");
    const other = await storage.getOrCreate("other");
    const records = [
      session("win-1", course, learner), session("win-2", course, learner),
      session("loss", course, learner), session("foreign", course, other),
      session("different-course", { ...course, id: "another" }, learner),
    ];
    for (const record of records) {
      await storage.create(record);
      await storage.complete(record.id, { ...debrief, won: record.id !== "loss" }, [{ category: "tense", count: 1 }], "user");
    }
    assert.deepEqual(await storage.learnedCourses("learner"), new Set([course.id, "another"]));
    assert.deepEqual(await storage.learnedCourses("other"), new Set([course.id]));
    await storage.unlearnCourse("learner", course.id);
    await storage.unlearnCourse("learner", course.id);
    await storage.unlearnCourse("nobody", course.id);
    assert.deepEqual(await storage.learnedCourses("learner"), new Set(["another"]));
    assert.deepEqual(await storage.learnedCourses("other"), new Set([course.id]));
    assert.equal(await storage.debrief("win-1"), undefined);
    assert.equal(await storage.debrief("win-2"), undefined);
    assert.equal((await storage.debrief("loss"))?.won, false);
    assert.deepEqual(await storage.debrief("foreign"), debrief);
    assert.deepEqual(await storage.debrief("different-course"), debrief);
    assert.equal(count(client, "sessions"), 5);
    assert.equal(count(client, "patternUpdates"), 5);
    assert.equal(count(client, "debriefs"), 3);
    assert.equal(count(client, "debriefWorked"), 3 * debrief.worked.length);
    assert.equal(count(client, "debriefWatch"), 3 * debrief.watch.length);
    assert.equal(count(client, "debriefCorrections"), 3 * debrief.corrections.length);
    await storage.applyPending();
    assert.equal((await storage.recall("learner"))[0]?.count, 4);
    assert.equal((await storage.recall("other"))[0]?.count, 1);
    assert.deepEqual(client.pragma("foreign_key_check"), []);
  } finally { client.close(); storage.onModuleDestroy(); await fixture.cleanup(); }
});

test("completion and memory updates are atomic across normalized child rows", async () => {
  const fixture = await fixtureConfig();
  const storage = new SqliteStorage(fixture.config);
  const second = new SqliteStorage(fixture.config);
  const client = new Database(join(fixture.config.dataDir, DATABASE_FILENAME));
  try {
    const course = loadCourse(await readFile(join(fixture.config.coursesDir, "refund.yaml"), "utf8"));
    await storage.create(session("one", course, await storage.getOrCreate("learner")));
    client.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON pattern_updates
      BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END`);
    await assert.rejects(storage.complete("one", debrief, [{ category: "tense", count: 1 }], "goal"));
    for (const table of ["debriefs", "debriefWorked", "debriefWatch", "debriefCorrections", "patternUpdates", "patternDeltas"] as const) {
      assert.equal(count(client, table), 0);
    }
    assert.equal((await storage.get("one"))?.status, "live");
    client.exec("DROP TRIGGER fail_ledger");
    const [first, repeated] = await Promise.all([
      storage.complete("one", debrief, [{ category: "tense", count: 1 }, { category: "articles", count: 2 }], "goal"),
      second.complete("one", { ...debrief, won: false }, [{ category: "wrong", count: 99 }], "network"),
    ]);
    assert.deepEqual(first, repeated);
    client.exec(`CREATE TRIGGER fail_pattern BEFORE INSERT ON patterns WHEN NEW.category='articles'
      BEGIN SELECT RAISE(ABORT, 'test pattern failure'); END`);
    await assert.rejects(storage.applyPending());
    assert.equal(count(client, "patterns"), 0);
    client.exec("DROP TRIGGER fail_pattern");
    await second.applyPending();
    await storage.applyPending();
    assert.deepEqual((await storage.recall("learner")).map(({ category, count }) => ({ category, count })), [
      { category: "articles", count: 2 }, { category: "tense", count: 1 },
    ]);
    assert.equal(count(client, "patternDeltas"), 2);
  } finally { client.close(); second.onModuleDestroy(); storage.onModuleDestroy(); await fixture.cleanup(); }
});

test("fresh schema is relational, matches Drizzle, and never touches legacy files", async () => {
  const fixture = await fixtureConfig();
  const legacyFiles = ["rehearsal.sqlite", "rehearsal.sqlite-wal", "rehearsal.sqlite-shm"];
  const sentinels = legacyFiles.map((name) => Buffer.from(`untouched old data: ${name}`));
  let storage: SqliteStorage | undefined;
  try {
    for (const [index, name] of legacyFiles.entries()) await writeFile(join(fixture.config.dataDir, name), sentinels[index]!);
    storage = new SqliteStorage(fixture.config);
    const initial = await storage.getOrCreate("learner");
    assert.equal(initial.onboarded, false);
    const client = new Database(join(fixture.config.dataDir, DATABASE_FILENAME));
    try {
      assert.equal(client.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      for (const table of Object.values(schema)) {
        const definition = getTableConfig(table);
        const columns = z.array(z.object({ name: z.string() })).parse(client.pragma(`table_info('${definition.name}')`));
        assert.deepEqual(columns.map((column) => column.name), definition.columns.map((column) => column.name));
        assert.ok(!columns.some((column) => column.name === "value" || column.name.includes("snapshot")));
        assert.ok(definition.columns.every((column) => column.dataType !== "json"));
      }
      assert.deepEqual(client.pragma("foreign_key_check"), []);
    } finally { client.close(); }
    for (const [index, name] of legacyFiles.entries()) {
      assert.deepEqual(await readFile(join(fixture.config.dataDir, name)), sentinels[index]);
    }
    for (const name of ["sqlite.ts", "rows.ts", "schema.ts", "initialize.ts"]) {
      const source = await readFile(new URL(`../src/storage/${name}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /JSON\.(parse|stringify)|json_extract|mode:\s*["']json["']/u);
    }
  } finally { storage?.onModuleDestroy(); await fixture.cleanup(); }
});

test("unexpected new-file schemas are rejected without resetting tables or versions", async () => {
  const fixture = await fixtureConfig();
  const client = new Database(join(fixture.config.dataDir, DATABASE_FILENAME));
  try {
    client.exec("CREATE TABLE existing_data(id INTEGER PRIMARY KEY)");
    client.prepare("INSERT INTO existing_data(id) VALUES (?)").run(7);
    assert.throws(() => new SqliteStorage(fixture.config), /SQLite initialization failed/);
    assert.equal(client.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(client.prepare("SELECT id FROM existing_data").all(), [{ id: 7 }]);
    client.pragma("user_version = 999");
    assert.throws(() => new SqliteStorage(fixture.config), /SQLite initialization failed/);
    assert.equal(client.pragma("user_version", { simple: true }), 999);
    assert.deepEqual(client.prepare("SELECT id FROM existing_data").all(), [{ id: 7 }]);
  } finally { client.close(); await fixture.cleanup(); }
});
