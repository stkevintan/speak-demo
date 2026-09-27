# Web Module

## Purpose

The web module is the browser client for onboarding, course selection, live practice, settings, and debrief. It owns presentation and learner interaction, but never owns provider secrets, durable session truth, or worker-private state.

## Responsibilities

- Use generated Orval/React Query hooks for profile, catalog, session, and debrief HTTP calls.
- Use zustand for ephemeral live state: transcript, turn state, coach cards, connection status, and replay cursor.
- Use LiveKit for browser media and reliable `rehearsal.v1` data-channel messages.
- Accept realtime events only from `agent:${sessionId}` with the expected topic, version, session, direction, and schema.
- Send commands with `seq: 0` and stable IDs; retry the identical body and settle only on the correlated acknowledgement.
- Apply durable worker events in contiguous sequence order, trigger sync on gaps, and replace public state with a validated snapshot when history is trimmed.
- Stop capture/playback on End, call the idempotent control-plane end endpoint, and load debrief data after `session.ended`; HTTP 409 means finalization is still pending.

## State ownership

React Query owns server state. zustand owns transient in-room state. The browser does not persist transcripts or credentials and does not access Redis, checkpoints, bootstrap data, leases, or `CloseAck`.

The active session owns its pinned course, level, preferences, and recalled patterns from bootstrap. Later profile changes do not overwrite the live session configuration.

## Live interaction

The UI and controller contain a preliminary interruption path: microphone capture may remain available during character speech, local playback can be silenced, and `learner.interrupt` can be sent. Reliable end-to-end barge-in is not yet implemented, so this is not a supported user-facing capability. The browser does not implement its own ASR, TTS queue, or turn commitment logic.

Reconnect uses the existing SDK connection and protocol replay. A cold page reload cannot resume without token renewal; the UI offers debrief retrieval/finish instead of pretending the old room is recoverable. Ending is terminal for the UI even if stale realtime state arrives later.

## Security and deployment

No JWT secret, LiveKit API secret, OpenAI key, or provider credential belongs in the bundle. The control-plane mints a room-scoped token. Production hosting needs SPA index fallback and a same-origin `/api` reverse proxy; the Vite proxy is development-only.

## Validation

```sh
pnpm --filter @rehearsal/web test
pnpm --filter @rehearsal/web typecheck
pnpm --filter @rehearsal/web build
```

Focused tests cover authenticated sender filtering, stable command retries, acknowledgement correlation, replay/snapshot application, contiguous cursors, terminal state, typed provenance, microphone denial, pending-connect End races, and cleanup. They do not claim browser automation or real voice/provider acceptance.
