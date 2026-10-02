import { z } from "zod";
import { AttemptMark, EndReason, SessionMetrics } from "./session.js";

/**
 * One row of `SessionRepo.attempts()` — a session as the progress read needs it,
 * before it has been numbered or marked within its course.
 *
 * `metrics` is nullable rather than absent because a session abandoned before
 * `end()` never wrote a record, and that absence is a fact the screen should not
 * confuse with a zero (§5.8).
 */
export const AttemptRow = z.strictObject({
  courseId: z.string().min(1),
  sessionId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  won: z.boolean(),
  endReason: EndReason,
  /** The record's own count; 0 for a session that left no record. */
  learnerTurns: z.number().int().nonnegative(),
  metrics: SessionMetrics.nullable(),
});
export type AttemptRow = z.infer<typeof AttemptRow>;

/**
 * One attempt as the screen renders it — §5.8's `Attempt`, plus the `mark` the
 * `att` chip shows. Flat rather than nesting `metrics`, because every field here
 * is a number the `att-row` prints directly and a nested object would only add a
 * level for the renderer to walk.
 */
export const ProgressAttempt = z.strictObject({
  sessionId: z.string().min(1),
  /** 1-based, oldest first within the course. */
  attempt: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  mark: AttemptMark,
  won: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  learnerTurns: z.number().int().nonnegative(),
  suggestionsOffered: z.number().int().nonnegative(),
  suggestionsAdopted: z.number().int().nonnegative(),
  nice: z.number().int().nonnegative(),
  nit: z.number().int().nonnegative(),
  /**
   * `attemptPoints()` — 0-100, points achieved over points achievable. Shipped
   * rather than left to the client for the same reason `mark` is: the recap bar
   * and the progress screen must not be able to score one attempt differently.
   */
  points: z.number().int().min(0).max(100),
}).refine((attempt) => attempt.won === (attempt.mark === "met"), {
  message: "mark must be met exactly when the attempt was won",
  path: ["mark"],
});
export type ProgressAttempt = z.infer<typeof ProgressAttempt>;

/**
 * §5.8: `met` means a win at some point, and nothing takes it away — a later
 * worse attempt does not demote the goal, and the API declares no trend for the
 * client to second-guess.
 */
export const GoalState = z.enum(["met", "unfinished", "not_started"]);
export type GoalState = z.infer<typeof GoalState>;

/** `unfinished` first — the thing the screen exists to surface. */
const GOAL_RANK: Record<GoalState, number> = { unfinished: 0, not_started: 1, met: 2 };

/**
 * The one place the screen's ordering rule lives, so `progressView` cannot order
 * goals one way and the validator accept another.
 */
export function goalRank(state: GoalState): number {
  return GOAL_RANK[state];
}

/**
 * When the learner last touched a goal: the start of its newest attempt, which
 * is what §5.8's "most recent activity" means. A goal with no history has none,
 * so `not_started` goals keep catalog order instead of being sorted by nothing.
 * Exported so `progressView` sorts by the same number this file validates.
 */
export function lastActivity(goal: GoalProgress): number {
  return goal.history[goal.history.length - 1]?.startedAt ?? 0;
}

/**
 * One goal line. `history` is every attempt oldest-first, `score` is the attempt
 * the summary tiles describe, and `wonOnAttempt` is the 1-based index of the
 * first win — the tuple the docs keep separate instead of collapsing into one
 * "last attempt" object that would lose the win (§5.8).
 *
 * `points` is that same attempt's score, hoisted so the recap bar and the scene
 * card can print a scene's number without walking `history` — and so the two
 * cannot walk it differently.
 */
export const GoalProgress = z.strictObject({
  courseId: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  state: GoalState,
  attempts: z.number().int().nonnegative(),
  wonOnAttempt: z.number().int().positive().nullable(),
  score: ProgressAttempt.nullable(),
  /** The scene's score: `score.points`, or 0 before the first attempt. */
  points: z.number().int().min(0).max(100),
  history: z.array(ProgressAttempt),
}).superRefine((goal, ctx) => {
  if (goal.attempts !== goal.history.length) {
    ctx.addIssue({ code: "custom", message: "attempts must count history", path: ["attempts"] });
  }
  goal.history.forEach((entry, index) => {
    if (entry.attempt !== index + 1) {
      ctx.addIssue({
        code: "custom",
        message: "attempts are numbered 1..n oldest-first",
        path: ["history", index, "attempt"],
      });
    }
    const previous = goal.history[index - 1];
    if (previous && entry.startedAt < previous.startedAt) {
      ctx.addIssue({
        code: "custom",
        message: "history must be ordered oldest-first",
        path: ["history", index, "startedAt"],
      });
    }
  });
  const firstWin = goal.history.findIndex((entry) => entry.won);
  if (goal.wonOnAttempt !== (firstWin === -1 ? null : firstWin + 1)) {
    ctx.addIssue({
      code: "custom",
      message: "wonOnAttempt must be the first winning attempt",
      path: ["wonOnAttempt"],
    });
  }
  if ((goal.state === "met") !== (firstWin !== -1)) {
    ctx.addIssue({ code: "custom", message: "met means some attempt won", path: ["state"] });
  }
  if ((goal.state === "not_started") !== (goal.history.length === 0)) {
    ctx.addIssue({
      code: "custom",
      message: "not_started means no attempt was made",
      path: ["state"],
    });
  }
  // The win stands even after a worse attempt, so "score" is the winning attempt
  // when there is one and the latest attempt otherwise — never the best.
  const scored = goal.history[firstWin === -1 ? goal.history.length - 1 : firstWin];
  if ((goal.score?.sessionId ?? null) !== (scored?.sessionId ?? null)) {
    ctx.addIssue({
      code: "custom",
      message: "score must be the winning attempt, or the latest one",
      path: ["score"],
    });
  }
  if (goal.points !== (scored?.points ?? 0)) {
    ctx.addIssue({
      code: "custom",
      message: "points must be the score attempt's points",
      path: ["points"],
    });
  }
});
export type GoalProgress = z.infer<typeof GoalProgress>;

/**
 * `ARCHITECTURE.md` §6.2's `/api/progress` body. `totals` is a partition of
 * `goals`, so it is checked rather than trusted: the count tiles and the list
 * below them are the same numbers, and a client that had to count for itself
 * would eventually disagree with the server.
 *
 * Goals are ordered by what needs doing — `unfinished`, then `not_started`,
 * then `met` — and within a group by most recent activity, so the screen never
 * has to sort and two clients never sort differently.
 */
export const Progress = z.strictObject({
  totals: z.strictObject({
    met: z.number().int().nonnegative(),
    unfinished: z.number().int().nonnegative(),
    notStarted: z.number().int().nonnegative(),
  }),
  goals: z.array(GoalProgress),
}).superRefine((progress, ctx) => {
  const seen = new Set<string>();
  let met = 0;
  let unfinished = 0;
  let notStarted = 0;
  let rank = 0;
  let previous: GoalProgress | null = null;
  progress.goals.forEach((goal, index) => {
    if (seen.has(goal.courseId)) {
      ctx.addIssue({
        code: "custom",
        message: "a course appears once",
        path: ["goals", index, "courseId"],
      });
    }
    seen.add(goal.courseId);
    if (goal.state === "met") met += 1;
    else if (goal.state === "unfinished") unfinished += 1;
    else notStarted += 1;
    const stateRank = goalRank(goal.state);
    if (stateRank < rank) {
      ctx.addIssue({
        code: "custom",
        message: "goals are ordered unfinished, not_started, met",
        path: ["goals", index, "state"],
      });
    }
    // Inside a group the freshest goal leads, so the screen's first line is the
    // one the learner touched last and not whatever order the query returned.
    if (previous && stateRank === rank && lastActivity(goal) > lastActivity(previous)) {
      ctx.addIssue({
        code: "custom",
        message: "goals in a group are ordered by most recent activity",
        path: ["goals", index, "state"],
      });
    }
    rank = stateRank;
    previous = goal;
  });
  const totals = progress.totals;
  if (totals.met !== met || totals.unfinished !== unfinished || totals.notStarted !== notStarted) {
    ctx.addIssue({ code: "custom", message: "totals must count the goals", path: ["totals"] });
  }
});
export type Progress = z.infer<typeof Progress>;
