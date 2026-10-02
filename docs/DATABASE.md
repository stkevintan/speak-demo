# Control-plane database design

## Scope and technology

The control-plane uses Drizzle ORM with the `better-sqlite3` driver. SQLite owns
durable learner preferences, course definitions, session metadata, debriefs,
session metrics and cross-session category memory. Redis continues to own live
conversations, checkpoints, worker leases and the close handshake.

The schema is declared in `apps/control-plane/src/storage/schema.ts`. Versioned
initialization DDL is embedded in `apps/control-plane/src/storage/initialize.ts`, so source and compiled execution
do not depend on a working-directory-relative SQL file. Tests compare the
initialized table columns with the Drizzle definitions.

## Database file and initialization

- Location: `DATA_DIR/rehearsal-v3.sqlite`.
- The previous `rehearsal.sqlite` and `rehearsal-v2.sqlite` files and their
  WAL/SHM files are left untouched.
- A fresh database is created in one immediate transaction and marked with
  `PRAGMA user_version = 3`. Reopening the same supported version preserves data.
- An unexpected version or nonempty, unversioned database at the new path is
  rejected rather than reset. Failed initialization closes the connection.
- WAL mode, foreign-key enforcement and a 5-second busy timeout are enabled.
  Backup/restore procedures must account for WAL, preferably using SQLite's
  backup facilities rather than copying a live main file alone.

## Type and naming conventions

IDs are text. Course `id` is a business identifier such as `refund`;
`definition_id` is a separate, generated immutable-record identifier. They
must not be confused.

Booleans are SQLite integers mapped to TypeScript booleans. Session times are
integer milliseconds since the Unix epoch. Pattern `last_seen` and ledger
`seen_at` retain the existing string contract and are written as ISO timestamps.
Enums have typed TypeScript columns and application-boundary Zod validation.

Every ordered child collection uses a zero-based `ordinal` as part of its
composite primary key. Reads explicitly order by `ordinal`; neither insertion
order nor a row ID is treated as array order. Duplicate array values are valid
and are retained.

## Tables

| Table | Primary key | Other columns / purpose |
|---|---|---|
| `profiles` | `id` | `level`, `onboarded`, `chinese`, `suggestions`: mutable learner preferences |
| `course_definitions` | `definition_id` | `course_id`, `version`, `title`, `accent`, optional `learner_turn_budget`; scalar avatar, stakes, counterpart and prompt fields described below |
| `course_levels` | `(definition_id, ordinal)` | `level`: ordered CEFR bands for an immutable course definition |
| `course_hints` | `(definition_id, ordinal)` | `hint`: ordered coach-hint text |
| `courses` | `id` | `definition_id`: current catalog's reference to a definition |
| `sessions` | `id` | `user_id`, `room_name`, `course_definition_id`; profile snapshot fields; `status`, `started_at`, optional `ended_at`/`end_reason`, `cleanup_needed` |
| `session_profile_patterns` | `(session_id, ordinal)` | `category`, `count`, `last_seen`: historical patterns recalled when the session was created |
| `debriefs` | `session_id` | `won`, `headline`, `next_id`, `next_title`: one completed debrief per session |
| `debrief_worked` | `(session_id, ordinal)` | `message`: ordered praise/factual encouragement |
| `debrief_watch` | `(session_id, ordinal)` | `message`: ordered repeated-pattern guidance |
| `debrief_corrections` | `(session_id, ordinal)` | `category`, `quote`, `better`, `en`, `zh`: every available complete correction in order |
| `session_metrics` | `session_id` | `duration_ms`, `learner_turns`, `suggestions_offered`, `suggestions_adopted`, `nice_count`, `nit_count`: what one attempt scored (`ARCHITECTURE.md` §5.8) |
| `patterns` | `(user_id, category)` | `count`, `last_seen`: aggregate memory across sessions |
| `pattern_updates` | `session_id` | `user_id`, `seen_at`, `applied`: exactly-once memory-update ledger |
| `pattern_deltas` | `(session_id, ordinal)` | `category`, `count`: ordered category increments for a ledger entry |

### Course scalar fields

`course_definitions` flattens nested singular objects:

| Domain object | Columns |
|---|---|
| `avatar` | `avatar_style`, `avatar_mood`, `avatar_hair`, `avatar_skin` |
| `stakes` | `stakes_you`, `stakes_setting`, `stakes_edge` |
| `counterpart` | `counterpart_name`, `counterpart_role`, `counterpart_goal` |
| `prompts` | `character_prompt`, `coach_prompt` |
| Other content | `goal`, `opener` |
| Optional `budget` | `learner_turn_budget`; SQL NULL reconstructs an omitted domain property |

### Session profile snapshot fields

`sessions` contains `profile_user_id`, `profile_level`, `profile_onboarded`,
`profile_chinese` and `profile_suggestions`. Together with
`session_profile_patterns`, these reconstruct the immutable profile passed to
the session. Later profile edits or memory updates must not change this snapshot.

The current `profiles` row does not store a second copy of aggregate patterns.
The existing ProfileService/MemoryService composition attaches current patterns
from the `patterns` repository. An initially created profile therefore still
returns an empty pattern list before that composition.

### Session metrics

One row per attempt that reported an end, written in the same transaction as the
debrief. It is deliberately **not** a column on `debriefs`: `unlearnCourse`
deletes winning debriefs, and withdrawing a verdict must not erase what the
attempt scored.

| Column | Meaning |
|---|---|
| `duration_ms` | Time the worker spent in the scene, so a reconnect gap is not counted as practice. An attempt that never reported metrics falls back to `ended_at - started_at` |
| `learner_turns` | Learner utterances, as the record counted them |
| `suggestions_offered` / `suggestions_adopted` | Hints emitted, and the ones the learner tapped (`ARCHITECTURE.md` §6.3) |
| `nice_count` / `nit_count` | ✓ and ⚠ cards the learner actually saw — the **admitted** `coach.card`s, not the raw `CoachSignal` counts, which also include findings `admit()` filtered out |

Counts and a duration only. No transcript, no quote, no correction text.

`won` is not stored here. It stays on `debriefs`, which is what makes the
progress "met" count and the picker's learned badge the same read.

## Relationships and deletion policy

| Parent -> child | Foreign key | Delete behavior |
|---|---|---|
| `course_definitions` -> `course_levels`, `course_hints` | `definition_id` | Cascade dependent content rows |
| `course_definitions` -> `courses` | `definition_id` | Restrict deleting a definition still in the catalog |
| `course_definitions` -> `sessions` | `course_definition_id` | Restrict deleting a pinned session definition |
| `sessions` -> `session_profile_patterns` | `session_id` | Cascade snapshot patterns if session deletion is added later |
| `sessions` -> `debriefs` | `session_id` | Restrict deleting a session with a debrief |
| `debriefs` -> worked/watch/corrections | `session_id` | Cascade when an explicit unlearn operation deletes a winning debrief |
| `sessions` -> `pattern_updates` | `session_id` | Restrict deleting a session with a memory ledger |
| `sessions` -> `session_metrics` | `session_id` | Restrict deleting a session whose attempt was scored |
| `pattern_updates` -> `pattern_deltas` | `session_id` | Restrict deleting an update before its deltas |

User IDs retain the current storage-port behavior: session/memory writes do not
require that a mutable profile row already exists. Service authentication and
owned-session lookup enforce caller isolation. Repository learned/unlearn
queries also include `user_id` explicitly.

`debriefs.next_id` intentionally does not reference the current catalog: a
historical recommendation must remain readable after a course is removed.

## Repository operations and transactions

### Profiles

Get-or-create inserts the default profile without overwriting existing data.
PATCH validates its allowed fields, reads the current profile and updates it
in one immediate transaction. An explicit `level` sets `onboarded=true`;
preference-only PATCH cannot complete or undo onboarding.

### Catalog replacement and pinned definitions

Course documents are validated before insertion. Catalog replacement runs as
one immediate transaction:

1. Remove the previous catalog references.
2. Insert normalized definitions, levels and hints, then their catalog entries.
3. Delete definitions no longer referenced by either the catalog or a session.
   Their levels/hints cascade.

A failure, including duplicate course IDs, rolls back all of these steps.
Sessions insert and reference their own immutable normalized definition, so a
same-ID course edit or removal does not rewrite old session context.

### Sessions and debriefs

Creating a session inserts its definition, metadata, profile scalar snapshot
and recalled-pattern children atomically. A duplicate or invalid session cannot
leave orphaned snapshot content.

State transitions preserve terminal `ended`/`failed` records. A delayed
`starting -> live` update cannot reopen a session already closing.

Completion acquires the writer lock, returns an existing debrief unchanged, or
atomically inserts:

1. The debrief parent and ordered praise/watch/correction children.
2. The session's metrics row, when the record reported one.
3. One unapplied memory ledger and its category deltas.
4. The session's terminal state, end time/reason and cleanup flag.

Metrics ride the same transaction as the terminal state, so an attempt cannot end
without its score and a retried completion cannot write two. `complete()` takes
the metrics alongside the debrief, which is why the signature grows by one
argument rather than gaining a second write path.

The debrief remains immutable except for the explicitly requested unlearn
operation below. Live Redis cleanup happens outside this transaction, after
durable completion, through the existing session service.

### Learned courses and unlearn

`learnedCourses(userId)` joins that user's `ended` sessions to winning debriefs
and their pinned course definitions, returning distinct course business IDs.
Losing debriefs, active sessions and other users do not establish learned state.

`unlearnCourse(userId, courseId)` transactionally deletes **all winning debriefs**
whose sessions match that user and course. Their child debrief rows cascade.
The operation is idempotent and does not change:

- Other users' or other courses' debriefs.
- Losing debriefs for the selected course.
- Sessions, pinned definitions or profile snapshots.
- Applied/unapplied memory ledgers or aggregate patterns.
- Session metrics — the attempt keeps the score it earned.

The progress view consequently moves that course from `met` back to `unfinished`
while its attempts and scores stay, which is what unlearn means: it withdraws the
verdict, not the practice.

This deliberately preserves the existing product implementation, rather than
introducing a separate learned marker. Consequently, unlearn also removes those
winning debriefs from history; the existing read API then reports no stored
debrief. The controller and HTTP contract remain outside this storage refactor.

### Progress

`attempts(userId)` reads one row per session belonging to the user — pinned
course business id, `started_at`, `debriefs.won` (false when no debrief exists)
and the metrics row — ordered by `started_at`. It is a read-only join; nothing is
written and nothing is cached.

The derivation is not in the repository. `progressView()` lives in
`packages/contracts` beside `toCourseCard()`, so the API and any offline caller
cannot disagree about what "met" means (`ARCHITECTURE.md` §5.8). The controller
composes it with the catalog it already loads for `GET /api/courses`.

Because the three states are derived, there is no progress table and no migration
when the rules change. The one stored input is the metrics row, and its absence
is meaningful: an attempt with neither metrics nor debrief is one the learner
abandoned, which reads as `unfinished` and can never read as `met`.

### Memory

Pending memory updates are applied in one immediate transaction. Category
counts are incremented with typed Drizzle upserts, `last_seen` takes the later
timestamp, and each ledger is marked applied only after all its deltas succeed.
Retries and repeated completion cannot increment memory twice. Empty delta
lists and multiple deltas for the same category are supported.

## Indexes and constraints

- Sessions: `(user_id, status)`, `course_definition_id`,
  `(status, cleanup_needed)` and `(user_id, started_at)` support learned-state
  joins, pinned-definition retention checks, recovery selection, and ordering one
  learner's attempts for the progress read.
- Pending ledger: index on `applied`.
- Child primary keys provide both parent lookup and stable array ordering.
- Positive counts, nonnegative timestamps/ordinals, booleans and session
  states have initialization-time SQL constraints. Zod validates reconstructed
  domain objects, including constraints spanning multiple child rows.

## Privacy and operational limits

No complete conversation transcript is persisted in SQLite. Corrected quotes
are retained as explicit correction text. Aggregate memory contains categories,
counts and timestamps, not full sentences. Session metrics are counts and one
duration, and add no text at all.

SQLite is still a local, single-writer database. Immediate transactions avoid
read-then-write upgrade races, but do not make it a multi-host database. The
repository interfaces remain the replacement boundary for a future Postgres
implementation. No HTTP behavior, worker protocol, or Redis storage is changed
by choosing Drizzle.

## Verification

Run the control-plane tests, typecheck and build. Storage coverage verifies
normalized-object round trips, ordering/duplicates, pinned course/profile
snapshots across catalog changes and restarts, atomic failure rollback,
exactly-once memory, learned/unlearn isolation, metrics surviving unlearn,
fresh-file initialization, foreign keys/schema columns, and that the old
database/WAL/SHM bytes are untouched. Contract coverage verifies the progress
derivation: the three counts, attempt ordering, repeat handling and the rule that
a missing debrief reads `unfinished` and never `met`. No real user database is
opened during tests.
