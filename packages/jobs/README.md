# @osai/jobs

Durable job queue for generation work: survives a restart, visible across every
project, priority-ordered.

```bash
npm test --workspace @osai/jobs
npm run typecheck --workspace @osai/jobs
```

## Why this exists

Every persona in the user journeys leaves the app mid-generation. Maya closes the
laptop (F3). Deon queues four projects and does something else entirely (F9) — the
global Jobs view is his *primary* screen, not a notification tray, and he needs to see
what's done and what broke across all four at a glance. Compute contention across
concurrent projects has to be visible, ideally controllable (F10). And scrapping a bad
draft has to be as cheap as shipping a good one (F11) — no salvage pressure.

## Why SQLite, when @osai/persistence uses JSON files

`@osai/persistence` stores one project per file because a project is loaded by id, one
at a time. Jobs are queried a different way entirely: "everything queued, highest
priority first, across every project" and "counts by status, per project" (the global
Jobs workspace). That's a real query pattern, not a lookup, so this package reaches for
`node:sqlite` — Node's built-in module (Node 22+) — rather than a native-binary
dependency like better-sqlite3. One less thing that can fail to compile on a platform.

## The model

**`Job`** is one unit of generation work against a specific project node. What the work
actually *is* stays opaque `payload` — this package only schedules and tracks, the same
way `@osai/core` only records results and never spends compute.

**`JobStore`** is dumb CRUD plus one atomic operation, `claimNext`, which flips the
highest-priority queued job to `running` in a single `UPDATE ... RETURNING` — what
stops two workers from claiming the same job. `SqliteJobStore` is the only
implementation so far.

**`JobQueue`** owns everything `JobStore` deliberately doesn't: retry policy,
concurrency, and terminal notification.

```
JobQueue.enqueue(input)        ──▶  JobStore.insert
JobQueue.tick(now)             ──▶  JobStore.claimNext ──▶ executor(job) ──▶ JobStore.update
```

`executor` is the seam a future inference-adapters phase plugs into — exactly the way
`Project.recordGeneration` is the seam `@osai/core` leaves for spent compute. This
package never runs inference itself.

Retry logic lives in `tick`: a retryable failure with attempts remaining goes back to
`queued` silently — a retry in flight isn't yet "what's done, and what broke" (F9), only
the eventual outcome is. Once retries are exhausted, or the failure wasn't retryable at
all, the job terminal-fails and a `NotificationSink` fires.

**Cancellation is a race that has to lose correctly.** `cancelByProject` (F11) can land
while a job is mid-execution. `JobStore.update` refuses to overwrite an already-
cancelled job — enforced by a `WHERE status <> 'cancelled'` clause, not by application
logic that could be skipped. `JobQueue` goes one step further: after writing a result,
it re-reads the job before deciding whether to notify, so a late success or failure for
work the user already threw away can never produce a "succeeded"/"failed" notification.

`tick(now)` takes an explicit timestamp so tests are deterministic; `start()` wraps it
in a real interval for actual use.

## Decisions taken here

| Decision | Rationale |
|---|---|
| `node:sqlite` over better-sqlite3 | No native binary to compile per platform/Node ABI. Costs a Node 22+ requirement (bumped from >=20 for this phase). |
| Retry policy lives in `JobQueue`, not `JobStore` | The store stays swappable and dumb; scheduling policy is one place, not smeared across a SQL layer and app code. |
| A cancelled job can never be overwritten, enforced at the SQL layer | Application-level checks get skipped under refactors; a `WHERE` clause can't be. |
| `JobQueue` re-reads before notifying | Otherwise a job resolved after cancellation still fires a "succeeded" notification for work that was thrown away. |
| Single-process concurrency only | `claimNext`'s atomicity holds within one Node process. Multiple processes sharing one SQLite file is out of scope for this phase. |

## Not built yet

The app layer that will construct a `JobQueue` and expose it over HTTP/RPC, and a real
`NotificationSink` (push/email/desktop) — `InMemoryNotificationSink` is for tests and
local development only. `@osai/inference` now supplies the `executor` (routing a job
to an adapter and recording the result via `Project.recordGeneration`), but only
against a fake, zero-cost adapter — no real provider is wired in yet.
