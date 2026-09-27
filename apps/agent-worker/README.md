# Agent worker

LiveKit Node worker for contracts 0.2.0 / realtime v1. The default worker name is
`rehearsal`; dispatch metadata is strictly `{ "sessionId": "..." }`. Jobs join as
`agent:${sessionId}`. Commands are accepted only from the bootstrap learner, on
the reliable `rehearsal.v1` topic.

## Local development

From the repository root:

```sh
pnpm install
pnpm --filter @rehearsal/contracts build
pnpm --filter @rehearsal/agent-worker dev
```

For compiled execution, run the worker `build` then `start` scripts. The root
`.env` is resolved relative to the module in both source and compiled execution,
not the current working directory. Existing process environment takes precedence.
Do not commit credentials.

Required environment variables:

| Variable | Meaning |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit server/account credentials |
| `REDIS_URL` | Authenticated server-side Redis connection |
| `STT_MODEL`, `LLM_MODEL`, `COACH_LLM_MODEL`, `TTS_MODEL` | LiveKit Inference model identifiers enabled for the account |

Optional: `LIVEKIT_AGENT_NAME` (default `rehearsal`), `TTS_VOICE`,
`SESSION_TTL_SECONDS` (86400), `TURN_PATIENCE_MS_A2` (2000),
`TURN_PATIENCE_MS_B1` (1600), and `TURN_PATIENCE_MS_B2` (1200).
Provider/account support is not inferred from model names. A self-hosted LiveKit
server without an Inference entitlement needs a separately configured provider
adapter; the worker does not silently switch providers.

No browser JWT or SQLite access is required. The pinned course, level,
preferences and recalled patterns come from the validated Redis bootstrap, not
from a local YAML reload or browser-provided prompt.

## Control-plane handoff

Follow `packages/contracts/PROTOCOL.md` exactly. Before dispatch, control-plane
must write both `WorkerBootstrap` and an idle, empty `WorkerCheckpoint` with
`workerId: "control-plane:init"`, `epoch: 1`, `seq: 0`.

Lease acquisition atomically refuses missing bootstrap/checkpoint, existing
lease, or close acknowledgment, and allocates an epoch above the checkpoint.
The lease lasts 15 seconds and is renewed every 5 seconds. All event/checkpoint/
command-receipt writes are fenced by worker ID and epoch; events are persisted
before publication and retained with exact `MAXLEN 256` trimming. Replay wrappers
are non-durable; trimmed, too-long or invalid cursors receive a full snapshot.

Close requests are first-wins `SET NX`. The worker stops input, cancels coach work,
interrupts and drains the SDK, persists `session.ended`, and freezes a matching
`CloseAck` whose `finalSeq` includes that event. The final record includes all
explained findings; the snapshot contains only admitted cards. Control-plane
owns immutable debrief persistence, lease-expiry recovery, and eventual deletion.
It must not treat a command acknowledgment as a persisted debrief.

Brief browser disconnections retain the same worker job for 30 seconds; after
that the worker ends with reason `network`. This is not process migration: an
already-used checkpoint is never reset to an empty scene or replayed opener.
Provider/storage failures are logged with redacted codes; unrecoverable failures
leave the valid checkpoint for control-plane recovery rather than fabricating a
successful close. Under the current EndReason contract, shutdown/provider-loss
recovery uses `network`, not an invented `error` enum member.

## Voice and coaching rules

- SDK manual endpointing plus a worker-owned silence timer; ASR segments do not
  independently commit learner turns. Manual commit skips patience, not ASR flush.
- Speech onset explicitly invokes **non-forced** SDK interruption. Every worker
  utterance remains interruptible. Forcing interruption marks the handle done
  before played-text finalization; it is reserved for the logged drain-timeout
  failure path. Normal end closes/drains the SDK before freezing the record.
- SDK synchronized playout transcripts preserve the played prefix. Room input
  and STT both use 24 kHz; Silero handles its own supported VAD input rate.
- The character's outcome tool uses `addDoneCallback`, not a circular
  `waitForPlayout()` inside tool execution. Interrupted/stale generations cannot
  record a concession. A met goal or course budget requests a natural close, not
  a forced learner cutoff.
- The coach has a separate model/context and no audio handle. Valid positives
  bypass nit filtering; nits dedupe by category/quote with a two-turn cooldown.
  Raw assessment counts, bilingual explanations and suppressed findings survive
  in the checkpoint. Coach requests have deadlines and an eight-turn queue cap.
- TTS failure emits an actionable alert and preserves generated text; cancellation
  is not reclassified as a TTS failure exposing an unplayed suffix.

## Validation

```sh
pnpm --filter @rehearsal/agent-worker typecheck
pnpm --filter @rehearsal/agent-worker test
pnpm --filter @rehearsal/agent-worker build
```

The suite covers fake-clock silence/manual commitment, SDK played-prefix and
typed-input behavior, lifecycle races, isolation/admission, replay, freeze, TTS
fallback, and the Redis adapter's keys/arguments/preconditions using an injected
mock. **It does not execute Lua in a Redis server.** Live Redis atomicity,
provider credentials/model availability, microphone capture, browser speaker
latency, and real TTS word alignment still require a configured local integration
environment. No Docker, Playwright, smoke scripts, provider calls, or shared live
Redis data are used by these tests.
