import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Course, Debrief, EndReason, Pattern, Profile, ProfilePatch } from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "../config.js";
import { StoredSession, type PatternDelta } from "./ports.js";
import { DATABASE_FILENAME, initializeStorage } from "./initialize.js";
import { DeltaList, insertCourse, insertDebrief, insertSession, readCourse, readDebrief, readSession } from "./rows.js";
import * as schema from "./schema.js";

@Injectable()
export class SqliteStorage {
  private readonly client: Database.Database;
  private readonly db: BetterSQLite3Database<typeof schema>;

  constructor(@Inject(CONFIG) config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.client = new Database(resolve(config.dataDir, DATABASE_FILENAME));
    try {
      this.client.pragma("journal_mode = WAL");
      this.client.pragma("foreign_keys = ON");
      this.client.pragma("busy_timeout = 5000");
      initializeStorage(this.client);
      this.db = drizzle(this.client, { schema });
    } catch (error) {
      this.client.close();
      throw new Error("SQLite initialization failed; check the v2 database schema", { cause: error });
    }
  }

  onModuleDestroy() { this.client.close(); }

  async getOrCreate(userId: string): Promise<Profile> {
    const initial = Profile.parse({
      userId, level: "B1", onboarded: false, chinese: true, suggestions: true, patterns: [],
    });
    const { patterns: _, ...row } = initial;
    this.db.insert(schema.profiles).values(row).onConflictDoNothing().run();
    return Profile.parse({
      ...this.db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).get(), patterns: [],
    });
  }

  async patch(userId: string, patch: ProfilePatch): Promise<Profile> {
    const parsed = ProfilePatch.parse(patch);
    await this.getOrCreate(userId);
    return this.db.transaction((tx) => {
      const current = Profile.parse({
        ...tx.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).get(), patterns: [],
      });
      const value = Profile.parse({ ...current, ...parsed, onboarded: current.onboarded || parsed.level !== undefined });
      const { patterns: _, ...row } = value;
      tx.update(schema.profiles).set(row).where(eq(schema.profiles.userId, userId)).run();
      return value;
    }, { behavior: "immediate" });
  }

  async replaceCatalog(courses: Course[]) {
    const values = courses.map((course) => Course.parse(course));
    this.db.transaction((tx) => {
      tx.delete(schema.courses).run();
      for (const course of values) {
        const definitionId = insertCourse(tx, course);
        tx.insert(schema.courses).values({ id: course.id, definitionId }).run();
      }
      tx.delete(schema.courseDefinitions).where(and(
        notInArray(schema.courseDefinitions.definitionId, tx.select({ id: schema.courses.definitionId }).from(schema.courses)),
        notInArray(schema.courseDefinitions.definitionId, tx.select({ id: schema.sessions.courseDefinitionId }).from(schema.sessions)),
      )).run();
    }, { behavior: "immediate" });
  }
  async listCourses(): Promise<Course[]> {
    return this.db.transaction((tx) => tx.select().from(schema.courses).orderBy(asc(schema.courses.id)).all()
      .map((row) => readCourse(tx, row.definitionId)));
  }
  async course(id: string) {
    return this.db.transaction((tx) => {
      const row = tx.select().from(schema.courses).where(eq(schema.courses.id, id)).get();
      return row ? readCourse(tx, row.definitionId) : undefined;
    });
  }

  async create(session: StoredSession) {
    const parsed = StoredSession.parse(session);
    this.db.transaction((tx) => insertSession(tx, parsed), { behavior: "immediate" });
  }
  async get(id: string) {
    return this.db.transaction((tx) => {
      const row = tx.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      return row ? readSession(tx, row) : undefined;
    });
  }
  async setStatus(id: string, status: StoredSession["status"]) {
    StoredSession.shape.status.parse(status);
    this.db.transaction((tx) => {
      const row = tx.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      if (!row) throw new Error("Session disappeared during transition");
      if (row.status === "ended" || row.status === "failed") return;
      if (status === "live" && row.status !== "starting") return;
      tx.update(schema.sessions).set({ status }).where(eq(schema.sessions.id, id)).run();
    }, { behavior: "immediate" });
  }
  async pending(): Promise<StoredSession[]> {
    return this.db.transaction((tx) => tx.select().from(schema.sessions).where(or(
      notInArray(schema.sessions.status, ["ended", "failed"]),
      eq(schema.sessions.cleanupNeeded, true),
    )).all().map((row) => readSession(tx, row)));
  }
  async debrief(id: string) {
    return this.db.transaction((tx) => {
      const row = tx.select().from(schema.debriefs).where(eq(schema.debriefs.sessionId, id)).get();
      return row ? readDebrief(tx, row) : undefined;
    });
  }

  async complete(id: string, debrief: Debrief, deltas: PatternDelta[], reason: EndReason): Promise<Debrief> {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(schema.debriefs).where(eq(schema.debriefs.sessionId, id)).get();
      if (existing) return readDebrief(tx, existing);
      const row = tx.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      if (!row) throw new Error("Session disappeared during completion");
      const session = readSession(tx, row);
      const validated = Debrief.parse(debrief);
      const parsedDeltas = DeltaList.parse(deltas);
      const endReason = EndReason.parse(reason);
      insertDebrief(tx, id, validated);
      tx.insert(schema.patternUpdates).values({
        sessionId: id, userId: session.userId, seenAt: new Date().toISOString(), applied: false,
      }).run();
      for (const [ordinal, delta] of parsedDeltas.entries()) {
        tx.insert(schema.patternDeltas).values({ sessionId: id, ordinal, ...delta }).run();
      }
      tx.update(schema.sessions).set({
        status: "ended", cleanupNeeded: true, endedAt: Date.now(), endReason,
      }).where(eq(schema.sessions.id, id)).run();
      return validated;
    }, { behavior: "immediate" });
  }
  async learnedCourses(userId: string): Promise<Set<string>> {
    const rows = this.db.selectDistinct({ courseId: schema.courseDefinitions.courseId }).from(schema.sessions)
      .innerJoin(schema.debriefs, eq(schema.debriefs.sessionId, schema.sessions.id))
      .innerJoin(schema.courseDefinitions, eq(schema.courseDefinitions.definitionId, schema.sessions.courseDefinitionId))
      .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, "ended"), eq(schema.debriefs.won, true)))
      .all();
    return new Set(rows.map((row) => row.courseId));
  }
  async unlearnCourse(userId: string, courseId: string): Promise<void> {
    this.db.transaction((tx) => {
      const ownedSessions = tx.select({ id: schema.sessions.id }).from(schema.sessions)
        .innerJoin(schema.courseDefinitions, eq(schema.courseDefinitions.definitionId, schema.sessions.courseDefinitionId))
        .where(and(eq(schema.sessions.userId, userId), eq(schema.courseDefinitions.courseId, courseId)));
      tx.delete(schema.debriefs).where(and(
        eq(schema.debriefs.won, true), inArray(schema.debriefs.sessionId, ownedSessions),
      )).run();
    }, { behavior: "immediate" });
  }
  async cleaned(id: string) {
    const rows = this.db.update(schema.sessions).set({ cleanupNeeded: false })
      .where(eq(schema.sessions.id, id)).returning({ id: schema.sessions.id }).all();
    if (!rows.length) throw new Error("Session disappeared during cleanup");
  }
  async recall(userId: string): Promise<Pattern[]> {
    return this.db.select({
      category: schema.patterns.category, count: schema.patterns.count, lastSeen: schema.patterns.lastSeen,
    }).from(schema.patterns).where(eq(schema.patterns.userId, userId))
      .orderBy(desc(schema.patterns.count), asc(schema.patterns.category)).all().map((row) => Pattern.parse(row));
  }
  async applyPending() {
    this.db.transaction((tx) => {
      const updates = tx.select().from(schema.patternUpdates).where(eq(schema.patternUpdates.applied, false)).all();
      for (const update of updates) {
        const deltas = tx.select({ category: schema.patternDeltas.category, count: schema.patternDeltas.count })
          .from(schema.patternDeltas).where(eq(schema.patternDeltas.sessionId, update.sessionId))
          .orderBy(asc(schema.patternDeltas.ordinal)).all();
        for (const delta of DeltaList.parse(deltas)) {
          tx.insert(schema.patterns).values({ userId: update.userId, ...delta, lastSeen: update.seenAt })
            .onConflictDoUpdate({
              target: [schema.patterns.userId, schema.patterns.category],
              set: {
                count: sql`${schema.patterns.count} + ${delta.count}`,
                lastSeen: sql`MAX(${schema.patterns.lastSeen}, ${update.seenAt})`,
              },
            }).run();
        }
        tx.update(schema.patternUpdates).set({ applied: true })
          .where(eq(schema.patternUpdates.sessionId, update.sessionId)).run();
      }
    }, { behavior: "immediate" });
  }
}
