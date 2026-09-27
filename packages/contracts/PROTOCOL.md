# Contracts 0.2.0 / realtime v1

This revision is the shared MVP boundary for web, control-plane and agent-worker.
Import validators and inferred types from `@rehearsal/contracts`; browser hooks
come from `@rehearsal/contracts/generated`. No app imports another app.

## HTTP and auth

The seven operations in `openapi.yaml` return **raw bodies**, not
`{ data, status, headers }` wrappers. GET hooks are queries; PATCH/POST hooks are
mutations. The fetcher throws `ApiError` (`status`, `code`, `message`); the
generator uses its exported `ErrorType` alias. Invalid error responses throw an
explicit `invalid_error_response`, not a fabricated successful result.

`AUTH_COOKIE_NAME` is `rehearsal_session`. Development-only GET `/api/me` without
a cookie issues an HttpOnly SameSite=Lax JWT for the fixed dev user. Other
operations require a valid cookie; an invalid presented cookie is a 401, not
anonymous bootstrap. Production bootstrap is disabled; cookies are Secure
outside local HTTP. Servers restrict credentialed CORS and validate mutation
Origin. These are server obligations, not enforcement provided by this package.

`Profile.onboarded` is required. New profiles start false; PATCH with an explicit
level atomically sets true, including Skip sending a level. It is read-only:
`ProfilePatch` accepts only level/chinese/suggestions, rejects unknown keys, and
permits an empty no-op patch. `StartSessionRequest` is strict `{courseId}`.
`ApiErrorBody` is strict `{code,message}`. Shared boundary objects reject unknown
keys. Runtime relational checks supplement generated JSON Schema.

## LiveKit data channel

Use reliable JSON messages on `REALTIME_TOPIC = "rehearsal.v1"`.
Every envelope contains `v:1`, `sessionId`, `id`, `seq`, `type`, `payload`.
Reject wrong versions, unknown keys, wrong session IDs and wrong directions.
Check the authenticated LiveKit participant identity **before** parsing/handling:
web accepts worker events only from the assigned agent; worker accepts commands
only from bootstrap.learnerIdentity. A payload's claimed identity is not proof.

Client commands have `seq:0` and a stable unique `id`. Retrying a command reuses
that ID and the same body. The worker deduplicates by ID for the session and
replays the original acknowledgement, never the side effect.

Worker durable events have stable unique IDs and consecutive `seq >= 1`, one
counter per session. Persist before publish. Replay retains the same IDs and
sequences. Neither timestamps nor Redis stream IDs replace this sequence.

| Direction | Type | Payload |
|---|---|---|
| web -> worker | learner.commit | `{turnId}`; only the current committable learner turn |
| web -> worker | learner.text | `{text}`; nonblank, at most 4000 characters |
| web -> worker | learner.interrupt | `{}`; cancel character playback/generation |
| web -> worker | preferences.update | `{suggestions}`; live preference; web also persists ProfilePatch |
| web -> worker | session.sync | `{afterSeq}` |
| web -> worker | session.end | `{reason:"user"}` |
| worker -> web | command.ack | `{commandId,status:"accepted"}` or `{commandId,status:"rejected",code}` |
| worker -> web | learner.turn | `{turnId,canCommit}`; never true before learner speech |
| worker -> web | agent.state | `{state:"listening"|"thinking"|"speaking"}` |
| worker -> web | transcript.final | `{turnId,role,text,tStart,tEnd,source}` |
| worker -> web | coach.card | CoachCard plus `{findingId,turnId}` |
| worker -> web | suggestions | `{prompt,options}` |
| worker -> web | alert | `{code,message}`; actionable text, not limited to mic errors |
| worker -> web | session.ended | `{reason}` |
| worker -> web | session.replay | Replay response below |

`accepted` means the command was accepted/deduplicated; it does not promise
debrief persistence. Suggested rejection codes: `stale_turn`, `not_committable`,
`session_ended`, `invalid_command`. Malformed envelopes cannot be trusted for
correlation; discard and log rather than reflecting unvalidated IDs.

Transcript source is `asr` or `typed` for learner turns and `character` for the
character; role/source mismatches and backwards timing are invalid. Times are
milliseconds relative to session start. IDs tie cards to transcript turns;
they are not indexes into a possibly replayed array.

`EndReason` is `user | quit | network | goal | budget`. `session.ended` means the
worker finished, not that the debrief is already stored. Read existing GET
`/api/sessions/{id}/debrief`, treating 409 as pending. Explicit browser End may
also call the idempotent POST end endpoint.

## Replay and snapshot

`session.replay` is not persisted as a durable event. Its envelope `seq` is the
current consistent high-watermark and may be zero. `payload.commandId` correlates
the sync request.

- `mode:"events"`: `{commandId,afterSeq,events}` contains every consecutive event
  after afterSeq through the envelope seq, max `MAX_REPLAY_EVENTS = 256`.
  No nested replay, skipped sequence, foreign-session event or partial suffix.
- `mode:"snapshot"`: `{commandId,snapshot}` is used if history was trimmed, the
  requested range exceeds 256, or the cursor is invalid. Snapshot is a full
  replacement at the envelope seq, not a delta.

Snapshot carries state, current learnerTurn or null, transcript, admitted cards,
suggestions or null, live preferences, and endReason or null. Ended state and
endReason must agree. It must not include unadmitted/private coach findings.

Web keeps a contiguous cursor, deduplicates IDs, buffers newer live events during
sync, applies replay/snapshot, then drains buffered consecutive events. Do not
advance the cursor just because the replay envelope arrived. Retry sync on a
gap. Ended snapshots must terminate the local session even if its live end
event was missed. `ClientCommand`, `DurableServerEvent`, `ServerEvent`,
`SessionSnapshot`, `SessionReplay`, `RealtimeEvent` and `EVENT_DIRECTION` are
the runtime entry points.

## Worker bootstrap, checkpoints and close

All worker envelopes are versioned with `v:1` and sessionId.

- `WorkerBootstrap`: userId, roomName, learnerIdentity, pinned full Course,
  profile `{level,chinese,suggestions}`, recalled Pattern[]. CP writes before
  dispatch; room dispatch metadata contains sessionId, not secrets. Worker
  parses bootstrap before its first line. Never pass full coach findings to the
  character; recalled historical category counts are the allowed memory input.
- `WorkerLease`: workerId, increasing epoch and ISO heartbeatAt. The storage
  adapter fences old epochs; merely validating a lease does not acquire it.
- `WorkerCheckpoint`: workerId, epoch, seq, public snapshot, **all explained**
  identified findings, raw CoachSignal, goalMet and learnerTurns. Snapshot.cards
  is the admitted rail subset. Raw findings are retained for debrief and memory.
  Enforce nice <= total at runtime. Zero observations is unknown, not a zero score.
- `CloseRequest`: commandId and reason; CP/worker close requests are idempotent.
- `CloseAck`: commandId, workerId, epoch, finalSeq, final SessionRecord. Record
  sessionId must match the envelope. Receiver also checks the outstanding close
  request, worker epoch, course identity and frozen high-watermark.

Worker stops accepting new turns, bounds completion of in-flight work, publishes
session.ended and freezes before writing CloseAck. finalSeq includes that ended
event. No transcript/finding/event mutations after the acknowledged freeze.
Ack records use the existing debrief SessionRecord shape; its findings are all
complete explained findings, with dedupe already applied from checkpoints.

CP persists an immutable debrief before deleting live data. If the worker dies,
recover from its last valid checkpoint after lease expiry; do not fabricate an
empty record for missing/corrupt data. Concurrent/stale finalizers require
storage-level fencing and one-time durable completion, not process-local locks.

### Redis keys and encoding

`sessionKeys(sessionId)` returns cluster-colocated keys under
`rehearsal:{sessionId}:`; session IDs must not contain braces.

| Suffix | Encoding | Writer |
|---|---|---|
| bootstrap | JSON WorkerBootstrap string | CP before dispatch |
| lease | JSON WorkerLease string | worker through atomic lease/fencing adapter |
| checkpoint | JSON WorkerCheckpoint string | active worker |
| events | Redis stream; one `event` field containing DurableServerEvent JSON | active worker |
| commands | Redis hash; command ID -> CommandAck JSON | active worker |
| close-request | JSON CloseRequest string | closing initiator, first request wins |
| close-ack | JSON CloseAck string | active worker after freeze |

Use exact `MAXLEN 256` trimming for replay events; checkpoint is the consistent
snapshot fallback. Publish/checkpoint/sequence updates, dedupe, lease validation
and freeze are atomic adapter responsibilities (transaction/Lua), not helpers
implemented by this package. Retrying duplicate commands reuses stored ack JSON.
Renew live-key TTLs while active; keep close/checkpoint state until durable
completion or a documented recovery retention deadline. No raw transcript is
written to SQLite; persistent debrief corrections may retain corrected quotes.

## Validation

Run `pnpm --filter @rehearsal/contracts check:contracts`, `pnpm check`,
`pnpm --filter @rehearsal/contracts typecheck` and `build`.
After schema edits run `codegen:schema`, then `codegen`; generated schemas/client
are committed, never manually patched. Tests cover schema rejection, sequencing,
raw fetcher responses/errors, generated operation semantics and worker boundary
invariants. They do not claim that consumer storage, auth or LiveKit adapters
already implement this protocol.
