# Rehearsal web

React/Vite/Tailwind client for the shared 0.2 HTTP contract and realtime v1.

## Local development

From the workspace root:

```sh
pnpm install
pnpm --filter @rehearsal/contracts build
pnpm --filter @rehearsal/web dev
```

Vite serves `http://localhost:5173` and proxies `/api` to
`http://localhost:3000`. Set optional `VITE_API_PROXY_TARGET` in the root `.env`
to change that development proxy target. It must be an origin, not a secret.
No provider credentials or LiveKit API secrets belong in browser configuration.
The room URL/token come exclusively from `POST /api/sessions`.

Control-plane must be running with the development-only fixed user/cookie
bootstrap at `GET /api/me`. An explicit profile level save completes onboarding;
there is no browser-local onboarding flag. Live voice additionally needs the
worker, LiveKit and the configured providers. Microphone capture requires
localhost or HTTPS; browser autoplay may require the visible Enable audio button.

## State and transport

Generated React Query hooks own profiles, catalog, progress and debrief.
Successful HTTP bodies are zod-validated. The zustand store holds only ephemeral
live UI state.
The LiveKit controller owns media resources, pending commands and cleanup.
No transcript or credential is written to browser storage.

Only reliable `rehearsal.v1` messages from `agent:${sessionId}` are accepted.
Commands use `seq=0`, stable IDs and three attempts with the identical body.
Worker events advance a contiguous cursor; gaps trigger correlated sync. Replay
is validated before application, live events are buffered during sync, and a
snapshot is a full public-state replacement. No access to worker bootstrap,
Redis, checkpoints or private CloseAck.

its own ASR or TTS queue.

Explicit End stops capture/playback and calls the idempotent CP end endpoint;
CP owns flush/freeze/CloseAck. Natural `session.ended` (including a replayed ended
snapshot) opens debrief. GET 409 polls ten times at two-second intervals, then
offers manual retry/finish. Offline/error responses remain visible.

Cold live-route reload cannot resume: there is no token-renewal HTTP endpoint.
It offers finish/retrieve debrief instead. In-room transient reconnect uses the
existing SDK connection and realtime replay. Tab-close finalization relies on
server disconnect/lease recovery, not an unreliable unload request.

## My progress

`/progress` is the fifth screen: an onboarded-gated route reachable from the
Scenes and Debrief headers. `useProgress()` validates the server body with the
`Progress` contract and caches it for 30 seconds; finishing a session invalidates
that cache so the attempt appears without a reload.

The screen renders the states, marks and order the server sends and derives none
of them. It never decides whether a goal is met, which attempt won, or where a
scene belongs in the list — it picks an icon and a label for each state the
server already named, adds up per-attempt counts for its summary line, and
formats, joining course titles and turning `durationMs` into minutes.
`Progress.goals[].courseId` is the same business id `CourseCard.id` uses, which
is why the screen can look the catalog up for avatars and level metadata while
the goal states stay server-owned. Attempt counts that the mockup labels
"upgrades" are the contract's `nit` — the "try this instead" card.

`useBeginScene(profile)` is the one scene-opening flow, shared by Scenes and the
progress resume button so the two entry points cannot drift. A suggestion tap
sends `suggestions.adopted` best-effort *before* the `learner.text` command, so a
failed or retried reply still counts the tap the learner actually made; the tap
is dropped rather than surfaced as an error, because progress is not worth
interrupting a scene for.

## UI scope

Five functional screens preserve the existing mockup palette and hierarchy.
Live variants share the same transcript/rail. Suggestions fill an editable
typing draft, never automatically submit. The debrief renders only supported
contract fields; no fabricated duration, score, learner name or recommendation
reason. The recommended next scene can be started directly. Progress shows what
the contract reports and adds no score, streak or ranking of its own.

Mobile layouts use natural flow, a non-overlay coach rail, wrapping controls and
sticky input controls. The original design documentation/assets are untouched.
There is no Docker work, Playwright, screenshot test or smoke-test script.

## Focused validation

```sh
pnpm --filter @rehearsal/web test
pnpm --filter @rehearsal/web typecheck
pnpm --filter @rehearsal/web build
```

Tests exercise replay/deduplication/snapshots, malformed event rejection,
terminal state, typed provenance, transcript retention, praise and cleanup.
Mocked LiveKit controller tests also verify authenticated sender/topic filtering,
stable-ID retries, acknowledgment correlation, replay completion, microphone
denial and ending while the connection is still pending. They use no server,
browser automation or external provider. No test covers `Progress.tsx` itself:
the states, marks and order it displays are asserted in contracts and
control-plane, so a browser test would only restate them. These tests do not
prove microphone, autoplay, interruption latency, provider availability or
CP-worker finalization; those require actual service acceptance.
Build output is `apps/web/dist`. A production host needs SPA index fallback and
a same-origin `/api` reverse proxy; Vite's development proxy is not bundled.
