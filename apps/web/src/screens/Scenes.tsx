import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, LoaderCircle, Target } from "lucide-react";
import type { CourseCard, Profile } from "@rehearsal/contracts";
import { useCourses, useCreateSession, useSaveProfile, useUnlearn } from "../api/hooks";
import { Avatar, Pip } from "../components/Artwork";
import { Settings } from "../components/Settings";
import { Busy, Problem, Shell, Switch, accents, errorMessage } from "../components/ui";
import { useSessionStore } from "../session/store";

export function Scenes({ profile }: { profile: Profile }) {
  const courses = useCourses();
  const save = useSaveProfile();
  const start = useCreateSession();
  const unlearn = useUnlearn();
  const starting = useRef(false);
  const [startingCourse, setStartingCourse] = useState<string | null>(null);
  const navigate = useNavigate();
  const begin = async (course: CourseCard) => {
    if (starting.current) return;
    starting.current = true;
    setStartingCourse(course.id);
    try {
      const grant = await start.mutateAsync({ data: { courseId: course.id } });
      useSessionStore.getState().begin(grant, course, profile);
      start.reset();
      navigate(`/sessions/${encodeURIComponent(grant.sessionId)}`);
    } catch {
      // The generated mutation exposes the failure beside the scene picker.
    } finally {
      starting.current = false;
      setStartingCourse(null);
    }
  };
  const pattern = profile.patterns[0];
  const confirmUnlearn = (course: CourseCard) => {
    if (window.confirm(`Mark “${course.title}” as not learned?`)) unlearn.mutate({ id: course.id });
  };
  return (
    <Shell header={<><span className="pill">Level {profile.level}</span><Settings profile={profile} /></>}>
      <section className="mb-6 flex flex-wrap items-center gap-4 rounded-[24px] bg-gradient-to-r from-violet-soft to-pink-soft/60 px-5 py-4">
        <Pip mood={pattern ? "write" : "cheer"} size={58} />
        <p className="min-w-0 flex-1 text-sm font-bold leading-relaxed text-body">
          {pattern ? <>Welcome back. Last time, <span className="text-violet-ink">{pattern.category}</span> came up {pattern.count} {pattern.count === 1 ? "time" : "times"}. Let's see what sticks.</> : <>A little practice goes a long way. Pick a conversation worth rehearsing.</>}
        </p>
        <Switch label="Chinese hints" checked={profile.chinese} disabled={save.isPending} onChange={chinese => save.mutate({ data: { chinese } })} />
      </section>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="heading">Pick a scene</h1><p className="mt-2 text-sm font-semibold text-muted">A character, a goal, and room to find your own words.</p></div>
        {courses.data && <span className="text-sm font-bold text-muted">{courses.data.length} scenes. All open to you.</span>}
      </div>
      {save.error && <Problem message={errorMessage(save.error)} />}
      {start.error && <Problem message={errorMessage(start.error)} />}
      {courses.isPending && <Busy>Finding your scenes...</Busy>}
      {courses.error && <Problem message={errorMessage(courses.error)} retry={() => { void courses.refetch(); }} />}
      {courses.data?.length === 0 && <Problem message="No scenes are available yet. Please try again after the course catalog has been configured." retry={() => { void courses.refetch(); }} />}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {courses.data?.map(course => {
          const colour = accents[course.accent];
          return (
            <article key={course.id} className="relative flex flex-col overflow-hidden rounded-[30px] border-t-[6px] bg-white p-6 shadow-card" style={{ borderColor: colour.fill }}>
              {course.learned && <button type="button" className="absolute right-0 top-0 size-[52px]" style={{ background: colour.soft, clipPath: "polygon(0 0, 100% 0, 100% 100%)" }} title="Undo learned status" aria-label={`Undo learned status for ${course.title}`} disabled={unlearn.isPending} onClick={() => { confirmUnlearn(course); }}><Check className="absolute right-2 top-2" size={17} strokeWidth={3} style={{ color: colour.ink }} /></button>}
              <div className="flex items-center gap-3">
                <Avatar {...course.avatar} accent={colour.fill} />
                <div><h2 className="font-black">{course.counterpart.name}</h2><p className="text-xs font-bold text-muted">{course.counterpart.role}</p></div>
                <span className="ml-auto rounded-full px-3 py-2 text-xs font-black" style={{ background: colour.soft, color: colour.ink }}>{course.levels.join(" / ")}</span>
              </div>
              <h3 className="mb-3 mt-5 text-[22px] font-black leading-tight tracking-tight">{course.title}</h3>
              <p className="text-sm font-semibold leading-relaxed text-body"><span className="mr-2 rounded-lg bg-line px-2 py-1 text-[10px] font-black uppercase text-muted">You</span>{course.you}</p>
              <p className="mt-3 flex items-start gap-2 text-sm font-extrabold text-body"><Target size={19} className="mt-0.5 shrink-0" style={{ color: colour.ink }} />{course.goal}</p>
              <p className="mt-3 text-sm italic leading-relaxed text-muted">{course.setting}</p>
              <p className="mt-3 text-xs font-semibold text-muted">{course.counterpart.name} {course.edge}.</p>
              <div className="mt-auto flex items-center gap-3 pt-5">
                <span className="text-xs font-bold" style={{ color: colour.ink }}>{course.fit === "on_level" ? "A good fit for your level" : course.fit === "easy" ? "Build your confidence" : "Try a little stretch"}</span>
                <button className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink" style={{ background: colour.soft }} disabled={start.isPending} aria-label={`Start ${course.title}`} onClick={() => { void begin(course); }}>{start.isPending && startingCourse === course.id ? <LoaderCircle size={22} className="animate-spin" /> : <ArrowRight size={22} />}</button>
              </div>
            </article>
          );
        })}
      </div>
      {start.isPending && <Busy>Opening your scene...</Busy>}
    </Shell>
  );
}
