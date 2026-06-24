import { homedir } from "node:os";
import path from "node:path";
import * as fs from "node:fs";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	ModelGroupsPersistenceError,
	type ModelGroupDef,
	type ModelGroupModel,
	type ModelGroupScope,
	type ModelGroupsBootValidation,
	type ModelGroupsConfig,
	type ModelGroupsLoadedGroup,
	type ModelGroupsLoadIssue,
	type ModelGroupsLoadResult,
	type ResolvedModelGroup,
} from "./types.js";

const CURRENT_VERSION = 1;
const EMPTY_CONFIG: ModelGroupsConfig = { version: CURRENT_VERSION, groups: {} };
const VALID_THINKING = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

type FsOps = Pick<typeof fs, "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync">;
let fsOps: FsOps = fs;

export function __setModelGroupsFsForTests(next: Partial<FsOps> | null): void {
	fsOps = next ? { ...fs, ...next } : fs;
}

export function modelGroupsPath(scope: ModelGroupScope, cwd: string): string {
	return scope === "global"
		? path.join(homedir(), ".pi", "agent", "pi-agenticoding", "model-groups.json")
		: path.join(cwd, ".pi", "pi-agenticoding", "model-groups.json");
}

function emptyConfig(): ModelGroupsConfig {
	return { version: CURRENT_VERSION, groups: {} };
}

function cloneDef(def: ModelGroupDef): ModelGroupDef {
	return { models: def.models.map((m) => ({ ...m })) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModelEntry(value: unknown): value is ModelGroupModel {
	if (!isPlainRecord(value)) return false;
	if (typeof value.provider !== "string" || value.provider.length === 0) return false;
	if (typeof value.modelId !== "string" || value.modelId.length === 0) return false;
	if (value.thinkingLevel !== undefined && !VALID_THINKING.has(value.thinkingLevel as ModelThinkingLevel)) return false;
	return true;
}

function validateConfig(raw: unknown): { ok: true; config: ModelGroupsConfig } | { ok: false; message: string } {
	if (!isPlainRecord(raw)) return { ok: false, message: "config root must be an object" };
	const version = raw.version === undefined || raw.version === 0 ? CURRENT_VERSION : raw.version;
	if (typeof version !== "number") return { ok: false, message: "version must be a number" };
	if (version > CURRENT_VERSION) return { ok: false, message: `unsupported version ${version}` };
	if (!isPlainRecord(raw.groups)) return { ok: false, message: "groups must be an object" };
	const groups: Record<string, ModelGroupDef> = {};
	for (const [name, def] of Object.entries(raw.groups)) {
		if (!isPlainRecord(def)) return { ok: false, message: `group ${name} must be an object` };
		if (!Array.isArray(def.models)) return { ok: false, message: `group ${name}.models must be an array` };
		if (!def.models.every(validateModelEntry)) return { ok: false, message: `group ${name}.models contains invalid model entry` };
		groups[name] = { models: def.models.map((m) => ({ ...m })) };
	}
	return { ok: true, config: { version: CURRENT_VERSION, groups } };
}

function backupAndIssue(scope: ModelGroupScope, sourcePath: string, kind: ModelGroupsLoadIssue["kind"], message: string, version?: number): ModelGroupsLoadIssue {
	const backupPath = `${sourcePath}.bak`;
	const issue: ModelGroupsLoadIssue = { scope, sourcePath, kind, message, backupPath, version };
	if (kind === "unsupported-version") return issue;
	try {
		fsOps.copyFileSync(sourcePath, backupPath);
	} catch (cause) {
		issue.backupFailed = true;
		issue.message = `${message}; backup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	return issue;
}

function loadScope(scope: ModelGroupScope, cwd: string): { config: ModelGroupsConfig; issue?: ModelGroupsLoadIssue } {
	const sourcePath = modelGroupsPath(scope, cwd);
	if (!fsOps.existsSync(sourcePath)) return { config: emptyConfig() };
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8")));
	} catch (cause) {
		return {
			config: emptyConfig(),
			issue: backupAndIssue(scope, sourcePath, "corrupt-json", cause instanceof Error ? cause.message : String(cause)),
		};
	}
	if (isPlainRecord(parsed)) {
		const version = parsed.version === undefined || parsed.version === 0 ? CURRENT_VERSION : parsed.version;
		if (typeof version === "number" && version > CURRENT_VERSION) {
			return { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "unsupported-version", `unsupported version ${version}`, version) };
		}
	}
	const validated = validateConfig(parsed);
	if (!validated.ok) {
		return { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "schema-invalid", validated.message) };
	}
	return { config: validated.config };
}

function mergeLoaded(configs: Record<ModelGroupScope, ModelGroupsConfig>, cwd: string): ModelGroupsLoadedGroup[] {
	const globalPath = modelGroupsPath("global", cwd);
	const projectPath = modelGroupsPath("project", cwd);
	const names = new Set([...Object.keys(configs.global.groups), ...Object.keys(configs.project.groups)]);
	const merged: ModelGroupsLoadedGroup[] = [];
	for (const name of [...names].sort()) {
		const globalDef = configs.global.groups[name];
		if (globalDef) merged.push({ name, scope: "global", sourcePath: globalPath, ...cloneDef(globalDef) });
		const projectDef = configs.project.groups[name];
		if (projectDef) merged.push({ name, scope: "project", sourcePath: projectPath, ...cloneDef(projectDef) });
	}
	return merged;
}

export function loadModelGroups(cwd: string): ModelGroupsLoadResult {
	const global = loadScope("global", cwd);
	const project = loadScope("project", cwd);
	const configs = { global: global.config, project: project.config };
	return {
		configs,
		merged: mergeLoaded(configs, cwd),
		issues: [global.issue, project.issue].filter((issue): issue is ModelGroupsLoadIssue => Boolean(issue)),
	};
}

function persistenceError(details: ConstructorParameters<typeof ModelGroupsPersistenceError>[0]): ModelGroupsPersistenceError {
	return new ModelGroupsPersistenceError(details);
}

export function saveModelGroups(scope: ModelGroupScope, cwd: string, config: ModelGroupsConfig): void {
	const sourcePath = modelGroupsPath(scope, cwd);
	const dir = path.dirname(sourcePath);
	const tempPath = `${sourcePath}.${process.pid}.${Date.now()}.tmp`;
	let raw: Record<string, unknown> = {};
	if (fsOps.existsSync(sourcePath)) {
		try {
			const parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8")));
			if (isPlainRecord(parsed)) raw = parsed;
		} catch {
			// Preserve nothing from malformed content; load recovery owns malformed-file handling.
		}
	}
	const body = JSON.stringify({ ...raw, version: CURRENT_VERSION, groups: config.groups }, null, 2) + "\n";
	try {
		fsOps.mkdirSync(dir, { recursive: true });
		fsOps.writeFileSync(tempPath, body, "utf8");
	} catch (cause) {
		throw persistenceError({ operation: "save", scope, sourcePath, targetPath: tempPath, phase: "temp-write", message: `Failed to write temp model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
	}
	try {
		fsOps.renameSync(tempPath, sourcePath);
	} catch (cause) {
		throw persistenceError({ operation: "save", scope, sourcePath, targetPath: tempPath, phase: "rename", message: `Failed to commit model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
	}
}

function loadScopeConfig(scope: ModelGroupScope, cwd: string): ModelGroupsConfig {
	const loaded = loadScope(scope, cwd);
	if (loaded.issue?.backupFailed) {
		throw persistenceError({
			operation: "save",
			scope,
			sourcePath: loaded.issue.sourcePath,
			targetPath: loaded.issue.backupPath,
			phase: "load-recovery",
			message: `Refusing to overwrite ${scope} model-groups config after ${loaded.issue.kind} recovery because backup failed: ${loaded.issue.message}`,
			cause: loaded.issue,
		});
	}
	return loaded.config;
}

function ensureGroupName(name: string): void {
	if (!name.trim()) throw new Error("Model group name is required");
}

export function createGroup(scope: ModelGroupScope, cwd: string, name: string, def: ModelGroupDef): void {
	ensureGroupName(name);
	const config = loadScopeConfig(scope, cwd);
	if (config.groups[name]) throw new Error(`Model group '${name}' already exists in ${scope} scope`);
	config.groups[name] = cloneDef(def);
	saveModelGroups(scope, cwd, config);
}

export function updateGroup(scope: ModelGroupScope, cwd: string, name: string, def: ModelGroupDef): void {
	const config = loadScopeConfig(scope, cwd);
	if (!config.groups[name]) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	config.groups[name] = cloneDef(def);
	saveModelGroups(scope, cwd, config);
}

export function renameGroup(scope: ModelGroupScope, cwd: string, oldName: string, newName: string): void {
	ensureGroupName(newName);
	if (oldName === newName) return;
	const config = loadScopeConfig(scope, cwd);
	const existing = config.groups[oldName];
	if (!existing) throw new Error(`Model group '${oldName}' does not exist in ${scope} scope`);
	if (config.groups[newName]) throw new Error(`Model group '${newName}' already exists in ${scope} scope`);
	delete config.groups[oldName];
	config.groups[newName] = cloneDef(existing);
	saveModelGroups(scope, cwd, config);
}

export function deleteGroup(scope: ModelGroupScope, cwd: string, name: string): { otherScopeHasOverride: boolean } {
	const config = loadScopeConfig(scope, cwd);
	if (!config.groups[name]) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	delete config.groups[name];

	// Load the opposite scope before saving — if this throws, nothing was persisted yet.
	const other = loadScopeConfig(scope === "global" ? "project" : "global", cwd);

	try {
		saveModelGroups(scope, cwd, config);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({
				operation: "delete",
				scope: cause.scope,
				sourcePath: cause.sourcePath,
				targetPath: cause.targetPath,
				phase: cause.phase,
				message: cause.message,
				cause,
			});
		}
		throw cause;
	}
	return { otherScopeHasOverride: Boolean(other.groups[name]) };
}

export function moveGroup(cwd: string, name: string, newScope: ModelGroupScope): void {
	const oldScope: ModelGroupScope = newScope === "project" ? "global" : "project";
	const source = loadScopeConfig(oldScope, cwd);
	const target = loadScopeConfig(newScope, cwd);
	const def = source.groups[name];
	if (!def) throw new Error(`Model group '${name}' does not exist in ${oldScope} scope`);
	if (target.groups[name]) throw new Error(`Model group '${name}' already exists in ${newScope} scope`);
	const nextTarget: ModelGroupsConfig = { version: CURRENT_VERSION, groups: { ...target.groups, [name]: cloneDef(def) } };
	try {
		saveModelGroups(newScope, cwd, nextTarget);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({
				operation: "move",
				scope: newScope,
				sourcePath: modelGroupsPath(oldScope, cwd),
				targetPath: modelGroupsPath(newScope, cwd),
				phase: cause.phase,
				message: `Model group '${name}' was not written to ${newScope}: ${cause.message}`,
				cause,
			});
		}
		throw cause;
	}
	const nextSource: ModelGroupsConfig = { version: CURRENT_VERSION, groups: { ...source.groups } };
	delete nextSource.groups[name];
	try {
		saveModelGroups(oldScope, cwd, nextSource);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({
				operation: "move",
				scope: oldScope,
				sourcePath: modelGroupsPath(oldScope, cwd),
				targetPath: modelGroupsPath(newScope, cwd),
				phase: "source-remove",
				partialMove: "target-written-source-retained",
				message: `Model group '${name}' was written to ${newScope} but retained in ${oldScope}: ${cause.message}`,
				cause,
			});
		}
		throw cause;
	}
}

export function validateModelGroups(loadResult: ModelGroupsLoadResult, modelRegistry: ModelRegistry): ResolvedModelGroup[] {
	const projectNames = new Set(Object.keys(loadResult.configs.project.groups));
	return loadResult.merged.map((group) => {
		const unavailableRefs: Array<{ provider: string; modelId: string }> = [];
		for (const modelRef of group.models) {
			const model = modelRegistry.find(modelRef.provider, modelRef.modelId);
			if (!model || !modelRegistry.hasConfiguredAuth(model)) unavailableRefs.push({ provider: modelRef.provider, modelId: modelRef.modelId });
		}
		const unavailableCount = unavailableRefs.length;
		const availableCount = group.models.length - unavailableCount;
		return {
			...group,
			validation: {
				unavailableRefs,
				shadowedByProject: group.scope === "global" && projectNames.has(group.name),
				degraded: unavailableCount > 0 && availableCount > 0,
			},
		};
	});
}

export function listResolvedModelGroups(cwd: string, modelRegistry: ModelRegistry): ModelGroupsBootValidation {
	const loaded = loadModelGroups(cwd);
	return { groups: validateModelGroups(loaded, modelRegistry), loadIssues: loaded.issues };
}

export function summarizeBootValidation(groups: ResolvedModelGroup[]): { unavailableCount: number; overrideCount: number } {
	return {
		unavailableCount: groups.reduce((sum, group) => sum + group.validation.unavailableRefs.length, 0),
		overrideCount: groups.filter((group) => group.validation.shadowedByProject).length,
	};
}

export { CURRENT_VERSION as MODEL_GROUPS_CONFIG_VERSION, EMPTY_CONFIG as EMPTY_MODEL_GROUPS_CONFIG };
