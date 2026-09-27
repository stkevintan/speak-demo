import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { Course, Debrief } from "@rehearsal/contracts";
import { StoredSession } from "./ports.js";
import * as schema from "./schema.js";

type Writer = Pick<BetterSQLite3Database<typeof schema>, "select" | "insert">;

export const DeltaList = z.array(z.strictObject({
  category: z.string().min(1),
  count: z.number().int().positive(),
}));

export function insertCourse(db: Writer, course: Course): string {
  const definitionId = randomUUID();
  db.insert(schema.courseDefinitions).values({
    definitionId, courseId: course.id, version: course.version, title: course.title, accent: course.accent,
    learnerTurnBudget: course.budget?.learnerTurns ?? null,
    avatarStyle: course.avatar.style, avatarMood: course.avatar.mood,
    avatarHair: course.avatar.hair, avatarSkin: course.avatar.skin,
    stakesYou: course.stakes.you, stakesSetting: course.stakes.setting, stakesEdge: course.stakes.edge,
    goal: course.goal, counterpartName: course.counterpart.name, counterpartRole: course.counterpart.role,
    counterpartGoal: course.counterpart.goal, opener: course.opener,
    characterPrompt: course.prompts.character, coachPrompt: course.prompts.coach,
  }).run();
  for (const [ordinal, level] of course.levels.entries()) {
    db.insert(schema.courseLevels).values({ definitionId, ordinal, level }).run();
  }
  for (const [ordinal, hint] of course.coachHints.entries()) {
    db.insert(schema.courseHints).values({ definitionId, ordinal, hint }).run();
  }
  return definitionId;
}

export function readCourse(db: Writer, definitionId: string): Course {
  const row = db.select().from(schema.courseDefinitions)
    .where(eq(schema.courseDefinitions.definitionId, definitionId)).get();
  if (!row) throw new Error("Stored course definition is missing");
  return Course.parse({
    id: row.courseId, version: row.version, title: row.title, accent: row.accent,
    ...(row.learnerTurnBudget === null ? {} : { budget: { learnerTurns: row.learnerTurnBudget } }),
    avatar: { style: row.avatarStyle, mood: row.avatarMood, hair: row.avatarHair, skin: row.avatarSkin },
    stakes: { you: row.stakesYou, setting: row.stakesSetting, edge: row.stakesEdge },
    goal: row.goal, counterpart: { name: row.counterpartName, role: row.counterpartRole, goal: row.counterpartGoal },
    opener: row.opener, prompts: { character: row.characterPrompt, coach: row.coachPrompt },
    levels: db.select({ level: schema.courseLevels.level }).from(schema.courseLevels)
      .where(eq(schema.courseLevels.definitionId, definitionId)).orderBy(asc(schema.courseLevels.ordinal)).all()
      .map((entry) => entry.level),
    coachHints: db.select({ hint: schema.courseHints.hint }).from(schema.courseHints)
      .where(eq(schema.courseHints.definitionId, definitionId)).orderBy(asc(schema.courseHints.ordinal)).all()
      .map((entry) => entry.hint),
  });
}

export function insertSession(db: Writer, session: StoredSession) {
  const courseDefinitionId = insertCourse(db, session.course);
  db.insert(schema.sessions).values({
    id: session.id, userId: session.userId, roomName: session.roomName, courseDefinitionId,
    profileUserId: session.profile.userId, profileLevel: session.profile.level,
    profileOnboarded: session.profile.onboarded, profileChinese: session.profile.chinese,
    profileSuggestions: session.profile.suggestions,
    status: session.status, startedAt: session.startedAt, endedAt: session.endedAt ?? null,
    endReason: session.endReason ?? null, cleanupNeeded: session.cleanupNeeded,
  }).run();
  for (const [ordinal, pattern] of session.profile.patterns.entries()) {
    db.insert(schema.sessionProfilePatterns).values({ sessionId: session.id, ordinal, ...pattern }).run();
  }
}

export function readSession(db: Writer, row: typeof schema.sessions.$inferSelect): StoredSession {
  return StoredSession.parse({
    id: row.id, userId: row.userId, roomName: row.roomName, course: readCourse(db, row.courseDefinitionId),
    profile: {
      userId: row.profileUserId, level: row.profileLevel, onboarded: row.profileOnboarded,
      chinese: row.profileChinese, suggestions: row.profileSuggestions,
      patterns: db.select({
        category: schema.sessionProfilePatterns.category, count: schema.sessionProfilePatterns.count,
        lastSeen: schema.sessionProfilePatterns.lastSeen,
      }).from(schema.sessionProfilePatterns).where(eq(schema.sessionProfilePatterns.sessionId, row.id))
        .orderBy(asc(schema.sessionProfilePatterns.ordinal)).all(),
    },
    status: row.status, startedAt: row.startedAt, cleanupNeeded: row.cleanupNeeded,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.endReason === null ? {} : { endReason: row.endReason }),
  });
}

export function insertDebrief(db: Writer, sessionId: string, value: Debrief) {
  db.insert(schema.debriefs).values({
    sessionId, won: value.won, headline: value.headline, nextId: value.next.id, nextTitle: value.next.title,
  }).run();
  for (const [ordinal, message] of value.worked.entries()) {
    db.insert(schema.debriefWorked).values({ sessionId, ordinal, message }).run();
  }
  for (const [ordinal, message] of value.watch.entries()) {
    db.insert(schema.debriefWatch).values({ sessionId, ordinal, message }).run();
  }
  for (const [ordinal, correction] of value.corrections.entries()) {
    db.insert(schema.debriefCorrections).values({ sessionId, ordinal, ...correction }).run();
  }
}

export function readDebrief(db: Writer, row: typeof schema.debriefs.$inferSelect): Debrief {
  const { sessionId } = row;
  return Debrief.parse({
    won: row.won, headline: row.headline, next: { id: row.nextId, title: row.nextTitle },
    worked: db.select({ message: schema.debriefWorked.message }).from(schema.debriefWorked)
      .where(eq(schema.debriefWorked.sessionId, sessionId)).orderBy(asc(schema.debriefWorked.ordinal)).all()
      .map((entry) => entry.message),
    watch: db.select({ message: schema.debriefWatch.message }).from(schema.debriefWatch)
      .where(eq(schema.debriefWatch.sessionId, sessionId)).orderBy(asc(schema.debriefWatch.ordinal)).all()
      .map((entry) => entry.message),
    corrections: db.select({
      category: schema.debriefCorrections.category, quote: schema.debriefCorrections.quote,
      better: schema.debriefCorrections.better, en: schema.debriefCorrections.en, zh: schema.debriefCorrections.zh,
    }).from(schema.debriefCorrections).where(eq(schema.debriefCorrections.sessionId, sessionId))
      .orderBy(asc(schema.debriefCorrections.ordinal)).all(),
  });
}
