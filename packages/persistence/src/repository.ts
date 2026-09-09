import { Project, type ProjectId, type Runtime } from '@osai/core';

import type { ProjectListing, ProjectStore } from './store.js';

/**
 * Adapts a `ProjectStore` (which moves snapshots) to work directly with `Project`
 * instances, so the app layer never has to call `toSnapshot`/`fromSnapshot` itself.
 */
export class ProjectRepository {
  constructor(
    private readonly store: ProjectStore,
    private readonly rt: Runtime,
  ) {}

  async save(project: Project): Promise<void> {
    await this.store.save(project.toSnapshot(), this.rt.clock.now());
  }

  async load(id: ProjectId): Promise<Project | undefined> {
    const snapshot = await this.store.load(id);
    return snapshot ? Project.fromSnapshot(snapshot, this.rt) : undefined;
  }

  list(): Promise<readonly ProjectListing[]> {
    return this.store.list();
  }

  delete(id: ProjectId): Promise<void> {
    return this.store.delete(id);
  }
}
