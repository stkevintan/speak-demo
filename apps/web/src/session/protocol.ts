import { ServerEvent, type DurableServerEvent, type SessionSnapshot } from "@rehearsal/contracts";

type Sink = {
  event: (event: DurableServerEvent) => void;
  snapshot: (snapshot: SessionSnapshot) => void;
  sync: (afterSeq: number) => string;
};

/** A cursor advances only after an event or complete snapshot has been applied. */
export class EventStream {
  cursor = 0;
  private syncing: { id: string; afterSeq: number } | null = null;
  private buffered = new Map<number, DurableServerEvent>();
  private seenIds = new Map<string, number>();
  private disposed = false;

  constructor(readonly sessionId: string, private readonly sink: Sink) {}

  sync() {
    if (this.disposed || this.syncing) return;
    this.syncing = { id: this.sink.sync(this.cursor), afterSeq: this.cursor };
  }

  syncFailed(id: string) {
    if (this.syncing?.id === id) this.syncing = null;
  }

  receive(value: unknown) {
    if (this.disposed) return;
    const result = ServerEvent.safeParse(value);
    if (!result.success || result.data.sessionId !== this.sessionId) {
      throw new Error("A session update was invalid. Reconnect to sync the conversation.");
    }
    const event = result.data;
    if (event.type === "session.replay") {
      if (event.payload.commandId !== this.syncing?.id) return;
      if (event.seq < this.cursor) throw new Error("The session replay was out of date.");
      if (event.payload.mode === "snapshot") {
        this.sink.snapshot(event.payload.snapshot);
        this.cursor = event.seq;
        this.seenIds.clear();
      } else {
        if (event.payload.afterSeq !== this.syncing.afterSeq) throw new Error("The session replay started at the wrong position.");
        for (const item of event.payload.events) this.apply(item);
      }
      this.syncing = null;
      for (const seq of this.buffered.keys()) if (seq <= this.cursor) this.buffered.delete(seq);
      this.drain();
      return event.payload.commandId;
    }
    const known = this.seenIds.get(event.id);
    if (known !== undefined && known !== event.seq) throw new Error("A session update reused an event identity.");
    if (event.seq <= this.cursor) return;
    const previous = this.buffered.get(event.seq);
    if (previous && previous.id !== event.id) throw new Error("Session updates disagree about their order.");
    this.buffered.set(event.seq, event);
    if (this.buffered.size > 512) {
      this.buffered.clear();
      throw new Error("Too many updates arrived while reconnecting. Please sync again.");
    }
    if (!this.syncing) this.drain();
  }

  private apply(event: DurableServerEvent) {
    if (event.seq !== this.cursor + 1) throw new Error("The conversation has a gap. Please sync again.");
    const buffered = this.buffered.get(event.seq);
    if (buffered && buffered.id !== event.id) throw new Error("Replay and live updates disagree about their order.");
    const known = this.seenIds.get(event.id);
    if (known !== undefined && known !== event.seq) throw new Error("A session update reused an event identity.");
    this.sink.event(event);
    this.cursor = event.seq;
    this.seenIds.set(event.id, event.seq);
  }

  private drain() {
    let next = this.buffered.get(this.cursor + 1);
    while (next) {
      this.apply(next);
      this.buffered.delete(next.seq);
      next = this.buffered.get(this.cursor + 1);
    }
    if (this.buffered.size) this.sync();
  }

  dispose() {
    this.disposed = true;
    this.buffered.clear();
    this.syncing = null;
  }
}
