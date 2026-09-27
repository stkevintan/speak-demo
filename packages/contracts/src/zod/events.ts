import { z } from "zod";
import { CoachCard, Role, State } from "./session.js";

/**
 * The LiveKit data-channel surface — `ARCHITECTURE.md` §6.3.
 *
 * Every message is `{ type, payload }`, validated with zod on **both** ends so a
 * worker and a browser that disagree fail loudly at the seam instead of quietly
 * rendering nonsense.
 */

export const AgentState = z.object({
  type: z.literal("agent.state"),
  payload: z.object({
    /**
     * Typed as the full `State` so there is only ever one state enum. In
     * practice the worker emits the three live values — `idle` is the browser's
     * own pre-connect state, and `ended` is delivered by the debrief.
     */
    state: State,
  }),
});

export const TranscriptFinal = z.object({
  type: z.literal("transcript.final"),
  payload: z.object({
    role: Role,
    text: z.string().min(1),
    tStart: z.number().int().nonnegative(),
    tEnd: z.number().int().nonnegative(),
  }),
});

/**
 * The **only** channel that carries a correction (§6.3). Nothing else in the
 * system can produce one, which is why the character cannot lecture even by
 * accident — the ban is a property of the wiring, not a prompt instruction a
 * model might ignore.
 */
export const CoachCardEvent = z.object({
  type: z.literal("coach.card"),
  payload: CoachCard,
});

export const Suggestions = z.object({
  type: z.literal("suggestions"),
  payload: z.object({
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
  }),
});

export const Alert = z.object({
  type: z.literal("alert"),
  payload: z.object({
    code: z.literal("mic_unavailable"),
    /** Plain language, and always paired with a next action (§8). */
    message: z.string().min(1),
  }),
});

export const SessionEnd = z.object({
  type: z.literal("session.end"),
  payload: z.object({ reason: z.literal("user") }),
});

export const RealtimeEvent = z.discriminatedUnion("type", [
  AgentState,
  TranscriptFinal,
  CoachCardEvent,
  Suggestions,
  Alert,
  SessionEnd,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/** Direction of travel, so a handler can reject a message sent the wrong way. */
export const EVENT_DIRECTION = {
  "agent.state": "worker->web",
  "transcript.final": "worker->web",
  "coach.card": "worker->web",
  suggestions: "worker->web",
  alert: "worker->web",
  "session.end": "web->worker",
} as const satisfies Record<RealtimeEvent["type"], "worker->web" | "web->worker">;

/** Per-event schemas, for emitting one JSON Schema file each and for the wire decoder. */
export const REALTIME_EVENTS = {
  "agent.state": AgentState,
  "transcript.final": TranscriptFinal,
  "coach.card": CoachCardEvent,
  suggestions: Suggestions,
  alert: Alert,
  "session.end": SessionEnd,
} as const;
