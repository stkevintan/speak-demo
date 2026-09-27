import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const positive = z.coerce.number().int().positive();
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: positive.max(65535).default(3000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default("rehearsal-control-plane"),
  JWT_AUDIENCE: z.string().min(1).default("rehearsal-web"),
  JWT_TTL_SECONDS: positive.default(86400),
  DEV_AUTH_ENABLED: z.enum(["true", "false"]).optional(),
  REDIS_URL: z.url().refine((url) => /^(redis|rediss):\/\//u.test(url)),
  LIVEKIT_URL: z.url().refine((url) => /^wss?:\/\//u.test(url)),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_AGENT_NAME: z.string().min(1).default("rehearsal-agent"),
  LIVEKIT_TOKEN_TTL_SECONDS: positive.default(3600),
  DATA_DIR: z.string().min(1).optional(),
  COURSES_DIR: z.string().min(1).optional(),
  SESSION_LIVE_TTL_SECONDS: positive.min(120).default(86400),
  SESSION_SWEEP_SECONDS: positive.default(5),
  SESSION_START_GRACE_MS: positive.default(30000),
  SESSION_CLOSE_TIMEOUT_MS: positive.default(5000),
});

function findWorkspaceRoot(from = import.meta.url): string | undefined {
  let directory = dirname(fileURLToPath(from));
  while (!existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return directory;
}
export function workspaceRoot(from = import.meta.url): string {
  const root = findWorkspaceRoot(from);
  if (!root) throw new Error("Set absolute DATA_DIR and COURSES_DIR outside the workspace");
  return root;
}

export function parseConfig(environment: NodeJS.ProcessEnv, root: string) {
  const parsed = Env.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid configuration: ${fields.join(", ")}`);
  }
  const env = parsed.data;
  const devAuth = env.DEV_AUTH_ENABLED === "true"
    || (env.DEV_AUTH_ENABLED === undefined && env.NODE_ENV === "development");
  if (devAuth && env.NODE_ENV === "production") throw new Error("Development auth is forbidden in production");
  const webOrigins = env.WEB_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean);
  if (webOrigins.length === 0 || webOrigins.some((value) => {
    try {
      const origin = new URL(value);
      return origin.origin !== value || !["http:", "https:"].includes(origin.protocol);
    } catch {
      return true;
    }
  })) {
    throw new Error("WEB_ORIGIN must contain comma-separated HTTP origins without trailing slashes");
  }
  const directory = (value: string | undefined, fallback: string) =>
    value && isAbsolute(value) ? value : resolve(root, value ?? fallback);
  return Object.freeze({
    ...env,
    WEB_ORIGINS: webOrigins,
    devAuth,
    dataDir: directory(env.DATA_DIR, "apps/control-plane/.data"),
    coursesDir: directory(env.COURSES_DIR, "courses"),
  });
}
export type AppConfig = ReturnType<typeof parseConfig>;
export const CONFIG = Symbol("AppConfig");

export function loadConfig(): AppConfig {
  const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
  const hasAbsolutePaths = process.env.DATA_DIR && isAbsolute(process.env.DATA_DIR)
    && process.env.COURSES_DIR && isAbsolute(process.env.COURSES_DIR);
  const root = findWorkspaceRoot() ?? (hasAbsolutePaths ? moduleRoot : workspaceRoot());
  const envFile = process.env.ENV_FILE;
  if (envFile && !isAbsolute(envFile)) throw new Error("ENV_FILE must be absolute");
  const file = envFile ?? resolve(root, ".env");
  if (existsSync(file)) {
    const result = dotenv({ path: file, override: false, quiet: true });
    if (result.error) throw new Error("Unable to load configured environment file", { cause: result.error });
  } else if (envFile) throw new Error("ENV_FILE does not exist");
  return parseConfig(process.env, root);
}
