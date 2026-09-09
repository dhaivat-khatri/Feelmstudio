declare const brand: unique symbol;

/** Nominal typing helper so a SceneId can never be passed where a NodeId is expected. */
export type Brand<B extends string> = string & { readonly [brand]: B };

export type ProjectId = Brand<'ProjectId'>;
export type NodeId = Brand<'NodeId'>;
export type VersionId = Brand<'VersionId'>;
export type SceneId = Brand<'SceneId'>;

export const projectId = (raw: string): ProjectId => raw as ProjectId;
export const nodeId = (raw: string): NodeId => raw as NodeId;
export const versionId = (raw: string): VersionId => raw as VersionId;
export const sceneId = (raw: string): SceneId => raw as SceneId;
