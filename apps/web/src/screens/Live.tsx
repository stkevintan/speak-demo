import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, Check, Heart, Keyboard, Mic, MicOff, Send, Sparkles, Square, Volume2, Zap } from "lucide-react";
import { MAX_TYPED_TEXT_LENGTH, type Profile } from "@rehearsal/contracts";
import { useFinishSession, useSaveProfile } from "../api/hooks";
import { Avatar, Pip } from "../components/Artwork";
import { Settings } from "../components/Settings";
import { BackToScenes, Busy, Problem, Shell, Switch, accents, errorMessage } from "../components/ui";
import { LiveSession } from "../session/livekit";
import { useSessionStore } from "../session/store";
import { turnPresentation } from "../session/turnState";

export function Live({ profile }: { profile: Profile }) {
  const { sessionId = "" } = useParams();
  const state = useSessionStore();
  const active = state.active?.grant.sessionId === sessionId ? state.active : null;
  const live = useRef<LiveSession | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigate = useNavigate();
  const finish = useFinishSession();
  const save = useSaveProfile();
  const [ending, setEnding] = useState(false);
  const endLock = useRef(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [preferencePending, setPreferencePending] = useState(false);
  const preferenceLock = useRef(false);
  const sendLock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const coachPanel = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followReleaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    clearTimeout(releaseTimer.current);
    if (!active) return;
    // Deferring connection avoids a throwaway Strict Mode effect joining a room.
    const timer = setTimeout(() => {
      const controller = new LiveSession(active.grant);
      live.current = controller;
      void controller.connect();
    }, 0);
    return () => {
      clearTimeout(timer);
      live.current?.dispose();
      live.current = null;
      releaseTimer.current = setTimeout(() => {
        if (useSessionStore.getState().active?.grant.sessionId === sessionId) useSessionStore.getState().reset();
      }, 0);
    };
  }, [active, sessionId]);

  useEffect(() => {
    if (state.snapshot.state === "ended" && active && !ending) {
      navigate(`/sessions/${encodeURIComponent(sessionId)}/debrief`, { replace: true });
    }
  }, [state.snapshot.state, active, ending, navigate, sessionId]);

  useEffect(() => {
    if (!following) return;
    const frame = requestAnimationFrame(() => {
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [following, state.snapshot.transcript]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      coachPanel.current?.scrollTo({ top: coachPanel.current.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.snapshot.cards.length, Boolean(state.snapshot.suggestions)]);

  useEffect(() => () => clearTimeout(followReleaseTimer.current), []);

  const end = async () => {
    if (endLock.current) return;
    endLock.current = true;
    setEnding(true);
    live.current?.stopMedia();
    try {
      await finish.mutateAsync({ id: sessionId });
      navigate(`/sessions/${encodeURIComponent(sessionId)}/debrief`, { replace: true });
    } catch {
      setEnding(false);
    } finally { endLock.current = false; }
  };

  const run = async (action: () => Promise<void>) => {
    setActionError(null);
    try { await action(); } catch (error) { setActionError(errorMessage(error)); }
  };

  const sendText = async (text: string) => {
    const value = text.trim();
    if (sendLock.current || !value || !live.current) return;
    sendLock.current = true;
    setSending(true);
    setActionError(null);
    try {
      await live.current.command({ type: "learner.text", payload: { text: value } });
      setDraft("");
    } catch (error) { setActionError(errorMessage(error)); }
    finally { sendLock.current = false; setSending(false); }
  };

  const send = async () => { await sendText(draft); };

  /**
   * Tapping a suggested reply is both a reply and the one progress signal the
   * learner gives on purpose, so the tap travels before the text: if the reply
   * itself fails to send, the suggestion they took still counted.
   */
  const adopt = async (option: string, optionIndex: number) => {
    const controller = live.current;
    if (!controller || sendLock.current) return;
    try { await controller.command({ type: "suggestions.adopted", payload: { optionIndex } }); }
    catch { /* Best effort — the reply the learner chose matters more than the count. */ }
    await sendText(option);
  };

  const setSuggestions = async (suggestions: boolean) => {
    const controller = live.current;
    if (!controller || preferenceLock.current) return;
    preferenceLock.current = true;
    setPreferencePending(true);
    await run(async () => {
      await controller.command({ type: "preferences.update", payload: { suggestions } });
      useSessionStore.setState(s => ({
        snapshot: { ...s.snapshot, preferences: { suggestions }, suggestions: suggestions ? s.snapshot.suggestions : null },
      }));
      await save.mutateAsync({ data: { suggestions } });
    });
    preferenceLock.current = false;
    setPreferencePending(false);
  };

  if (!active) return (
    <Shell>
      <section className="panel mx-auto mt-10 max-w-2xl">
        <h1 className="heading">Let's pick up your feedback</h1>
        <p className="my-5 leading-relaxed text-body">This page no longer has the room connection. Your session can still be finished safely, without losing the feedback already recorded.</p>
        {finish.error && <Problem message={errorMessage(finish.error)} />}
        <div className="flex flex-wrap gap-3">
          <button className="button button-primary" disabled={finish.isPending} onClick={() => { void end(); }}>{finish.isPending ? "Finishing..." : "Finish and get feedback"}</button>
          <Link className="button button-secondary" to={`/sessions/${encodeURIComponent(sessionId)}/debrief`}>View saved feedback</Link>
          <BackToScenes />
        </div>
      </section>
    </Shell>
  );
  const { course, level } = active;
  const colour = accents[course.accent];
  const presentation = turnPresentation(state.snapshot.state, state.connection, state.mode, state.mic, course.counterpart.name);
  const tone = accents[presentation.tone];
  const available = state.connection === "connected" && !ending && state.snapshot.state !== "ended";
  const suggestions = state.snapshot.preferences.suggestions ? state.snapshot.suggestions : null;
  const transcriptTurns = state.snapshot.transcript;
  return (
    <Shell scrollable={false} header={<><span className="pill hidden sm:inline-flex">{course.title}</span><span className="pill">{level}</span><Settings profile={profile} live /></>}>
      {state.problem && <Problem message={state.problem} />}
      {actionError && <Problem message={actionError} />}
      {finish.error && <Problem message={errorMessage(finish.error)} retry={() => { void end(); }} />}
      {state.micIssue && <section role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-[24px] border border-sun bg-sun-soft p-5">
        <MicOff size={24} className="shrink-0 text-sun-ink" />
        <div className="min-w-0 flex-1"><h2 className="font-black">We can't hear you.</h2><p className="mt-1 text-sm text-body">{state.micIssue}</p></div>
        <button className="button button-primary" disabled={!available} onClick={() => { void live.current?.setMic(true); }}>Fix my mic</button>
        <button className="button button-secondary" onClick={() => {
          void live.current?.typeInstead();
          useSessionStore.setState({ micIssue: null });
        }}>Keep typing</button>
      </section>}
      {state.audioBlocked && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-sun-soft p-4">
          <Volume2 size={20} /><p className="flex-1 text-sm font-bold">Tap to allow character audio. The transcript is always available.</p>
          <button className="button button-secondary" onClick={() => { void live.current?.startAudio(); }}>Enable audio</button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 items-stretch gap-3 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(260px,32%)] xl:gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[32px] bg-gradient-to-br from-white via-[#fbf7ff] to-[#fff6f1] p-5 shadow-card sm:p-7">
            <header className="flex flex-wrap items-center gap-4 border-b-2 border-line pb-5">
              <div className="rounded-full bg-white p-2 ring-4 ring-violet-soft"><Avatar {...course.avatar} accent={colour.fill} size={80} /></div>
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-black tracking-tight">{course.counterpart.name}</h1>
                <p className="text-sm font-bold text-muted">{course.counterpart.role}</p>
                <span role="status" className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-extrabold" style={{ background: tone.soft, color: tone.ink }}>
                  <span className="size-2 rounded-full" style={{ background: tone.ink }} />{ending ? "Finishing your scene..." : presentation.label}
                </span>
              </div>
              <div aria-hidden="true" className="hidden h-12 items-center gap-1 sm:flex">
                {[12, 26, 18, 36, 24, 42, 22, 32, 16, 28].map((height, index) => <span key={index} className={`w-1 rounded-full ${presentation.moving ? "wave-bar" : ""}`} style={{ height, background: tone.fill, animationDelay: `${index * 0.08}s` }} />)}
              </div>
            </header>
            <p className="my-4 text-xs font-semibold text-muted"><strong className="text-body">Your goal:</strong> {course.goal}</p>
            <div ref={transcript} role="log" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 pr-2" onScroll={e => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
              setFollowing(atBottom);
              if (atBottom) clearTimeout(followReleaseTimer.current);
              if (!atBottom) {
                clearTimeout(followReleaseTimer.current);
                followReleaseTimer.current = setTimeout(() => {
                  setFollowing(true);
                  if (transcript.current) transcript.current.scrollTo({ top: transcript.current.scrollHeight, behavior: "smooth" });
                }, 1500);
              }
            }}>
              <div className="flex min-h-full flex-col gap-3">
              {state.connection !== "connected" && state.snapshot.transcript.length === 0 && <div className="my-auto rounded-2xl bg-white p-5 text-sm font-semibold text-muted">Connecting you to the character...</div>}
              {transcriptTurns.map(turn => (
                <div key={turn.turnId} className={`max-w-[92%] break-words rounded-[22px] px-4 py-3 text-sm font-semibold leading-relaxed sm:max-w-[80%] ${turn.role === "character" ? "self-start rounded-bl-lg bg-white shadow-sm" : turn.source === "typed" ? "self-end rounded-br-lg border-2 border-violet-soft bg-white" : "self-end rounded-br-lg bg-violet-deep text-white"}`}>
                  <span className={`mb-1 block text-[10px] font-black uppercase tracking-wide ${turn.role === "learner" && turn.source === "asr" ? "text-white" : "text-muted"}`}>{turn.role === "character" ? course.counterpart.name : turn.source === "typed" ? "You - typed" : "You"}</span>
                  {turn.text}
                </div>
              ))}
              </div>
            </div>
            {!following && <button className="button mt-2 self-center bg-violet-soft text-violet-ink" onClick={() => {
              setFollowing(true);
              requestAnimationFrame(() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; });
            }}><ArrowDown size={16} />Latest messages</button>}
          </section>

          <div className="mt-4 shrink-0 rounded-[26px] bg-white p-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-card sm:p-4">
            {state.mode === "typing" && <form className="mb-3 flex items-end gap-2 rounded-2xl border-2 border-violet p-2" onSubmit={e => { e.preventDefault(); void send(); }}>
              <label className="sr-only" htmlFor="learner-text">Your reply</label>
              <textarea ref={composer} id="learner-text" className="max-h-40 min-h-12 flex-1 resize-y rounded-xl p-2 text-sm outline-offset-0" rows={2} maxLength={MAX_TYPED_TEXT_LENGTH} placeholder="Write your reply..." value={draft} disabled={sending || !available} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
              }} />
              <button type="submit" aria-label="Send reply" className="icon-button bg-violet-deep text-white" disabled={!draft.trim() || sending || !available}><Send size={19} /></button>
            </form>}
            <div className="flex flex-wrap items-center gap-2">
              <button className={`icon-button ${state.mic ? "bg-teal-soft text-teal-ink" : ""}`} disabled={!available} aria-label={state.mic ? "Mute microphone" : "Fix my mic or switch to voice"} aria-pressed={state.mic} onClick={() => { void live.current?.setMic(!state.mic); }}>{state.mic ? <Mic size={21} /> : <MicOff size={21} />}</button>
              <button className={`icon-button ${state.mode === "typing" ? "bg-violet-soft text-violet-ink" : ""}`} disabled={!available} aria-label="Type instead" aria-pressed={state.mode === "typing"} onClick={() => { void live.current?.typeInstead(); }}><Keyboard size={21} /></button>
              {state.snapshot.learnerTurn?.canCommit && state.mode === "voice" && state.mic && state.snapshot.state === "listening" && <button className="button bg-teal-soft text-teal-ink" disabled={!available} onClick={() => {
                const turn = state.snapshot.learnerTurn;
                const controller = live.current;
                if (turn && controller) void run(() => controller.command({ type: "learner.commit", payload: { turnId: turn.turnId } }));
              }}><Check size={17} />I'm done</button>}
              <button className="button button-primary ml-auto" disabled={ending} onClick={() => { void end(); }}><Square size={16} />{ending ? "Finishing..." : "End scene"}</button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>{state.mode === "typing" ? "Enter to send. Shift + Enter for a new line." : "Audio is processed live. Feedback and patterns are saved."}</span>
              <button className="min-h-11 font-bold underline underline-offset-4" disabled={!available} onClick={() => live.current?.sync()}>Sync conversation</button>
            </div>
          </div>
          {ending && <Busy>Saving your feedback...</Busy>}
        </div>
        <aside aria-label="Quiet coach" className="min-w-0 overflow-hidden rounded-[32px] bg-white shadow-card flex flex-col">
          <header className="flex items-center gap-3 border-b-2 border-line px-5 py-4"><Pip size={60} mood={presentation.mood} /><div className="min-w-0"><h2 className="text-xl font-black">Coach</h2><Switch label="Suggestions" checked={state.snapshot.preferences.suggestions} disabled={!available || preferencePending} onChange={value => { void setSuggestions(value); }} /></div></header>
          <div ref={coachPanel} className="flex flex-col gap-4 p-4 sm:p-5 xl:max-h-[72dvh] overflow-y-auto">
            {state.snapshot.cards.length === 0 && <p className="rounded-2xl bg-teal-soft/40 p-4 text-sm leading-relaxed text-body">Stay in the scene. Your coach will leave a little encouragement and a sharper way to say things here.</p>}
            {state.snapshot.cards.map(card => <article key={card.findingId} className={`rounded-[22px] border-l-[5px] p-4 shadow-sm ${card.kind === "nice" ? "border-teal bg-teal-soft/25" : "border-sun bg-sun-soft/30"}`}>
              <h3 className={`flex items-center gap-2 text-xs font-black uppercase tracking-wide ${card.kind === "nice" ? "text-teal-ink" : "text-sun-ink"}`}>{card.kind === "nice" ? <Heart size={16} /> : <Zap size={16} />}{card.kind === "nice" ? "Nice" : "Upgrade this"}</h3>
              <p className="mt-3 break-words text-sm font-bold">{card.better ? <><span className="text-coral-ink line-through">{card.quote}</span><span className="mt-1 block text-teal-ink">{card.better}</span></> : card.quote}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.en}</p>
              {profile.chinese && <p lang="zh" className="mt-3 border-t border-dashed border-violet-soft pt-3 text-sm font-semibold leading-relaxed text-violet-ink">{card.zh}</p>}
            </article>)}
            {suggestions && <section className="rounded-[22px] border-l-[5px] border-violet bg-violet-soft/40 p-4">
              <h3 className="flex items-center gap-2 text-xs font-black uppercase text-violet-ink"><Sparkles size={16} />Try a reply</h3>
              <p className="mt-2 text-sm font-semibold text-body">{suggestions.prompt}</p>
              {suggestions.options.map((option, i) => <button key={i} disabled={!available || sending} className="mt-2 block min-h-11 w-full rounded-xl bg-white p-3 text-left text-sm font-bold leading-relaxed text-body disabled:opacity-60" onClick={() => { void adopt(option, i); }}>{option}</button>)}
              <p className="mt-3 text-xs text-muted">Tap a reply to send it, or say it your own way.</p>
            </section>}
          </div>
        </aside>
      </div>
    </Shell>
  );
}
