import type { CourseCard, DurableServerEvent, Profile, SessionSnapshot, SessionStart } from "@rehearsal/contracts";
import { create } from "zustand";

export type Connection = "connecting" | "connected" | "reconnecting" | "disconnected";

export function emptySnapshot(suggestions = true): SessionSnapshot {
  return {
    state: "idle", learnerTurn: null, transcript: [], cards: [],
    suggestions: null, preferences: { suggestions }, endReason: null,
  };
}

export function reduceEvent(snapshot: SessionSnapshot, event: DurableServerEvent): SessionSnapshot {
  if (snapshot.state === "ended") return snapshot;
  switch (event.type) {
    case "agent.state":
      return { ...snapshot, state: event.payload.state, suggestions: null,
        learnerTurn: event.payload.state === "listening" ? snapshot.learnerTurn : null };
    case "learner.turn": return { ...snapshot, learnerTurn: event.payload };
    case "transcript.final":
      return { ...snapshot, transcript: [...snapshot.transcript.filter(t => t.turnId !== event.payload.turnId), event.payload],
        suggestions: null };
    case "coach.card":
      return { ...snapshot, cards: [...snapshot.cards.filter(c => c.findingId !== event.payload.findingId), event.payload] };
    case "suggestions": return { ...snapshot, suggestions: event.payload };
    case "session.ended":
      return { ...snapshot, state: "ended", endReason: event.payload.reason, learnerTurn: null, suggestions: null };
    default: return snapshot;
  }
}

type SessionStore = {
  active: { grant: SessionStart; course: CourseCard; level: Profile["level"] } | null;
  snapshot: SessionSnapshot;
  connection: Connection;
  mode: "voice" | "typing";
  mic: boolean;
  micIssue: string | null;
  audioBlocked: boolean;
  problem: string | null;
  begin: (grant: SessionStart, course: CourseCard, profile: Profile) => void;
  reset: () => void;
};

export const useSessionStore = create<SessionStore>((set) => ({
  active: null, snapshot: emptySnapshot(), connection: "disconnected", mode: "voice",
  mic: false, micIssue: null, audioBlocked: false, problem: null,
  begin: (grant, course, profile) => set({
    active: { grant, course, level: profile.level },
    snapshot: emptySnapshot(profile.suggestions), connection: "connecting",
    mode: "voice", mic: false, micIssue: null, audioBlocked: false, problem: null,
  }),
  reset: () => set({
    active: null, snapshot: emptySnapshot(), connection: "disconnected", mode: "voice",
    mic: false, micIssue: null, audioBlocked: false, problem: null,
  }),
}));
