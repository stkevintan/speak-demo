import type Database from "better-sqlite3";
import { z } from "zod";

export const DATABASE_FILENAME = "rehearsal-v3.sqlite";
export const SCHEMA_VERSION = 3;

// Embedded DDL travels with both tsx and compiled JS; no cwd-relative SQL assets.
const CREATE_SCHEMA = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY NOT NULL, level TEXT NOT NULL CHECK(level IN ('A2','B1','B2')),
  onboarded INTEGER NOT NULL CHECK(onboarded IN (0,1)),
  chinese INTEGER NOT NULL CHECK(chinese IN (0,1)),
  suggestions INTEGER NOT NULL CHECK(suggestions IN (0,1))
);
CREATE TABLE course_definitions (
  definition_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), title TEXT NOT NULL, accent TEXT NOT NULL,
  learner_turn_budget INTEGER CHECK(learner_turn_budget BETWEEN 1 AND 20),
  avatar_style TEXT NOT NULL, avatar_mood TEXT NOT NULL, avatar_hair TEXT NOT NULL, avatar_skin TEXT NOT NULL,
  stakes_you TEXT NOT NULL, stakes_setting TEXT NOT NULL, stakes_edge TEXT NOT NULL, goal TEXT NOT NULL,
  counterpart_name TEXT NOT NULL, counterpart_role TEXT NOT NULL, counterpart_goal TEXT NOT NULL,
  opener TEXT NOT NULL, character_prompt TEXT NOT NULL, coach_prompt TEXT NOT NULL
);
CREATE TABLE course_levels (
  definition_id TEXT NOT NULL REFERENCES course_definitions(definition_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), level TEXT NOT NULL CHECK(level IN ('A2','B1','B2')),
  PRIMARY KEY(definition_id,ordinal)
);
CREATE TABLE course_hints (
  definition_id TEXT NOT NULL REFERENCES course_definitions(definition_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), hint TEXT NOT NULL, PRIMARY KEY(definition_id,ordinal)
);
CREATE TABLE courses (
  id TEXT PRIMARY KEY NOT NULL, definition_id TEXT NOT NULL REFERENCES course_definitions(definition_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, room_name TEXT NOT NULL,
  course_definition_id TEXT NOT NULL REFERENCES course_definitions(definition_id),
  profile_user_id TEXT NOT NULL, profile_level TEXT NOT NULL CHECK(profile_level IN ('A2','B1','B2')),
  profile_onboarded INTEGER NOT NULL CHECK(profile_onboarded IN (0,1)),
  profile_chinese INTEGER NOT NULL CHECK(profile_chinese IN (0,1)),
  profile_suggestions INTEGER NOT NULL CHECK(profile_suggestions IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('starting','live','closing','ended','failed')),
  started_at INTEGER NOT NULL CHECK(started_at >= 0), ended_at INTEGER CHECK(ended_at >= 0),
  end_reason TEXT CHECK(end_reason IN ('user','quit','network','goal','budget')),
  cleanup_needed INTEGER NOT NULL CHECK(cleanup_needed IN (0,1))
);
CREATE INDEX sessions_user_status_idx ON sessions(user_id,status);
CREATE INDEX sessions_definition_idx ON sessions(course_definition_id);
CREATE INDEX sessions_recovery_idx ON sessions(status,cleanup_needed);
CREATE TABLE session_profile_patterns (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), category TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0), last_seen TEXT NOT NULL, PRIMARY KEY(session_id,ordinal)
);
CREATE TABLE debriefs (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
  won INTEGER NOT NULL CHECK(won IN (0,1)), headline TEXT NOT NULL,
  next_id TEXT NOT NULL, next_title TEXT NOT NULL
);
CREATE TABLE debrief_worked (
  session_id TEXT NOT NULL REFERENCES debriefs(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), message TEXT NOT NULL, PRIMARY KEY(session_id,ordinal)
);
CREATE TABLE debrief_watch (
  session_id TEXT NOT NULL REFERENCES debriefs(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), message TEXT NOT NULL, PRIMARY KEY(session_id,ordinal)
);
CREATE TABLE debrief_corrections (
  session_id TEXT NOT NULL REFERENCES debriefs(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), category TEXT NOT NULL,
  quote TEXT NOT NULL, better TEXT NOT NULL, en TEXT NOT NULL, zh TEXT NOT NULL,
  PRIMARY KEY(session_id,ordinal)
);
CREATE TABLE session_metrics (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
  learner_turns INTEGER NOT NULL CHECK(learner_turns >= 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  suggestions_offered INTEGER NOT NULL CHECK(suggestions_offered >= 0),
  suggestions_adopted INTEGER NOT NULL CHECK(suggestions_adopted BETWEEN 0 AND suggestions_offered),
  nice_count INTEGER NOT NULL CHECK(nice_count >= 0),
  nit_count INTEGER NOT NULL CHECK(nit_count >= 0)
);
CREATE TABLE patterns (
  user_id TEXT NOT NULL, category TEXT NOT NULL, count INTEGER NOT NULL CHECK(count > 0),
  last_seen TEXT NOT NULL, PRIMARY KEY(user_id,category)
);
CREATE TABLE pattern_updates (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1))
);
CREATE INDEX pattern_updates_pending_idx ON pattern_updates(applied);
CREATE TABLE pattern_deltas (
  session_id TEXT NOT NULL REFERENCES pattern_updates(session_id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), category TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0), PRIMARY KEY(session_id,ordinal)
);
`;

export function initializeStorage(client: Database.Database) {
  // The writer lock serializes schema creation across concurrent API startups.
  client.transaction(() => {
    const version = z.number().int().parse(client.pragma("user_version", { simple: true }));
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) throw new Error("Unsupported SQLite schema version; no automatic migration is configured");
    const tables = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length) throw new Error("Expected a fresh SQLite database; refusing to overwrite existing tables");
    client.exec(CREATE_SCHEMA);
    client.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}
