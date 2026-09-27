import { AgentSessionEventTypes, inference, llm, voice, type JobContext, type VAD } from "@livekit/agents";
import { ReadableStream } from "node:stream/web";
import { z } from "zod";
import type { WorkerBootstrap } from "@rehearsal/contracts";
import { characterInstructions } from "./character.js";
import type { TextModel } from "./coach.js";
import type { Config } from "./config.js";
import type { Log } from "./log.js";
import type { Session, VoicePort } from "./session.js";
import { synthesizeWithFallback } from "./tts.js";

export const AUDIO_SAMPLE_RATE = 24000;

export function createTextModel(modelName: string): TextModel {
  const model = inference.LLM.fromModelString(modelName);
  return {
    async complete(prompt, signal) {
      signal.throwIfAborted();
      const chatCtx = llm.ChatContext.empty();
      chatCtx.addMessage({ role: "system", content: prompt });
      const stream = model.chat({ chatCtx });
      const abort = () => stream.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await stream.collect();
        signal.throwIfAborted();
        return result.text;
      } finally {
        signal.removeEventListener("abort", abort);
        stream.close();
      }
    },
    close: () => model.aclose(),
  };
}

export class Voice implements VoicePort {
  private runtime: Session | undefined;
  private readonly session: voice.AgentSession;
  private readonly agent: voice.Agent;

  constructor(config: Config, bootstrap: WorkerBootstrap, vad: VAD, private readonly log: Log) {
    let ttsErrorRevision = 0;
    const getRuntime = () => {
      if (!this.runtime) throw new Error("Voice runtime not attached");
      return this.runtime;
    };
    class Character extends voice.Agent {
      constructor() {
        super({
          instructions: characterInstructions(bootstrap),
          turnHandling: {
            turnDetection: "manual",
            endpointing: { minDelay: 0, maxDelay: 0 },
            interruption: { enabled: true, resumeFalseInterruption: false },
            preemptiveGeneration: { enabled: false },
          },
          tools: {
            scene_outcome: llm.tool({
              description: "Record your character's concession or natural closing, then say it aloud in character.",
              parameters: z.object({ goalMet: z.boolean(), closeScene: z.boolean() }),
              execute: async (outcome, { ctx }) => {
                const runtime = getRuntime();
                const generation = runtime.generation;
                ctx.speechHandle.addDoneCallback((handle) => {
                  if (!handle.interrupted) {
                    void runtime.outcome(outcome, generation).catch(() => log("character.outcome_discarded"));
                  }
                });
                return "Continue with the spoken in-character decision.";
              },
            }),
          },
        });
      }
      override async onUserTurnCompleted(chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
        const runtime = getRuntime();
        const generation = runtime.generation;
        if (runtime.isEnding) throw new voice.StopResponse();
        try {
          const directive = await runtime.learner(message.textContent ?? "", message.id);
          if (runtime.isEnding || generation !== runtime.generation || !message.textContent?.trim()) throw new voice.StopResponse();
          if (directive) chatCtx.addMessage({ role: "system", content: directive });
        } catch {
          // SDK catches ordinary hook errors and would otherwise still generate a reply.
          throw new voice.StopResponse();
        }
      }
      override async ttsNode(text: ReadableStream<string> | AsyncIterable<string>, settings: voice.ModelSettings) {
        const runtime = getRuntime();
        const generation = runtime.generation;
        const revision = ttsErrorRevision;
        const startedAt = Date.now();
        // Materialize the generated sentence before handing it to TTS so the
        // transcript can be persisted immediately before the first audio frame.
        const content = await collectText(text);
        if (content.trim() && !runtime.isEnding && runtime.generation === generation) {
          await runtime.character(content, `speech:${generation}:${startedAt}`, startedAt);
        }
        return synthesizeWithFallback(toTextStream(content), (input) => voice.Agent.default.ttsNode(this, input, settings),
          async () => {
            await runtime.alert("tts_unavailable", "Audio is unavailable. The character's reply is shown as text; you can keep talking or type.");
          },
          () => !runtime.isEnding && runtime.generation === generation,
          () => ttsErrorRevision !== revision);
      }
    }
    this.agent = new Character();
    this.session = new voice.AgentSession({
      vad,
      stt: new inference.STT({ model: config.STT_MODEL, sampleRate: AUDIO_SAMPLE_RATE, connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 } }),
      llm: inference.LLM.fromModelString(config.LLM_MODEL),
      tts: new inference.TTS({ model: config.TTS_MODEL, ...(config.TTS_VOICE ? { voice: config.TTS_VOICE } : {}), connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 } }),
      connOptions: {
        maxUnrecoverableErrors: 1,
        sttConnOptions: { maxRetry: 0 },
        ttsConnOptions: { maxRetry: 0 },
      },
      useTtsAlignedTranscript: true,
    });
    this.session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      if (event.newState === "speaking") getRuntime().speechStart();
      else getRuntime().speechEnd();
    });
    this.session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      const state = event.newState;
      if (state === "listening" || state === "thinking" || state === "speaking") {
        void getRuntime().state(state).catch(() => log("voice.state_failed"));
      }
    });
    this.session.on(AgentSessionEventTypes.UserTranscriptionTimeout, () => {
      getRuntime().detector.reset();
      void getRuntime().alert("asr_timeout", "I could not hear that. Check your microphone or type your reply.")
        .catch(() => log("voice.alert_failed"));
      void getRuntime().state("listening").catch(() => log("voice.state_failed"));
    });
    this.session.on(AgentSessionEventTypes.Error, ({ error }) => {
      if (error.type === "tts_error") {
        ttsErrorRevision++;
        log("voice.tts_failed");
        return;
      }
      if (error.type === "llm_error" && error.error instanceof Error && /429|rate.?limit/i.test(error.error.message)) {
        log("voice.llm_rate_limited");
        void getRuntime().alert("voice_unavailable", "The character service is busy. Please wait a moment, then try again.")
          .catch(() => log("voice.alert_failed"));
        void getRuntime().state("listening").catch(() => log("voice.state_failed"));
        return;
      }
      log("voice.provider_error");
      void getRuntime().alert("voice_unavailable", "The voice service is having trouble. Try typing, or end the scene to save your debrief.")
        .catch(() => log("voice.alert_failed"));
      void getRuntime().state("listening").catch(() => log("voice.state_failed"));
    });
    this.session.on(AgentSessionEventTypes.Close, () => {
      void getRuntime().end("network").catch(() => log("voice.close_recovery_required"));
    });
  }

  attach(runtime: Session): void { this.runtime = runtime; }

  async start(ctx: JobContext, learnerIdentity: string): Promise<void> {
    // Gate incoming audio during opening; the SDK may still initialize STT.
    this.session.input.setAudioEnabled(false);
    await this.session.start({
      agent: this.agent, room: ctx.room,
      inputOptions: { participantIdentity: learnerIdentity, audioSampleRate: AUDIO_SAMPLE_RATE,
        textEnabled: false, closeOnDisconnect: false },
      outputOptions: { transcriptionEnabled: true, syncTranscription: true },
      record: { audio: false, transcript: false, traces: false, logs: false, redaction: true },
    });
  }

  setListening(enabled: boolean): void { this.session.input.setAudioEnabled(enabled); }

  async interrupt(): Promise<void> {
    try { await within(this.session.interrupt().await, 2000); }
    catch {
      await this.session.interrupt({ force: true }).await;
      this.log("voice.interrupt_drain_failed");
      throw new Error("Voice interruption did not finalize in time");
    }
  }
  async finish(): Promise<void> { await within(this.session.close(), 5000); }
  commit(): void { this.session.commitUserTurn(); }
  replyText(text: string, instructions?: string): void {
    this.session.generateReply({ userInput: text, ...(instructions ? { instructions } : {}) });
  }
  say(text: string): void { this.session.say(text); }
  reengage(): void {
    this.session.generateReply({ instructions: "The learner is quiet. Offer one brief, gentle, in-character way to continue. Do not mention silence, tutoring, grading or a system check." });
  }
  async close(): Promise<void> { await this.session.close(); }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Voice operation timeout")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function toTextStream(text: string): ReadableStream<string> {
  return new ReadableStream({ start(controller) { controller.enqueue(text); controller.close(); } });
}

async function collectText(text: ReadableStream<string> | AsyncIterable<string>): Promise<string> {
  if (text instanceof ReadableStream) {
    let result = "";
    for await (const part of text) result += part;
    return result;
  }
  let result = "";
  for await (const part of text) result += part;
  return result;
}
