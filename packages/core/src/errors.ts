export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NodeNotFoundError extends DomainError {
  constructor(id: string) {
    super(`No node "${id}" in this project graph.`, 'NODE_NOT_FOUND');
  }
}

export class DuplicateNodeError extends DomainError {
  constructor(id: string) {
    super(`Node "${id}" already exists in this project graph.`, 'DUPLICATE_NODE');
  }
}

export class CycleError extends DomainError {
  constructor(
    readonly path: readonly string[],
    message = `Adding this dependency would create a cycle: ${path.join(' -> ')}`,
  ) {
    super(message, 'CYCLE');
  }
}

export class IllegalDependencyError extends DomainError {
  constructor(message: string) {
    super(message, 'ILLEGAL_DEPENDENCY');
  }
}

export class VersionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`No version "${id}" on this node.`, 'VERSION_NOT_FOUND');
  }
}

export class NoCurrentVersionError extends DomainError {
  constructor(id: string) {
    super(`Node "${id}" has no versions yet.`, 'NO_CURRENT_VERSION');
  }
}
