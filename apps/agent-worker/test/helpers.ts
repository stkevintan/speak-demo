import { readFile } from "node:fs/promises";
import { loadCourse, WorkerBootstrap, WorkerCheckpoint, CloseAck, type CloseRequest, type CommandAck,
  type DurableServerEvent, type WorkerLease } from "@rehearsal/contracts";
import type { Store } from "../src/store.js";
import type { Timer } from "../src/turn-detector.js";

export const bootstrap = WorkerBootstrap.parse({
  v: 1, sessionId: "test-session", userId: "dev", roomName: "test-room", learnerIdentity: "learner:test-session",
  course: loadCourse(await readFile(new URL("../../../courses/refund.yaml", import.meta.url), "utf8")),
  profile: { level: "B1", chinese: true, suggestions: true }, recalled: [],
});

export const lease: WorkerLease = {
  v: 1, sessionId: bootstrap.sessionId, workerId: "worker:test", epoch: 2, heartbeatAt: new Date().toISOString(),
};

export function initialCheckpoint(): WorkerCheckpoint {
  return WorkerCheckpoint.parse({
    v: 1, sessionId: bootstrap.sessionId, workerId: "control-plane:init", epoch: 1, seq: 0,
    snapshot: { state: "idle", learnerTurn: null, transcript: [], cards: [], suggestions: null,
      preferences: { suggestions: true }, endReason: null },
    findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0,
  });
}

export class FakeClock implements Timer {
  private milliseconds = 100000;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.milliseconds; }
  set(callback: () => void, ms: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.milliseconds + ms, callback });
    return id;
  }
  clear(handle: unknown) { if (typeof handle === "number") this.timers.delete(handle); }
  advance(ms: number) {
    const target = this.milliseconds + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.milliseconds = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.milliseconds = target;
  }
}

export class MemoryStore implements Store {
  value: WorkerCheckpoint | null = initialCheckpoint();
  history: DurableServerEvent[] = [];
  receipts = new Map<string, CommandAck>();
  request: CloseRequest | null = null;
  closed: CloseAck | null = null;
  writes = 0;
  failWrites = false;
  bootstrap = async () => bootstrap;
  acquire = async () => lease;
  renew = async () => {};
  checkpoint = async () => this.value ? structuredClone(this.value) : null;
  events = async () => structuredClone(this.history);
  acknowledgement = async (id: string) => this.receipts.get(id) ?? null;
  async write(next: WorkerCheckpoint, previous: number, event?: DurableServerEvent) {
    if (this.failWrites) throw new Error("offline");
    if (this.closed || this.value?.snapshot.state === "ended") throw new Error("frozen");
    if (previous !== this.value?.seq) throw new Error("sequence conflict");
    WorkerCheckpoint.parse(next);
    this.writes++;
    this.value = structuredClone(next);
    if (event) {
      this.history.push(structuredClone(event));
      this.history = this.history.slice(-256);
      if (event.type === "command.ack") this.receipts.set(event.payload.commandId, event);
    }
  }
  async requestClose(request: CloseRequest) { this.request ??= request; return this.request; }
  closeRequest = async () => this.request;
  async freeze(ack: CloseAck) {
    CloseAck.parse(ack);
    if (this.value?.seq !== ack.finalSeq || this.value?.snapshot.state !== "ended") throw new Error("invalid freeze");
    this.closed = structuredClone(ack);
  }
  release = async () => {};
  close = async () => {};
}

export async function settle() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
