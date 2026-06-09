/**
 * Shared singleton container for the agenticoding extension.
 *
 * Allows tests to replace all module-level singletons (write lock, frame
 * scheduler, etc.) with one atomic swap via __setSingletons(), instead of
 * patching each singleton individually per test.
 *
 * In production the frame scheduler is registered by spawn/renderer.ts at
 * module import time.  In tests, createTestHarness() provides a fresh
 * container that tests own and dispose.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── Types ─────────────────────────────────────────────────────────────

/** Minimal frame scheduler interface that the container understands. */
export interface RuntimeFrameScheduler {
	markDirty(component: unknown): void;
	cancelDirty(component: unknown): void;
	flushNow(): void;
	clear(): void;
	/** Marker property to identify the default noop scheduler. */
	[NOOP_SCHEDULER_MARKER]?: true;
}

export interface RuntimeWriteLock {
	pending: number;
	tail: Promise<void>;
}

export interface RuntimeSingletons {
	writeLock: RuntimeWriteLock;
	writeContext: AsyncLocalStorage<true>;
	frameScheduler: RuntimeFrameScheduler;
}

export function createWriteLock(): RuntimeWriteLock {
	return {
		pending: 0,
		tail: Promise.resolve(),
	};
}

// ── Pre‑init defaults (overwritten by spawn/renderer.ts at import time) ──

/** Sentinel tag to identify the default noop scheduler. */
const NOOP_SCHEDULER_MARKER = Symbol("no-op-scheduler");

function createNoopScheduler(): RuntimeFrameScheduler {
	return {
		markDirty: () => {},
		cancelDirty: () => {},
		flushNow: () => {},
		clear: () => {},
		[NOOP_SCHEDULER_MARKER]: true,
	};
}

let current: RuntimeSingletons = {
	writeLock: createWriteLock(),
	writeContext: new AsyncLocalStorage<true>(),
	frameScheduler: createNoopScheduler(),
};

// ── Public API ────────────────────────────────────────────────────────

/** Atomically replace all singletons.  Test‑only — use __ naming convention. */
export function __setSingletons(
	s: RuntimeSingletons,
	options?: { forceWriteLock?: boolean },
): void {
	if (!options?.forceWriteLock && current.writeLock.pending > 0) {
		console.warn(
			"[runtime-singletons] writeLock has %d pending operation(s) — " +
				"preserving existing lock chain to avoid breaking in-flight writes. " +
				"Use { forceWriteLock: true } to override.",
			current.writeLock.pending,
		);
		current = { ...s, writeLock: current.writeLock };
		return;
	}
	current = s;
}

/** Read the current singleton container. */
export function getSingletons(): RuntimeSingletons {
	return current;
}
