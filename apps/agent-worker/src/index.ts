import { fileURLToPath } from "node:url";
import { cli, ServerOptions } from "@livekit/agents";
import { Dispatch } from "./agent.js";
import { loadConfig, loadRootEnv } from "./config.js";
import { log } from "./log.js";

loadRootEnv();
const config = loadConfig();
cli.runApp(new ServerOptions({
  agent: fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./agent.ts" : "./agent.js", import.meta.url)),
  agentName: config.LIVEKIT_AGENT_NAME,
  wsURL: config.LIVEKIT_URL,
  apiKey: config.LIVEKIT_API_KEY,
  apiSecret: config.LIVEKIT_API_SECRET,
  requestFunc: async (job) => {
    const parsed = Dispatch.safeParse(parseMetadata(job.job.metadata));
    if (!parsed.success) { log("dispatch.invalid"); await job.reject(); return; }
    await job.accept("Rehearsal", `agent:${parsed.data.sessionId}`);
  },
}));

function parseMetadata(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
