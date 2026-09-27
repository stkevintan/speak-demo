import type { AudioFrame } from "@livekit/rtc-node";
import { ReadableStream, type ReadableStreamDefaultReader } from "node:stream/web";
import { log } from "./log.js";

export async function synthesizeWithFallback(
  text: ReadableStream<string> | AsyncIterable<string>,
  synthesize: (text: ReadableStream<string>) => Promise<ReadableStream<AudioFrame> | null>,
  fallback: (text: string) => Promise<void>,
  isCurrent: () => boolean,
  hasFailed: () => boolean,
): Promise<ReadableStream<AudioFrame>> {
  const source = text instanceof ReadableStream ? text : fromIterable(text);
  const [input, copy] = source.tee();
  const fullText = collect(copy);
  // The collector is consumed below; attach a handler immediately for cancellation races.
  void fullText.catch(() => {});
  let reader: ReadableStreamDefaultReader<AudioFrame> | undefined;
  let cancelled = false;
  return new ReadableStream<AudioFrame>({
    async start(controller) {
      try {
        const audio = await synthesize(input);
        if (!audio) throw new Error("TTS returned no audio stream");
        reader = audio.getReader();
        let frames = 0;
        while (!cancelled) {
          const next = await reader.read();
          if (next.done) break;
          if (!cancelled) { controller.enqueue(next.value); frames++; }
        }
        if (cancelled) return;
        if (hasFailed() || frames === 0) throw new Error("TTS provider produced no complete audio");
        controller.close();
      } catch {
        if (cancelled) return;
        if (isCurrent()) {
          try {
            const content = await fullText;
            if (isCurrent() && content.trim()) await fallback(content);
            // The SDK owns retry limits; keep the fallback text-only behavior
            // and let the failed provider turn terminate normally.
          } catch {
            controller.error(new Error("TTS text fallback failed"));
            return;
          }
        }
        controller.close();
      } finally {
        try { await reader?.cancel(); }
        catch { log("tts.cleanup_failed"); }
        reader?.releaseLock();
      }
    },
    async cancel() {
      cancelled = true;
      await reader?.cancel();
      if (!input.locked) void input.cancel().catch(() => log("tts.input_cancel_failed"));
    },
  });
}

function fromIterable(text: AsyncIterable<string>): ReadableStream<string> {
  const iterator = text[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return?.(); },
  });
}

async function collect(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  for await (const part of stream) text += part;
  return text;
}
