# @osai/core

The domain core: project graph, versioning, staleness propagation, and scene identity.

Pure TypeScript. No I/O, no framework, no inference, no clock or randomness of its own —
`Runtime` (clock + id source) is injected so every behaviour is deterministic under test.

```bash
npm test --workspace @osai/core
npm run typecheck --workspace @osai/core
```

## Why this exists first

PRD §3 names scene-level regeneration as the wedge, but that is table stakes — several
competitors ship it. What nobody does is model the project as an explicit dependency
graph, which is what makes staleness *precise* and version history *reproducible*. That
precision is the product's trust story, so it is built and proven before any pixel.

## The model

### Edge direction

```
dependency  ──▶  dependent          data flows left to right
(Character)      (Scene image)      the image depends on the character
```

Staleness propagation walks **dependents**. Provenance walks **dependencies**. Only
`graph.ts` touches the adjacency maps.

### Materiality — what happens when an input changes

Every node kind is classified in `kinds.ts`:

| | Meaning | On upstream change |
|---|---|---|
| `derived` | Pure function of upstream, cheap, no user intent | Recomputed automatically |
| `media` | Generated media, costs real GPU time | Flagged only, never touched |
| `authored` | Carries human or model intent | Flagged only, never touched |

`derived` is gated further at runtime by **version authorship**. The moment a user
hand-edits a derived node, auto-recompute would destroy their work, so it is treated
exactly like media. This is what protects Maya's fifteen minutes of timeline trims from
being clobbered by an unrelated script edit.

### Three staleness states, not one

The PRD uses "stale" for three different situations, and §10 already flags that users
won't understand it. Split in `node.ts`:

- **`updated`** — auto-resolved. Informational; never counts as needing attention.
- **`outOfDate`** — media no longer matches its inputs. Still playable. Regenerating is
  the user's explicit call.
- **`needsReview`** — structure moved underneath this node. A human has to look.

### Scoping a whole-script edit

Scene media depends on a per-scene `sceneScript` slice, never on the script node
directly. When the script changes, every slice is re-derived — but a slice that
recomputes to exactly what it already held **prunes** itself, and the walk stops there.

That is the mechanism behind "Maya edits scene 9, only scene 9 flags." Without it, one
script edit flags all nineteen scenes, which is the over-flagging §5.1 exists to prevent
and the fastest way to teach users that flags are noise.

### Scene identity across re-segmentation

The case the PRD's staleness model does not cover, and the most likely way the
non-destructive promise breaks. When a script edit changes scene *boundaries*, that is
identity loss, not staleness: renumber silently and scene 5's video quietly becomes
scene 6's.

`segmentation.ts` matches a proposed segmentation against the current one over a
bipartite relation (symmetric similarity plus containment in both directions), and
classifies connected components: 1:1 is a match, 1:N a split, M:1 a merge, M:N a
restructure.

Leftovers get a **positional rescue** pass: a scene rewritten from scratch, but sitting
in the same slot between the same two unchanged neighbours, keeps its identity rather
than being orphaned. Those matches are marked `positional` and always require review,
because identity was inferred from position rather than content. A deletion in one slot
and an insertion in a different slot are never paired.

Nothing is applied silently — `diffSegmentation` proposes, `Project.applySegmentation`
commits.

### Lifecycle

`propagate` respects project lifecycle. Published and archived projects are never
flagged. Without this, changing a shared voice asset lights up every project that ever
used it, and flags that fire on finished work are flags people learn to ignore.

## Decisions taken here that the PRD leaves open

| Decision | Rationale |
|---|---|
| Approve-all is the default posture; per-scene click-through is opt-in | §11 Q3. The three personas give three incompatible answers, so it is a project/template setting, not a product default. |
| `userMedia` is a first-class root kind | Journey C, F17. Client work always involves client footage. A node with no upstream, so it can never go stale — the cheapest possible addition. |
| Retired scenes keep their nodes and full history | A scene leaving the script must not destroy hours of generated work in case it comes back. |
| Restore is additive | Restoring appends a copy rather than rewinding, so the version being left is still reachable. |
| Acknowledgement is scoped to a version | "Approve as-is" clears the flag for *that* change. A later change to the same upstream flags afresh. |

## Testing

121 tests. The suite is mutation-checked rather than merely green — each core invariant
was verified to fail when deliberately broken:

- acknowledgement as a standing exemption instead of version-scoped
- media allowed to auto-recompute
- flagging everything downstream instead of walking graph edges
- lifecycle suppression removed (both the propagation and structural paths)
- blame cited at the wrong node instead of inherited
- pruning disabled
- naive positional identity (the renumbering bug)
- split children all given fresh ids
- `requiresReview` forced false
- positional rescue disabled, and its gap constraint dropped
- scene media wired straight to the script

## Persistence

`ArtifactNode`, `ProjectGraph` and `Project` each expose `toSnapshot()` and a static
`fromSnapshot()`. A snapshot is plain, JSON-safe data — the same private fields the
class already holds, not a replay of the public API, because some state (the
acknowledged map, a `notStarted` status) isn't reachable by calling public mutators
against an empty node. Restoring never re-runs `addDependency`'s cycle/root-kind checks
either: the data was already validated once, before it was saved.

`Project.fromSnapshot` takes a fresh `Runtime`, so a reloaded project resumes with a
live clock and id source rather than the one it was saved under. See `@osai/persistence`
for the storage layer built on top of this.

## Not built yet

The app layer. `Project.recordGeneration` is the seam: the core records results and
propagates, it never spends compute — `@osai/jobs` schedules the work and
`@osai/inference` defines what a provider connection looks like, but no real provider
is wired in yet. `@osai/inference` ships a fake adapter only; real providers (image,
video, speech, text APIs or self-hosted models) are a later, per-capability decision.
