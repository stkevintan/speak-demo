import { createClient } from "redis";
import {
  CloseAck, CloseRequest, CommandAck, DurableServerEvent, MAX_REPLAY_EVENTS,
  WorkerBootstrap, WorkerCheckpoint, WorkerLease, sessionKeys,
} from "@rehearsal/contracts";
import type { Log } from "./log.js";

export const LEASE_MS = 15000;
export interface Store {
  bootstrap(): Promise<WorkerBootstrap>;
  acquire(workerId: string): Promise<WorkerLease>;
  renew(lease: WorkerLease): Promise<void>;
  checkpoint(): Promise<WorkerCheckpoint | null>;
  events(): Promise<DurableServerEvent[]>;
  acknowledgement(id: string): Promise<CommandAck | null>;
  write(checkpoint: WorkerCheckpoint, previousSeq: number, event?: DurableServerEvent): Promise<void>;
  requestClose(request: CloseRequest): Promise<CloseRequest>;
  closeRequest(): Promise<CloseRequest | null>;
  freeze(ack: CloseAck): Promise<void>;
  release(lease: WorkerLease): Promise<void>;
  close(): Promise<void>;
}
type CommandAck = ReturnType<typeof CommandAck.parse>;

export interface RedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { NX: boolean; EX: number }): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  xRange(key: string, start: string, end: string): Promise<Array<{ message: Record<string, string> }>>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  readonly isOpen: boolean;
  quit(): Promise<unknown>;
}

const acquireScript = `
if redis.call('EXISTS', KEYS[4]) == 0 then return redis.error_reply('BOOTSTRAP_MISSING') end
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.error_reply('LEASE_HELD') end
if redis.call('EXISTS', KEYS[3]) == 1 then return redis.error_reply('SESSION_FROZEN') end
local epoch = 1
local prior = redis.call('GET', KEYS[2])
if not prior then return redis.error_reply('CHECKPOINT_MISSING') end
epoch = cjson.decode(prior).epoch + 1
local lease = cjson.decode(ARGV[1])
lease.epoch = epoch
local encoded = cjson.encode(lease)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[2])
return encoded
`;
const fence = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return redis.error_reply('LEASE_EXPIRED') end
local lease = cjson.decode(encoded)
if lease.workerId ~= ARGV[1] or lease.epoch ~= tonumber(ARGV[2]) then
  return redis.error_reply('STALE_WORKER')
end
`;
const writeScript = fence + `
if redis.call('EXISTS', KEYS[5]) == 1 then return redis.error_reply('SESSION_FROZEN') end
local previous = redis.call('GET', KEYS[2])
local seq = 0
if previous then
  local checkpoint = cjson.decode(previous)
  seq = checkpoint.seq
  if checkpoint.snapshot.state == 'ended' then return redis.error_reply('SESSION_ENDED') end
end
if seq ~= tonumber(ARGV[3]) then return redis.error_reply('SEQUENCE_CONFLICT') end
local next = cjson.decode(ARGV[4])
if next.seq ~= seq + tonumber(ARGV[5]) then return redis.error_reply('INVALID_SEQUENCE') end
if ARGV[5] == '1' then
  local event = cjson.decode(ARGV[6])
  if event.seq ~= next.seq then return redis.error_reply('EVENT_SEQUENCE_CONFLICT') end
  if event.type == 'command.ack' then
    if redis.call('HEXISTS', KEYS[4], event.payload.commandId) == 1 then
      return redis.error_reply('DUPLICATE_COMMAND')
    end
    redis.call('HSET', KEYS[4], event.payload.commandId, ARGV[6])
  end
  redis.call('XADD', KEYS[3], 'MAXLEN', ${MAX_REPLAY_EVENTS}, '*', 'event', ARGV[6])
end
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[7])
for i = 3, 4 do redis.call('EXPIRE', KEYS[i], ARGV[7]) end
return 1
`;
const freezeScript = fence + `
local current = redis.call('GET', KEYS[2])
local request = redis.call('GET', KEYS[3])
if not current or not request then return redis.error_reply('MISSING_CLOSE_STATE') end
local checkpoint = cjson.decode(current)
local closeRequest = cjson.decode(request)
local ack = cjson.decode(ARGV[3])
if checkpoint.snapshot.state ~= 'ended' or checkpoint.seq ~= ack.finalSeq
  or checkpoint.workerId ~= lease.workerId or checkpoint.epoch ~= lease.epoch
  or ack.workerId ~= lease.workerId or ack.epoch ~= lease.epoch
  or closeRequest.commandId ~= ack.commandId or closeRequest.reason ~= ack.record.endReason then
  return redis.error_reply('CLOSE_CONFLICT')
end
local old = redis.call('GET', KEYS[4])
if old then
  if old ~= ARGV[3] then return redis.error_reply('ALREADY_FROZEN') end
  return 1
end
redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[4])
return 1
`;

export async function connectStore(url: string, sessionId: string, ttl: number, log: Log): Promise<Store> {
  const client = createClient({ url, socket: { reconnectStrategy: false }, disableOfflineQueue: true });
  client.on("error", () => log("redis.connection_error", { sessionId }));
  await client.connect();
  return redisStore(client, sessionId, ttl);
}

export function redisStore(client: RedisPort, sessionId: string, ttl: number): Store {
  const keys = sessionKeys(sessionId);
  const read = async <T>(key: string, parse: (value: unknown) => T): Promise<T | null> => {
    const raw = await client.get(key);
    return raw === null ? null : parse(JSON.parse(raw));
  };
  return {
    async bootstrap() {
      const value = await read(keys.bootstrap, WorkerBootstrap.parse);
      if (!value || value.sessionId !== sessionId) throw new Error("Missing or mismatched bootstrap");
      return value;
    },
    async acquire(workerId) {
      const result = await client.eval(acquireScript, {
        keys: [keys.lease, keys.checkpoint, keys.closeAck, keys.bootstrap],
        arguments: [JSON.stringify({ v: 1, sessionId, workerId, epoch: 1, heartbeatAt: new Date().toISOString() }), String(LEASE_MS)],
      });
      if (typeof result !== "string") throw new Error("Invalid lease response");
      return WorkerLease.parse(JSON.parse(result));
    },
    async renew(lease) {
      const next = { ...lease, heartbeatAt: new Date().toISOString() };
      await client.eval(fence + `
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
for i = 2, #KEYS do redis.call('EXPIRE', KEYS[i], ARGV[5]) end
return 1`, {
        keys: [keys.lease, keys.bootstrap, keys.checkpoint, keys.events, keys.commands, keys.closeRequest],
        arguments: [lease.workerId, String(lease.epoch), JSON.stringify(next), String(LEASE_MS), String(ttl)],
      });
    },
    checkpoint: () => read(keys.checkpoint, WorkerCheckpoint.parse),
    async events() {
      return (await client.xRange(keys.events, "-", "+")).map(({ message }) => {
        if (!message.event) throw new Error("Missing event field");
        return DurableServerEvent.parse(JSON.parse(message.event));
      });
    },
    async acknowledgement(id) {
      const raw = await client.hGet(keys.commands, id);
      return raw == null ? null : CommandAck.parse(JSON.parse(raw));
    },
    async write(checkpoint, previousSeq, event) {
      WorkerCheckpoint.parse(checkpoint);
      if (checkpoint.sessionId !== sessionId || (event && event.sessionId !== sessionId)) throw new Error("Foreign session write");
      if (event) DurableServerEvent.parse(event);
      await client.eval(writeScript, {
        keys: [keys.lease, keys.checkpoint, keys.events, keys.commands, keys.closeAck],
        arguments: [checkpoint.workerId, String(checkpoint.epoch), String(previousSeq), JSON.stringify(checkpoint),
          event ? "1" : "0", event ? JSON.stringify(event) : "", String(ttl)],
      });
    },
    async requestClose(request) {
      CloseRequest.parse(request);
      if (request.sessionId !== sessionId) throw new Error("Foreign close request");
      await client.set(keys.closeRequest, JSON.stringify(request), { NX: true, EX: ttl });
      const result = await read(keys.closeRequest, CloseRequest.parse);
      if (!result) throw new Error("Close request disappeared");
      return result;
    },
    closeRequest: () => read(keys.closeRequest, CloseRequest.parse),
    async freeze(ack) {
      CloseAck.parse(ack);
      const checkpoint = await read(keys.checkpoint, WorkerCheckpoint.parse);
      if (!checkpoint || ack.sessionId !== sessionId || checkpoint.workerId !== ack.workerId || checkpoint.epoch !== ack.epoch) {
        throw new Error("Invalid frozen checkpoint");
      }
      const { snapshot, findings, signal, goalMet, learnerTurns } = checkpoint;
      const record = {
        sessionId, courseId: (await read(keys.bootstrap, WorkerBootstrap.parse))?.course.id,
        transcript: snapshot.transcript.map(({ role, text, tStart, tEnd }) => ({ role, text, tStart, tEnd })),
        findings: findings.map(({ findingId: _findingId, turnId: _turnId, ...card }) => card),
        signal, goalMet, learnerTurns, endReason: snapshot.endReason,
      };
      if (JSON.stringify(record) !== JSON.stringify(ack.record)) throw new Error("Close record differs from checkpoint");
      await client.eval(freezeScript, {
        keys: [keys.lease, keys.checkpoint, keys.closeRequest, keys.closeAck],
        arguments: [ack.workerId, String(ack.epoch), JSON.stringify(ack), String(ttl)],
      });
    },
    async release(lease) {
      await client.eval(`
local value = redis.call('GET', KEYS[1])
if value then
  local lease = cjson.decode(value)
  if lease.workerId == ARGV[1] and lease.epoch == tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) end
end
return 1`, { keys: [keys.lease], arguments: [lease.workerId, String(lease.epoch)] });
    },
    async close() { if (client.isOpen) await client.quit(); },
  };
}
