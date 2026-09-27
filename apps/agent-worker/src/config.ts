import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config as dotenv } from "dotenv";
import { z } from "zod";

export const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));
const positive = (value: number) => z.coerce.number().int().positive().default(value);
const Environment = z.object({
  LIVEKIT_URL: z.url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_AGENT_NAME: z.string().min(1).default("rehearsal"),
  REDIS_URL: z.url(),
  STT_MODEL: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  COACH_LLM_MODEL: z.string().min(1),
  COACH_API_KEY: z.string().min(1).optional(),
  COACH_BASE_URL: z.url().default("https://api.openai.com/v1"),
  TTS_MODEL: z.string().min(1),
  TTS_VOICE: z.string().min(1).optional(),
  TURN_PATIENCE_MS_A2: positive(2000),
  TURN_PATIENCE_MS_B1: positive(1600),
  TURN_PATIENCE_MS_B2: positive(1200),
  SESSION_TTL_SECONDS: positive(86400),
});
export type Config = z.infer<typeof Environment>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat blank optional entries from dotenv files like omitted values.
  const normalized = { ...env, TTS_VOICE: env.TTS_VOICE?.trim() || undefined };
  const parsed = Environment.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`);
  }
  return parsed.data;
}

export function loadRootEnv(): void {
  if (!existsSync(ROOT_ENV)) return;
  const result = dotenv({ path: ROOT_ENV, quiet: true });
  if (result.error) {
    throw new Error("Cannot read worker root environment file");
  }
}
