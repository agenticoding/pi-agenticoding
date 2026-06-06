/**
 * Shared mutable state for the agenticoding extension.
 *
 * Single source of truth that all modules read/write through.
 * Mutable by design — this is session-scoped imperative state.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface AgenticodingState {
	/** Compact notebook pages keyed by kebab-case name */
	notebookPages: Map<string, string>;

	/** Monotonically increasing epoch, set on first notebook_write */
	epoch: number;

	/** Current semantic frame for topic-aware spawn vs handoff decisions. */
	activeNotebookTopic: string | null;

	/** Whether the current topic came from the human or the agent. */
	activeNotebookTopicSource: "human" | "agent" | null;

	/** One-shot boundary cue consumed by the next LLM call after a topic change. */
	pendingTopicBoundaryHint: {
		from: string | null;
		to: string;
		source: "human" | "agent";
	} | null;

	/** Last context usage percent from getContextUsage() */
	lastContextPercent: number | null;

	/** Handoff task queued by the tool until the compaction hook consumes it. */
	pendingHandoff: { task: string; source: "tool"; manualRequestGeneration?: number | null; manualRequestId?: string | null } | null;

	/** User-requested handoff that must result in a real tool-driven compaction. */
	pendingRequestedHandoff: {
		/** Unique identity for this manual request; prompt text/direction is not identity. */
		requestId: string;
		direction: string;
		enforcementAttempts: number;
		toolCalled: boolean;
		/** True until the LLM run created by /handoff has actually started. */
		awaitingAgentTurn: boolean;
	} | null;

	/** Exact extension-injected user message that should start the pending /handoff run. */
	pendingRequestedHandoffPrompt: string | null;

	/** Monotonic identity for manual /handoff requests; same direction is not identity. */
	pendingRequestedHandoffGeneration: number;

	/**
	 * One-shot grace after compaction onError restores a manual request. Prevents
	 * same failed turn cleanup from treating the retry-ready request as stale.
	 */
	pendingRequestedHandoffRetryProtected: boolean;

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
}

/** Create a fresh state instance. Call reset() on /new. */
export function createState(): AgenticodingState {
	const childSessions = new Map<string, AgentSession>();
	const liveChildSessions = new Map<string, AgentSession>();
	const state: AgenticodingState = {
		notebookPages: new Map(),
		epoch: 0,
		activeNotebookTopic: null,
		activeNotebookTopicSource: null,
		pendingTopicBoundaryHint: null,
		lastContextPercent: null,
		pendingHandoff: null,
		pendingRequestedHandoff: null,
		pendingRequestedHandoffPrompt: null,
		pendingRequestedHandoffGeneration: 0,
		pendingRequestedHandoffRetryProtected: false,
		childSessions,
		liveChildSessions,
		childSessionEpoch: 0,
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
	state.pendingTopicBoundaryHint = null;
	state.lastContextPercent = null;
	state.pendingHandoff = null;
	state.pendingRequestedHandoff = null;
	state.pendingRequestedHandoffPrompt = null;
	state.pendingRequestedHandoffGeneration = 0;
	state.pendingRequestedHandoffRetryProtected = false;
	abortAndClearChildSessions(state);
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
		session.abort().catch((e: unknown) => console.warn("[spawn] abort failed:", id, e));
	}
}
