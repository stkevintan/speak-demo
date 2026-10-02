import { z } from "zod";
import { CoachCard, EndReason, State, Turn } from "./session.js";
import { ApiErrorBody, SessionId } from "./http.js";

export const PROTOCOL_VERSION = 1;
export const REALTIME_TOPIC = "rehearsal.v1";
export const MAX_REPLAY_EVENTS = 256;
export const MAX_TYPED_TEXT_LENGTH = 4000;

const Id = z.string().min(1);
const Sequence = z.number().int().nonnegative();
const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  sessionId: SessionId,
  id: Id,
};
const command = { ...envelope, seq: z.literal(0) };
const event = { ...envelope, seq: Sequence.min(1) };

export const TranscriptEntry = z.strictObject({
  ...Turn.shape,
  turnId: Id,
  source: z.enum(["asr", "typed", "character"]),
}).superRefine((turn, ctx) => {
  if (turn.tEnd < turn.tStart) {
    ctx.addIssue({ code: "custom", path: ["tEnd"], message: "tEnd must not precede tStart" });
  }
  if ((turn.role === "character") !== (turn.source === "character")) {
    ctx.addIssue({ code: "custom", path: ["source"], message: "source must match role" });
  }
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

export const IdentifiedCoachCard = z.strictObject({
  ...CoachCard.shape,
  findingId: Id,
  turnId: Id,
});
export type IdentifiedCoachCard = z.infer<typeof IdentifiedCoachCard>;

export const SuggestionPayload = z.strictObject({
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
});

export const LearnerTurnPayload = z.strictObject({
  turnId: Id,
  canCommit: z.boolean(),
});

export const AgentState = z.strictObject({
  ...event,
  type: z.literal("agent.state"),
  payload: z.strictObject({ state: z.enum(["listening", "thinking", "speaking"]) }),
});

export const TranscriptFinal = z.strictObject({
  ...event,
  type: z.literal("transcript.final"),
  payload: TranscriptEntry,
});

export const CoachCardEvent = z.strictObject({
  ...event,
  type: z.literal("coach.card"),
  payload: IdentifiedCoachCard,
});

export const Suggestions = z.strictObject({
  ...event,
  type: z.literal("suggestions"),
  payload: SuggestionPayload,
});

export const Alert = z.strictObject({
  ...event,
  type: z.literal("alert"),
  payload: ApiErrorBody,
});

export const LearnerTurn = z.strictObject({
  ...event,
  type: z.literal("learner.turn"),
  payload: LearnerTurnPayload,
});

export const CommandAck = z.strictObject({
  ...event,
  type: z.literal("command.ack"),
  payload: z.discriminatedUnion("status", [
    z.strictObject({ commandId: Id, status: z.literal("accepted") }),
    z.strictObject({ commandId: Id, status: z.literal("rejected"), code: z.string().min(1) }),
  ]),
});

export const SessionEnded = z.strictObject({
  ...event,
  type: z.literal("session.ended"),
  payload: z.strictObject({ reason: EndReason }),
});

export const LearnerCommit = z.strictObject({
  ...command,
  type: z.literal("learner.commit"),
  payload: z.strictObject({ turnId: Id }),
});

export const LearnerText = z.strictObject({
  ...command,
  type: z.literal("learner.text"),
  payload: z.strictObject({ text: z.string().trim().min(1).max(MAX_TYPED_TEXT_LENGTH) }),
});

export const LearnerInterrupt = z.strictObject({
  ...command,
  type: z.literal("learner.interrupt"),
  payload: z.strictObject({}),
});

/**
 * The learner tapped one of the replies `suggestions` offered (§6.3).
 *
 * Only the index travels. Which offer a tap answers is decided by the worker
 * from its own `snapshot.suggestions`, because the worker is the component that
 * owns that state: an id echoed back by the browser would be a second,
 * unverifiable source of truth, and the offer can already have been replaced by
 * the time a retried command lands. What makes a retry safe is the stable
 * command `id`, which the worker deduplicates before it counts anything.
 */
export const SuggestionsAdopted = z.strictObject({
  ...command,
  type: z.literal("suggestions.adopted"),
  payload: z.strictObject({
    optionIndex: z.number().int().nonnegative(),
  }),
});

export const PreferencesUpdate = z.strictObject({
  ...command,
  type: z.literal("preferences.update"),
  payload: z.strictObject({ suggestions: z.boolean() }),
});

export const SessionSync = z.strictObject({
  ...command,
  type: z.literal("session.sync"),
  payload: z.strictObject({ afterSeq: Sequence }),
});

export const SessionEnd = z.strictObject({
  ...command,
  type: z.literal("session.end"),
  payload: z.strictObject({ reason: z.literal("user") }),
});

export const ClientCommand = z.discriminatedUnion("type", [
  LearnerCommit, LearnerText, LearnerInterrupt, SuggestionsAdopted, PreferencesUpdate, SessionSync,
  SessionEnd,
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

export const DurableServerEvent = z.discriminatedUnion("type", [
  AgentState, TranscriptFinal, CoachCardEvent, Suggestions, Alert,
  LearnerTurn, CommandAck, SessionEnded,
]);
export type DurableServerEvent = z.infer<typeof DurableServerEvent>;

export const SessionSnapshot = z.strictObject({
  state: State,
  learnerTurn: LearnerTurnPayload.nullable(),
  transcript: z.array(TranscriptEntry),
  cards: z.array(IdentifiedCoachCard),
  suggestions: SuggestionPayload.nullable(),
  preferences: z.strictObject({ suggestions: z.boolean() }),
  endReason: EndReason.nullable(),
}).refine((snapshot) => (snapshot.state === "ended") === (snapshot.endReason !== null), {
  message: "ended state and endReason must agree",
  path: ["endReason"],
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

// Replay is a transport response, not a durable event: seq is the snapshot high-watermark.
export const SessionReplay = z.strictObject({
  ...envelope,
  seq: Sequence,
  type: z.literal("session.replay"),
  payload: z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("events"),
      commandId: Id,
      afterSeq: Sequence,
      events: z.array(DurableServerEvent).max(MAX_REPLAY_EVENTS),
    }),
    z.strictObject({
      mode: z.literal("snapshot"),
      commandId: Id,
      snapshot: SessionSnapshot,
    }),
  ]),
}).superRefine((replay, ctx) => {
  if (replay.payload.mode !== "events") return;
  let previous = replay.payload.afterSeq;
  const seen = new Set<string>();
  for (const [index, entry] of replay.payload.events.entries()) {
    if (entry.sessionId !== replay.sessionId || entry.seq !== previous + 1 || seen.has(entry.id)) {
      ctx.addIssue({
        code: "custom", path: ["payload", "events", index],
        message: "replay must contain consecutive, uniquely identified events for this session",
      });
    }
    seen.add(entry.id);
    previous = entry.seq;
  }
  if (previous !== replay.seq) {
    ctx.addIssue({ code: "custom", path: ["seq"], message: "replay must reach its high-watermark" });
  }
});
export type SessionReplay = z.infer<typeof SessionReplay>;

export const ServerEvent = z.union([DurableServerEvent, SessionReplay]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export const RealtimeEvent = z.union([ClientCommand, ServerEvent]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

export const EVENT_DIRECTION = {
  "agent.state": "worker->web",
  "transcript.final": "worker->web",
  "coach.card": "worker->web",
  suggestions: "worker->web",
  alert: "worker->web",
  "learner.turn": "worker->web",
  "command.ack": "worker->web",
  "session.ended": "worker->web",
  "session.replay": "worker->web",
  "learner.commit": "web->worker",
  "learner.text": "web->worker",
  "learner.interrupt": "web->worker",
  "suggestions.adopted": "web->worker",
  "preferences.update": "web->worker",
  "session.sync": "web->worker",
  "session.end": "web->worker",
} as const satisfies Record<RealtimeEvent["type"], "worker->web" | "web->worker">;

export const REALTIME_EVENTS = {
  "agent.state": AgentState,
  "transcript.final": TranscriptFinal,
  "coach.card": CoachCardEvent,
  suggestions: Suggestions,
  alert: Alert,
  "learner.turn": LearnerTurn,
  "command.ack": CommandAck,
  "session.ended": SessionEnded,
  "session.replay": SessionReplay,
  "learner.commit": LearnerCommit,
  "learner.text": LearnerText,
  "learner.interrupt": LearnerInterrupt,
  "suggestions.adopted": SuggestionsAdopted,
  "preferences.update": PreferencesUpdate,
  "session.sync": SessionSync,
  "session.end": SessionEnd,
} as const;
