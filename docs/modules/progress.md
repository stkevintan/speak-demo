# My Progress Module

## Purpose

`PRODUCT.md` and `docs/design/UI.md` §4.8 define one screen: the learner's goals,
what each attempt scored, and a way back into the scene they left. The shapes are
in `ARCHITECTURE.md` §5.8, the table is in `DATABASE.md` "Session metrics", and
the rules live in `packages/contracts/src/progress.ts`.

This document is the per-application half: **which app owns which part of that
feature, and when each part happens.** Read it beside `web.md`,
`control-plane.md` and `agent-worker.md`; it adds one feature across all three
and changes nothing about their existing boundaries.

This is the one screen that shows a number. It is a 0–100 score per attempt,
weighted so that meeting the goal is worth 55 of it and the three engagement
counters share the other 45 — see "The score" below for why that split is
load-bearing rather than cosmetic.

## The one new input

Everything §5.8 needs already existed except one number. Duration, learner turns,
`goalMet` and the ✓/⚠ findings already ride with the `SessionRecord` at `end()`;
the catalog already has every goal. Suggestion adoption is the single addition,
because only the browser knows the learner tapped an example rather than typing
their own words.

So the feature is one counted event, one table row, one read, and one screen. The
only derived state is the score, and it is a pure function over data the screen
already receives: no progress table, no stored score, and no trend for a client
to second-guess.

## agent-worker

The worker is the only component that observes a scene as it happens, so it is
the only component that counts. It accumulates `SessionMetrics`
(`{durationMs, suggestionsOffered, suggestionsAdopted, nice, nit}`) on the
`WorkerCheckpoint` and reports it with the record at `end()`.

| Counter | Incremented when | Why there |
|---|---|---|
| `durationMs` | `finish()`, from the injectable timer, not the wall clock | Scene time, so a reconnect gap is not counted as practice |
| `suggestionsOffered` | a `suggestions` event is **actually emitted** | The offer is retried and gated; only a delivered offer was offered |
| `suggestionsAdopted` | a `suggestions.adopted` command is accepted **against the current offer** | The worker owns `snapshot.suggestions`, so it decides whether a tap answers anything |
| `nice` / `nit` | a `coach.card` passes `coach.admit()` | The **admitted** cards — what the learner saw — not `CoachSignal`, which counts raw findings `admit()` filtered out |

Three rules keep the counters honest:

- **Count on write, not on intent.** The counters move inside the `mutate`
  callback of the `emit()` that persists the event, so a failed or abandoned
  write cannot leave a count for something the learner never saw.
- **The offer is consumed by the tap.** Accepting an adoption clears
  `snapshot.suggestions` in the same write. Since only a `suggestions` event sets
  it and every such event counts, adoptions cannot exceed offers — the invariant
  `SessionMetrics` refines on, which would otherwise throw inside the write and
  brick the session on a double-tap.
- **An adoption is a tap, not a citation.** `suggestions.adopted` carries only
  `{optionIndex}`. A tap that no longer matches a live offer is acknowledged and
  not counted: the learner's reply is never lost to a metric.

`WorkerCheckpoint.metrics` is optional, and the counters must be preserved when a
checkpoint is recovered — `store.ts` `freeze()` rebuilds the record from the
checkpoint and asserts it equals the acknowledgement, so live and recovery paths
must agree. `emptyMetrics()` in `packages/contracts` is the defined zero the
control-plane initializes.

The worker still never reads SQLite, never computes `Progress`, and never decides
what a mark means. It counts and hands over.

## control-plane

The control-plane persists what the worker counted and derives what the screen
reads. It is the only app that touches `session_metrics`.

### Persist

`CloseAck.record.metrics` is the only source. `SessionService.finalize()` already
threads the acknowledgement into `SessionRepo.complete()`; metrics ride the same
call and land in the **same immediate transaction as the debrief**. A retry that
finds an existing debrief returns before writing anything, so completion stays
idempotent.

The table is real columns, never a JSON blob: `session_id`, `learner_turns`,
`duration_ms`, `suggestions_offered`, `suggestions_adopted`, `nice_count`,
`nit_count`. It is separate from `debriefs` on purpose — `unlearnCourse` deletes
winning debriefs, and withdrawing a verdict must not erase what the attempt
scored. A `CHECK (suggestions_adopted <= suggestions_offered)` restates the
contract invariant where the data lives.

The DDL is versioned by filename, as it already was: this is schema **v3**
(`rehearsal-v3.sqlite`, `PRAGMA user_version = 3`). An older database is left on
disk untouched and a fresh one is created; there is still no migration
mechanism, and `DATABASE.md` "Database file and initialization" says so.

### Read

`SessionRepo.attempts(userId)` returns `AttemptRow[]` — one row per ended
session of that user, ordered by `started_at`: the pinned course **business**
`courseId` (never `definition_id`; a content edit must not split one learner's
history), `startedAt`, `endedAt`, `debriefs.won` (false when no debrief exists),
`endReason`, `learner_turns` and the nullable metrics.

`won` is read from `debriefs`, the same read `learnedCourses()` uses. That is
what makes the picker's learned badge and the progress `met` count impossible to
disagree, and it is why unlearning withdraws a `met` here too.

`GET /api/progress` composes the catalog with those rows through `progressView()`
and parses the result with `Progress` before it leaves the server. The
derivation is not in SQL and not in the controller: `progressView()` lives in
`packages/contracts` beside `toCourseCard()`, so an offline caller and the API
cannot disagree about what "met" means. The endpoint is derived state — nothing
is written, nothing is cached, and there is no `progress` table to migrate when
the rules change.

## The score

`attemptPoints()` and `overallPoints()` live in `packages/contracts/src/progress.ts`
beside `progressView()`, for the same reason: `history` is derived from persisted
rows, so a rule that lived in a component would let two clients show two different
scores for the same saved attempt.

| Component | Max | Full marks when |
|---|---|---|
| Goal | 55 | `won` |
| Time on task | 15 | 6 minutes of scene time |
| Suggestions adopted | 15 | 3 adopted |
| Coach cards | 15 | 6 admitted (`nice + nit`) |

Every component is clamped by `share()` before it is added, so an attempt cannot
exceed 100 by talking longer or collecting more cards than the cap.

**The split is the rule.** A win scores at least 55 and a miss at most 45, so the
number can never contradict the *Goal met* badge printed beside it — no amount of
time or chattiness lets a failed attempt outrank a successful one. That invariant
is asserted directly (`bestMiss === 45`, `worstWin === 55`), and it is the reason
the goal is worth more than half rather than a proportional share.

Two derived numbers ride on it:

- **A scene's score** is the attempt referenced by `GoalProgress.score` — the
  winning attempt once the goal is met, otherwise the latest — not the best
  attempt. It matches the existing `score` semantics, so the scene row and the
  attempt list cannot disagree.
- **The overall score** is the rounded mean of `points` across goals with
  `attempts > 0`, and `null` when there are none. Unstarted scenes are excluded
  rather than counted as zero, which is why the homepage shows no ring at all for
  a learner who has not started.

`ProgressAttempt.points` and `GoalProgress.points` are in the zod schemas with
the same 0–100 bound, and `GoalProgress` refines that `points` matches the scored
attempt's `points`, so a body that disagrees with its own `history` is rejected
before it leaves the server.

## web

The web renders and nothing more. It never computes a mark, an order, or an
attempt's score — `overallPoints()` is the only derivation it calls, and it lives
in `packages/contracts` with the rest of the rules.

- `useProgress()` wraps the generated `useGetProgress` and validates the body
  with `Progress`, like every other hook.
- `/progress` is a route beside `/scenes`, reachable from the topbar. Loading,
  failure and retry use the existing `Busy` / `Problem` components.
- The screen reads straight from the response: the count tiles are
  `totals.met` / `totals.unfinished` / `totals.notStarted`; a scene row's chips
  are `history`, its badge is `state`, and its ring is `points`; "Attempt by
  attempt" is `score` and its `history`, each row showing that attempt's `points`
  out of 100; the footer aggregates `history` across goals.
- The score is never recomputed, re-weighted or rescaled in the browser. The
  homepage ring reads `overallPoints(goals)` and the per-scene rings read
  `points`, so the recap bar and the progress screen are the same numbers by
  construction. A scene with `attempts === 0` renders no ring, and a learner with
  no attempts renders no headline ring — an absent score, not a zero.
- **"Pick up where you left off"** targets `goals[0]`. The server already orders
  `unfinished` first and, within it, freshest first, so the freshest unfinished
  goal is the first element by construction — the screen needs no field of its
  own to know where the learner stopped.

The one live-app change is in `Live.tsx`: tapping a suggestion option now sends
`suggestions.adopted` with the option index in addition to the `learner.text`
that was already sent. Both publish synchronously in that order, so the adoption
reaches the worker before the reply that ends the offer. Adoption is best-effort
— a tap that fails to report never blocks or fails the learner's reply, because
the reply is the point and the count is a report about it.

## Boundaries

| Concern | Owner |
|---|---|
| Counting a scene as it happens | agent-worker |
| Persisting one metrics row per attempt | control-plane |
| Deriving state, marks, numbering, order, totals, score | `packages/contracts` (`progressView`, `attemptPoints`, `overallPoints`) |
| Rendering | web |

No app derives a rule another app already owns, and no app reads another's
private state to do it. The browser never sees a checkpoint or a metrics row, and
the worker never sees SQLite.

## Validation

```sh
pnpm --filter @rehearsal/agent-worker test
pnpm --filter @rehearsal/control-plane test
pnpm --filter @rehearsal/web test
pnpm --filter @rehearsal/contracts check:contracts
```

Coverage per app: the worker counts offers, adoptions and admitted cards and
reports them in the frozen record; the control-plane persists metrics in the
completion transaction, reads attempts, and serves a validated `Progress` body
including for a learner with no attempts at all; the web validates the body and
reduces the live events it already handled; `check:contracts` asserts the score's
0–100 bounds, its caps, its monotonicity in time, and the invariant that a win
outranks any miss. As in the other module docs, these suites do not claim browser
automation or real voice/provider acceptance.
