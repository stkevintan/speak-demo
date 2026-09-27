import { z } from "zod";
import { Accent, Avatar, Level } from "./course.js";

/* ------------------------------------------------------------------ *
 * The turn state machine — ARCHITECTURE.md §5.1
 * ------------------------------------------------------------------ */

/**
 * Five states, one owner. `PRODUCT.md`'s "never ambiguous silence" holds only
 * while every visible signal is a pure function of this one value, so it is
 * part of the contract rather than an internal of `web`.
 */
export const State = z.enum(["idle", "listening", "thinking", "speaking", "ended"]);
export type State = z.infer<typeof State>;

export const EndReason = z.enum(["user", "quit", "network", "goal", "budget"]);
export type EndReason = z.infer<typeof EndReason>;

/**
 * Inputs to `transition(s, e)`.
 *
 * Named `TurnEvent`, not `Event`: §6.3's realtime events are also "events", and
 * one name for two things is how a codebase starts lying to you.
 */
export const TurnEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("connect") }),
  z.object({ t: z.literal("speech_onset") }),
  z.object({ t: z.literal("speech_end"), text: z.string() }),
  z.object({ t: z.literal("commit") }),
  z.object({ t: z.literal("reply_ready") }),
  z.object({ t: z.literal("tts_end") }),
  z.object({ t: z.literal("barge_in") }),
  z.object({ t: z.literal("silence"), ms: z.number().int().nonnegative() }),
  z.object({ t: z.literal("end"), reason: EndReason }),
  z.object({ t: z.literal("converge") }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

/** Milliseconds from session start. */
export const Timing = z.strictObject({
  tStart: z.number().int().nonnegative(),
  tEnd: z.number().int().nonnegative(),
});
export type Timing = z.infer<typeof Timing>;

export const Role = z.enum(["learner", "character"]);
export type Role = z.infer<typeof Role>;

/** One transcript line. Also the payload of the `transcript.final` event (§6.3). */
export const Turn = z.strictObject({
  role: Role,
  text: z.string().min(1),
  tStart: z.number().int().nonnegative(),
  tEnd: z.number().int().nonnegative(),
});
export type Turn = z.infer<typeof Turn>;

/* ------------------------------------------------------------------ *
 * Coach — ARCHITECTURE.md §5.4
 * ------------------------------------------------------------------ */

/**
 * What `observe()` returns, before `admit()` filters it. `nice` findings use the
 * same machinery as `nit`s because "positive cards always show" cannot depend on
 * happening to find nothing wrong.
 */
export const Finding = z.strictObject({
  kind: z.enum(["nice", "nit"]),
  category: z.string().min(1),
  quote: z.string().min(1),
  /** The sharper phrasing. Present on a nit, absent on praise. */
  better: z.string().min(1).optional(),
});
export type Finding = z.infer<typeof Finding>;

/** A `Finding` that passed `admit()` and was explained. The `coach.card` payload (§6.3). */
export const CoachCard = Finding.extend({
  en: z.string().min(1),
  zh: z.string().min(1),
});
export type CoachCard = z.infer<typeof CoachCard>;

/**
 * Counts over the **raw** `observe()` findings, before `admit()`.
 *
 * Only counts are stored. §5.4 describes a single scalar (`nice` ÷ `total`), but
 * persisting it next to its own inputs invites the two to disagree; `coachRate()`
 * derives it instead. It also keeps "no findings yet" (`0 / 0`) distinguishable
 * from "nothing went well" (`0 / 12`) — a real difference in the debrief, and one
 * a stored `0` would erase.
 */
export const CoachSignal = z.strictObject({
  nice: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).refine((signal) => signal.nice <= signal.total, {
  message: "nice cannot exceed total",
  path: ["nice"],
});
export type CoachSignal = z.infer<typeof CoachSignal>;

/** The scalar of §5.4. `null` when nothing was observed — not `0`. */
export function coachRate(signal: CoachSignal): number | null {
  return signal.total === 0 ? null : signal.nice / signal.total;
}

/** A nit, kept with its fix. A correction with no `better` is not a correction. */
export const Correction = z.strictObject({
  category: z.string().min(1),
  quote: z.string().min(1),
  better: z.string().min(1),
  en: z.string().min(1),
  zh: z.string().min(1),
});
export type Correction = z.infer<typeof Correction>;

/* ------------------------------------------------------------------ *
 * Memory — ARCHITECTURE.md §5.5
 * ------------------------------------------------------------------ */

/** Slips counted by category across sessions — never a stored transcript (§11). */
export const Pattern = z.strictObject({
  category: z.string().min(1),
  count: z.number().int().positive(),
  lastSeen: z.string().min(1),
});
export type Pattern = z.infer<typeof Pattern>;

/* ------------------------------------------------------------------ *
 * Ending and debrief — ARCHITECTURE.md §5.6, §5.7
 * ------------------------------------------------------------------ */

/** Handed to the character so it closes in character instead of opening a thread. */
export const Directive = z.strictObject({
  converge: z.literal(true),
  withinTurns: z.number().int().positive(),
});
export type Directive = z.infer<typeof Directive>;

export const CourseRef = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
});
export type CourseRef = z.infer<typeof CourseRef>;

/**
 * `won` is the character's `goalMet` flag, never the coach's rate (§5.6): the
 * scene asks "did you get the refund", not "was your English clean". Binary,
 * because "did you win?" is a game question.
 */
export const Debrief = z.strictObject({
  won: z.boolean(),
  headline: z.string().min(1),
  /**
   * Never empty. §5.6 gives it a deterministic floor — turns taken, no switch to
   * Chinese, no abandonment — which are facts about the session rather than
   * opinions from the coach, so a coach failure cannot drain this. `.min(1)`
   * makes that a property of the contract instead of a hope about the builder.
   */
  worked: z.array(z.string().min(1)).min(1),
  watch: z.array(z.string().min(1)),
  /** Every sentence that was corrected. */
  corrections: z.array(Correction),
  next: CourseRef,
});
export type Debrief = z.infer<typeof Debrief>;

/** What the worker leaves in Redis for `buildDebrief` to read (§7). */
export const SessionRecord = z.strictObject({
  sessionId: z.string().min(1),
  courseId: z.string().min(1),
  transcript: z.array(Turn),
  findings: z.array(CoachCard),
  signal: CoachSignal,
  goalMet: z.boolean(),
  learnerTurns: z.number().int().nonnegative(),
  endReason: EndReason,
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/* ------------------------------------------------------------------ *
 * Profile — ARCHITECTURE.md §4.2
 * ------------------------------------------------------------------ */

export const Profile = z.strictObject({
  userId: z.string().min(1),
  level: Level,
  /** Set by the server when a level is explicitly saved, including Skip. */
  onboarded: z.boolean(),
  /** Show the Chinese line under every correction (`PRODUCT.md` "never left to decode"). */
  chinese: z.boolean(),
  /** Offer prompts after a long silence. */
  suggestions: z.boolean(),
  patterns: z.array(Pattern),
});
export type Profile = z.infer<typeof Profile>;

export const ProfilePatch = Profile.pick({ level: true, chinese: true, suggestions: true }).partial();
export type ProfilePatch = z.infer<typeof ProfilePatch>;

/* ------------------------------------------------------------------ *
 * Course card — ARCHITECTURE.md §6.2
 * ------------------------------------------------------------------ */

/**
 * `levels` orders and badges, it never hides (§4.4). Every course is returned to
 * every learner; `fit` is the badge, computed per learner.
 */
export const CourseFit = z.enum(["easy", "on_level", "stretch"]);
export type CourseFit = z.infer<typeof CourseFit>;

export const CourseCard = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  levels: z.array(Level).min(1),
  accent: Accent,
  avatar: Avatar,
  counterpart: z.strictObject({ name: z.string().min(1), role: z.string().min(1) }),
  goal: z.string().min(1),
  you: z.string().min(1),
  setting: z.string().min(1),
  edge: z.string().min(1),
  fit: CourseFit,
  learned: z.boolean(),
});
export type CourseCard = z.infer<typeof CourseCard>;

/* ------------------------------------------------------------------ *
 * Realtime surface — ARCHITECTURE.md §6.3
 * ------------------------------------------------------------------ */

export const SessionStart = z.strictObject({
  sessionId: z.string().min(1),
  livekit: z.strictObject({
    url: z.string().min(1),
    /** Scoped to one room. The only credential the browser ever holds (§6.2). */
    token: z.string().min(1),
  }),
  recalled: z.array(Pattern),
});
export type SessionStart = z.infer<typeof SessionStart>;
