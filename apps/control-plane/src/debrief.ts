import {
  Correction, Debrief, SessionRecord, coachRate, courseFit,
  type Course, type Profile,
} from "@rehearsal/contracts";
import type { PatternDelta } from "./storage/ports.js";

export function buildDebrief(input: SessionRecord, course: Course, profile: Profile, catalog: Course[]) {
  const record = SessionRecord.parse(input);
  const counts = new Map<string, number>();
  const corrections: Correction[] = [];
  for (const finding of record.findings) {
    if (finding.kind !== "nit") continue;
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
    if (finding.better) {
      corrections.push(Correction.parse({
        category: finding.category, quote: finding.quote, better: finding.better,
        en: finding.en, zh: finding.zh,
      }));
    }
  }
  const deltas: PatternDelta[] = [...counts].map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const praise = [...new Set(record.findings.filter((finding) => finding.kind === "nice").map((finding) => finding.en))];
  const learnerTurns = record.transcript.filter((turn) => turn.role === "learner").length;
  const floor = learnerTurns > 0
    ? `You practised ${learnerTurns} conversational ${learnerTurns === 1 ? "turn" : "turns"}.`
    : "You made time to open a practice scene.";
  const rate = coachRate(record.signal);
  const worked = praise.length ? (rate !== null && rate >= 0.5 ? [...praise, floor] : [floor, ...praise]) : [floor];
  const priorities = new Set(deltas.map((delta) => delta.category.toLowerCase()));
  const alternatives = catalog.filter((item) => item.id !== course.id);
  const candidates = alternatives.length ? alternatives : [course];
  const score = (candidate: Course) =>
    (courseFit(candidate, profile.level) === "on_level" ? 1 : 0)
    + (rate !== null && rate < 0.5 ? 2 * candidate.coachHints.filter((hint) => priorities.has(hint.toLowerCase())).length : 0);
  const next = candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0] ?? course;
  return {
    debrief: Debrief.parse({
      won: record.goalMet,
      headline: record.goalMet
        ? "You reached your scene goal."
        : rate !== null && rate >= 0.5
          ? "Your language showed strengths. Keep practising the scene goal."
          : "Every rehearsal is a step forward.",
      worked,
      watch: deltas.filter((delta) => delta.count > 1).map((delta) => `${delta.category}: ${delta.count} times.`),
      corrections,
      next: { id: next.id, title: next.title },
    }),
    deltas,
  };
}
