export interface Timer {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const clock: Timer = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => { if (handle instanceof Object && "hasRef" in handle) clearTimeout(handle as NodeJS.Timeout); },
};

export class TurnDetector {
  private timer: unknown;
  private speaking = false;
  private pending = false;
  private committing = false;
  private id: string | null = null;
  private started = 0;

  constructor(
    private readonly patienceMs: number,
    private readonly time: Timer,
    private readonly createId: () => string,
    private readonly onCommit: () => void,
  ) {}

  get turn() { return this.id ? { turnId: this.id, canCommit: this.pending && !this.committing } : null; }
  get startedAt() { return this.started; }
  get hasPending() { return this.pending || this.committing; }

  speechStart(): void {
    this.cancelTimer();
    this.speaking = true;
    if (!this.id) {
      this.id = this.createId();
      this.started = this.time.now();
      this.pending = true;
    }
  }

  speechEnd(): void {
    this.speaking = false;
    this.cancelTimer();
    if (this.pending && !this.committing) {
      this.timer = this.time.set(() => {
        if (!this.speaking && this.id) this.commit(this.id);
      }, this.patienceMs);
    }
  }

  commit(turnId: string): "accepted" | "stale_turn" | "not_committable" {
    if (turnId !== this.id) return "stale_turn";
    if (!this.pending || this.committing) return "not_committable";
    this.cancelTimer();
    this.committing = true;
    this.onCommit();
    return "accepted";
  }

  complete(): { turnId: string; startedAt: number } {
    const result = { turnId: this.id ?? this.createId(), startedAt: this.id ? this.started : this.time.now() };
    const continuing = this.speaking;
    this.reset();
    if (continuing) this.speechStart();
    return result;
  }

  reset(): void {
    this.cancelTimer();
    this.id = null;
    this.pending = false;
    this.committing = false;
    this.speaking = false;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
  }
}
