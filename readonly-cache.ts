/**
 * Readonly cache for skill/prompt-template frontmatter.
 *
 * Populated lazily in `before_agent_start` from:
 *   1. Loaded skills (via `systemPromptOptions.skills`).
 *   2. Resolved prompt commands from `pi.getCommands()`.
 *   3. Standard prompt directories as a partial fallback:
 *      `~/.pi/agent/prompts/` and trusted `cwd/.pi/prompts/`.
 *
 * All production prompt-resolution happens through
 * `populatePromptCacheFromResolvedCommandsAndDirs`. The narrower
 * `populateFromPromptDirs`, `populateFromPromptCommands`, and
 * `populateFromPromptTemplates` have been removed as dead code —
 * they duplicated the logic of the production path. Any test that
 * needs to exercise prompt caching should go through the production
 * function with an empty command list.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export interface ReadonlyCacheEntry {
	readonly: boolean | null;
	mtimeMs: number;
	filePath: string;
}

export interface ReadonlyCacheIssue {
	kind: "invalid-readonly-value" | "malformed-frontmatter" | "unreadable-file";
	filePath: string;
}

export interface ReadonlyCacheStore {
	readonlySkillCache: Map<string, ReadonlyCacheEntry>;
	readonlyPromptCache: Map<string, ReadonlyCacheEntry>;
	readonlySkillIssues: Map<string, ReadonlyCacheIssue>;
	readonlyPromptIssues: Map<string, ReadonlyCacheIssue>;
}

interface CacheReadResult {
	entry: ReadonlyCacheEntry | null;
	issue: ReadonlyCacheIssue | null;
}

function readCacheEntry(filePath: string, previous?: ReadonlyCacheEntry): CacheReadResult {
	let st;
	try {
		st = statSync(filePath);
	} catch (error: any) {
		return error?.code === "ENOENT" || error?.code === "ENOTDIR"
			? { entry: null, issue: null }
			: { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	if (previous && previous.filePath === filePath && st.mtimeMs === previous.mtimeMs) {
		return { entry: previous, issue: null };
	}

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		const readonly = frontmatter["readonly"];
		if (readonly === undefined || typeof readonly === "boolean") {
			return {
				entry: { readonly: readonly ?? null, mtimeMs: st.mtimeMs, filePath },
				issue: null,
			};
		}
		return {
			entry: { readonly: null, mtimeMs: st.mtimeMs, filePath },
			issue: { kind: "invalid-readonly-value", filePath },
		};
	} catch {
		return {
			entry: null,
			issue: { kind: "malformed-frontmatter", filePath },
		};
	}
}

function replaceCache(target: Map<string, ReadonlyCacheEntry>, next: Map<string, ReadonlyCacheEntry>): void {
	target.clear();
	for (const [name, entry] of next) target.set(name, entry);
}

function replaceIssues(target: Map<string, ReadonlyCacheIssue>, next: Map<string, ReadonlyCacheIssue>): void {
	target.clear();
	for (const [name, issue] of next) target.set(name, issue);
}

function setEntry(
	nextCache: Map<string, ReadonlyCacheEntry>,
	nextIssues: Map<string, ReadonlyCacheIssue>,
	name: string,
	result: CacheReadResult,
): void {
	if (result.entry) nextCache.set(name, result.entry);
	if (result.issue) nextIssues.set(name, result.issue);
}

export function cacheLookupSkill(store: ReadonlyCacheStore, name: string): boolean | null {
	return store.readonlySkillCache.get(name)?.readonly ?? null;
}

export function cacheLookupPrompt(store: ReadonlyCacheStore, name: string): boolean | null {
	return store.readonlyPromptCache.get(name)?.readonly ?? null;
}

export function cacheLookupCommand(store: ReadonlyCacheStore, name: string): boolean | null {
	return cacheLookupPrompt(store, name);
}

export function cacheLookupSkillIssue(store: ReadonlyCacheStore, name: string): ReadonlyCacheIssue | null {
	return store.readonlySkillIssues.get(name) ?? null;
}

export function cacheLookupCommandIssue(store: ReadonlyCacheStore, name: string): ReadonlyCacheIssue | null {
	return store.readonlyPromptIssues.get(name) ?? null;
}

/**
 * Format a user-facing warning message for a readonly frontmatter issue.
 * Used when a skill or prompt has invalid `readonly` frontmatter or the
 * source file cannot be read. Missing `readonly` is a normal no-op.
 */
export function formatReadonlyFrontmatterIssue(commandRef: string, issue: ReadonlyCacheIssue): string {
	const detail = issue.kind === "invalid-readonly-value"
		? "`readonly` frontmatter must be `true` or `false`"
		: issue.kind === "malformed-frontmatter"
			? "frontmatter could not be parsed"
			: "prompt/skill file could not be read";
	return `Readonly frontmatter ignored for \`${commandRef}\`: ${detail} at \`${issue.filePath}\`.`;
}

export function populateFromSkills(store: ReadonlyCacheStore, skills: Skill[]): void {
	const nextCache = new Map<string, ReadonlyCacheEntry>();
	const nextIssues = new Map<string, ReadonlyCacheIssue>();
	for (const skill of skills) {
		const result = readCacheEntry(skill.filePath, store.readonlySkillCache.get(skill.name));
		setEntry(nextCache, nextIssues, skill.name, result);
	}
	replaceCache(store.readonlySkillCache, nextCache);
	replaceIssues(store.readonlySkillIssues, nextIssues);
}

function collectPromptFilesFromDir(
	store: ReadonlyCacheStore,
	dir: string,
	nextCache: Map<string, ReadonlyCacheEntry>,
	nextIssues: Map<string, ReadonlyCacheIssue>,
	blockedNames: Set<string>,
): void {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (extname(file) !== ".md") continue;
		const name = basename(file, ".md");
		if (!name || blockedNames.has(name) || nextCache.has(name) || nextIssues.has(name)) continue;
		const result = readCacheEntry(join(dir, file), store.readonlyPromptCache.get(name));
		setEntry(nextCache, nextIssues, name, result);
	}
}

/**
 * Populate the prompt cache from resolved prompt commands plus the standard
 * prompt directories that Pi also uses on disk.
 *
 * Priority for duplicate names:
 *   1. Resolved prompt commands from `pi.getCommands()`.
 *   2. Trusted project prompts in `cwd/.pi/prompts/`.
 *   3. Global prompts in `~/.pi/agent/prompts/`.
 *
 * This is intentionally not a full prompt-source resolver. Anything outside
 * those standard dirs must already be surfaced by `pi.getCommands()`.
 */
export function populatePromptCacheFromResolvedCommandsAndDirs(
	store: ReadonlyCacheStore,
	commands: SlashCommandInfo[],
	cwd: string,
	projectTrusted: boolean,
): void {
	const nextCache = new Map<string, ReadonlyCacheEntry>();
	const nextIssues = new Map<string, ReadonlyCacheIssue>();
	const blockedNames = new Set<string>();

	for (const command of commands) {
		if (!command.name) continue;
		if (command.source !== "prompt") {
			blockedNames.add(command.name);
			continue;
		}
		if (nextCache.has(command.name) || nextIssues.has(command.name)) continue;
		const result = readCacheEntry(command.sourceInfo.path, store.readonlyPromptCache.get(command.name));
		setEntry(nextCache, nextIssues, command.name, result);
	}

	if (projectTrusted) {
		collectPromptFilesFromDir(store, join(cwd, ".pi", "prompts"), nextCache, nextIssues, blockedNames);
	}
	collectPromptFilesFromDir(store, join(homedir(), ".pi", "agent", "prompts"), nextCache, nextIssues, blockedNames);

	replaceCache(store.readonlyPromptCache, nextCache);
	replaceIssues(store.readonlyPromptIssues, nextIssues);
}
