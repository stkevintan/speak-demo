import {
  ClientCommand, PROTOCOL_VERSION, REALTIME_TOPIC,
  type DurableServerEvent, type SessionStart,
} from "@rehearsal/contracts";
import { Room, RoomEvent, Track, type RemoteAudioTrack } from "livekit-client";
import { EventStream } from "./protocol";
import { reduceEvent, useSessionStore } from "./store";

type CommandBody = ClientCommand extends infer C
  ? C extends ClientCommand ? Pick<C, "type" | "payload"> : never
  : never;
type Pending = {
  command: ClientCommand;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class LiveSession {
  private readonly room: Room;
  private readonly stream: EventStream;
  private readonly pending = new Map<string, Pending>();
  private readonly tracks = new Set<RemoteAudioTrack>();
  private disposed = false;
  private mediaStopped = false;
  private cancellingAudio = false;
  private micVersion = 0;
  private readonly agentIdentity: string;
  private connecting: Promise<void> | null = null;

  constructor(private readonly grant: SessionStart, room?: Room) {
    this.room = room ?? new Room({
      adaptiveStream: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.agentIdentity = `agent:${grant.sessionId}`;
    this.stream = new EventStream(grant.sessionId, {
      event: event => this.apply(event),
      snapshot: snapshot => {
        useSessionStore.setState({ snapshot });
        this.cancelAudio(snapshot.state !== "speaking");
        if (snapshot.state === "ended") this.stopMedia();
      },
      sync: afterSeq => {
        const command = this.makeCommand({ type: "session.sync", payload: { afterSeq } });
        this.track(command, () => {}, error => this.report(error.message));
        return command.id;
      },
    });
    this.room
      .on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (this.disposed || topic !== REALTIME_TOPIC || participant?.identity !== this.agentIdentity) return;
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          const replayCommandId = this.stream.receive(value);
          if (replayCommandId) this.settle(replayCommandId);
        } catch {
          this.report("A session update couldn't be read. Use Sync conversation to recover.");
        }
      })
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (this.disposed || participant.identity !== this.agentIdentity || track.kind !== Track.Kind.Audio) return;
        const audio = track as RemoteAudioTrack;
        this.tracks.add(audio);
        const element = audio.attach();
        element.dataset.rehearsalAudio = this.grant.sessionId;
        element.hidden = true;
        document.body.appendChild(element);
        audio.setVolume(this.cancellingAudio ? 0 : 1);
      })
      .on(RoomEvent.TrackUnsubscribed, track => {
        if (track.kind !== Track.Kind.Audio) return;
        const audio = track as RemoteAudioTrack;
        audio.detach().forEach(element => element.remove());
        this.tracks.delete(audio);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!this.disposed) useSessionStore.setState({ audioBlocked: !this.room.canPlaybackAudio });
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!this.disposed) useSessionStore.setState({ connection: "reconnecting" });
      })
      .on(RoomEvent.Reconnected, () => {
        if (this.disposed) return;
        useSessionStore.setState({ connection: "connected" });
        this.sync();
      })
      .on(RoomEvent.ParticipantConnected, participant => {
        if (!this.disposed && participant.identity === this.agentIdentity) this.sync();
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.disposed) return;
        this.cancelAudio(true);
        useSessionStore.setState({
          connection: "disconnected", mic: false,
          problem: "The connection ended. You can still finish the scene and get your feedback.",
        });
      });
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  private async connectOnce() {
    if (this.disposed || this.room.state === "connected" || this.room.state === "connecting") return;
    try {
      await this.room.connect(this.grant.livekit.url, this.grant.livekit.token);
      if (this.disposed) { await this.room.disconnect(); return; }
      if (this.mediaStopped) return;
      useSessionStore.setState({ connection: "connected" });
      this.sync();
      await this.setMic(true);
    } catch {
      if (!this.disposed) {
        useSessionStore.setState({ connection: "disconnected" });
        this.report("We couldn't connect to the scene. End the scene for feedback, or return to scenes and try again.");
      }
    }
  }

  private makeCommand(body: CommandBody): ClientCommand {
    return ClientCommand.parse({
      v: PROTOCOL_VERSION, sessionId: this.grant.sessionId, id: crypto.randomUUID(), seq: 0, ...body,
    });
  }

  command(body: CommandBody): Promise<void> {
    if (this.disposed || this.mediaStopped) return Promise.reject(new Error("This scene is closing. Finish it to get your feedback."));
    const command = this.makeCommand(body);
    return new Promise((resolve, reject) => this.track(command, resolve, reject));
  }

  private track(command: ClientCommand, resolve: () => void, reject: (error: Error) => void) {
    const pending: Pending = { command, attempts: 0, resolve, reject };
    this.pending.set(command.id, pending);
    this.publish(pending);
  }

  private publish(pending: Pending) {
    if (this.disposed) return;
    pending.attempts++;
    pending.timer = setTimeout(() => {
      if (!this.pending.has(pending.command.id)) return;
      if (pending.attempts < 3) this.publish(pending);
      else {
        this.pending.delete(pending.command.id);
        this.stream.syncFailed(pending.command.id);
        pending.reject(new Error("The character hasn't confirmed your action. Sync the conversation before trying again."));
      }
    }, 4000);
    void this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(pending.command)),
      { reliable: true, topic: REALTIME_TOPIC, destinationIdentities: [this.agentIdentity] },
    ).catch(() => {
      if (!this.disposed) this.report("An action couldn't be sent. Retrying with the same request ID...");
    });
  }

  private settle(id: string, error?: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private apply(event: DurableServerEvent) {
    useSessionStore.setState(state => ({ snapshot: reduceEvent(state.snapshot, event) }));
    if (event.type === "command.ack") {
      const pending = this.pending.get(event.payload.commandId);
      if (pending?.command.type === "session.sync" && event.payload.status === "accepted") return;
      if (event.payload.status === "rejected") {
        this.stream.syncFailed(event.payload.commandId);
        this.settle(event.payload.commandId, new Error(`That action wasn't accepted (${event.payload.code}). Sync the conversation and try again.`));
      } else this.settle(event.payload.commandId);
    }
    if (event.type === "agent.state" && event.payload.state === "speaking") this.cancelAudio(false);
    if (event.type === "learner.turn" && event.payload.canCommit) this.cancelAudio(true);
    if (event.type === "session.ended") this.stopMedia();
    if (event.type === "alert") {
      if (event.payload.code === "mic_unavailable") useSessionStore.setState({ micIssue: event.payload.message });
      else this.report(event.payload.message);
    }
  }

  sync() {
    if (!this.disposed) this.stream.sync();
  }

  async setMic(enabled: boolean) {
    if (this.disposed || this.mediaStopped) return;
    const version = ++this.micVersion;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(enabled);
      if (this.disposed || this.mediaStopped) {
        this.room.localParticipant.audioTrackPublications.forEach(p => p.track?.stop());
        return;
      }
      if (version !== this.micVersion) return;
      useSessionStore.setState({
        mic: enabled, mode: enabled ? "voice" : useSessionStore.getState().mode,
        ...(enabled ? { micIssue: null } : {}),
      });
    } catch {
      if (!this.disposed) useSessionStore.setState({
        mic: false, mode: "typing",
        micIssue: "We can't hear your microphone. Check browser permissions and your input device, or keep typing.",
      });
    }
  }

  async typeInstead() {
    if (this.disposed || this.mediaStopped) return;
    useSessionStore.setState({ mode: "typing" });
    await this.setMic(false);
  }

  async interrupt() {
    this.cancelAudio(true);
    await this.command({ type: "learner.interrupt", payload: {} });
  }

  async startAudio() {
    try {
      await this.room.startAudio();
      useSessionStore.setState({ audioBlocked: !this.room.canPlaybackAudio });
    } catch {
      this.report("Your browser blocked audio. Allow playback or follow the transcript.");
    }
  }

  private cancelAudio(cancel: boolean) {
    this.cancellingAudio = cancel || this.mediaStopped;
    this.tracks.forEach(track => track.setVolume(this.cancellingAudio ? 0 : 1));
  }

  stopMedia() {
    this.mediaStopped = true;
    this.micVersion++;
    this.cancelAudio(true);
    this.room.localParticipant.audioTrackPublications.forEach(p => p.track?.stop());
    useSessionStore.setState({ mic: false });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.micVersion++;
    this.stream.dispose();
    this.stopMedia();
    this.pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error("The scene has closed.")); });
    this.pending.clear();
    this.tracks.forEach(track => track.detach().forEach(element => element.remove()));
    this.tracks.clear();
    this.room.removeAllListeners();
    if (this.room.state !== "disconnected") void this.room.disconnect().catch(() => {
      console.warn("Rehearsal room disconnect did not complete.");
    });
  }

  private report(message: string) { if (!this.disposed) useSessionStore.setState({ problem: message }); }
  private message(error: unknown) { return error instanceof Error ? error.message : "The action couldn't be completed."; }
}
