import { Level, type Course } from "./zod/course.js";
import { ACCENTS } from "./zod/palette.js";
import type { CourseCard, CourseFit } from "./zod/session.js";

/** CEFR order, so "is this below me?" is a comparison rather than a lookup table. */
const ORDER: Record<Level, number> = { A2: 0, B1: 1, B2: 2 };

/**
 * Which badge the picker shows — `ARCHITECTURE.md` §4.4.
 *
 * `levels` orders and badges, it **never hides**. Every course is offered to every
 * learner; this only decides which one is labelled "on level", so a B1 learner
 * can still choose the easy one on a tired evening.
 */
export function courseFit(course: Course, level: Level): CourseFit {
  if (course.levels.includes(level)) return "on_level";
  const easiest = course.levels.reduce(
    (min, l) => (ORDER[l] < ORDER[min] ? l : min),
    course.levels[0] as Level,
  );
  return ORDER[easiest] < ORDER[level] ? "easy" : "stretch";
}

/**
 * Project a `Course` onto what the picker needs.
 *
 * Lives in the contract package rather than in the API because both the
 * control-plane and the offline `check:courses` script need the same answer, and
 * a card that renders differently in the two is a bug nobody would notice.
 *
 * `accent` crosses as a **name**; the resolved tokens stay in `web`. A course
 * picks a palette entry, never a hex, which is what keeps every pair in
 * `UI.md` §6 at its verified contrast ratio.
 */
export function toCourseCard(course: Course, level: Level): CourseCard {
  return {
    id: course.id,
    title: course.title,
    levels: course.levels,
    accent: course.accent,
    avatar: course.avatar,
    counterpart: { name: course.counterpart.name, role: course.counterpart.role },
    goal: course.goal,
    you: course.stakes.you,
    setting: course.stakes.setting,
    edge: course.stakes.edge,
    fit: courseFit(course, level),
  };
}

/** The accent tokens for a card, for callers that need the actual colours. */
export function accentTokens(course: Course) {
  return ACCENTS[course.accent];
}
