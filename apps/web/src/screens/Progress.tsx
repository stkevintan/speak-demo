import { ArrowRight, Check, Clock, Heart, LoaderCircle, RefreshCw, Sparkles, Square, Target, Users, X, Zap } from "lucide-react";
import { overallPoints } from "@rehearsal/contracts";
import type { CourseCard, GoalProgress, Profile, ProgressAttempt } from "@rehearsal/contracts";
import { useBeginScene, useCourses, useProgress } from "../api/hooks";
import { Avatar, Pip } from "../components/Artwork";
import { Settings } from "../components/Settings";
import { BackToScenes, Busy, Problem, ScorePill, ScoreRing, Shell, accents, errorMessage } from "../components/ui";

/**
 * `UI.md` §4.8. The server sends the states, the marks, the ordering and the
 * scores (`progressView`, `ARCHITECTURE.md` §5.8), so this screen only picks the
 * icon and the words for each one and adds up counts that were already reported —
 * it never derives a state, a mark, an order or a score, because three clients
 * doing that would drift.
 */

const MARK = {
  met: { Icon: Check, ink: "#08735A", tint: "bg-teal-soft", chip: "bg-teal-soft text-teal-ink", label: "Goal met" },
  missed: { Icon: X, ink: "#66617C", tint: "bg-line", chip: "bg-line text-muted", label: "Goal missed" },
  ended_early: { Icon: Square, ink: "#8A6013", tint: "bg-sun-soft", chip: "bg-sun-soft text-sun-ink", label: "Ended early" },
} as const;

const BADGE = {
  met: { Icon: Check, label: "Goal met", chip: "bg-teal-soft text-teal-ink" },
  unfinished: { Icon: Clock, label: "Ended early", chip: "bg-sun-soft text-sun-ink" },
  not_started: { Icon: Target, label: "Not started yet", chip: "bg-line text-muted" },
} as const;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function minutes(ms: number): string {
  const whole = Math.round(ms / 60_000);
  return whole < 1 ? "under a minute" : `${whole} min`;
}

function titles(goals: GoalProgress[]): string {
  const names = goals.map(goal => goal.title);
  if (names.length <= 3) return names.join(" · ");
  return `${names.slice(0, 2).join(" · ")} · and ${names.length - 2} more`;
}

function total(goals: GoalProgress[], count: (attempt: ProgressAttempt) => number): number {
  return goals.reduce((sum, goal) => sum + goal.history.reduce((row, attempt) => row + count(attempt), 0), 0);
}

function AttemptChip({ attempt }: { attempt: ProgressAttempt }) {
  const { Icon, ink, chip } = MARK[attempt.mark];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-black ${chip}`} title={`Attempt ${attempt.attempt}`}>
      <Icon size={12} strokeWidth={3} style={{ color: ink }} />Attempt {attempt.attempt}
    </span>
  );
}

function AttemptRow({ attempt }: { attempt: ProgressAttempt }) {
  const { Icon, ink, tint, label } = MARK[attempt.mark];
  const counts = [
    { Icon: Clock, text: minutes(attempt.durationMs) },
    { Icon: Zap, text: `${plural(attempt.suggestionsAdopted, "suggestion")} used` },
    { Icon: Heart, text: `${attempt.nice} nice` },
    { Icon: Sparkles, text: plural(attempt.nit, "upgrade") },
  ];
  return (
    <li className="flex items-start gap-3 border-b border-line py-2 last:border-0">
      <span className={`flex size-[27px] shrink-0 items-center justify-center rounded-[9px] ${tint}`}>
        <Icon size={14} strokeWidth={3} style={{ color: ink }} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-black">
          Attempt {attempt.attempt}
          <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-black ${MARK[attempt.mark].chip}`}>{label}</span>
          <span className="ml-auto text-base font-black tabular-nums" style={{ color: ink }}>{attempt.points}<span className="text-[11px] font-bold text-muted">/100</span></span>
        </p>
        <ul className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs font-bold text-muted">
          {counts.map(count => <li key={count.text} className="inline-flex items-center gap-1.5"><count.Icon size={13} />{count.text}</li>)}
        </ul>
      </div>
    </li>
  );
}

export function Progress({ profile }: { profile: Profile }) {
  const query = useProgress();
  const courses = useCourses();
  const { begin, start, startingCourse } = useBeginScene(profile);
  const view = query.data;
  const catalog = new Map<string, CourseCard>((courses.data ?? []).map(course => [course.id, course]));
  const goals = view?.goals ?? [];
  const scene = (goal: GoalProgress) => catalog.get(goal.courseId);
  const met = goals.filter(goal => goal.state === "met");
  const unfinished = goals.filter(goal => goal.state === "unfinished");
  const notStarted = goals.filter(goal => goal.state === "not_started");
  const attempts = goals.reduce((sum, goal) => sum + goal.attempts, 0);
  const adopted = total(goals, attempt => attempt.suggestionsAdopted);
  const nice = total(goals, attempt => attempt.nice);
  const nit = total(goals, attempt => attempt.nit);
  // The panel takes the scene the learner has come back to most, and stays quiet
  // until there is an attempt to take apart.
  const focus = goals.reduce<GoalProgress | null>((best, goal) => goal.attempts > (best?.attempts ?? 0) ? goal : best, null);
  const focusCourse = focus ? scene(focus) : undefined;
  const resume = unfinished[0] ?? notStarted[0] ?? null;
  const resumeCourse = resume ? scene(resume) : undefined;
  const overall = overallPoints(goals);
  const tiles = [
    { n: met.length, label: "Goals met", sub: met.length ? titles(met) : "None yet", ...accents.teal, Icon: Check },
    { n: unfinished.length, label: "Tried, not finished", sub: unfinished.length ? `${titles(unfinished)} — ended early` : "Nothing half-finished", ...accents.sun, Icon: Clock },
    { n: notStarted.length, label: "Not started yet", sub: notStarted.length ? titles(notStarted) : "None left", ...accents.sky, Icon: Target },
  ];
  const hero = attempts
    ? `${plural(attempts, "attempt")} across ${plural(goals.filter(goal => goal.attempts > 0).length, "scene")}. ${unfinished.length ? `${unfinished.length === 1 ? "One scene is" : `${unfinished.length} scenes are`} still waiting for you.` : "Nothing is left half-finished."}`
    : "No attempts yet. Your first scene is one tap away.";
  return (
    <Shell header={<><span className="pill">Level {profile.level}</span><BackToScenes /><Settings profile={profile} /></>}>
      {query.isPending && <Busy>Adding up your practice...</Busy>}
      {query.error && <Problem message={errorMessage(query.error)} retry={() => { void query.refetch(); }} />}
      {view && goals.length === 0 && <Problem message="No scenes are available yet. Please try again after the course catalog has been configured." retry={() => { void query.refetch(); }} />}
      {view && goals.length > 0 && <>
        <section className="mb-4 flex flex-wrap items-center gap-6 rounded-[32px] bg-gradient-to-r from-violet-soft via-pink-soft to-coral-soft px-6 py-5 shadow-card sm:px-8">
          <div className="min-w-0 flex-1">
            <h1 className="heading">You've met {view.totals.met} of {goals.length} goals.</h1>
            <p className="mt-2 max-w-[620px] text-sm font-semibold leading-relaxed text-body">{hero}</p>
          </div>
          {overall !== null && (
            <div className="flex items-center gap-3 rounded-[24px] bg-white/70 px-4 py-3">
              <ScoreRing points={overall} size={62} stroke={7} tone={accents.violet} label="Overall progress" />
              <div className="min-w-0">
                <p className="text-sm font-black">Overall progress</p>
                <p className="mt-0.5 text-xs font-bold text-muted">across {plural(goals.filter(goal => goal.attempts > 0).length, "scene")} you have tried</p>
              </div>
            </div>
          )}
          <Pip mood="cheer" size={104} />
        </section>
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          {tiles.map(tile => (
            <article key={tile.label} className="relative flex items-center gap-4 overflow-hidden rounded-[26px] bg-white p-4 pl-6 shadow-card">
              <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: tile.fill }} aria-hidden="true" />
              <span className="flex size-[46px] shrink-0 items-center justify-center rounded-[15px]" style={{ background: tile.soft }}>
                <tile.Icon size={22} strokeWidth={2.6} style={{ color: tile.ink }} />
              </span>
              <div className="min-w-0">
                <p className="text-3xl font-black leading-none tracking-tight" style={{ color: tile.ink }}>{tile.n}</p>
                <p className="mt-1 text-sm font-black">{tile.label}</p>
                <p className="mt-1 text-xs font-bold text-muted">{tile.sub}</p>
              </div>
            </article>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_452px]">
          <section className="panel flex flex-col">
            <div className="mb-3 flex flex-wrap items-baseline gap-3">
              <h2 className="flex items-center gap-2 text-lg font-black"><Users size={17} strokeWidth={2.4} className="text-violet-ink" />Your scenes</h2>
              <p className="ml-auto flex items-center gap-2 whitespace-nowrap text-[11.5px] font-extrabold text-muted">
                <Check size={12} strokeWidth={3} className="text-teal-ink" /> met
                <X size={12} strokeWidth={3} /> missed
                <Square size={12} strokeWidth={2.4} className="text-sun-ink" /> ended early
              </p>
            </div>
            <ul>
              {goals.map(goal => {
                const course = scene(goal);
                const badge = BADGE[goal.state];
                const colour = accents[course?.accent ?? "violet"];
                return (
                  <li key={goal.courseId} className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
                    {course && <Avatar {...course.avatar} accent={colour.fill} size={46} />}
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-black tracking-tight">{goal.title}</p>
                      <p className="mt-0.5 text-xs font-bold text-muted">
                        {course ? `${course.counterpart.name} · ${course.counterpart.role} · ${course.levels.join(" / ")}` : goal.goal}
                        {goal.attempts > 0 && ` · ${plural(goal.attempts, "attempt")}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">{goal.history.map(attempt => <AttemptChip key={attempt.sessionId} attempt={attempt} />)}</div>
                    {goal.attempts > 0 && <ScorePill points={goal.points} tone={colour} caption={`${goal.title} score`} />}
                    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-black ${badge.chip}`}>
                      <badge.Icon size={13} strokeWidth={3} />{badge.label}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-auto border-t border-dashed border-line pt-3 text-xs font-bold leading-relaxed text-muted">
              {attempts
                ? <>Across all {plural(attempts, "attempt")} you used <b className="text-violet-ink">{plural(adopted, "suggestion")}</b>, earned <b className="text-violet-ink">{plural(nice, "nice moment")}</b> and <b className="text-violet-ink">{plural(nit, "upgrade")}</b>. Each attempt is scored out of 100: 55 for meeting the goal, then up to 15 each for time, suggestions you used and coach cards.</>
                : <>Play a scene and this fills in with what you actually did. Each attempt is scored out of 100: 55 for meeting the goal, then up to 15 each for time, suggestions you used and coach cards.</>}
            </p>
          </section>
          <div className="flex flex-col gap-4">
            {focus && focus.history.length > 0 && (
              <section className="panel">
                <div className="mb-3 flex flex-wrap items-baseline gap-3">
                  <h2 className="flex items-center gap-2 text-lg font-black"><RefreshCw size={17} strokeWidth={2.4} className="text-violet-ink" />Attempt by attempt</h2>
                  <p className="ml-auto text-[11.5px] font-extrabold text-muted">{focusCourse ? `${focusCourse.counterpart.name} · ${focusCourse.levels[0] ?? ""}` : focus.title}</p>
                </div>
                <ul>{focus.history.map(attempt => <AttemptRow key={attempt.sessionId} attempt={attempt} />)}</ul>
                <p className="mt-3 border-t border-dashed border-line pt-3 text-[11.5px] font-bold leading-relaxed text-muted">Meeting the goal is worth 55 of the 100, so a win always outranks a miss however long the miss ran.</p>
              </section>
            )}
            <section className="panel flex flex-1 flex-col">
              <h2 className="flex items-center gap-2 text-lg font-black"><ArrowRight size={17} strokeWidth={2.4} className="text-violet-ink" />{resume?.state === "unfinished" ? "Pick up where you left off" : "Start something new"}</h2>
              {resume ? <>
                <p className="mt-2 text-[13px] font-semibold leading-relaxed text-muted">
                  {resume.score?.mark === "ended_early"
                    ? `You stopped after ${minutes(resume.score.durationMs)}, so ${resumeCourse?.counterpart.name ?? "your character"} never heard the end of your story.`
                    : resume.state === "unfinished"
                      ? `${resumeCourse?.counterpart.name ?? "Your character"} ran out of time before the goal landed. The scene is still open.`
                      : `${resume.title} is waiting for its first attempt.`}
                </p>
                <p className="mt-2 text-[13px] font-semibold leading-relaxed text-muted">Resuming is the same attempt, not a restart.</p>
                <div className="mt-3 flex items-center gap-3">
                  {resumeCourse && <Avatar {...resumeCourse.avatar} accent={accents[resumeCourse.accent].fill} size={44} />}
                  <div className="min-w-0">
                    <p className="font-black">{resume.title}</p>
                    <p className="text-xs font-bold text-muted">{resumeCourse ? `${resumeCourse.counterpart.name} · ${resumeCourse.counterpart.role} · ${resumeCourse.levels.join(" / ")}` : resume.goal}</p>
                  </div>
                </div>
                {start.error && <Problem message={errorMessage(start.error)} />}
                <div className="mt-auto pt-4">
                  {resumeCourse
                    ? <button className="button button-primary w-full font-black" disabled={start.isPending} onClick={() => { void begin(resumeCourse); }}>
                      {start.isPending && startingCourse === resumeCourse.id ? <LoaderCircle className="animate-spin" size={18} /> : <>Back to {resumeCourse.counterpart.name} <ArrowRight size={18} /></>}
                    </button>
                    : <BackToScenes />}
                </div>
              </> : <>
                <p className="mt-2 text-[13px] font-semibold leading-relaxed text-muted">Every goal is met. Replay any scene to keep the words fresh — nothing you have earned can be taken away.</p>
                <div className="mt-auto pt-4"><BackToScenes /></div>
              </>}
            </section>
          </div>
        </div>
      </>}
    </Shell>
  );
}
