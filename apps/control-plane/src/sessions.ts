import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { CloseAck, SessionStart, type EndReason } from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "./config.js";
import { CourseService } from "./catalog.js";
import { ProfileService, MemoryService } from "./memory.js";
import { CourseRepo, LiveSessionStore, SessionRepo, type LiveRead, type StoredSession } from "./storage/ports.js";
import { RoomGateway } from "./livekit.js";
import { apiError, unavailable } from "./errors.js";
import { buildDebrief } from "./debrief.js";

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(
    @Inject(SessionRepo) private readonly sessions: SessionRepo,
    @Inject(LiveSessionStore) private readonly live: LiveSessionStore,
    @Inject(RoomGateway) private readonly rooms: RoomGateway,
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(CourseService) private readonly courses: CourseService,
    @Inject(CourseRepo) private readonly catalog: CourseRepo,
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => this.logger.error("Recovery sweep unavailable; will retry"));
    }, this.config.SESSION_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async start(userId: string, courseId: string) {
    const course = await this.courses.get(courseId);
    const profile = await this.profiles.get(userId);
    const id = randomUUID();
    const session: StoredSession = {
      id, userId, roomName: `rehearsal-${id}`, course, profile,
      status: "starting", startedAt: Date.now(), cleanupNeeded: true,
    };
    try {
      await this.sessions.create(session);
      await this.live.initialize({
        v: 1, sessionId: id, userId, roomName: session.roomName,
        learnerIdentity: `learner-${id}`, course,
        profile: { level: profile.level, chinese: profile.chinese, suggestions: profile.suggestions },
        recalled: profile.patterns,
      });
      await this.rooms.create(session.roomName, id);
      const token = await this.rooms.token(session.roomName, `learner-${id}`);
      await this.sessions.setStatus(id, "live");
      return SessionStart.parse({
        sessionId: id, livekit: { url: this.config.LIVEKIT_URL, token }, recalled: profile.patterns,
      });
    } catch {
      this.logger.error(`Session start failed: ${id}`);
      try {
        const stored = await this.sessions.get(id);
        if (stored) {
          await this.sessions.setStatus(id, "failed");
          await this.cleanup(stored);
        }
      } catch { this.logger.error(`Session start compensation deferred: ${id}`); }
      throw unavailable();
    }
  }

  private async owned(userId: string, id: string) {
    const session = await this.sessions.get(id);
    if (!session || session.userId !== userId || session.status === "failed") {
      throw apiError(404, "not_found", "That session was not found.");
    }
    return session;
  }
  async debrief(userId: string, id: string) {
    await this.owned(userId, id);
    const debrief = await this.sessions.debrief(id);
    if (!debrief) throw apiError(409, "debrief_pending", "Your debrief is not ready yet.");
    return debrief;
  }
  async end(userId: string, id: string) {
    const session = await this.owned(userId, id);
    const existing = await this.sessions.debrief(id);
    if (existing) return existing;
    try {
      await this.sessions.setStatus(id, "closing");
      await this.closeRequest(id, "user");
      const deadline = Date.now() + this.config.SESSION_CLOSE_TIMEOUT_MS;
      do {
        const result = await this.finalize(session);
        if (result) return result;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);
      this.logger.warn(`Close acknowledgement pending: ${id}`);
      throw unavailable();
    } catch {
      try {
        const completed = await this.sessions.debrief(id);
        if (completed) return completed;
      } catch { this.logger.error(`Debrief persistence unavailable: ${id}`); }
      this.logger.error(`Session finalization deferred: ${id}`);
      throw unavailable();
    }
  }
  private closeRequest(id: string, reason: EndReason) {
    return this.live.requestClose({ v: 1, sessionId: id, commandId: randomUUID(), reason });
  }

  private validateAck(session: StoredSession, state: LiveRead, input: CloseAck): CloseAck {
    const ack = CloseAck.parse(input);
    const request = state.closeRequest;
    const checkpoint = state.checkpoint;
    if (!request || !checkpoint || ack.sessionId !== session.id
      || ack.record.courseId !== session.course.id || ack.commandId !== request.commandId
      || ack.record.endReason !== request.reason || ack.workerId !== checkpoint.workerId
      || ack.epoch !== checkpoint.epoch || ack.finalSeq !== checkpoint.seq) {
      throw new Error("Close acknowledgement does not match the frozen session");
    }
    return ack;
  }
  private async finalize(session: StoredSession) {
    const existing = await this.sessions.debrief(session.id);
    if (existing) return existing;
    let state = await this.live.read(session.id);
    if (!state.closeRequest) return undefined;
    if (!state.ack && state.lease) return undefined;
    if (!state.ack) {
      const recovered = await this.live.recover(session.id, session.course.id);
      if (!recovered) return undefined;
      state = await this.live.read(session.id);
    }
    if (!state.ack) return undefined;
    const ack = this.validateAck(session, state, state.ack);
    const { debrief, deltas } = buildDebrief(ack.record, session.course, session.profile, await this.catalog.listCourses());
    const stored = await this.sessions.complete(session.id, debrief, deltas, ack.record.endReason);
    await this.memory.recordPending();
    await this.cleanup(session);
    return stored;
  }
  private async cleanup(session: StoredSession) {
    try {
      // Removing the room before Redis state prevents a still-connected writer
      // from publishing into an already-cleaned session.
      await this.rooms.remove(session.roomName);
      await this.live.cleanup(session.id);
      await this.sessions.cleaned(session.id);
    } catch { this.logger.warn(`Session cleanup pending: ${session.id}`); }
  }
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const session of await this.sessions.pending()) {
        try {
          if (session.status === "ended" || session.status === "failed") {
            await this.cleanup(session);
            continue;
          }
          const state = await this.live.read(session.id);
          if (!state.closeRequest) {
            if (state.lease || Date.now() - session.startedAt < this.config.SESSION_START_GRACE_MS) continue;
            await this.closeRequest(session.id, state.checkpoint?.snapshot.endReason ?? "network");
          }
          await this.sessions.setStatus(session.id, "closing");
          await this.finalize(session);
        } catch { this.logger.error(`Session recovery deferred: ${session.id}`); }
      }
      await this.memory.recordPending();
    } finally { this.sweeping = false; }
  }
}
