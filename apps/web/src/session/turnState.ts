import type { State } from "@rehearsal/contracts";
import type { PipMood } from "../components/Artwork";
import type { Connection } from "./store";

export function turnPresentation(state: State, connection: Connection, mode: "voice" | "typing", mic: boolean, name: string): { label: string; tone: "teal" | "violet" | "coral"; mood: PipMood; moving: boolean } {
  if (state === "ended") return { label: "Scene finished", tone: "teal", mood: "idle", moving: false };
  if (connection !== "connected") return { label: connection === "reconnecting" ? "Reconnecting..." : connection === "disconnected" ? "Connection lost" : "Connecting...", tone: "violet", mood: "think", moving: false };
  if (state === "thinking" || state === "idle") return { label: state === "idle" ? "Getting the scene ready..." : "Thinking...", tone: "violet", mood: "think", moving: state === "thinking" };
  if (state === "speaking") return { label: `${name} is speaking`, tone: "coral", mood: "idle", moving: true };
  return { label: mode === "typing" ? "Your turn - typing is on" : mic ? "Listening - your turn" : "Mic is muted - unmute or type", tone: "teal", mood: "listen", moving: mode === "voice" && mic };
}
