import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionEventTypes, initializeLogger, voice } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";

initializeLogger({ pretty: false, level: "silent" });

class TestAudioOutput extends voice.AudioOutput {
  onFirstFrame?: () => void;
  private started = false;
  constructor(private readonly prefix: string) { super(24000); }
  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (!this.started) {
      this.started = true;
      this.onPlaybackStarted(Date.now());
      this.onFirstFrame?.();
    }
  }
  override clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true, synchronizedTranscript: this.prefix });
  }
}

class FrameCharacter extends voice.Agent {
  constructor() {
    super({ instructions: "Test character", turnHandling: {
      turnDetection: "manual", endpointing: { minDelay: 0, maxDelay: 0 },
      preemptiveGeneration: { enabled: false },
      interruption: { enabled: true, resumeFalseInterruption: false },
    } });
  }
  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new AudioFrame(new Int16Array(480), 24000, 1, 480));
        controller.close();
      },
    });
  }
}

test("SDK manual-mode interruption retains only synchronized played prefix in chat and event", { timeout: 10000 }, async () => {
  const sdk = new voice.AgentSession({
    llm: new voice.testing.FakeLLM([{ input: "hello", content: "Hello there, this suffix was never heard." }]),
  });
  const output = new TestAudioOutput("Hello there");
  const agent = new FrameCharacter();
  const transcript: string[] = [];
  sdk.output.audio = output;
  output.onFirstFrame = () => { sdk.interrupt(); };
  sdk.on(AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === "message" && item.role === "assistant") transcript.push(item.textContent ?? "");
  });
  await sdk.start({ agent, record: false });
  try {
    await sdk.generateReply({ userInput: "hello" }).waitForPlayout();
    assert.deepEqual(transcript, ["Hello there"]);
    assert.deepEqual(agent.chatCtx.items.filter((item) => item.type === "message" && item.role === "assistant")
      .map((item) => item.type === "message" ? item.textContent : ""), ["Hello there"]);
  } finally { await sdk.close(); }
});

test("SDK typed input adds exactly one user item without invoking the voice commit hook", { timeout: 10000 }, async () => {
  let completedVoiceTurns = 0;
  class TypedAgent extends voice.Agent {
    override async onUserTurnCompleted(): Promise<void> { completedVoiceTurns++; }
  }
  const sdk = new voice.AgentSession({
    llm: new voice.testing.FakeLLM([{ input: "typed input", content: "A text reply." }]),
    turnHandling: { turnDetection: "manual" },
  });
  const agent = new TypedAgent({ instructions: "test" });
  await sdk.start({ agent, record: false });
  try {
    await sdk.generateReply({ userInput: "typed input" }).waitForPlayout();
    const learners = agent.chatCtx.items.filter((item) => item.type === "message" && item.role === "user");
    assert.equal(learners.length, 1);
    assert.equal(completedVoiceTurns, 0);
  } finally { await sdk.close(); }
});
