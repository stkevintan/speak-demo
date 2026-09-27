import { Inject, Injectable, Logger } from "@nestjs/common";
import { createClient } from "redis";
import { z } from "zod";
import {
  CloseAck, CloseRequest, SessionRecord, WorkerBootstrap, WorkerCheckpoint,
  WorkerLease, sessionKeys,
} from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "../config.js";
import { LiveSessionStore, type LiveRead } from "./ports.js";

export const INITIALIZE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;

export const RECOVER = `
local ack = redis.call('GET', KEYS[1])
if ack then return ack end
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return false end
if redis.call('GET', KEYS[4]) ~= ARGV[2] then return false end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return ARGV[3]`;

@Injectable()
export class RedisLiveSessionStore extends LiveSessionStore {
  private readonly client;
  private readonly logger = new Logger(RedisLiveSessionStore.name);
  private connectedOnce = false;
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    super();
    this.client = createClient({
      url: config.REDIS_URL,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => this.connectedOnce ? Math.min(100 * (retries + 1), 2000) : false,
      },
      disableOfflineQueue: true,
    });
    this.client.on("error", () => this.logger.error("Redis connection error"));
  }
  async onModuleInit() { await this.client.connect(); this.connectedOnce = true; }
  async onModuleDestroy() {
    if (this.client.isReady) await this.client.quit();
    else if (this.client.isOpen) this.client.destroy();
  }

  async initialize(input: WorkerBootstrap) {
    const bootstrap = WorkerBootstrap.parse(input);
    const keys = sessionKeys(bootstrap.sessionId);
    const checkpoint = WorkerCheckpoint.parse({
      v: 1, sessionId: bootstrap.sessionId, workerId: "control-plane:init", epoch: 1, seq: 0,
      snapshot: {
        state: "idle", learnerTurn: null, transcript: [], cards: [], suggestions: null,
        preferences: { suggestions: bootstrap.profile.suggestions }, endReason: null,
      },
      findings: [], signal: { nice: 0, total: 0 }, goalMet: false, learnerTurns: 0,
    });
    const result = await this.client.eval(INITIALIZE, {
      keys: [keys.bootstrap, keys.checkpoint],
      arguments: [JSON.stringify(bootstrap), JSON.stringify(checkpoint), String(this.config.SESSION_LIVE_TTL_SECONDS)],
    });
    if (result !== 1) throw new Error("Live session already exists");
  }

  private parse<T>(value: string | null, schema: z.ZodType<T>): T | undefined {
    return value === null ? undefined : schema.parse(JSON.parse(value));
  }
  async read(id: string): Promise<LiveRead> {
    const keys = sessionKeys(id);
    const [checkpoint, lease, closeRequest, ack] = await this.client.mGet([
      keys.checkpoint, keys.lease, keys.closeRequest, keys.closeAck,
    ]);
    const result = {
      checkpoint: this.parse(checkpoint ?? null, WorkerCheckpoint),
      lease: this.parse(lease ?? null, WorkerLease),
      closeRequest: this.parse(closeRequest ?? null, CloseRequest),
      ack: this.parse(ack ?? null, CloseAck),
    };
    for (const value of Object.values(result)) {
      if (value && value.sessionId !== id) throw new Error("Foreign session in Redis snapshot");
    }
    return result;
  }
  async requestClose(input: CloseRequest) {
    const request = CloseRequest.parse(input);
    const key = sessionKeys(request.sessionId).closeRequest;
    await this.client.set(key, JSON.stringify(request), { NX: true, EX: this.config.SESSION_LIVE_TTL_SECONDS });
    const winner = this.parse(await this.client.get(key), CloseRequest);
    if (!winner || winner.sessionId !== request.sessionId) throw new Error("Invalid winning close request");
    return winner;
  }
  async recover(id: string, courseId: string): Promise<CloseAck | undefined> {
    const keys = sessionKeys(id);
    const [rawCheckpoint, rawRequest] = await this.client.mGet([keys.checkpoint, keys.closeRequest]);
    if (!rawCheckpoint || !rawRequest) throw new Error("Recovery state is missing; cannot fabricate a transcript");
    const checkpoint = WorkerCheckpoint.parse(JSON.parse(rawCheckpoint));
    const request = CloseRequest.parse(JSON.parse(rawRequest));
    if (checkpoint.sessionId !== id || request.sessionId !== id) throw new Error("Recovery session mismatch");
    const record = SessionRecord.parse({
      sessionId: id, courseId,
      transcript: checkpoint.snapshot.transcript.map(({ turnId: _turnId, source: _source, ...turn }) => turn),
      findings: checkpoint.findings.map(({ findingId: _findingId, turnId: _turnId, ...finding }) => finding),
      signal: checkpoint.signal, goalMet: checkpoint.goalMet,
      learnerTurns: checkpoint.learnerTurns, endReason: request.reason,
    });
    const ack = CloseAck.parse({
      v: 1, sessionId: id, commandId: request.commandId, workerId: checkpoint.workerId,
      epoch: checkpoint.epoch, finalSeq: checkpoint.seq, record,
    });
    const raw = await this.client.eval(RECOVER, {
      keys: [keys.closeAck, keys.lease, keys.checkpoint, keys.closeRequest],
      arguments: [rawCheckpoint, rawRequest, JSON.stringify(ack), String(this.config.SESSION_LIVE_TTL_SECONDS)],
    });
    return raw === null ? undefined : CloseAck.parse(JSON.parse(z.string().parse(raw)));
  }
  async cleanup(id: string) {
    await this.client.del(Object.values(sessionKeys(id)));
  }
}
