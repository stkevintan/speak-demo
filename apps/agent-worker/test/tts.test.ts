import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { synthesizeWithFallback } from "../src/tts.js";

test("TTS failure preserves generated text without inventing audio", async () => {
  const fallbacks: string[] = [];
  const text = new ReadableStream<string>({
    start(controller) { controller.enqueue("Here is "); controller.enqueue("your refund."); controller.close(); },
  });
  const audio = await synthesizeWithFallback(text,
    async (input) => {
      for await (const _ of input) { /* consume synthesis input */ }
      throw new Error("provider down");
    },
    async (content) => { fallbacks.push(content); },
    () => true, () => false);
  const frames = [];
  for await (const frame of audio) frames.push(frame);
  assert.deepEqual(frames, []);
  assert.deepEqual(fallbacks, ["Here is your refund."]);
});

test("interruption cannot turn the unplayed suffix into a text fallback", async () => {
  let fallback = false;
  const text = new ReadableStream<string>({ start(controller) { controller.enqueue("unplayed suffix"); controller.close(); } });
  const audio = await synthesizeWithFallback(text,
    async (input) => { for await (const _ of input) {} throw new Error("cancelled"); },
    async () => { fallback = true; }, () => false, () => true);
  for await (const _ of audio) {}
  assert.equal(fallback, false);
});
