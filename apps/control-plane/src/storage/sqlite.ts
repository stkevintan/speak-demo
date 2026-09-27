import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import Database from "better-sqlite3";
import { z } from "zod";
import { Course, Debrief, EndReason, Pattern, Profile, ProfilePatch } from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "../config.js";
import { StoredSession, type PatternDelta } from "./ports.js";

const JsonRow = z.object({ value: z.string() });
const DeltaList = z.array(z.strictObject({ category: z.string().min(1), count: z.number().int().positive() }));

@Injectable()
export class SqliteStorage {
  private readonly db: Database.Database;

  constructor(@Inject(CONFIG) config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(resolve(config.dataDir, "rehearsal.sqlite"));
    if (z.number().parse(this.db.pragma("user_version", { simple: true })) > 1) {
      this.db.close();
      throw new Error("SQLite schema is newer than this control-plane version");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
        cleanup_needed INTEGER NOT NULL DEFAULT 1, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS debriefs (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patterns (
        user_id TEXT NOT NULL, category TEXT NOT NULL, count INTEGER NOT NULL,
        last_seen TEXT NOT NULL, PRIMARY KEY(user_id, category)
      );
      CREATE TABLE IF NOT EXISTS pattern_updates (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), user_id TEXT NOT NULL,
        seen_at TEXT NOT NULL, value TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 1;
    `);
  }

  onModuleDestroy() { this.db.close(); }

  private value<T>(row: unknown, schema: z.ZodType<T>): T | undefined {
    return row === undefined ? undefined : schema.parse(JSON.parse(JsonRow.parse(row).value));
  }

  async getOrCreate(userId: string): Promise<Profile> {
    const initial = Profile.parse({
      userId, level: "B1", onboarded: false, chinese: true, suggestions: true, patterns: [],
    });
    this.db.prepare("INSERT OR IGNORE INTO profiles(id,value) VALUES (?,?)").run(userId, JSON.stringify(initial));
    return Profile.parse(this.value(this.db.prepare("SELECT value FROM profiles WHERE id=?").get(userId), Profile));
  }

  async patch(userId: string, patch: ProfilePatch): Promise<Profile> {
    await this.getOrCreate(userId);
    return this.db.transaction(() => {
      const current = Profile.parse(this.value(this.db.prepare("SELECT value FROM profiles WHERE id=?").get(userId), Profile));
      const value = Profile.parse({
        ...current, ...ProfilePatch.parse(patch),
        onboarded: current.onboarded || patch.level !== undefined,
      });
      this.db.prepare("UPDATE profiles SET value=? WHERE id=?").run(JSON.stringify(value), userId);
      return value;
    })();
  }

  async replaceCatalog(courses: Course[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM courses").run();
      const insert = this.db.prepare("INSERT INTO courses(id,value) VALUES (?,?)");
      for (const course of courses) insert.run(course.id, JSON.stringify(Course.parse(course)));
    })();
  }
  async listCourses(): Promise<Course[]> {
    return this.db.prepare("SELECT value FROM courses ORDER BY id").all()
      .map((row) => Course.parse(this.value(row, Course)));
  }
  async course(id: string) { return this.value(this.db.prepare("SELECT value FROM courses WHERE id=?").get(id), Course); }

  async create(session: StoredSession) {
    const value = StoredSession.parse(session);
    this.db.prepare("INSERT INTO sessions(id,user_id,status,cleanup_needed,value) VALUES (?,?,?,?,?)")
      .run(value.id, value.userId, value.status, Number(value.cleanupNeeded), JSON.stringify(value));
  }
  async get(id: string) {
    return this.value(this.db.prepare("SELECT value FROM sessions WHERE id=?").get(id), StoredSession);
  }
  async setStatus(id: string, status: StoredSession["status"]) {
    this.db.transaction(() => {
      const current = this.value(this.db.prepare("SELECT value FROM sessions WHERE id=?").get(id), StoredSession);
      if (!current) throw new Error("Session disappeared during transition");
      if (current.status === "ended" || current.status === "failed") return;
      // A delayed start must not reopen a concurrently closing session.
      if (status === "live" && current.status !== "starting") return;
      this.db.prepare("UPDATE sessions SET status=?,value=? WHERE id=?")
        .run(status, JSON.stringify({ ...current, status }), id);
    })();
  }
  async pending(): Promise<StoredSession[]> {
    return this.db.prepare("SELECT value FROM sessions WHERE status NOT IN ('ended','failed') OR cleanup_needed=1").all()
      .map((row) => StoredSession.parse(this.value(row, StoredSession)));
  }
  async debrief(id: string) { return this.value(this.db.prepare("SELECT value FROM debriefs WHERE session_id=?").get(id), Debrief); }

  async complete(id: string, debrief: Debrief, deltas: PatternDelta[], reason: EndReason): Promise<Debrief> {
    return this.db.transaction(() => {
      const existing = this.value(this.db.prepare("SELECT value FROM debriefs WHERE session_id=?").get(id), Debrief);
      if (existing) return existing;
      const session = StoredSession.parse(this.value(this.db.prepare("SELECT value FROM sessions WHERE id=?").get(id), StoredSession));
      const validated = Debrief.parse(debrief);
      this.db.prepare("INSERT INTO debriefs(session_id,value) VALUES (?,?)").run(id, JSON.stringify(validated));
      this.db.prepare("INSERT INTO pattern_updates(session_id,user_id,seen_at,value) VALUES (?,?,?,?)")
        .run(id, session.userId, new Date().toISOString(), JSON.stringify(DeltaList.parse(deltas)));
      this.db.prepare("UPDATE sessions SET status='ended',cleanup_needed=1,value=? WHERE id=?")
        .run(JSON.stringify({
          ...session, status: "ended", cleanupNeeded: true,
          endedAt: Date.now(), endReason: EndReason.parse(reason),
        }), id);
      return validated;
    })();
  }
  async cleaned(id: string) {
    this.db.transaction(() => {
      const current = StoredSession.parse(this.value(this.db.prepare("SELECT value FROM sessions WHERE id=?").get(id), StoredSession));
      this.db.prepare("UPDATE sessions SET cleanup_needed=0,value=? WHERE id=?")
        .run(JSON.stringify({ ...current, cleanupNeeded: false }), id);
    })();
  }
  async recall(userId: string): Promise<Pattern[]> {
    return this.db.prepare("SELECT category,count,last_seen AS lastSeen FROM patterns WHERE user_id=? ORDER BY count DESC, category")
      .all(userId).map((row) => Pattern.parse(row));
  }
  async applyPending() {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT session_id,user_id,seen_at,value FROM pattern_updates WHERE applied=0").all();
      for (const raw of rows) {
        const row = z.object({
          session_id: z.string(), user_id: z.string(), seen_at: z.string(), value: z.string(),
        }).parse(raw);
        for (const delta of DeltaList.parse(JSON.parse(row.value))) {
          this.db.prepare(`INSERT INTO patterns(user_id,category,count,last_seen) VALUES (?,?,?,?)
            ON CONFLICT(user_id,category) DO UPDATE SET count=count+excluded.count,
            last_seen=MAX(last_seen,excluded.last_seen)`)
            .run(row.user_id, delta.category, delta.count, row.seen_at);
        }
        this.db.prepare("UPDATE pattern_updates SET applied=1 WHERE session_id=?").run(row.session_id);
      }
    })();
  }
}
