import { randomUUID } from "node:crypto";
import {
  ClientCommand, MAX_REPLAY_EVENTS, REALTIME_TOPIC, SessionReplay,
  type DurableServerEvent, type WorkerCheckpoint,
} from "@rehearsal/contracts";

export type EventBody = DurableServerEvent extends infer E
  ? E extends DurableServerEvent ? Pick<E, "type" | "payload"> : never
  : never;

export function decodeCommand(bytes: Uint8Array, identity: string | undefined, learnerIdentity: string, sessionId: string, topic?: string): ClientCommand {
  if (identity !== learnerIdentity || topic !== REALTIME_TOPIC) throw new Error("Untrusted data sender");
  if (bytes.byteLength > 16384) throw new Error("Command exceeds message limit");
  const value = ClientCommand.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (value.sessionId !== sessionId) throw new Error("Foreign session command");
  return value;
}

export function replay(checkpoint: WorkerCheckpoint, events: DurableServerEvent[], commandId: string, afterSeq: number): SessionReplay {
  const suffix = events.filter((event) => event.seq > afterSeq);
  const complete = afterSeq <= checkpoint.seq && checkpoint.seq - afterSeq <= MAX_REPLAY_EVENTS
    && suffix.length === checkpoint.seq - afterSeq
    && suffix.every((event, index) => event.seq === afterSeq + index + 1);
  return SessionReplay.parse({
    v: 1, sessionId: checkpoint.sessionId, id: randomUUID(), seq: checkpoint.seq, type: "session.replay",
    payload: complete
      ? { mode: "events", commandId, afterSeq, events: suffix }
      : { mode: "snapshot", commandId, snapshot: checkpoint.snapshot },
  });
}
