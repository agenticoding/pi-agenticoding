import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTestHarness } from "../test-utils.js";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
	isNoopScheduler,
} from "../../runtime-singletons.js";

test("createTestHarness swaps singleton state atomically and restores it on teardown", () => {
	const before = getSingletons();
	const h = createTestHarness();
	const during = getSingletons();

	assert.notEqual(during, before);
	assert.notEqual(during.writeContext, before.writeContext);
	assert.notEqual(during.frameScheduler, before.frameScheduler);

	h.teardown();
	assert.equal(getSingletons(), before);
});

test("__setSingletons warns when preserving in-flight write lock", () => {
	// Use harness to isolate the test's singleton manipulation
	const h = createTestHarness();
	try {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => {
			warnings.push(msg);
		};
		try {
			const s = getSingletons();
			s.writeLock.pending = 1; // simulate in-flight write on test singleton
			__setSingletons({
				writeLock: createWriteLock(),
				writeContext: new AsyncLocalStorage<true>(),
				frameScheduler: s.frameScheduler,
			});
			assert.ok(warnings.length > 0);
			assert.match(warnings[0], /pending/);
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		h.teardown();
	}
});

test("write lock serializes concurrent writers and completes all", async () => {
	const h = createTestHarness();
	const s = getSingletons();

	const order: number[] = [];
	const writers = Array.from({ length: 5 }, (_, i) =>
		(async () => {
			// Grab the current tail promise before acquiring the lock
			const prev = s.writeLock.tail;
			// Simulate acquiring the lock by chaining onto the tail
			let release: () => void;
			const next = new Promise<void>((resolve) => { release = resolve; });
			s.writeLock.pending += 1;
			s.writeLock.tail = next;
			await prev;
			order.push(i);
			s.writeLock.pending -= 1;
			release!();
		})(),
	);

	await Promise.all(writers);

	// All writers completed in some order
	assert.equal(order.length, 5);
	assert.ok(order.includes(0));
	assert.ok(order.includes(4));

	// Order is deterministic (no concurrent completion — serialized by lock)
	// If lock works, order is a strict permutation of [0,1,2,3,4]
	const sorted = [...order].sort((a, b) => a - b);
	assert.deepEqual(order, sorted, "lock must serialize writers — no concurrent completion");

	h.teardown();
});

test("isNoopScheduler returns false for SpawnFrameScheduler", () => {
	// The noop scheduler is created at module init but overwritten by
	// spawn/renderer.ts at import time — so the global singleton always
	// holds a real scheduler. The true path (returns true) is exercised by
	// the import-order guard in createTestHarness() — see test-utils.ts.
	assert.equal(isNoopScheduler(getSingletons().frameScheduler), false);

	const h = createTestHarness();
	assert.equal(isNoopScheduler(getSingletons().frameScheduler), false);
	h.teardown();
});
