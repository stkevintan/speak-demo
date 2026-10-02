import { z } from "zod";
import {
  AttemptRow, CloseAck, CloseRequest, Course, Debrief, EndReason, Pattern, Profile, ProfilePatch,
  SessionMetrics, WorkerBootstrap, WorkerCheckpoint, WorkerLease,
} from "@rehearsal/contracts";

export const StoredSession = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  roomName: z.string().min(1),
  course: Course,
  profile: Profile,
  status: z.enum(["starting", "live", "closing", "ended", "failed"]),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  endReason: EndReason.optional(),
  cleanupNeeded: z.boolean(),
});
export type StoredSession = z.infer<typeof StoredSession>;
export type PatternDelta = { category: string; count: number };

/**
 * What one attempt scored: the worker's `SessionMetrics` plus the turn count its
 * record also carries. `SessionMetrics` deliberately leaves turns out (§5.8) —
 * the record already has them — but the metrics row is the only durable home
 * they have once the session is over, and `AttemptRow` reads them from there.
 */
export const AttemptMetrics = SessionMetrics.extend({
  learnerTurns: z.number().int().nonnegative(),
});
export type AttemptMetrics = z.infer<typeof AttemptMetrics>;

export abstract class ProfileRepo {
  abstract getOrCreate(userId: string): Promise<Profile>;
  abstract patch(userId: string, patch: ProfilePatch): Promise<Profile>;
}
export abstract class CourseRepo {
  abstract replaceCatalog(courses: Course[]): Promise<void>;
  abstract listCourses(): Promise<Course[]>;
  abstract course(id: string): Promise<Course | undefined>;
}
export abstract class SessionRepo {
  abstract create(session: StoredSession): Promise<void>;
  abstract get(id: string): Promise<StoredSession | undefined>;
  abstract setStatus(id: string, status: StoredSession["status"]): Promise<void>;
  abstract pending(): Promise<StoredSession[]>;
  abstract debrief(id: string): Promise<Debrief | undefined>;
  abstract learnedCourses(userId: string): Promise<Set<string>>;
  abstract unlearnCourse(userId: string, courseId: string): Promise<void>;
  /** Every ended attempt of one learner, oldest first, with its metrics when it has any. */
  abstract attempts(userId: string): Promise<AttemptRow[]>;
  abstract complete(
    id: string, debrief: Debrief, deltas: PatternDelta[], reason: EndReason, metrics: AttemptMetrics,
  ): Promise<Debrief>;
  abstract cleaned(id: string): Promise<void>;
}
export abstract class PatternRepo {
  abstract recall(userId: string): Promise<Pattern[]>;
  abstract applyPending(): Promise<void>;
}

export interface LiveRead {
  checkpoint?: WorkerCheckpoint;
  lease?: WorkerLease;
  closeRequest?: CloseRequest;
  ack?: CloseAck;
}
export abstract class LiveSessionStore {
  abstract initialize(bootstrap: WorkerBootstrap): Promise<void>;
  abstract read(id: string): Promise<LiveRead>;
  abstract requestClose(request: CloseRequest): Promise<CloseRequest>;
  abstract recover(id: string, courseId: string): Promise<CloseAck | undefined>;
  abstract cleanup(id: string): Promise<void>;
}
