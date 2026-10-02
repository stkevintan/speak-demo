import { attemptMark } from "./zod/session.js";
import type { Course } from "./zod/course.js";
import { goalRank, lastActivity } from "./zod/progress.js";
import type { AttemptRow, GoalProgress, Progress, ProgressAttempt } from "./zod/progress.js";

/**
 * `PRODUCT.md` "My Progress": how the 100 achievable points are split.
 *
 * The goal carries 55 and everything else 45, and that majority is the whole
 * reason the number can be trusted: a win can never score below 55 and a miss
 * can never score above 45, so the score can never contradict the badge sitting
 * next to it. An even split would let a long, talkative failure outrank a short
 * success, which is the one way a progress number actively misleads.
 */
export const SCORE_POINTS = { goal: 55, time: 15, suggestions: 15, cards: 15 } as const;

/**
 * Where each engagement component stops paying. Capped rather than unbounded,
 * because talking for forty minutes is not six times as much practice as
 * talking for six, and an uncapped term would let time alone buy a perfect
 * score. Six minutes, three tapped hints and six coach cards are all "you did
 * the work" rather than "you did the maximum".
 */
export const SCORE_TARGETS = { durationMs: 6 * 60_000, suggestionsAdopted: 3, cards: 6 } as const;

/** The share of a target that was reached, clamped to 0-1. */
function share(value: number, target: number): number {
  return Math.min(1, Math.max(0, value / target));
}

/**
 * One attempt's score, 0-100: points achieved over points achievable.
 *
 * Takes the derived attempt rather than the raw metrics, so the number is
 * always computed from the same `durationMs` the screen prints — a session that
 * never reported falls back to its span in one place, not two.
 *
 * Every component is monotonic and independent, so more time, more adopted
 * suggestions or more coach cards can only ever help. Nothing here rewards
 * *not* doing something, which is what keeps the number from being gamed by
 * quitting early.
 */
export function attemptPoints(attempt: Pick<ProgressAttempt, "won" | "durationMs" | "suggestionsAdopted" | "nice" | "nit">): number {
  const goal = attempt.won ? SCORE_POINTS.goal : 0;
  const time = SCORE_POINTS.time * share(attempt.durationMs, SCORE_TARGETS.durationMs);
  const suggestions = SCORE_POINTS.suggestions * share(attempt.suggestionsAdopted, SCORE_TARGETS.suggestionsAdopted);
  const cards = SCORE_POINTS.cards * share(attempt.nice + attempt.nit, SCORE_TARGETS.cards);
  return Math.round(goal + time + suggestions + cards);
}

/**
 * The headline number for the recap bar: the mean of the scenes actually tried.
 *
 * Averaging over the whole catalog would make a learner's number drop the moment
 * they open a new scene, which is the one arithmetic `PRODUCT.md` will not allow.
 * Returns `null`, not 0, before the first attempt: an untouched learner has no
 * score, and "0" would read as a failure they never had.
 */
export function overallPoints(goals: GoalProgress[]): number | null {
  const tried = goals.filter((goal) => goal.attempts > 0);
  if (tried.length === 0) return null;
  return Math.round(tried.reduce((sum, goal) => sum + goal.points, 0) / tried.length);
}

/**
 * §5.8's derivation, kept beside `toCourseCard()` for the same reason: the API
 * and any offline caller must not be able to disagree about what "met" means, so
 * the rule lives in one pure function rather than in SQL and a controller.
 *
 * Takes the whole catalog, not just the courses with attempts: the screen lists
 * the goals the learner has not started too, and a course absent from `attempts`
 * is `not_started` rather than missing.
 *
 * Attempts arrive unordered; the numbering is derived here so a repository that
 * forgets an `ORDER BY` cannot renumber somebody's history.
 */
export function progressView(courses: Course[], attempts: AttemptRow[]): Progress {
  const byCourse = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const group = byCourse.get(attempt.courseId);
    if (group) group.push(attempt);
    else byCourse.set(attempt.courseId, [attempt]);
  }

  const goals: GoalProgress[] = courses.map((course) => {
    const history = [...(byCourse.get(course.id) ?? [])]
      .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
      .map((row, index) => toProgressAttempt(row, index + 1));
    // The first win, not the last: a goal once met stays met (§5.8).
    const firstWin = history.findIndex((entry) => entry.won);
    const met = firstWin !== -1;
    // The scene's score is the attempt the summary describes, not its best: a
    // later, worse attempt is the learner's current standing, and the win it
    // cannot take away is already carried by `state` and `wonOnAttempt`.
    const scored = history[firstWin === -1 ? history.length - 1 : firstWin];
    return {
      courseId: course.id,
      title: course.title,
      goal: course.goal,
      state: met ? "met" : history.length === 0 ? "not_started" : "unfinished",
      attempts: history.length,
      wonOnAttempt: met ? firstWin + 1 : null,
      score: scored ?? null,
      points: scored?.points ?? 0,
      history,
    };
  });

  // Stable sort, so courses with no activity at all keep catalog order.
  goals.sort((a, b) => goalRank(a.state) - goalRank(b.state) || lastActivity(b) - lastActivity(a));

  const totals = { met: 0, unfinished: 0, notStarted: 0 };
  for (const goal of goals) {
    if (goal.state === "met") totals.met += 1;
    else if (goal.state === "unfinished") totals.unfinished += 1;
    else totals.notStarted += 1;
  }

  return { totals, goals };
}

/** A session that never ended has no span; the fallback is `DATABASE.md`'s. */
function toProgressAttempt(row: AttemptRow, attempt: number): ProgressAttempt {
  const { metrics } = row;
  const derived = {
    sessionId: row.sessionId,
    attempt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    mark: attemptMark(row.won, row.endReason),
    won: row.won,
    durationMs:
      metrics?.durationMs ??
      (row.endedAt === null ? 0 : Math.max(0, row.endedAt - row.startedAt)),
    learnerTurns: row.learnerTurns,
    suggestionsOffered: metrics?.suggestionsOffered ?? 0,
    suggestionsAdopted: metrics?.suggestionsAdopted ?? 0,
    nice: metrics?.nice ?? 0,
    nit: metrics?.nit ?? 0,
  };
  return { ...derived, points: attemptPoints(derived) };
}
