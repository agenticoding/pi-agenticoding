/**
 * Central test harness for the agenticoding extension.
 *
 * Every non-E2E test that touches module-level singletons starts with
 * `const h = createTestHarness()` and ends with `h.teardown()`.  One call
 * replaces the singleton container atomically and captures console output —
 * no per-test patches.
 *
 * Usage:
 *
 *   const h = createTestHarness();
 *   // test body — use h.warnings
 *   h.teardown();
 *
 * With beforeEach/afterEach:
 *
 *   describe("spawn", () => {
 *     let h: TestHarness;
 *     beforeEach(() => { h = createTestHarness(); });
 *     afterEach(() => { h.teardown(); });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
	type RuntimeSingletons,
} from "../runtime-singletons.js";
import { SpawnFrameScheduler } from "../spawn/renderer.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TestHarness {
	/** Captured console.warn and console.error calls. */
	warnings: Array<{ level: string; args: unknown[] }>;
	/** Restore console, clear scheduler, reset write lock. */
	teardown: () => void;
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a fresh test harness.  Every test that needs isolation calls this.
 *
 * CRITICAL: ESM static imports resolve before any module body runs. This means
 * spawn/renderer.ts registers the production frame scheduler at import time,
 * and createTestHarness() (called in beforeEach) always wins because tests
 * import this module after production modules. Never use dynamic import() to
 * load spawn/renderer.ts after createTestHarness() — the production scheduler
 * would overwrite the test one.
 */
export function createTestHarness(): TestHarness {
	const previousSingletons = getSingletons();
	const singletons: RuntimeSingletons = {
		writeLock: createWriteLock(),
		writeContext: new AsyncLocalStorage<true>(),
		frameScheduler: new SpawnFrameScheduler(),
	};
	const warnings: Array<{ level: string; args: unknown[] }> = [];
	const originalWarn = console.warn;
	const originalError = console.error;

	// Atomic swap: replace the production singleton container (write lock,
	// context, frame scheduler) in one call.
	__setSingletons(singletons);

	// Capture console output for assertions without noisy passing-test output.
	console.warn = (...args: unknown[]) => {
		warnings.push({ level: "warn", args });
	};
	console.error = (...args: unknown[]) => {
		warnings.push({ level: "error", args });
	};

	return {
		warnings,
		teardown: () => {
			// Restore singletons first so the harness scheduler is current.
			// Then clear it to release any dirty components before disposal.
			__setSingletons(previousSingletons);
			singletons.frameScheduler.clear();
			console.warn = originalWarn;
			console.error = originalError;
		},
	};
}
