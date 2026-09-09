# @osai/persistence

Durable storage for a `Project`: save it, load it back, survive a restart.

```bash
npm test --workspace @osai/persistence
npm run typecheck --workspace @osai/persistence
```

## Why this exists

Journey A, F3: Maya closes the laptop mid-generation. The async premise of the whole
product collapses if that loses her project. This package is what makes a `Project`
outlive the process that created it.

## The model

All the graph invariants — versions, staleness, acknowledgement, scene identity — are
owned by `@osai/core`'s `Project.toSnapshot()` / `Project.fromSnapshot()`. This package
never touches them; it only moves the resulting JSON-safe snapshot in and out of a
storage medium.

```
Project.toSnapshot()  ──▶  ProjectStore.save()  ──▶  disk / memory
Project.fromSnapshot() ◀── ProjectStore.load()  ◀── disk / memory
```

**`ProjectStore`** is the port: `save`, `load`, `list`, `delete`, operating on
snapshots. `savedAt` is caller-supplied rather than read from a clock inside the store,
so store behaviour stays deterministic under test — the same discipline `@osai/core`
uses for its own `Runtime`.

Two implementations:

- **`InMemoryProjectStore`** — a `Map`, deep-cloned on `save`/`load` via
  `structuredClone` so callers can never alias into what the store holds. For tests and
  for developing the app layer before real storage is wired up.
- **`FileProjectStore`** — one JSON file per project under a directory. Writes land via
  a temp file plus `rename`, which is atomic on the same filesystem: a crash mid-write
  can never leave a half-written file where a later `load` would find it.

**`ProjectRepository`** adapts a `ProjectStore` to work with `Project` instances
directly, so the app layer never calls `toSnapshot`/`fromSnapshot` itself:

```ts
const repo = new ProjectRepository(new FileProjectStore('./data/projects'), systemRuntime());

await repo.save(project);
const reloaded = await repo.load(project.id); // a live Project, ready to keep mutating
```

## Not built yet

The app layer, which will hold a `ProjectRepository` and expose it over HTTP/RPC.
`FileProjectStore` stays deliberately simple — one file per project, full-file reads
for `list()` — because at a single creator's scale that's the whole requirement for
*project* storage. Job records needed a different, queryable access pattern (status,
priority, project), which is why `@osai/jobs` reaches for SQLite instead of reusing
this package's file-per-record approach.
