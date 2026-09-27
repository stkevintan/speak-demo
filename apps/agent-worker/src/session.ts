import { randomUUID } from "node:crypto";
import {
  CloseAck, DurableServerEvent, WorkerCheckpoint, type ClientCommand, type CloseRequest,
  type EndReason, type ServerEvent, type TranscriptEntry, type WorkerBootstrap, type WorkerLease,
} from "@rehearsal/contracts";
import { Coach } from "./coach.js";
import { convergence, type SceneOutcome } from "./character.js";
import { replay, type EventBody } from "./events.js";
import type { Log } from "./log.js";
import type { Store } from "./store.js";
import { TurnDetector, clock, type Timer } from "./turn-detector.js";

export interface VoicePort {
  setListening?(enabled: boolean): void;
  interrupt(): Promise<void>;
  finish(): Promise<void>;
  commit(): void;
  replyText(text: string, instructions?: string): void;
  say(text: string): void;
  reengage(): void;
}

export class Session {
  private current: WorkerCheckpoint;
  private tail: Promise<unknown> = Promise.resolve();
  private commandTail: Promise<unknown> = Promise.resolve();
  private coachTail: Promise<unknown> = Promise.resolve();
  private coachPending = 0;
  private readonly abortCoach = new AbortController();
  private ending = false;
  private frozen = false;
  private failed = false;
  private endPromise: Promise<void> | undefined;
  private readonly startedAt: number;
  private idleSince = 0;
  private offeredSuggestions = false;
  private reengaged = false;
  private suggesting = false;
  private ready = false;
  private readonly seenLearnerItems = new Set<string>();
  readonly detector: TurnDetector;
  generation = 0;

  constructor(
    readonly bootstrap: WorkerBootstrap,
    readonly lease: WorkerLease,
    private readonly store: Store,
    private readonly voice: VoicePort,
    private readonly coach: Coach,
    private readonly publish: (event: ServerEvent) => Promise<void>,
    private readonly log: Log,
    patienceMs: number,
    private readonly time: Timer = clock,
  ) {
    this.startedAt = time.now();
    this.current = WorkerCheckpoint.parse({
      v: 1, sessionId: bootstrap.sessionId, workerId: lease.workerId, epoch: lease.epoch, seq: 0,
      snapshot: { state: "idle", learnerTurn: null, transcript: [], cards: [], suggestions: null,
        preferences: { suggestions: bootstrap.profile.suggestions }, endReason: null },
      findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0,
    });
    this.detector = new TurnDetector(patienceMs, time, randomUUID, () => {
      void this.enqueue(async () => {
        if (this.ending) return;
        await this.emitTurn();
        await this.stateNow("thinking");
        this.voice.commit();
      });
    });
  }

  get checkpoint(): WorkerCheckpoint { return structuredClone(this.current); }
  get isEnding() { return this.ending; }
  get directive() {
    return convergence(this.current.goalMet, this.current.learnerTurns, this.bootstrap.course.budget?.learnerTurns ?? 12);
  }

  async initialize(): Promise<void> {
    const initial = await this.store.checkpoint();
    if (!initial) throw new Error("Missing control-plane checkpoint");
    if (initial.sessionId !== this.bootstrap.sessionId || initial.workerId !== "control-plane:init"
      || initial.seq !== 0 || initial.snapshot.state !== "idle" || initial.snapshot.transcript.length
      || initial.findings.length || initial.learnerTurns || initial.epoch >= this.lease.epoch) {
      throw new Error("Existing session requires control-plane recovery");
    }
    this.current = { ...initial, workerId: this.lease.workerId, epoch: this.lease.epoch };
    await this.store.write(this.current, 0);
  }

  async start(): Promise<void> {
    const startOpening = await this.enqueue(async () => {
      if (this.ending || this.ready) return false;
      this.ready = true;
      await this.stateNow("thinking");
      return true;
    });
    if (!startOpening || this.ending) return;
    this.voice.say(this.bootstrap.course.opener);
  }

  speechStart(): void {
    if (this.ending || !this.ready) return;
    this.generation++;
    this.detector.speechStart();
    this.resetIdle();
    // Manual SDK endpointing disables its default VAD interruption path.
    void this.voice.interrupt().catch(() => this.fail("voice.interrupt_failed"));
    void this.enqueue(async () => {
      if (this.ending) return;
      await this.stateNow("listening");
      await this.emitTurn();
    });
  }

  speechEnd(): void {
    if (!this.ending) this.detector.speechEnd();
  }

  async learner(text: string, itemId: string): Promise<string | undefined> {
    await this.enqueue(async () => {
      if (this.ending || this.seenLearnerItems.has(itemId)) return;
      this.seenLearnerItems.add(itemId);
      const pending = this.detector.complete();
      if (!text.trim()) {
        await this.alertNow("asr_empty", "I could not hear that. Try again or type your reply.");
        await this.stateNow("listening");
        return;
      }
      await this.appendLearner({
        role: "learner", source: "asr", text: text.trim(), turnId: pending.turnId,
        tStart: this.relative(pending.startedAt), tEnd: this.relative(this.time.now()),
      });
      await this.emitTurn();
    });
    return this.directive;
  }

  character(text: string, itemId: string, startedAt: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.frozen || this.failed || !text.trim()
        || this.current.snapshot.transcript.some((turn) => turn.turnId === itemId)) return;
      await this.emit({
        type: "transcript.final",
        payload: { role: "character", source: "character", text: text.trim(), turnId: itemId,
          tStart: this.relative(startedAt), tEnd: Math.max(this.relative(startedAt), this.relative(this.time.now())) },
      }, (next) => { next.snapshot.suggestions = null; });
    });
  }

  outcome(outcome: SceneOutcome, generation: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.ending || generation !== this.generation) return;
      await this.update((next) => { next.goalMet ||= outcome.goalMet; });
      if (outcome.closeScene && (this.current.goalMet || this.current.learnerTurns >= (this.bootstrap.course.budget?.learnerTurns ?? 12))) {
        void this.end(this.current.goalMet ? "goal" : "budget").catch(() => this.log("session.natural_close_failed"));
      }
    });
  }

  state(state: "listening" | "thinking" | "speaking"): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ending && this.ready) await this.stateNow(state);
    });
  }

  alert(code: string, message: string): Promise<void> {
    return this.enqueue(async () => { if (!this.ending) await this.alertNow(code, message); });
  }

  command(command: ClientCommand): Promise<void> {
    const result = this.commandTail.then(() => this.handleCommand(command));
    this.commandTail = result.catch(() => this.fail("command.operation_failed"));
    return result;
  }

  private async handleCommand(command: ClientCommand): Promise<void> {
    if (command.type === "learner.text") {
      let accepted = false;
      await this.enqueue(async () => {
        const prior = await this.store.acknowledgement(command.id);
        if (prior) { await this.deliver(prior); return; }
        if (this.frozen || this.ending) {
          await this.sendReplay(command.id, Number.MAX_SAFE_INTEGER);
          return;
        }
        if (!this.ready || this.detector.hasPending) {
          await this.ack(command.id, "not_committable");
          return;
        }
        await this.ack(command.id);
        this.generation++;
        accepted = true;
      });
      if (accepted) {
        // Let the SDK's played-prefix callback enter the event queue before the new learner turn.
        await this.voice.interrupt();
        await this.enqueue(async () => {
          if (this.ending) return;
          const now = this.relative(this.time.now());
          await this.appendLearner({ turnId: command.id, role: "learner", source: "typed",
            text: command.payload.text, tStart: now, tEnd: now });
          this.voice.replyText(command.payload.text, this.directive);
        });
      }
      return;
    }
    return this.enqueue(async () => {
      const previous = await this.store.acknowledgement(command.id);
      if (previous) {
        await this.deliver(previous);
        if (command.type === "session.sync") await this.sendReplay(command.id, command.payload.afterSeq);
        return;
      }
      if (command.type === "session.sync") {
        if (!this.frozen && !this.ending) await this.ack(command.id);
        await this.sendReplay(command.id, command.payload.afterSeq);
        return;
      }
      if (this.frozen || this.ending) {
        // Freeze forbids new durable acks; an ended replacement snapshot conveys the terminal state.
        await this.sendReplay(command.id, Number.MAX_SAFE_INTEGER);
        return;
      }
      switch (command.type) {
        case "learner.commit": {
          const result = this.detector.commit(command.payload.turnId);
          await this.ack(command.id, result === "accepted" ? undefined : result);
          return;
        }
        case "learner.interrupt":
          await this.ack(command.id);
          this.generation++;
          await this.voice.interrupt();
          await this.stateNow("listening");
          return;
        case "preferences.update":
          await this.emit({ type: "command.ack", payload: { commandId: command.id, status: "accepted" } },
            (next) => {
              next.snapshot.preferences.suggestions = command.payload.suggestions;
              if (!command.payload.suggestions) next.snapshot.suggestions = null;
            });
          this.offeredSuggestions = false;
          return;
        case "session.end":
          await this.ack(command.id);
          void this.end("user", command.id).catch(() => this.log("session.command_close_failed"));
      }
    });
  }

  async heartbeat(): Promise<void> {
    if (this.failed) throw new Error("Worker has failed; recovery required");
    if (this.frozen) return;
    try {
      await this.store.renew(this.lease);
      const close = await this.store.closeRequest();
      if (close) { await this.end(close.reason, close.commandId); return; }
      await this.idle();
    } catch {
      this.fail("worker.lease_or_storage_failed");
      throw new Error("Worker lease or storage unavailable");
    }
  }

  async idle(): Promise<void> {
    if (this.ending || !this.ready || this.current.snapshot.state !== "listening" || this.detector.hasPending) return;
    const elapsed = this.time.now() - this.idleSince;
    if (elapsed >= 200 && this.current.snapshot.preferences.suggestions && !this.offeredSuggestions && !this.suggesting) {
      this.offeredSuggestions = true;
      this.suggesting = true;
      const generation = this.generation;
      try {
        const payload = await this.coach.suggest(this.current.snapshot.transcript,
          AbortSignal.any([this.abortCoach.signal, AbortSignal.timeout(5000)]));
        await this.enqueue(async () => {
          if (!this.ending && generation === this.generation && this.current.snapshot.preferences.suggestions && !this.detector.hasPending) {
            await this.emit({ type: "suggestions", payload });
          }
        });
      } catch (error) {
        this.log("coach.suggestions_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      finally { this.suggesting = false; }
    }
    if (elapsed >= 30000 && !this.reengaged && !this.ending && !this.detector.hasPending && this.current.snapshot.state === "listening") {
      this.reengaged = true;
      await this.state("thinking");
      this.voice.reengage();
    }
  }

  end(reason: EndReason, commandId: string = randomUUID()): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.ending = true;
    this.voice.setListening?.(false);
    this.detector.reset();
    this.abortCoach.abort();
    this.generation++;
    this.endPromise = this.finish({ v: 1, sessionId: this.bootstrap.sessionId, commandId, reason });
    return this.endPromise;
  }

  private async finish(request: CloseRequest): Promise<void> {
    try {
      const canonical = await this.store.requestClose(request);
      await this.voice.interrupt();
      await this.voice.finish();
      await this.enqueue(async () => {
        if (this.failed) throw new Error("Cannot finalize failed storage");
        await this.emit({ type: "session.ended", payload: { reason: canonical.reason } });
        const { snapshot, findings, signal, goalMet, learnerTurns } = this.current;
        const ack = CloseAck.parse({
          v: 1, sessionId: this.bootstrap.sessionId, commandId: canonical.commandId,
          workerId: this.lease.workerId, epoch: this.lease.epoch, finalSeq: this.current.seq,
          record: {
            sessionId: this.bootstrap.sessionId, courseId: this.bootstrap.course.id,
            transcript: snapshot.transcript.map(({ role, text, tStart, tEnd }) => ({ role, text, tStart, tEnd })),
            findings: findings.map(({ findingId: _findingId, turnId: _turnId, ...card }) => card),
            signal, goalMet, learnerTurns, endReason: canonical.reason,
          },
        });
        await this.store.freeze(ack);
        this.frozen = true;
      });
    } catch {
      this.fail("session.finalization_failed");
      throw new Error("Session finalization failed; control-plane recovery required");
    }
  }

  private async appendLearner(turn: TranscriptEntry): Promise<void> {
    this.resetIdle();
    await this.emit({ type: "transcript.final", payload: turn }, (next) => {
      next.learnerTurns++;
      next.snapshot.learnerTurn = null;
      next.snapshot.suggestions = null;
    });
    await this.stateNow("thinking");
    this.queueCoach(turn);
  }

  private queueCoach(turn: TranscriptEntry): void {
    if (this.coachPending >= 8) { this.log("coach.queue_full", { turnId: turn.turnId }); return; }
    const transcript = structuredClone(this.current.snapshot.transcript);
    const turnNumber = this.current.learnerTurns;
    this.coachPending++;
    this.coachTail = this.coachTail.then(async () => {
      if (this.ending) return;
      try {
        const cards = await this.coach.observe(transcript, turn,
          AbortSignal.any([this.abortCoach.signal, AbortSignal.timeout(8000)]));
        await this.enqueue(async () => {
          if (this.ending) return;
          await this.update((next) => {
            next.findings.push(...cards);
            next.signal.nice += cards.filter((card) => card.kind === "nice").length;
            next.signal.total += cards.length;
          });
          for (const card of cards) {
            if (this.coach.admit(card, turnNumber)) await this.emit({ type: "coach.card", payload: card });
          }
        });
      } catch (error) {
        this.log(this.ending ? "coach.cancelled_on_end" : "coach.assessment_failed", {
          turnId: turn.turnId, error: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => { this.coachPending--; });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => { this.fail("session.operation_failed"); });
    return result;
  }

  private fail(code: string): void {
    this.failed = true;
    this.ending = true;
    this.voice.setListening?.(false);
    this.abortCoach.abort();
    this.detector.reset();
    this.log(code, { sessionId: this.bootstrap.sessionId });
    void this.voice.interrupt().catch(() => this.log("voice.cancel_failed"));
  }

  private async deliver(event: ServerEvent): Promise<void> {
    try { await this.publish(event); }
    catch { this.log("event.publish_failed", { sessionId: this.bootstrap.sessionId, seq: event.seq }); }
  }

  private async sendReplay(commandId: string, afterSeq: number): Promise<void> {
    await this.deliver(replay(this.current, await this.store.events(), commandId, afterSeq));
  }

  private async update(mutate: (next: WorkerCheckpoint) => void): Promise<void> {
    const next = structuredClone(this.current);
    mutate(next);
    await this.store.write(next, this.current.seq);
    this.current = next;
  }

  private async emit(body: EventBody, mutate?: (next: WorkerCheckpoint) => void): Promise<void> {
    const event = DurableServerEvent.parse({ v: 1, sessionId: this.bootstrap.sessionId,
      id: randomUUID(), seq: this.current.seq + 1, ...body });
    const next = structuredClone(this.current);
    next.seq = event.seq;
    mutate?.(next);
    switch (event.type) {
      case "agent.state": next.snapshot.state = event.payload.state; break;
      case "learner.turn": next.snapshot.learnerTurn = event.payload; break;
      case "transcript.final": next.snapshot.transcript.push(event.payload); break;
      case "coach.card": next.snapshot.cards.push(event.payload); break;
      case "suggestions": next.snapshot.suggestions = event.payload; break;
      case "session.ended":
        next.snapshot.state = "ended";
        next.snapshot.endReason = event.payload.reason;
        next.snapshot.learnerTurn = null;
        next.snapshot.suggestions = null;
        break;
    }
    await this.store.write(next, this.current.seq, event);
    this.current = next;
    await this.deliver(event);
  }

  private async emitTurn(): Promise<void> {
    const turn = this.detector.turn;
    if (turn) await this.emit({ type: "learner.turn", payload: turn });
  }
  private async stateNow(state: "listening" | "thinking" | "speaking"): Promise<void> {
    this.voice.setListening?.(state === "listening");
    if (this.current.snapshot.state === state) return;
    if (state === "listening") this.resetIdle();
    await this.emit({ type: "agent.state", payload: { state } });
  }
  private ack(commandId: string, code?: string): Promise<void> {
    return this.emit({ type: "command.ack", payload: code
      ? { commandId, status: "rejected", code } : { commandId, status: "accepted" } });
  }
  private alertNow(code: string, message: string): Promise<void> {
    return this.emit({ type: "alert", payload: { code, message } });
  }
  private relative(at: number) { return Math.max(0, Math.round(at - this.startedAt)); }
  private resetIdle() {
    this.idleSince = this.time.now();
    this.offeredSuggestions = false;
    this.reengaged = false;
  }
}
