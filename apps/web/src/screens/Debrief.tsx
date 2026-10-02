import { useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Check, Heart, Sparkles, Target } from "lucide-react";
import type { Profile } from "@rehearsal/contracts";
import { ApiError } from "@rehearsal/contracts/fetcher";
import { useCourses, useCreateSession, useDebrief, useFinishSession } from "../api/hooks";
import { Pip } from "../components/Artwork";
import { BackToScenes, Busy, Problem, Shell, errorMessage } from "../components/ui";
import { useSessionStore } from "../session/store";

export function DebriefScreen({ profile }: { profile: Profile }) {
  const { sessionId = "" } = useParams();
  const query = useDebrief(sessionId);
  const finish = useFinishSession();
  const courses = useCourses();
  const start = useCreateSession();
  const starting = useRef(false);
  const navigate = useNavigate();
  const attempts = useRef(0);
  const pending = query.error instanceof ApiError && query.error.status === 409;
  useEffect(() => { useSessionStore.getState().reset(); }, []);
  useEffect(() => {
    if (!pending || attempts.current >= 10) return;
    const timer = setTimeout(() => { attempts.current++; void query.refetch(); }, 2000);
    return () => clearTimeout(timer);
  }, [pending, query.errorUpdatedAt, query.refetch]);
  const debrief = query.data;
  const nextCourse = courses.data?.find(course => course.id === debrief?.next.id);
  const beginNext = async () => {
    if (!nextCourse || starting.current) return;
    starting.current = true;
    try {
      const grant = await start.mutateAsync({ data: { courseId: nextCourse.id } });
      useSessionStore.getState().begin(grant, nextCourse, profile);
      start.reset();
      navigate(`/sessions/${encodeURIComponent(grant.sessionId)}`);
    } catch {
      // The mutation error is rendered with the recommended scene.
    } finally { starting.current = false; }
  };
  return (
    <Shell header={<><Link className="button button-secondary" to="/progress"><Target size={18} />My progress</Link><BackToScenes /></>}>
      {query.isPending && <Busy>Getting your feedback...</Busy>}
      {pending && (
        <section className="panel mx-auto mt-10 max-w-2xl">
          <h1 className="heading">Your feedback is on its way</h1>
          <p className="my-4 text-body">The scene is still being wrapped up. You can check again or ask us to finish it now.</p>
          <div className="flex flex-wrap gap-3">
            <button className="button button-secondary" disabled={query.isFetching} onClick={() => { attempts.current = 0; void query.refetch(); }}>Check again</button>
            <button className="button button-primary" disabled={finish.isPending} onClick={() => finish.mutate({ id: sessionId })}>{finish.isPending ? "Finishing..." : "Finish scene"}</button>
          </div>
        </section>
      )}
      {query.error && !pending && <Problem message={errorMessage(query.error)} retry={() => { void query.refetch(); }} />}
      {finish.error && <Problem message={errorMessage(finish.error)} />}
      {debrief && (
        <div className="grid gap-5 lg:grid-cols-3">
          <section className={`flex flex-wrap items-center gap-5 rounded-[32px] p-7 shadow-card sm:p-9 lg:col-span-2 ${debrief.won ? "bg-gradient-to-br from-teal to-[#7ce8cd]" : "bg-gradient-to-br from-violet-soft to-pink-soft"}`}>
            <div className="min-w-0 flex-1">
              <p className="mb-3 text-xs font-black uppercase tracking-wider">{debrief.won ? "Goal achieved" : "Practice that counts"}</p>
              <h1 className="heading break-words">{debrief.headline}</h1>
              {!debrief.won && <p className="mt-3 text-sm font-semibold">The goal wasn't reached this time. Here's what you can take into the next conversation.</p>}
            </div>
            <Pip mood={debrief.won ? "cheer" : "idle"} size={112} />
          </section>
          <section className="panel flex flex-col justify-center">
            <p className="eyebrow">Do this next</p>
            <h2 className="mt-4 text-2xl font-black tracking-tight">{debrief.next.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{nextCourse ? `${nextCourse.counterpart.name}, ${nextCourse.counterpart.role}. ${nextCourse.goal}` : "A new scene to put your practice to work."}</p>
            {nextCourse ? <button disabled={start.isPending} onClick={() => { void beginNext(); }} className="button button-primary mt-5"><Target size={18} />{start.isPending ? "Opening scene..." : "Start this scene"}</button> : <div className="mt-5"><BackToScenes /></div>}
            {start.error && <Problem message={errorMessage(start.error)} />}
          </section>
          <section className="panel lg:col-span-2">
            <h2 className="flex items-center gap-2 text-lg font-black"><Heart size={21} className="text-teal-ink" />What worked</h2>
            <ul className="mt-3 divide-y divide-line">{debrief.worked.map((line, i) => <li key={i} className="flex items-start gap-3 py-3 text-sm leading-relaxed text-body"><Check size={18} className="mt-1 shrink-0 text-teal-ink" />{line}</li>)}</ul>
          </section>
          <section className="panel">
            <h2 className="text-lg font-black">What to watch</h2>
            {debrief.watch.length ? <ul className="mt-3 list-inside list-disc space-y-3 text-sm leading-relaxed text-body">{debrief.watch.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="mt-3 text-sm text-muted">No repeated patterns were recorded this time.</p>}
          </section>
          <section className="panel lg:col-span-3">
            <h2 className="flex items-center gap-2 text-lg font-black"><Sparkles className="text-violet-ink" size={21} />Your sentences, sharpened</h2>
            {debrief.corrections.length ? <ol className="mt-3 divide-y divide-line">{debrief.corrections.map((correction, i) => (
              <li key={i} className="flex items-start gap-3 py-4 text-sm leading-relaxed">
                <span className="rounded-lg bg-line px-2 py-1 text-xs font-black text-muted">{i + 1}</span>
                <div className="min-w-0 break-words">
                  <p className="font-bold"><span className="text-coral-ink line-through">{correction.quote}</span><span className="mx-2" aria-hidden="true">→</span><span className="text-teal-ink">{correction.better}</span></p>
                  <p className="mt-2 text-muted">{correction.en}</p>
                  {profile.chinese && <p lang="zh" className="mt-2 font-semibold text-violet-ink">{correction.zh}</p>}
                </div>
              </li>
            ))}</ol> : <p className="mt-4 text-sm text-muted">No corrections were recorded. Your next conversation is another chance to practise.</p>}
          </section>
        </div>
      )}
    </Shell>
  );
}
