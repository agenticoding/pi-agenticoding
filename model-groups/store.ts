import { homedir } from "node:os";
import path from "node:path";
import * as fs from "node:fs";
import { CONFIG_DIR_NAME, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { canonicalizeModelGroupName } from "./names.js";
import {
	ModelGroupsPersistenceError,
	type ModelGroupDef,
	type ModelGroupModel,
	type ModelGroupScope,
	type ModelGroupsAccess,
	type ModelGroupsBootValidation,
	type ModelGroupsConfig,
	type ModelGroupsLoadedGroup,
	type ModelGroupsLoadIssue,
	type ModelGroupsLoadResult,
	type ResolvedModelGroup,
} from "./types.js";

const CURRENT_VERSION = 1;
const VALID_THINKING = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
type FsOps = Pick<typeof fs, "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync">;
let fsOps: FsOps = fs;

export function __setModelGroupsFsForTests(next: Partial<FsOps> | null): void { fsOps = next ? { ...fs, ...next } : fs; }
export function modelGroupsPath(scope: ModelGroupScope, cwd: string, projectConfigDirName = CONFIG_DIR_NAME): string {
	return scope === "global"
		? path.join(homedir(), ".pi", "agent", "pi-agenticoding", "model-groups.json")
		: path.join(cwd, projectConfigDirName, "pi-agenticoding", "model-groups.json");
}

function ownGroups(): Record<string, ModelGroupDef> { return Object.create(null) as Record<string, ModelGroupDef>; }
function defineGroup(groups: Record<string, ModelGroupDef>, name: string, def: ModelGroupDef): void {
	Object.defineProperty(groups, name, { value: cloneDef(def), enumerable: true, writable: true, configurable: true });
}
function hasOwnGroup(groups: Record<string, ModelGroupDef>, name: string): boolean { return Object.hasOwn(groups, name); }
function emptyConfig(): ModelGroupsConfig { return { version: CURRENT_VERSION, groups: ownGroups() }; }
function cloneDef(def: ModelGroupDef): ModelGroupDef { return { models: def.models.map((model) => ({ ...model })) }; }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertScopeAllowed(scope: ModelGroupScope, access: ModelGroupsAccess): void {
	if (scope === "project" && access.policy === "global-only") throw new Error("Project Model Groups are unavailable in global-only mode");
}
function persistenceError(details: ConstructorParameters<typeof ModelGroupsPersistenceError>[0]): ModelGroupsPersistenceError {
	return new ModelGroupsPersistenceError(details);
}
function validateModelEntry(value: unknown, at: string): { ok: true; model: ModelGroupModel } | { ok: false; message: string } {
	if (!isPlainRecord(value)) return { ok: false, message: `${at} must be an object` };
	if (typeof value.provider !== "string" || value.provider.length === 0) return { ok: false, message: `${at}.provider must be a non-empty string` };
	if (typeof value.modelId !== "string" || value.modelId.length === 0) return { ok: false, message: `${at}.modelId must be a non-empty string` };
	if (value.thinkingLevel !== undefined && !VALID_THINKING.has(value.thinkingLevel as ModelThinkingLevel)) return { ok: false, message: `${at}.thinkingLevel is invalid` };
	const model: ModelGroupModel = { provider: value.provider, modelId: value.modelId };
	if (value.thinkingLevel !== undefined) model.thinkingLevel = value.thinkingLevel as ModelThinkingLevel;
	return { ok: true, model };
}
function normalizeGroups(rawGroups: Record<string, unknown>): { ok: true; groups: Record<string, ModelGroupDef> } | { ok: false; message: string } {
	const groups = ownGroups();
	for (const rawName of Object.keys(rawGroups)) {
		const name = canonicalizeModelGroupName(rawName);
		if (!name) return { ok: false, message: "group name must not be empty after trimming" };
		if (hasOwnGroup(groups, name)) return { ok: false, message: `group keys collide after trimming at '${name}'` };
		const rawDef = rawGroups[rawName];
		if (!isPlainRecord(rawDef)) return { ok: false, message: `group ${rawName} must be an object` };
		if (!Array.isArray(rawDef.models)) return { ok: false, message: `group ${rawName}.models must be an array` };
		const models: ModelGroupModel[] = [];
		for (let index = 0; index < rawDef.models.length; index++) {
			const result = validateModelEntry(rawDef.models[index], `group ${rawName}.models[${index}]`);
			if (!result.ok) return result;
			models.push(result.model);
		}
		defineGroup(groups, name, { models });
	}
	return { ok: true, groups };
}
function validateConfig(raw: unknown): { ok: true; config: ModelGroupsConfig } | { ok: false; message: string } {
	if (!isPlainRecord(raw)) return { ok: false, message: "config root must be an object" };
	const version = raw.version === undefined || raw.version === 0 ? CURRENT_VERSION : raw.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, message: "version must be a non-negative supported integer (only missing/0 normalize)" };
	if (version > CURRENT_VERSION) return { ok: false, message: `unsupported version ${version}` };
	if (!isPlainRecord(raw.groups)) return { ok: false, message: "groups must be an object" };
	const normalized = normalizeGroups(raw.groups);
	return normalized.ok ? { ok: true, config: { version: CURRENT_VERSION, groups: normalized.groups } } : normalized;
}
function backupAndIssue(scope: ModelGroupScope, sourcePath: string, kind: ModelGroupsLoadIssue["kind"], message: string, version?: number): ModelGroupsLoadIssue {
	const backupPath = `${sourcePath}.bak`;
	const issue: ModelGroupsLoadIssue = { scope, sourcePath, kind, message, backupPath, version };
	if (kind === "unsupported-version") return issue;
	try { fsOps.copyFileSync(sourcePath, backupPath); }
	catch (cause) {
		issue.backupFailed = true;
		issue.message = `${message}; backup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	return issue;
}
function loadScope(scope: ModelGroupScope, access: ModelGroupsAccess): { config: ModelGroupsConfig; issue?: ModelGroupsLoadIssue } {
	assertScopeAllowed(scope, access);
	const sourcePath = modelGroupsPath(scope, access.cwd);
	if (!fsOps.existsSync(sourcePath)) return { config: emptyConfig() };
	let parsed: unknown;
	try { parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8"))); }
	catch (cause) { return { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "corrupt-json", cause instanceof Error ? cause.message : String(cause)) }; }
	if (isPlainRecord(parsed) && typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version > CURRENT_VERSION) {
		return { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "unsupported-version", `unsupported version ${parsed.version}`, parsed.version) };
	}
	const validated = validateConfig(parsed);
	if (!validated.ok) return { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "schema-invalid", validated.message) };
	return { config: validated.config };
}
function mergeLoaded(configs: Record<ModelGroupScope, ModelGroupsConfig>, access: ModelGroupsAccess): ModelGroupsLoadedGroup[] {
	const names = new Set([...Object.keys(configs.global.groups), ...Object.keys(configs.project.groups)]);
	const merged: ModelGroupsLoadedGroup[] = [];
	for (const name of [...names].sort()) {
		if (hasOwnGroup(configs.global.groups, name)) merged.push({ name, scope: "global", sourcePath: modelGroupsPath("global", access.cwd), ...cloneDef(configs.global.groups[name]) });
		if (access.policy === "global-project" && hasOwnGroup(configs.project.groups, name)) merged.push({ name, scope: "project", sourcePath: modelGroupsPath("project", access.cwd), ...cloneDef(configs.project.groups[name]) });
	}
	return merged;
}
export function loadModelGroups(access: ModelGroupsAccess): ModelGroupsLoadResult {
	const global = loadScope("global", access);
	const project = access.policy === "global-project" ? loadScope("project", access) : { config: emptyConfig() };
	const configs = { global: global.config, project: project.config };
	return { configs, merged: mergeLoaded(configs, access), issues: [global.issue, project.issue].filter((issue): issue is ModelGroupsLoadIssue => Boolean(issue)) };
}
function normalizeSaveConfig(scope: ModelGroupScope, sourcePath: string, config: ModelGroupsConfig): ModelGroupsConfig {
	const normalized = normalizeGroups(config.groups as unknown as Record<string, unknown>);
	if (!normalized.ok) throw persistenceError({ operation: "save", scope, sourcePath, phase: "config-validation", message: normalized.message });
	return { version: CURRENT_VERSION, groups: normalized.groups };
}
export function saveModelGroups(scope: ModelGroupScope, access: ModelGroupsAccess, config: ModelGroupsConfig): void {
	assertScopeAllowed(scope, access);
	const sourcePath = modelGroupsPath(scope, access.cwd);
	const normalized = normalizeSaveConfig(scope, sourcePath, config);
	const dir = path.dirname(sourcePath);
	const tempPath = `${sourcePath}.${process.pid}.${Date.now()}.tmp`;
	let raw: Record<string, unknown> = {};
	if (fsOps.existsSync(sourcePath)) {
		try { const parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8"))); if (isPlainRecord(parsed)) raw = parsed; }
		catch { /* load recovery owns malformed content */ }
	}
	const body = JSON.stringify({ ...raw, version: CURRENT_VERSION, groups: normalized.groups }, null, 2) + "\n";
	try { fsOps.mkdirSync(dir, { recursive: true }); fsOps.writeFileSync(tempPath, body, "utf8"); }
	catch (cause) { throw persistenceError({ operation: "save", scope, sourcePath, targetPath: tempPath, phase: "temp-write", message: `Failed to write temp model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }); }
	try { fsOps.renameSync(tempPath, sourcePath); }
	catch (cause) { throw persistenceError({ operation: "save", scope, sourcePath, targetPath: tempPath, phase: "rename", message: `Failed to commit model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }); }
}
function loadScopeConfig(scope: ModelGroupScope, access: ModelGroupsAccess): ModelGroupsConfig {
	const loaded = loadScope(scope, access);
	if (loaded.issue?.backupFailed) throw persistenceError({ operation: "save", scope, sourcePath: loaded.issue.sourcePath, targetPath: loaded.issue.backupPath, phase: "load-recovery", message: `Refusing to overwrite ${scope} model-groups config after ${loaded.issue.kind} recovery because backup failed: ${loaded.issue.message}`, cause: loaded.issue });
	return loaded.config;
}
function canonicalName(raw: string): string { const name = canonicalizeModelGroupName(raw); if (!name) throw new Error("Model group name is required"); return name; }
export function createGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string, def: ModelGroupDef): void {
	assertScopeAllowed(scope, access); const name = canonicalName(rawName); const config = loadScopeConfig(scope, access);
	if (hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' already exists in ${scope} scope`);
	defineGroup(config.groups, name, def); saveModelGroups(scope, access, config);
}
export function updateGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string, def: ModelGroupDef): void {
	assertScopeAllowed(scope, access); const name = canonicalName(rawName); const config = loadScopeConfig(scope, access);
	if (!hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	defineGroup(config.groups, name, def); saveModelGroups(scope, access, config);
}
export function renameGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawOldName: string, rawNewName: string): void {
	assertScopeAllowed(scope, access); const oldName = canonicalName(rawOldName); const newName = canonicalName(rawNewName); if (oldName === newName) return;
	const config = loadScopeConfig(scope, access);
	if (!hasOwnGroup(config.groups, oldName)) throw new Error(`Model group '${oldName}' does not exist in ${scope} scope`);
	if (hasOwnGroup(config.groups, newName)) throw new Error(`Model group '${newName}' already exists in ${scope} scope`);
	const existing = config.groups[oldName]; delete config.groups[oldName]; defineGroup(config.groups, newName, existing); saveModelGroups(scope, access, config);
}
export function deleteGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string): { otherScopeHasOverride: boolean } {
	assertScopeAllowed(scope, access); const name = canonicalName(rawName); const config = loadScopeConfig(scope, access);
	if (!hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	delete config.groups[name];
	const other = access.policy === "global-only" ? emptyConfig() : loadScopeConfig(scope === "global" ? "project" : "global", access);
	try { saveModelGroups(scope, access, config); }
	catch (cause) { if (cause instanceof ModelGroupsPersistenceError) throw new ModelGroupsPersistenceError({ operation: "delete", scope: cause.scope, sourcePath: cause.sourcePath, targetPath: cause.targetPath, phase: cause.phase, message: cause.message, cause }); throw cause; }
	return { otherScopeHasOverride: hasOwnGroup(other.groups, name) };
}
export function moveGroup(access: ModelGroupsAccess, rawName: string, newScope: ModelGroupScope): void {
	const name = canonicalName(rawName); const oldScope: ModelGroupScope = newScope === "project" ? "global" : "project";
	assertScopeAllowed(oldScope, access); assertScopeAllowed(newScope, access);
	const source = loadScopeConfig(oldScope, access); const target = loadScopeConfig(newScope, access);
	if (!hasOwnGroup(source.groups, name)) throw new Error(`Model group '${name}' does not exist in ${oldScope} scope`);
	if (hasOwnGroup(target.groups, name)) throw new Error(`Model group '${name}' already exists in ${newScope} scope`);
	defineGroup(target.groups, name, source.groups[name]);
	try { saveModelGroups(newScope, access, target); }
	catch (cause) { if (cause instanceof ModelGroupsPersistenceError) throw new ModelGroupsPersistenceError({ operation: "move", scope: newScope, sourcePath: modelGroupsPath(oldScope, access.cwd), targetPath: modelGroupsPath(newScope, access.cwd), phase: cause.phase, message: `Model group '${name}' was not written to ${newScope}: ${cause.message}`, cause }); throw cause; }
	delete source.groups[name];
	try { saveModelGroups(oldScope, access, source); }
	catch (cause) { if (cause instanceof ModelGroupsPersistenceError) throw new ModelGroupsPersistenceError({ operation: "move", scope: oldScope, sourcePath: modelGroupsPath(oldScope, access.cwd), targetPath: modelGroupsPath(newScope, access.cwd), phase: "source-remove", partialMove: "target-written-source-retained", message: `Model group '${name}' was written to ${newScope} but retained in ${oldScope}: ${cause.message}`, cause }); throw cause; }
}
export function validateModelGroups(loadResult: ModelGroupsLoadResult, modelRegistry: ModelRegistry): ResolvedModelGroup[] {
	const projectNames = new Set(Object.keys(loadResult.configs.project.groups));
	return loadResult.merged.map((group) => {
		const unavailableRefs: Array<{ provider: string; modelId: string }> = [];
		for (const ref of group.models) { const model = modelRegistry.find(ref.provider, ref.modelId); if (!model || !modelRegistry.hasConfiguredAuth(model)) unavailableRefs.push({ provider: ref.provider, modelId: ref.modelId }); }
		return { ...group, validation: { unavailableRefs, shadowedByProject: group.scope === "global" && projectNames.has(group.name), degraded: unavailableRefs.length > 0 && unavailableRefs.length < group.models.length } };
	});
}
export function listResolvedModelGroups(access: ModelGroupsAccess, modelRegistry: ModelRegistry): ModelGroupsBootValidation {
	const loaded = loadModelGroups(access); return { groups: validateModelGroups(loaded, modelRegistry), loadIssues: loaded.issues };
}
export function summarizeBootValidation(groups: ResolvedModelGroup[]): { unavailableCount: number; overrideCount: number } {
	return { unavailableCount: groups.reduce((sum, group) => sum + group.validation.unavailableRefs.length, 0), overrideCount: groups.filter((group) => group.validation.shadowedByProject).length };
}
export const EMPTY_MODEL_GROUPS_CONFIG: ModelGroupsConfig = emptyConfig();
export { CURRENT_VERSION as MODEL_GROUPS_CONFIG_VERSION, hasOwnGroup };
