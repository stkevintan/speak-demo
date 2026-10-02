# Control-plane

Local-first NestJS API against contracts 0.2.0 / realtime v1. SQLite stores
profiles, validated courses, session metadata, immutable debriefs, per-session
metrics and category memory. Redis stores live checkpoints, leases and the close
handshake. Media never passes through this process.

SQLite persistence uses **Drizzle ORM and fully normalized tables**: no JSON
columns, document serialization, or JSON extraction. See [DATABASE.md](../../docs/DATABASE.md)
for the tables, relationships, transaction boundaries, the progress read model
and learned/unlearn rules.

**Fresh start:** the app now opens `DATA_DIR/rehearsal-v3.sqlite`. Existing
`rehearsal.sqlite` and `rehearsal-v2.sqlite` (plus their `-wal`/`-shm` companions)
are untouched. There is no migration/import: old profiles, history and memory
remain in the old databases and do not appear in the app. YAML courses populate
the new catalog normally. Restarting preserves data already written to the v3
database.

## Local setup

From the workspace root:

```sh
pnpm install
pnpm --filter @rehearsal/contracts build
pnpm --filter @rehearsal/control-plane dev
```

Start Redis separately (`redis-server` locally), or use the repository-root
`docker compose up --build` stack. Configure a running LiveKit server and the
named worker; Docker does not provide a fake provider fallback.
The worker must use explicit dispatch with the same `LIVEKIT_AGENT_NAME`.

Set these variables in the repository-root `.env` (never commit values):

| Variable | Default / requirement |
|---|---|
| JWT_SECRET | Required, at least 32 characters |
| REDIS_URL | Required, redis:// or rediss:// |
| LIVEKIT_URL | Required, ws:// or wss://, browser-reachable |
| LIVEKIT_API_KEY, LIVEKIT_API_SECRET | Required; server-only |
| LIVEKIT_AGENT_NAME | rehearsal-agent |
| WEB_ORIGIN | http://localhost:5173, exact origin without trailing slash |
| HOST, PORT | 127.0.0.1, 3000 |
| NODE_ENV | development |
| DEV_AUTH_ENABLED | true only by default in development; forbidden in production |
| JWT_ISSUER, JWT_AUDIENCE | rehearsal-control-plane, rehearsal-web |
| JWT_TTL_SECONDS | 86400 |
| LIVEKIT_TOKEN_TTL_SECONDS | 3600 |
| DATA_DIR | apps/control-plane/.data relative to workspace root |
| COURSES_DIR | courses relative to workspace root |
| ENV_FILE | Optional absolute environment-file override |
| SESSION_LIVE_TTL_SECONDS | 86400, minimum 120 |
| SESSION_START_GRACE_MS | 30000 |
| SESSION_CLOSE_TIMEOUT_MS | 5000 |
| SESSION_SWEEP_SECONDS | 5 |

Real process environment takes precedence over `.env`. Paths resolve relative
to the module/workspace, never the launch directory. Packaged deployments must
provide absolute data/course paths; ENV_FILE can explicitly name their env file.
The data directory must be writable. SQLite uses WAL, foreign keys and a 5-second
busy timeout. Pin Node/pnpm through the integrating workspace's environment;
`better-sqlite3` may need native compilation on a new Node release.

Production auth accepts existing signed JWTs but does not implement login:
never enable the dev bootstrap on a public deployment. GET `/api/me` without a
cookie bootstraps fixed `dev-user` only in development. The JWT cookie is
HttpOnly/SameSite=Lax and Secure outside local HTTP. Invalid cookies return 401;
clear an invalid/expired development cookie then reload GET `/api/me`.
Mutations require Origin equal to WEB_ORIGIN; a rejected Origin returns
403 `{code:"origin_rejected",message}`. CORS is credentialed and restricted.
Profile defaults are B1, Chinese on, suggestions on, onboarded false. Saving
level, including Skip, marks onboarding complete; changing only preferences
does not.

## Boundaries and lifecycle

Feature modules depend on ProfileRepo, CourseRepo, SessionRepo, PatternRepo and
LiveSessionStore ports. Only StorageModule imports SQLite/Redis drivers.
CourseModule uses shared loadCourse/toCourseCard; invalid course files are
logged with their filename and omitted, duplicates/empty catalog fail startup.
Restart imports YAML updates. Each session references its own immutable course
definition and normalized profile snapshot, so later course/profile edits
cannot change an existing session's context. Catalog replacement removes only
unreferenced definitions and cascades their child rows.

Session start durably registers metadata, initializes bootstrap and an empty
idle checkpoint, creates a room, explicitly dispatches the worker, and mints a
room-limited learner token. Failure compensates room/Redis state and leaves a
retryable cleanup record. Initial checkpoint workerId is `control-plane:init`,
epoch 1; the worker must acquire a greater epoch.

The reaper runs every 5 seconds by default and scans durable unfinished/cleanup
records; restarting the API does not forget pending work. The in-process sweep
flag only prevents overlapping scans in one process; Redis/SQLite enforce
cross-process correctness.

- Worker lease is **PX 15000**, renewed every **5000 ms**, with atomic
  workerId/epoch fencing. Lease presence is authoritative, not a clock estimate.
- Close requests use SET NX; every initiator honors the winning commandId/reason.
- Worker writes the frozen final checkpoint and CloseAck together. CP validates
  session/course ID, commandId, reason, workerId, epoch and finalSeq against the
  stored checkpoint. A valid ack remains usable after lease expiry.
- Without an ack, CP waits for a live worker. On lease expiry it atomically
  compares the last checkpoint and winning request and publishes a frozen ack.
  Worker acquisition must refuse any existing closeAck or missing bootstrap;
  otherwise reacquisition could invalidate recovery.
- Before any worker acquires a lease, startup grace avoids premature network
  recovery. Explicit user End may finalize the initialized empty checkpoint.
- Natural goal/budget completion uses the same Redis handshake. There is no
  internal HTTP endpoint.
- A close taking longer than the bounded request wait returns 503; the reaper
  continues. GET debrief returns 409 until the result is durably committed.
- Missing/corrupt checkpoint is an explicit error, never a made-up empty
  conversation. A legitimately initialized empty checkpoint produces a useful
  debrief without claiming language proficiency.
- SQLite inserts one immutable debrief and a category-update ledger in one
  transaction. Applying memory is best-effort, retryable and exactly once.
  Remove the LiveKit room, then Redis keys, only after durable completion.
  Cleanup failure does not erase a completed debrief.

`won` is goalMet, never coach rate. Every available complete correction is
included; repeated categories are counted independently of UI admission.
Praise always has a truthful floor. SQLite never stores the full transcript;
debrief corrections intentionally retain corrected quotes. Memory stores only
category/count/time. No extra LLM call is needed for a debrief.

## My progress

`GET /api/progress` is a read-only, `AuthGuard`-protected projection, and the
controller derives nothing. It gathers `CourseRepo.listCourses()` and
`SessionRepo.attempts(userId)` and hands both to `progressView` from
`@rehearsal/contracts`, so the API and the web client cannot disagree about what
a goal state, an attempt mark or an ordering means. `Progress.parse` guards the
boundary: a regression in the contract fails the request instead of being served.

`attempts()` is the read model behind it. It inner-joins each session's own
course definition and left-joins `debriefs` and `session_metrics`, because an
attempt with no debrief or no metrics row is a real attempt that scored nothing,
not a missing row. It reads `status = 'ended'` sessions only and orders by
`started_at`, oldest first; `progressView` re-groups them into
`unfinished` → `not_started` → `met`, most recent activity first within a group.
A course nobody has touched is a `not_started` goal, not a gap.

`session_metrics` holds one row per ended session — learner turns, scene
duration, suggestions offered/adopted, nice and nit counts — keyed by session ID
and written in the same transaction as the immutable debrief. Every value is
copied from the worker's frozen `CloseAck` record; control-plane never recounts a
turn or a suggestion, so the numbers a learner reads in progress cannot drift
from the debrief they already read. A repeated completion is a no-op, so the
metrics of the attempt that actually completed stand.

`won` is the only input to a mark: `won` is `met`, otherwise `budget` is
`missed` and `user`/`quit`/`network` is `ended_early`. A met goal keeps the
winning attempt as `score` and never regresses; an unfinished goal reports its
latest attempt. Unlearning withdraws the verdict and drops the goal back to
`unfinished` without deleting the attempt.

## Validation

```sh
pnpm --filter @rehearsal/control-plane test
pnpm --filter @rehearsal/control-plane typecheck
pnpm --filter @rehearsal/control-plane build
```

The test command requires `redis-server` on PATH (or REDIS_SERVER_BIN pointing to
it). Redis adapter tests spawn an isolated, persistence-disabled server on a
temporary port and stop only their own process; they never FLUSHDB a shared
server. SQLite tests use temporary directories. Request tests use Nest's real
module graph and fake LiveKit/Redis ports; they are not deployed smoke tests.
No Playwright tests, Docker builds or provider calls run in this suite.

Storage and request tests cover the metrics write path and the whole
`GET /api/progress` derivation: a met goal sorting last, a `not_started` goal for
untouched courses, a second user seeing only their own attempts, a metrics row
surviving repeated completion, and an unlearned course falling back to
`unfinished` while its attempt stays.

Actual LiveKit/worker operation requires the integrating worker and configured
credentials; passing isolated tests does not claim a live voice session.

## Scale limits

SQLite's single writer and local file are the first limit. Replace its port
implementations with Postgres before multi-host API deployment. Keep immutable
completion and category ledger uniqueness. Redis session keys share one hash
slot; worker/reaper fencing remains required. At higher concurrency add indexed
batch recovery, provider admission limits and worker pools. Async debrief jobs
would require a deliberate HTTP/readiness-contract change, not just config.
