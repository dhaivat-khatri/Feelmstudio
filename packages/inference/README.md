# @osai/inference

The seam between "there's a queued job" and "the project has a new version": an
adapter contract per generative capability, and the bridge that connects
`@osai/jobs`'s `JobQueue` to `@osai/core`'s `Project.recordGeneration`.

```bash
npm test --workspace @osai/inference
npm run typecheck --workspace @osai/inference
```

## Scope of this phase

This package defines the contract and ships **one implementation: a fake adapter.**
No real provider — no API key, no network call, no cost. That's deliberate: picking
providers (cloud APIs vs. self-hosted models, which vendor per capability) is a product
and cost decision, not an architecture one, and it doesn't need to be made before the
seam connecting jobs to the project graph can be proven correct.

The fake adapter exercises the entire path for real: `JobQueue.tick()` claims a job,
calls the adapter, and the result lands on the actual `Project` graph exactly as if a
real provider had produced it — see `test/end-to-end.test.ts`, which builds a real
`Project`, a real `SqliteJobStore`-backed `JobQueue`, and this package's executor, and
asserts a scene's image node ends up with a real recorded version.

## The model

**`Capability`** — `'text' | 'image' | 'video' | 'speech' | 'music'` — matches the
node kinds in `@osai/core/kinds.ts` that actually cost compute (`sceneImage`,
`sceneVideo`, `narration`, `music`/`sfx`) plus text generation for script/research
drafting. Convention: a `Job`'s `kind` (from `@osai/jobs`) is one of these literally,
and its `payload` is an `InferenceRequest` — that convention is what lets the executor
route a job to the right adapter without a separate mapping table.

**`InferenceAdapter`** is one capability's connection to a provider: `generate(request)
=> InferenceResult`. Failures are thrown as `InferenceError`, which carries the
adapter's own judgment about whether retrying is worth it (`retryable`) — a rate limit
is, a rejected prompt is not. That flag flows straight into `@osai/jobs`'s retry
decision.

**`createInferenceExecutor(adapters, projects)`** builds the `JobExecutor` the queue
actually calls:

```
job → adapters.get(job.kind) → adapter.generate(job.payload)
    → project.recordGeneration(job.nodeId, result.payload, {prompt, seed, model})
    → projects.save(project)
```

`projects: ProjectLookup` is a two-method shape (`get`/`save`) matched structurally to
`@osai/persistence`'s `ProjectRepository` — no dependency on that package, so a real
repository can be passed in directly once the app layer exists, or a plain in-memory
map for tests.

## Decisions taken here

| Decision | Rationale |
|---|---|
| Fake adapter only, no real provider | Provider choice is a cost/product decision; the seam can be proven correct without it. |
| `Capability` set fixed to what @osai/core's kinds actually cost compute for | No speculative capabilities — text/image/video/speech/music covers every media-costing node kind today. |
| `job.kind` *is* the capability string, `job.payload` *is* the request | One convention, no adapter-routing table to keep in sync separately. |
| `ProjectLookup` is a minimal structural interface, not a hard dependency on @osai/persistence | Keeps this package composable — any two-method get/save shape works, including a test double. |
| Executor validates payload shape (`prompt` present) before calling the adapter | Cheap guard against a malformed enqueue producing a confusing adapter-level crash instead of a clear `INVALID_PAYLOAD`. |

## Experimental: local Seedance-style adapter

`createSeedanceImageAdapter` / `createSeedanceVideoAdapter` (`src/seedance-adapter.ts`)
talk to `python/seedance_server.py`, a persistent HTTP server around the
from-scratch DiT in `research/seedance-model/model.py` (imported directly from
there — one source of truth, not duplicated). Same warm-process pattern as
the FLUX image server: `startSeedanceServer()` spawns it and waits for
`/health`.

**Untrained by default.** With no `--checkpoint`, the model has random
weights and every call produces structured noise, not real images or video —
useful for exercising the adapter/job/project pipeline end to end, not for
real output. Train one with `research/seedance-model/train.py`, then pass
`checkpoint` to `startSeedanceServer`.

Pass a reference image via `request.params.referenceImagePath` on either
adapter to exercise the model's reference-conditioning pathway (Seedance's
"Reference-to-Video" idea, scaled down to a single clean-image reference).
The video adapter samples raw frames server-side and stitches them into an
mp4 with ffmpeg client-side, matching `VideoPayload`'s single-file shape
used elsewhere in this package.

## Not built yet

Any real provider. Per capability, that's a separate later decision: which vendor (or
self-hosted model), API key handling, rate limits, and cost accounting. The app layer,
which will own picking a `ProjectLookup` implementation and starting the queue for
real.
