import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeLogger, voice, type VAD } from "@livekit/agents";
import { ReadableStream } from "node:stream/web";
import { Voice } from "../src/voice.js";
import { loadConfig } from "../src/config.js";
import type { Session } from "../src/session.js";
import { bootstrap } from "./helpers.js";

initializeLogger({ pretty: false, level: "silent" });

test("production voice publishes once when TTS fails and disables session retry overrides", async () => {
  const env = { LIVEKIT_URL: "wss://example.test", LIVEKIT_API_KEY: "test", LIVEKIT_API_SECRET: "test",
    REDIS_URL: "redis://localhost:6379", STT_MODEL: "deepgram/nova-3", LLM_MODEL: "openai/gpt-4.1-mini",
    COACH_LLM_MODEL: "openai/gpt-4.1-mini", TTS_MODEL: "cartesia/sonic-3" };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const adapter = new Voice(loadConfig(env), bootstrap, {} as VAD, () => {});
    const internals = adapter as unknown as { agent: voice.Agent; session: voice.AgentSession };
    assert.equal(internals.session.connOptions.sttConnOptions.maxRetry, 0);
    assert.equal(internals.session.connOptions.ttsConnOptions.maxRetry, 0);
    const transcripts: string[] = [];
    const alerts: string[] = [];
    adapter.attach({ generation: 0, isEnding: false,
      character: async (text: string) => { transcripts.push(text); },
      alert: async (code: string) => { alerts.push(code); },
    } as unknown as Session);
    // No SDK activity is running: the default TTS node fails without a network call.
    const output = await internals.agent.ttsNode(new ReadableStream<string>({
      start(controller) { controller.enqueue(bootstrap.course.opener); controller.close(); },
    }), {});
    assert.ok(output);
    for await (const _frame of output) { /* Drain fallback. */ }
    assert.deepEqual(transcripts, [bootstrap.course.opener]);
    assert.deepEqual(alerts, ["tts_unavailable"]);
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
