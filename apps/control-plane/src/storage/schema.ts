import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Course, EndReason } from "@rehearsal/contracts";
import type { StoredSession } from "./ports.js";

export const profiles = sqliteTable("profiles", {
  userId: text("id").primaryKey(),
  level: text("level", { enum: ["A2", "B1", "B2"] }).notNull(),
  onboarded: integer("onboarded", { mode: "boolean" }).notNull(),
  chinese: integer("chinese", { mode: "boolean" }).notNull(),
  suggestions: integer("suggestions", { mode: "boolean" }).notNull(),
});

// Catalog entries can change; session references pin immutable definitions.
export const courseDefinitions = sqliteTable("course_definitions", {
  definitionId: text("definition_id").primaryKey(),
  courseId: text("course_id").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  accent: text("accent").$type<Course["accent"]>().notNull(),
  learnerTurnBudget: integer("learner_turn_budget"),
  avatarStyle: text("avatar_style").$type<Course["avatar"]["style"]>().notNull(),
  avatarMood: text("avatar_mood").$type<Course["avatar"]["mood"]>().notNull(),
  avatarHair: text("avatar_hair").notNull(),
  avatarSkin: text("avatar_skin").notNull(),
  stakesYou: text("stakes_you").notNull(),
  stakesSetting: text("stakes_setting").notNull(),
  stakesEdge: text("stakes_edge").notNull(),
  goal: text("goal").notNull(),
  counterpartName: text("counterpart_name").notNull(),
  counterpartRole: text("counterpart_role").notNull(),
  counterpartGoal: text("counterpart_goal").notNull(),
  opener: text("opener").notNull(),
  characterPrompt: text("character_prompt").notNull(),
  coachPrompt: text("coach_prompt").notNull(),
});
export const courseLevels = sqliteTable("course_levels", {
  definitionId: text("definition_id").notNull().references(() => courseDefinitions.definitionId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  level: text("level", { enum: ["A2", "B1", "B2"] }).notNull(),
}, (table) => [primaryKey({ columns: [table.definitionId, table.ordinal] })]);
export const courseHints = sqliteTable("course_hints", {
  definitionId: text("definition_id").notNull().references(() => courseDefinitions.definitionId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  hint: text("hint").notNull(),
}, (table) => [primaryKey({ columns: [table.definitionId, table.ordinal] })]);
export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  definitionId: text("definition_id").notNull().references(() => courseDefinitions.definitionId),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  roomName: text("room_name").notNull(),
  courseDefinitionId: text("course_definition_id").notNull().references(() => courseDefinitions.definitionId),
  profileUserId: text("profile_user_id").notNull(),
  profileLevel: text("profile_level", { enum: ["A2", "B1", "B2"] }).notNull(),
  profileOnboarded: integer("profile_onboarded", { mode: "boolean" }).notNull(),
  profileChinese: integer("profile_chinese", { mode: "boolean" }).notNull(),
  profileSuggestions: integer("profile_suggestions", { mode: "boolean" }).notNull(),
  status: text("status").$type<StoredSession["status"]>().notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  endReason: text("end_reason").$type<EndReason>(),
  cleanupNeeded: integer("cleanup_needed", { mode: "boolean" }).notNull(),
}, (table) => [
  index("sessions_user_status_idx").on(table.userId, table.status),
  index("sessions_definition_idx").on(table.courseDefinitionId),
  index("sessions_recovery_idx").on(table.status, table.cleanupNeeded),
]);
export const sessionProfilePatterns = sqliteTable("session_profile_patterns", {
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  category: text("category").notNull(),
  count: integer("count").notNull(),
  lastSeen: text("last_seen").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })]);

export const debriefs = sqliteTable("debriefs", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id),
  won: integer("won", { mode: "boolean" }).notNull(),
  headline: text("headline").notNull(),
  nextId: text("next_id").notNull(),
  nextTitle: text("next_title").notNull(),
});
export const debriefWorked = sqliteTable("debrief_worked", {
  sessionId: text("session_id").notNull().references(() => debriefs.sessionId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  message: text("message").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })]);
export const debriefWatch = sqliteTable("debrief_watch", {
  sessionId: text("session_id").notNull().references(() => debriefs.sessionId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  message: text("message").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })]);
export const debriefCorrections = sqliteTable("debrief_corrections", {
  sessionId: text("session_id").notNull().references(() => debriefs.sessionId, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  category: text("category").notNull(),
  quote: text("quote").notNull(),
  better: text("better").notNull(),
  en: text("en").notNull(),
  zh: text("zh").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })]);

export const patterns = sqliteTable("patterns", {
  userId: text("user_id").notNull(),
  category: text("category").notNull(),
  count: integer("count").notNull(),
  lastSeen: text("last_seen").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.category] })]);
export const patternUpdates = sqliteTable("pattern_updates", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id),
  userId: text("user_id").notNull(),
  seenAt: text("seen_at").notNull(),
  applied: integer("applied", { mode: "boolean" }).notNull(),
}, (table) => [index("pattern_updates_pending_idx").on(table.applied)]);
export const patternDeltas = sqliteTable("pattern_deltas", {
  sessionId: text("session_id").notNull().references(() => patternUpdates.sessionId),
  ordinal: integer("ordinal").notNull(),
  category: text("category").notNull(),
  count: integer("count").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })]);
