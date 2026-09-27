# Control-plane Module

## Purpose

The control-plane is the authenticated, durable coordination service for Rehearsal. It owns HTTP APIs, profiles, course catalog loading, session registration, LiveKit room/token management, Redis lifecycle state, SQLite persistence, recovery, and debrief finalization.

It is not in the agent's real-time conversation loop: audio, transcription, LLM generation, interruption, and event publication continue in the worker/data plane without a synchronous control-plane request.

## Responsibilities

- Bootstrap the development session cookie and resolve the authenticated user.
- Validate profile, session, course, and debrief requests against `@rehearsal/contracts`.
- Load and validate YAML courses, reject malformed/duplicate catalogs, and pin the selected course into each session.
- Create one LiveKit room per session, dispatch the named worker, and issue a room-scoped learner token.
- Persist profiles, session metadata, pinned course snapshots, immutable debriefs, and the idempotent category-memory ledger in SQLite.
- Initialize and coordinate worker bootstrap, checkpoint, lease, replay retention, close requests, and close acknowledgements in Redis.
- Run the 5-second recovery sweep and fence lease-expiry recovery against worker reacquisition.

## Boundaries

`StorageModule` is the only module that knows SQLite and Redis drivers. Feature services depend on repository/store ports. The control-plane never imports worker or browser implementation code; shared shapes come only from `packages/contracts`.

The browser sees public HTTP responses and LiveKit credentials only. `WorkerBootstrap`, `WorkerCheckpoint`, `WorkerLease`, and `CloseAck` remain private Redis-side artifacts.

## Session lifecycle

1. Authenticate and validate the start request.
2. Persist session metadata and the complete pinned course snapshot.
3. Write bootstrap plus the initialized checkpoint (`control-plane:init`, epoch 1, seq 0).
4. Create the LiveKit room, dispatch the worker with `{sessionId}`, and mint the learner token.
5. On End or natural completion, issue a first-wins close request and wait within the bounded request timeout.
6. Accept only a close acknowledgement matching session, course, command ID, reason, worker ID, epoch, and final sequence.
7. On lease expiry, atomically compare the last checkpoint and winning request before freezing recovery.
8. Persist the immutable debrief before deleting LiveKit/Redis state; return HTTP 409 while finalization is pending.

A valid close acknowledgement remains usable after lease expiry. Missing or corrupt checkpoints are errors, never an invitation to fabricate an empty conversation.

## API and security

Mutations require the configured `WEB_ORIGIN` and reject mismatches with `403 origin_rejected`. Development cookie bootstrap is disabled in production. LiveKit tokens are short-lived and restricted to one learner room. Provider/API secrets never leave the server.

## Scaling direction

SQLite is intentionally local-first and single-writer. The repository ports permit a later PostgreSQL implementation before multi-host API deployment. Redis fencing, immutable completion, and the category ledger remain required when adding API replicas. Recovery scans should become indexed/batched as session volume grows.

## Validation

```sh
pnpm --filter @rehearsal/control-plane test
pnpm --filter @rehearsal/control-plane typecheck
pnpm --filter @rehearsal/control-plane build
```

The focused suite covers Nest request behavior, auth and ownership, catalog validation, SQLite restart persistence, Redis close/recovery CAS, reaper behavior, token scope/TTL, and idempotent debrief memory. It does not claim live provider or voice integration.
