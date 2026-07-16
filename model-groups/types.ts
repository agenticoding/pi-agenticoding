import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ModelGroupScope = "project" | "global";
export type ModelGroupsAccessPolicy = "global-project" | "global-only";
export interface ModelGroupsAccess { cwd: string; policy: ModelGroupsAccessPolicy }

export interface ModelGroupModel {
	provider: string;
	modelId: string;
	thinkingLevel?: ModelThinkingLevel;
}
export interface ModelGroupDef { models: ModelGroupModel[] }
export interface ModelGroupsConfig { version: 1; groups: Record<string, ModelGroupDef> }
export interface ModelGroupValidation {
	unavailableRefs: Array<{ provider: string; modelId: string }>;
	shadowedByProject: boolean;
	degraded: boolean;
}
export interface ModelGroupsLoadedGroup extends ModelGroupDef {
	name: string;
	scope: ModelGroupScope;
	sourcePath: string;
}
export interface ResolvedModelGroup extends ModelGroupsLoadedGroup { validation: ModelGroupValidation }
export type ModelGroupsLoadIssueKind = "corrupt-json" | "schema-invalid" | "unsupported-version";
export interface ModelGroupsLoadIssue {
	scope: ModelGroupScope;
	sourcePath: string;
	kind: ModelGroupsLoadIssueKind;
	message: string;
	backupPath?: string;
	backupFailed?: boolean;
	version?: number;
}
export type ModelGroupsPersistenceOperation = "save" | "delete" | "move";
export type ModelGroupsPersistencePhase = "config-validation" | "temp-write" | "rename" | "source-remove" | "load-recovery";
export class ModelGroupsPersistenceError extends Error {
	readonly operation!: ModelGroupsPersistenceOperation;
	readonly scope?: ModelGroupScope;
	readonly sourcePath?: string;
	readonly targetPath?: string;
	readonly phase!: ModelGroupsPersistencePhase;
	readonly partialMove?: "target-written-source-retained";
	readonly cause?: unknown;
	constructor(details: {
		operation: ModelGroupsPersistenceOperation;
		scope?: ModelGroupScope;
		sourcePath?: string;
		targetPath?: string;
		phase: ModelGroupsPersistencePhase;
		partialMove?: "target-written-source-retained";
		message: string;
		cause?: unknown;
	}) {
		super(details.message);
		this.name = "ModelGroupsPersistenceError";
		Object.assign(this, details);
	}
}
export interface ModelGroupsLoadResult {
	configs: Record<ModelGroupScope, ModelGroupsConfig>;
	merged: ModelGroupsLoadedGroup[];
	issues: ModelGroupsLoadIssue[];
}
export interface ModelGroupsBootValidation { groups: ResolvedModelGroup[]; loadIssues: ModelGroupsLoadIssue[] }
