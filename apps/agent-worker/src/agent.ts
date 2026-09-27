import { randomUUID } from "node:crypto";
import { defineAgent, type JobContext } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import * as silero from "@livekit/agents-plugin-silero";
import { REALTIME_TOPIC } from "@rehearsal/contracts";
import { z } from "zod";
import { loadConfig, loadRootEnv } from "./config.js";
import { Coach } from "./coach.js";
import { decodeCommand } from "./events.js";
import { log } from "./log.js";
import { Session } from "./session.js";
import { connectStore } from "./store.js";
import { createTextModel, Voice } from "./voice.js";

export const Dispatch = z.strictObject({ sessionId: z.string().min(1) });

async function entry(ctx: JobContext): Promise<void> {
  loadRootEnv();
  const config = loadConfig();
  const { sessionId } = Dispatch.parse(JSON.parse(ctx.job.metadata));
  const store = await connectStore(config.REDIS_URL, sessionId, config.SESSION_TTL_SECONDS, log);
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const bootstrap = await store.bootstrap();
    if (ctx.job.room?.name !== bootstrap.roomName) throw new Error("Dispatch room mismatch");
    const vad = await silero.VAD.load({ sampleRate: 16000 });
    const lease = await store.acquire(randomUUID());
    const model = createTextModel(config.COACH_LLM_MODEL);
    const voice = new Voice(config, bootstrap, vad, log);
    const runtime = new Session(bootstrap, lease, store, voice, new Coach(bootstrap, model),
      async (event) => {
        const participant = ctx.room.localParticipant;
        if (!participant) throw new Error("No local participant");
        await participant.publishData(new TextEncoder().encode(JSON.stringify(event)),
          { topic: REALTIME_TOPIC, reliable: true, destination_identities: [bootstrap.learnerIdentity] });
      }, log, config[`TURN_PATIENCE_MS_${bootstrap.profile.level}`]);
    voice.attach(runtime);
    await runtime.initialize();
    let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void runtime.heartbeat().then(() => {
        if (runtime.checkpoint.snapshot.state === "ended") ctx.shutdown("session_ended");
      }).catch(() => {
        log("worker.heartbeat_failed", { sessionId });
        ctx.shutdown("storage_failure");
      }).finally(() => { heartbeatRunning = false; });
    }, 5000);
    const idle = setInterval(() => { void runtime.idle().catch(() => log("session.idle_failed")); }, 500);
    cleanup = async () => {
      clearInterval(heartbeat);
      clearInterval(idle);
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      try { await runtime.end("network"); }
      catch { log("session.shutdown_recovery_required", { sessionId }); }
      try { await voice.close(); } catch { log("voice.close_failed"); }
      try { await model.close(); } catch { log("coach.close_failed"); }
      try { await store.release(lease); } catch { log("lease.release_failed"); }
      await store.close();
    };
    ctx.addShutdownCallback(cleanup);
    ctx.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      let command;
      try { command = decodeCommand(bytes, participant?.identity, bootstrap.learnerIdentity, sessionId, topic); }
      catch { log("command.rejected_invalid", { sessionId }); return; }
      void runtime.command(command).catch(() => log("command.failed", { sessionId }));
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity !== bootstrap.learnerIdentity) return;
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      disconnectedTimer = setTimeout(() => {
        void runtime.end("network").catch(() => log("session.disconnect_close_failed"));
      }, 30000);
    });
    ctx.room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === bootstrap.learnerIdentity && disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = undefined;
      }
    });
    await voice.start(ctx, bootstrap.learnerIdentity);
    await runtime.start();
  } catch {
    log("worker.job_failed", { sessionId });
    if (cleanup) await cleanup();
    else await store.close();
    throw new Error("Worker job failed; consult redacted worker error codes");
  }
}

export default defineAgent({ entry });
