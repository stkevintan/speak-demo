# Agent-worker Module

## Purpose

The agent-worker is the real-time data-plane process. One worker job joins one LiveKit room per session and owns the learner conversation: media input, learner-aware turn detection, character response generation, TTS playback, interruption, transcript/event production, and asynchronous coaching.

The worker must remain useful when the control-plane is slow or temporarily unavailable. It reads its pinned session context from the private Redis bootstrap and does not import profiles or courses over HTTP during a live turn.

## Responsibilities

- Join the assigned LiveKit room as `agent:${sessionId}` and accept only the authenticated learner and `rehearsal.v1` topic.
- Acquire and renew a fenced Redis lease, starting above the control-plane initialization epoch.
- Validate commands, deduplicate stable command IDs, persist durable events before publication, and maintain bounded replay state.
- Use manual endpointing and a learner-aware silence threshold (roughly 1200-2000ms); manual commit bypasses patience without bypassing ASR flush.
- Run an isolated character path and an independent coach path. The character never receives coach findings and the coach never owns audio.
- Preserve the synchronized played text prefix during barge-in and avoid exposing unplayed generated suffixes as spoken transcript.
- Stop input, cancel work, drain/close the SDK, persist the final `session.ended` event, and write a matching frozen close acknowledgement.

## Hot path

The control-plane is not a synchronous dependency of the hot path. The worker's per-turn sequence is:

```text
LiveKit audio -> ASR/turn detector -> character LLM -> TTS -> LiveKit audio
                                      \-> coach queue -> coach.card (async)
```

Redis checkpoint/event writes provide durability and fencing, but a control-plane HTTP request is never required between these steps. A slow coach affects feedback freshness, not character latency. A storage/provider failure must stop or recover conservatively without fabricating a successful completion.

## Worker lifecycle

Before dispatch, control-plane writes `WorkerBootstrap` and an idle checkpoint with `workerId: control-plane:init`, `epoch: 1`, and `seq: 0`. Acquisition atomically refuses missing bootstrap/checkpoint, an existing lease, or an existing close acknowledgement, then allocates a strictly higher epoch.

The lease is PX 15000ms and renews every 5000ms. Event/checkpoint/close writes are fenced by worker ID and epoch. Durable events use monotonic `seq >= 1`; commands use `seq: 0`; replay envelopes are non-durable high-watermarks.

Close requests are first-wins. The worker writes the final checkpoint and `CloseAck` together, with `finalSeq` including the ended event. A stale generation or foreign worker cannot freeze the session.

## Voice and coaching policy

- Normal barge-in uses non-forced SDK interruption so played-prefix finalization remains correct.
- Forced interruption is reserved for the logged drain-timeout path.
- Natural goal/budget completion requests close; it does not forcibly cut off the learner.
- Coach findings are complete internally, while rate-limited admitted cards are the only UI rail output.
- TTS failure preserves generated text and emits an alert; an unplayed suffix is never presented as spoken text.

## Validation

```sh
pnpm --filter @rehearsal/agent-worker typecheck
pnpm --filter @rehearsal/agent-worker test
pnpm --filter @rehearsal/agent-worker build
```

Focused tests cover turn policy, SDK interruption and played-prefix handling, typed input, lifecycle races, dedupe/replay/freeze, coach isolation, TTS fallback, and Redis adapter preconditions. They do not execute Lua against live Redis or prove real provider, microphone, or speaker behavior.

### Learner-turn audio input

SDK audio input starts disabled. The runtime enables input only in `listening`,
then disables it during `thinking`, `speaking`, shutdown, and failure. This gates
incoming audio to VAD/STT; providers remain configured rather than being rebuilt
per turn. Disabling audio does not prevent SDK STT connection initialization.
STT and TTS retries are disabled at the AgentSession connection-options layer,
which overrides provider constructor defaults. A 429 still requires checking
provider quota/concurrency; disabling retries does not cure provider rejection.
Assistant text is published once before TTS; a TTS failure emits only an alert,
not a second transcript entry. Browser active-speaker notifications no longer automatically interrupt
character playback. Explicit interruption and typed replies remain supported.

Opening transcript persistence runs outside the runtime's serialized start task:
it queues its own transcript event before playback, without waiting on itself or
blocking subsequent sync acknowledgements.
