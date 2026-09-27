import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerBootstrap, WorkerCheckpoint, CloseAck, type CloseRequest } from "@rehearsal/contracts";
import { parseConfig } from "../src/config.js";
import { LiveSessionStore, type LiveRead } from "../src/storage/ports.js";
import { RoomGateway } from "../src/livekit.js";

export async function fixtureConfig() {
  const dataDir = await mkdtemp(join(tmpdir(), "rehearsal-cp-test-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  return {
    config: parseConfig({
      NODE_ENV: "test", DEV_AUTH_ENABLED: "true",
      JWT_SECRET: "test-only-secret-not-for-production-123456",
      REDIS_URL: "redis://127.0.0.1:6379", DATA_DIR: dataDir,
      COURSES_DIR: join(root, "courses"),
      LIVEKIT_URL: "ws://127.0.0.1:7880",
      LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret",
      SESSION_CLOSE_TIMEOUT_MS: "10", SESSION_START_GRACE_MS: "100",
      SESSION_SWEEP_SECONDS: "3600",
    }, root),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

export class FakeLiveStore extends LiveSessionStore {
  readonly data = new Map<string, LiveRead>();
  readonly bootstrap = new Map<string, WorkerBootstrap>();
  unavailable = false;
  async initialize(input: WorkerBootstrap) {
    if (this.unavailable) throw new Error("redis offline");
    const value = WorkerBootstrap.parse(input);
    this.bootstrap.set(input.sessionId, value);
    this.data.set(input.sessionId, {
      checkpoint: WorkerCheckpoint.parse({
        v: 1, sessionId: input.sessionId, workerId: "control-plane:init", epoch: 1, seq: 0,
        snapshot: {
          state: "idle", learnerTurn: null, transcript: [], cards: [], suggestions: null,
          preferences: { suggestions: input.profile.suggestions }, endReason: null,
        },
        findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0,
      }),
    });
  }
  async read(id: string): Promise<LiveRead> {
    if (this.unavailable) throw new Error("redis offline");
    return this.data.get(id) ?? {};
  }
  async requestClose(request: CloseRequest) {
    const current = await this.read(request.sessionId);
    current.closeRequest ??= request;
    this.data.set(request.sessionId, current);
    return current.closeRequest;
  }
  async recover(id: string, courseId: string) {
    const state = await this.read(id);
    if (state.ack) return state.ack;
    if (state.lease) return undefined;
    if (!state.checkpoint || !state.closeRequest) throw new Error("missing checkpoint");
    const cp = state.checkpoint;
    state.ack = CloseAck.parse({
      v: 1, sessionId: id, commandId: state.closeRequest.commandId,
      workerId: cp.workerId, epoch: cp.epoch, finalSeq: cp.seq,
      record: {
        sessionId: id, courseId, transcript: cp.snapshot.transcript.map(({ turnId: _, source: __, ...turn }) => turn),
        findings: cp.findings.map(({ findingId: _, turnId: __, ...finding }) => finding),
        signal: cp.signal, goalMet: cp.goalMet, learnerTurns: cp.learnerTurns,
        endReason: state.closeRequest.reason,
      },
    });
    return state.ack;
  }
  async cleanup(id: string) { this.data.delete(id); this.bootstrap.delete(id); }
}
export class FakeRooms extends RoomGateway {
  readonly created = new Set<string>();
  readonly removed = new Set<string>();
  failCreate = false;
  async create(room: string) {
    this.created.add(room);
    if (this.failCreate) throw new Error("dispatch failed");
  }
  async token(room: string, identity: string) { return `token:${room}:${identity}`; }
  async remove(room: string) { this.created.delete(room); this.removed.add(room); }
}
