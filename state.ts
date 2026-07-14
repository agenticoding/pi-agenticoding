/**
 * Shared mutable state for the agenticoding extension.
 *
 * Single source of truth that all modules read/write through.
 * Mutable by design — this is session-scoped imperative state.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ReadonlyCacheEntry, ReadonlyCacheIssue } from "./readonly-cache.js";
import type { NotebookTopicBoundaryHint } from "./notebook/topic.js";

export interface AgenticodingState {
	/** Compact notebook pages keyed by kebab-case name */
	notebookPages: Map<string, string>;

	/** Monotonically increasing epoch, set on first notebook_write */
	epoch: number;

	/** Current semantic frame for topic-aware spawn vs handoff decisions. */
	activeNotebookTopic: string | null;

	/** Whether the current topic came from the human or the agent. */
	activeNotebookTopicSource: "human" | "agent" | null;

	/**
	 * Boundary cue consumed after a topic change. Human readonly boundaries remain
	 * queued while context usage is unavailable or below the handoff threshold so a
	 * later eligible context hook can promote them to the handoff bypass.
	 */
	pendingTopicBoundaryHint: NotebookTopicBoundaryHint | null;

	/** Last context usage percent from getContextUsage() */
	lastContextPercent: number | null;

	/** Handoff task queued by the tool until the matching compaction hook consumes it. */
	pendingHandoff: { task: string; source: "tool"; generation: number } | null;

	/** Monotonically increasing identity used to ignore stale compaction callbacks. */
	handoffGeneration: number;

	/** Generation of the compaction currently in flight, if any. */
	handoffCompactionGeneration: number | null;

	/**
	 * Required handoff request that stays alive until a real tool-driven compaction
	 * succeeds, is explicitly reset, or ages out via watchdog enforcement.
	 */
	pendingRequestedHandoff: {
		/** True only after the current session has actually called the handoff tool. */
		toolCalled: boolean;
		/** Fresh context after successful compaction resumes in readonly mode. */
		resumeReadonlyAfterHandoff: boolean;
		/** Turn counter for repeated "you still owe the user a handoff" nudges. */
		enforcementAttempts: number;
	} | null;

	/**
	 * Published child agent sessions keyed by toolCallId.
	 * Lifecycle: executeSpawn publishes → renderSpawnResult claims via get+delete.
	 * This is only the render handoff queue, not the full live-session registry.
	 */
	childSessions: Map<string, AgentSession>;

	/**
	 * All live child agent sessions keyed by toolCallId, including claimed ones.
	 * Reset/teardown aborts this registry so claimed children cannot outlive /new or UI disposal.
	 * Completed children remove themselves from this registry before returning.
	 *
	 * INVARIANT: This Map is never replaced — only cleared via .clear().
	 * Spawn renderer ownership checks read this registry after attach, so its
	 * identity must stay stable across resets, completion cleanup, and disposal.
	 */
	liveChildSessions: Map<string, AgentSession>;

	/**
	 * Generation counter for child-session ownership.
	 * Increment on /new so stale child updates/results cannot touch fresh state.
	 */
	childSessionEpoch: number;

	/** Whether readonly mode is active — write/edit blocked; handoff needs explicit /handoff or a human topic boundary; bash writes limited to temp. */
	readonlyEnabled: boolean;

	/** One-shot flag: deliver a readonly ON or OFF nudge via context hook, then clear. */
	readonlyNudgePending: boolean;

	/** Session-owned readonly frontmatter cache for loaded skills. */
	readonlySkillCache: Map<string, ReadonlyCacheEntry>;

	/** Session-owned readonly frontmatter cache for resolved prompt commands. */
	readonlyPromptCache: Map<string, ReadonlyCacheEntry>;

	/** Frontmatter issues keyed by skill name. */
	readonlySkillIssues: Map<string, ReadonlyCacheIssue>;

	/** Frontmatter issues keyed by prompt command name. */
	readonlyPromptIssues: Map<string, ReadonlyCacheIssue>;

	/**
	 * FIFO slash-command intents extracted from queued user inputs, deferred to
	 * before_agent_start where the readonly frontmatter cache is populated.
	 * Empty = no pending toggle.
	 *
	 * `type` preserves `/skill:name` vs generic `/name` so lookup can target the
	 * correct readonly source without conflating skills and prompt templates.
	 * Enqueued in `input`, drained in `before_agent_start` until the first real
	 * readonly decision, cleared on session reset.
	 */
	pendingReadonlyCommands: Array<{ type: "skill" | "command"; name: string }>;

	/**
	 * Last context-percentage band at which the watchdog nudge was delivered.
	 * null = never delivered. Bands: null (<30), 0 (30-49), 1 (50-69), 2 (70+).
	 * Used to throttle nudges — only nudge when crossing into a higher band.
	 */
	lastWatchdogBand: number | null;

}

/** Create a fresh state instance. Call reset() on /new. */
export function createState(): AgenticodingState {
	const childSessions = new Map<string, AgentSession>();
	const liveChildSessions = new Map<string, AgentSession>();
	const readonlySkillCache = new Map<string, ReadonlyCacheEntry>();
	const readonlyPromptCache = new Map<string, ReadonlyCacheEntry>();
	const readonlySkillIssues = new Map<string, ReadonlyCacheIssue>();
	const readonlyPromptIssues = new Map<string, ReadonlyCacheIssue>();
	const state: AgenticodingState = {
		notebookPages: new Map(),
		epoch: 0,
		activeNotebookTopic: null,
		activeNotebookTopicSource: null,
		pendingTopicBoundaryHint: null,
		lastContextPercent: null,
		pendingHandoff: null,
		handoffGeneration: 0,
		handoffCompactionGeneration: null,
		pendingRequestedHandoff: null,
		childSessions,
		liveChildSessions,
		childSessionEpoch: 0,
		readonlyEnabled: false,
		readonlyNudgePending: false,
		readonlySkillCache,
		readonlyPromptCache,
		readonlySkillIssues,
		readonlyPromptIssues,
		pendingReadonlyCommands: [],
		lastWatchdogBand: null,
	};
	// Prevent replacement — spawn lifecycle code and renderer ownership checks
	// depend on stable map identity. Only .clear() and .delete() are valid —
	// assigning a new Map would silently break child-session invalidation.
	Object.defineProperty(state, 'childSessions', {
		get: () => childSessions,
		set: () => { throw new Error('childSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	Object.defineProperty(state, 'liveChildSessions', {
		get: () => liveChildSessions,
		set: () => { throw new Error('liveChildSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	return state;
}

/** Reset all state. Used on /new or session reset. */
export function resetState(state: AgenticodingState): void {
	state.childSessionEpoch++;
	state.notebookPages.clear();
	state.epoch = 0; // sentinel: 0 = not yet initialized; set to Date.now() on first write
	state.activeNotebookTopic = null;
	state.activeNotebookTopicSource = null;
	state.lastContextPercent = null;
	invalidateHandoffState(state);
	// /new abandons the previous session completely; do not carry its in-flight
	// reservation into the fresh session.
	state.handoffCompactionGeneration = null;
	state.readonlyEnabled = false;
	state.readonlyNudgePending = false;
	state.readonlySkillCache.clear();
	state.readonlyPromptCache.clear();
	state.readonlySkillIssues.clear();
	state.readonlyPromptIssues.clear();
	state.pendingReadonlyCommands.length = 0;
	abortAndClearChildSessions(state);
}

/** Invalidate handoff work that belongs to a previous session-tree branch. */
export function invalidateHandoffState(state: AgenticodingState): void {
	state.handoffGeneration++;
	state.pendingHandoff = null;
	state.handoffCompactionGeneration = null;
	state.pendingRequestedHandoff = null;
	state.pendingTopicBoundaryHint = null;
	state.lastWatchdogBand = null;
	// A branch switch abandons the old compaction path completely. Release the
	// overlap guard now so the new branch cannot get stuck waiting on callbacks
	// from work that no longer belongs to the active session tree.
}

/** Abort all active child sessions and clear both registries. Called on /new (session reset). */
export function abortAndClearChildSessions(state: AgenticodingState): void {
	const seen = new Map<any, string>(); // session → first id (for logging)
	for (const [id, session] of [...state.childSessions.entries(), ...state.liveChildSessions.entries()]) {
		if (!seen.has(session)) seen.set(session, id);
	}
	state.childSessions.clear();
	state.liveChildSessions.clear();
	for (const [session, id] of seen) {
		session.abort().catch(() => {});
	}
}
