/**
 * Unit + property tests for the active-time clock (time/clock.ts).
 *
 * External invariants only: the reading equals the union of active spans,
 * UI waits inside active spans are excluded, and aborted/missing tool ends
 * never corrupt the depth counter or the reading.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
	createClock,
	monotonicNow,
	startGeneration,
	endGeneration,
	startTool,
	endTool,
	startUiPrompt,
	endUiPrompt,
	read,
	restore,
	snapshot,
	type Clock,
} from "../../time/clock.js";

// ── Idle gaps do not advance L ────────────────────────────────────────

test("idle gaps between active intervals do not advance L", () => {
	const c = createClock(0);
	startGeneration(c, 0);
	endGeneration(c, 1000);
	assert.equal(read(c), 1000);

	// Long idle stretch — nothing advances.
	assert.equal(read(c), 1000);

	startTool(c, "t1", 50_000);
	assert.equal(read(c), 1000);
	endTool(c, "t1", 51_000);
	assert.equal(read(c), 2000);
});

// ── Parallel tools count once via depth ──────────────────────────────

test("parallel tools count once: elapsed equals union span, not sum", () => {
	const c = createClock(0);
	startTool(c, "a", 0);
	startTool(c, "b", 100);
	// "a" runs 0..1000, "b" runs 100..1500 → union 0..1500 = 1500 (not 2400).
	endTool(c, "a", 1000);
	endTool(c, "b", 1500);
	assert.equal(read(c), 1500);
	assert.equal(endTool(c, "a", 2000).delta, null);
	assert.equal(endTool(c, "b", 2000).delta, null);
	// Clock is idle: subsequent wall time does not advance reading
	startTool(c, "c", 5000);
	assert.equal(read(c), 1500);
	endTool(c, "c", 6000);
	assert.equal(read(c), 2500);
});

// ── UI wait subtracted inside an active interval ─────────────────────

test("UI wait inside a tool is excluded from L and tool delta", () => {
	const c = createClock(0);
	startTool(c, "t", 0);
	// Clock is event-driven: time accrues on the next event, not on read.
	startUiPrompt(c, 100);
	assert.equal(read(c), 100);

	endUiPrompt(c, 10_100);
	assert.equal(read(c), 100);
	const { elapsed, delta } = endTool(c, "t", 10_200);
	assert.equal(elapsed, 200);
	assert.equal(delta, 200, "tool delta must exclude the UI prompt wait");
});

test("a repeated startTool is ignored so duplicate events cannot leak depth", () => {
	const c = createClock(0);
	startTool(c, "t1", 0);
	startTool(c, "t1", 100); // duplicate start event
	const r = endTool(c, "t1", 500);
	assert.equal(r.delta, 500);
	assert.equal(endTool(c, "t1", 600).delta, null);
	assert.equal(read(c), 500);
	// Idle gap: clock does not advance
	startTool(c, "t2", 1000);
	assert.equal(read(c), 500);
	endTool(c, "t2", 1200);
	assert.equal(read(c), 700);
});

// ── Abort / missing-start robustness ─────────────────────────────────

test("endTool for never-started id returns null delta, corrupts nothing", () => {
	const c = createClock(0);
	startTool(c, "real", 0);

	const r = endTool(c, "ghost", 500);
	assert.equal(r.delta, null);
	assert.equal(read(c), 500); // time recorded while depth still counted "real"

	// "real" keeps its slot, so its full span still accrues after the ghost end.
	const r2 = endTool(c, "real", 1000);
	assert.equal(r2.delta, 1000);
	assert.equal(read(c), 1000);
	// Idle gap: clock does not advance
	startTool(c, "after", 2000);
	assert.equal(read(c), 1000);
	endTool(c, "after", 2100);
	assert.equal(read(c), 1100);
});

test("ended tool start is removed so its endTool is idempotent-safe", () => {
	const c = createClock(0);
	startTool(c, "t", 0);
	endTool(c, "t", 100);
	// Second end: null delta, no depth underflow.
	const r = endTool(c, "t", 200);
	assert.equal(r.delta, null);
	// Next tool records correct span without underflow corruption
	startTool(c, "t2", 300);
	assert.equal(read(c), 100);
	endTool(c, "t2", 400);
	assert.equal(read(c), 200);
});

// ── Generation delta ─────────────────────────────────────────────────

test("endGeneration reports generation delta and clears marker", () => {
	const c = createClock(0);
	startGeneration(c, 0);
	startTool(c, "t", 100);
	endTool(c, "t", 600);
	const r = endGeneration(c, 1000);
	assert.equal(r.delta, 1000);
	assert.equal(endGeneration(c, 1100).delta, 0);
	// Idle gap: clock does not advance
	startTool(c, "t2", 2000);
	assert.equal(read(c), 1000);
	endTool(c, "t2", 2500);
	assert.equal(read(c), 1500);
});

test("endGeneration without start yields delta 0 and no depth underflow", () => {
	const c = createClock(0);
	const r = endGeneration(c, 100);
	assert.equal(r.delta, 0);
	startGeneration(c, 200);
	assert.equal(read(c), 0);
	const r2 = endGeneration(c, 300);
	assert.equal(r2.delta, 100);
	assert.equal(read(c), 100);
});

test("a repeated startGeneration is ignored so a synthetic failure pair cannot leak depth", () => {
	const c = createClock(0);
	startGeneration(c, 0);
	startGeneration(c, 100); // synthetic failure-path restart mid-stream
	endGeneration(c, 500);
	endGeneration(c, 600); // defensive second end stays balanced
	assert.equal(read(c), 500);
	assert.equal(endGeneration(c, 700).delta, 0);
	// Idle gap: clock does not advance
	startTool(c, "t", 1000);
	assert.equal(read(c), 500);
	endTool(c, "t", 1200);
	assert.equal(read(c), 700);
});

// ── Restore / snapshot ───────────────────────────────────────────────

test("startUiPrompt and endUiPrompt are idempotent", () => {
	const c = createClock(0);
	startTool(c, "t", 0);
	// 0..1000 active
	startUiPrompt(c, 1000);
	assert.equal(read(c), 1000);
	startUiPrompt(c, 2000); // duplicate start while already blocked
	assert.equal(read(c), 1000);

	endUiPrompt(c, 10_000);
	// Spurious second end while not blocked must not bump lastMarkMs or erase work
	endUiPrompt(c, 11_000);

	const { elapsed, delta } = endTool(c, "t", 12_000);
	// Active time: 0..1000 (1000ms) + 10_000..12_000 (2000ms) = 3000ms
	assert.equal(elapsed, 3000);
	assert.equal(delta, 3000);
});

test("restore resets depth, flags, and maps; sets reading", () => {
	const c = createClock(0);
	startGeneration(c, 0);
	startTool(c, "t", 10);
	startUiPrompt(c, 20);

	restore(c, 42_000, 999);
	assert.equal(read(c), 42_000);
	assert.equal(endTool(c, "t", 1000).delta, null);
	assert.equal(endGeneration(c, 1000).delta, 0);

	// After restore, time only advances on new activity.
	startTool(c, "t2", 1_000);
	endTool(c, "t2", 2_000);
	assert.equal(read(c), 43_000);
});

test("snapshot rounds the reading", () => {
	const c = createClock(0);
	startTool(c, "t", 0);
	endTool(c, "t", 100.6);
	assert.equal(snapshot(c), 101);
});

test("negative clock deltas are ignored", () => {
	const c = createClock(100);
	startTool(c, "t", 100);
	endTool(c, "t", 50); // now < lastMarkMs
	assert.equal(read(c), 0);
});

for (const correction of [-3_600_000, 3_600_000]) {
	test(`calendar correction ${correction}ms cannot skew active time`, (t) => {
		// Virtual calendar time is necessary: tests must never change the OS clock.
		t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
		const start = monotonicNow();
		const c = createClock(start);
		startTool(c, "t", start);
		t.mock.timers.setTime(Date.now() + correction);
		const end = monotonicNow();
		const result = endTool(c, "t", end);
		assert.equal(result.elapsed, end - start);
		assert.equal(result.delta, end - start);
		assert.ok(result.elapsed >= 0 && result.elapsed < Math.abs(correction));
	});
}

// ── Property: random valid transition sequences ──────────────────────

type ClockAction =
	| { type: "startGeneration" }
	| { type: "endGeneration" }
	| { type: "startTool"; id: string }
	| { type: "endTool"; id: string }
	| { type: "startUiPrompt" }
	| { type: "endUiPrompt" }
	| { type: "restore" };

const arbId = fc.stringMatching(/^[a-z0-9]{1,4}$/);
const arbAction: fc.Arbitrary<ClockAction> = fc.oneof(
	fc.constant({ type: "startGeneration" as const }),
	fc.constant({ type: "endGeneration" as const }),
	fc.record({ type: fc.constant("startTool" as const), id: arbId }),
	fc.record({ type: fc.constant("endTool" as const), id: arbId }),
	fc.constant({ type: "startUiPrompt" as const }),
	fc.constant({ type: "endUiPrompt" as const }),
	fc.constant({ type: "restore" as const }),
);

function apply(
	c: Clock,
	a: ClockAction,
	now: number,
	started: Map<string, number>,
): number | null {
	// Returns a tool delta when the action ends a tool, else null.
	switch (a.type) {
		case "startGeneration":
			startGeneration(c, now);
			return null;
		case "endGeneration":
			endGeneration(c, now);
			return null;
		case "startTool":
			startTool(c, a.id, now);
			return null;
		case "endTool": {
			const { delta } = endTool(c, a.id, now);
			return delta;
		}
		case "startUiPrompt":
			startUiPrompt(c, now);
			return null;
		case "endUiPrompt":
			endUiPrompt(c, now);
			return null;
		case "restore":
			restore(c, read(c), now);
			started.clear(); // restore drops all in-flight spans
			return null;
	}
}

test("property: reading within [0, wall span] and tool starts removed on end", () => {
	fc.assert(
		fc.property(
			fc.array(fc.tuple(arbAction, fc.nat({ max: 5_000 })), { maxLength: 60 }),
			fc.nat({ max: 10_000 }),
			(actions, origin) => {
				const c = createClock(origin);
				const started = new Map<string, number>();
				let now = origin;

				for (const [a, gap] of actions) {
					now += gap;
					const delta = apply(c, a, now, started);

					// Invariants after every step:
					assert.ok(read(c) >= 0, "reading must be non-negative");
					assert.ok(
						read(c) <= now - origin,
						"reading must not exceed wall span",
					);

					if (a.type === "startTool") started.set(a.id, now);
					if (a.type === "endTool") {
						started.delete(a.id);
						// Every ended tool's start is removed from the clock (repeat end returns null delta).
						const repeatEnd = endTool(c, a.id, now);
						assert.equal(repeatEnd.delta, null, `ended tool ${a.id} must return null delta on repeat end`);
						// A real start with a non-negative gap yields a non-negative delta.
						if (gap > 0) assert.ok(delta === null || delta >= 0);
					}
				}

				// Every still-running tool start is still tracked (endTool returns non-null delta).
				for (const id of started.keys()) {
					const endResult = endTool(c, id, now);
					assert.notEqual(endResult.delta, null, `in-flight tool ${id} must return non-null delta`);
				}

				// Final snapshot stays within the wall span.
				const s = snapshot(c);
				assert.ok(s >= 0 && s <= now - origin + 1);
			},
		),
		{ numRuns: 300 },
	);
});

test("property: clock monotonicity holds across arbitrary action sequences", () => {
	fc.assert(
		fc.property(
			fc.array(fc.tuple(arbAction, fc.nat({ max: 5_000 })), { minLength: 1, maxLength: 80 }),
			fc.nat({ max: 10_000 }),
			(actions, origin) => {
				const c = createClock(origin);
				const started = new Map<string, number>();
				let now = origin;
				let prevElapsed = read(c);

				for (const [a, gap] of actions) {
					now += gap;
					apply(c, a, now, started);
					const currentElapsed = read(c);
					assert.ok(
						currentElapsed >= prevElapsed,
						`monotonicity violated: ${currentElapsed} < ${prevElapsed} on action ${a.type}`,
					);
					prevElapsed = currentElapsed;
				}
			},
		),
		{ numRuns: 500 },
	);
});
