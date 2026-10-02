import { z } from "zod";
import { Course } from "./course.js";
import { EndReason, Pattern, Profile, SessionRecord } from "./session.js";
import { IdentifiedCoachCard, PROTOCOL_VERSION, SessionSnapshot } from "./events.js";
import { SessionId } from "./http.js";

const Id = z.string().min(1);
const version = { v: z.literal(PROTOCOL_VERSION), sessionId: SessionId };

export const WorkerBootstrap = z.strictObject({
  ...version,
  userId: Id,
  roomName: Id,
  learnerIdentity: Id,
  course: Course,
  profile: Profile.pick({ level: true, chinese: true, suggestions: true }),
  recalled: z.array(Pattern),
});
export type WorkerBootstrap = z.infer<typeof WorkerBootstrap>;

export const WorkerLease = z.strictObject({
  ...version,
  workerId: Id,
  epoch: z.number().int().positive(),
  heartbeatAt: z.iso.datetime(),
});
export type WorkerLease = z.infer<typeof WorkerLease>;

export const CloseRequest = z.strictObject({
  ...version,
  commandId: Id,
  reason: EndReason,
});
export type CloseRequest = z.infer<typeof CloseRequest>;

export const CloseAck = z.strictObject({
  ...version,
  commandId: Id,
  workerId: Id,
  epoch: z.number().int().positive(),
  finalSeq: z.number().int().nonnegative(),
  record: SessionRecord,
}).refine((ack) => ack.sessionId === ack.record.sessionId, {
  message: "record belongs to a different session",
  path: ["record", "sessionId"],
});
export type CloseAck = z.infer<typeof CloseAck>;

export const WorkerCheckpoint = z.strictObject({
  ...version,
  workerId: Id,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  snapshot: SessionSnapshot,
  /** Complete explained findings, not the admitted/rate-limited UI subset. */
  findings: z.array(IdentifiedCoachCard),
  signal: SessionRecord.shape.signal,
  goalMet: z.boolean(),
  learnerTurns: z.number().int().nonnegative(),
  /**
   * On the checkpoint rather than only on `CloseAck` because a worker that dies
   * mid-scene is recovered *from the checkpoint* and the recovered record must
   * equal the one the worker would have sent (`agent-worker/src/store.ts`
   * `freeze()`). Counters kept anywhere else would make the two paths differ.
   *
   * Optional for a session that ended before this field existed; `CloseAck`
   * inherits the same optionality through `SessionRecord`.
   */
  metrics: SessionRecord.shape.metrics,
});
export type WorkerCheckpoint = z.infer<typeof WorkerCheckpoint>;

/** Keys share one Redis Cluster slot. Key usage and write ownership are in PROTOCOL.md. */
export function sessionKeys(sessionId: string) {
  const id = SessionId.parse(sessionId);
  if (/[{}]/u.test(id)) throw new Error("sessionId must not contain Redis hash-tag delimiters");
  const prefix = `rehearsal:{${id}}`;
  return {
    bootstrap: `${prefix}:bootstrap`,
    lease: `${prefix}:lease`,
    checkpoint: `${prefix}:checkpoint`,
    events: `${prefix}:events`,
    commands: `${prefix}:commands`,
    closeRequest: `${prefix}:close-request`,
    closeAck: `${prefix}:close-ack`,
  } as const;
}
