import test from "node:test";
import assert from "node:assert/strict";
import { advance, createClock, read, restore, startTool } from "../../time/clock.js";
import {
	CLOCK_ENTRY_TYPE,
	persistClock,
	readPreviousCutElapsed,
	reconstructClock,
	resolveCutAnchor,
} from "../../time/store.js";

function clockEntry(id: string, l: unknown, version: unknown = 1): any {
	return { id, type: "custom", customType: CLOCK_ENTRY_TYPE, data: { version, l } };
}

function toolClockEntry(id: string, l: number, toolCallId: unknown): any {
	return { ...clockEntry(id, l), data: { version: 1, l, toolCallId } };
}

function toolResultEntry(id: string, toolCallId: string): any {
	return {
		id, type: "message",
		message: { role: "toolResult", toolCallId, content: [{ type: "text", text: "[read | task 99h]" }] },
	};
}

function restoredElapsed(branch: any[]): number {
	const clock = createClock(0);
	reconstructClock(clock, branch, 9999);
	return clock.elapsedMs;
}

function compactionEntry(id: string): any {
	return { id, type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 };
}

test("persistClock appends a v1 clock entry with the rounded reading", () => {
	const appended: Array<{ customType: string; data: any }> = [];
	const pi = { appendEntry: (customType: string, data: any) => { appended.push({ customType, data }); } } as any;
		const clock = createClock(1000);
	restore(clock, 1234.6, 1000);
	persistClock(pi, clock);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, CLOCK_ENTRY_TYPE);
	assert.deepEqual(appended[0].data, { version: 1, l: 1235 });
	persistClock(pi, clock, "call");
	assert.deepEqual(appended[1].data, { version: 1, l: 1235, toolCallId: "call" });
});

test("reconstructClock restores the newest valid reading", () => {
	const clock = createClock(0);
	reconstructClock(clock, [clockEntry("a", 100), clockEntry("b", 500)], 9999);
	assert.equal(clock.elapsedMs, 500);
	assert.equal(clock.lastMarkMs, 9999);
	assert.equal(clock.depth, 0);
});

test("reconstructClock ignores invalid and legacy data falling back to older valid", () => {
	for (const bad of [
		clockEntry("bad-version", 500, 2),
		clockEntry("negative", -5),
		clockEntry("fractional", 1.5),
		clockEntry("unsafe", Number.MAX_SAFE_INTEGER + 1),
		clockEntry("missing-l", undefined),
		{ id: "wrong-type", type: "custom", customType: "other", data: { version: 1, l: 500 } },
		{ id: "not-custom", type: "message", customType: CLOCK_ENTRY_TYPE, data: { version: 1, l: 500 } },
	]) {
		const clock = createClock(0);
		reconstructClock(clock, [clockEntry("valid", 200), bad], 9999);
		assert.equal(clock.elapsedMs, 200, `invalid entry must fall through to older valid (${(bad as any).id})`);
	}
});

test("reconstructClock: an invalid newest entry does not block an older valid one", () => {
	const clock = createClock(0);
	reconstructClock(
		clock,
		[clockEntry("old-valid", 300), clockEntry("new-invalid", 900, 99)],
		9999,
	);
	assert.equal(clock.elapsedMs, 300);
});

test("reconstructClock with no valid entry resets the clock to 0", () => {
	const clock = createClock(1000);
	restore(clock, 42, 1000);
	startTool(clock, "t", 1500);
	reconstructClock(clock, [{ id: "x", type: "message" } as any], 2000);
	assert.equal(read(clock), 0, "rewind to a branch without clock entries resets to 0");
	assert.equal(clock.lastMarkMs, 2000);
	// Behavioral invariant: after the reset the clock is idle, so idle wall time
	// cannot advance the reading (an in-flight span from the old branch is gone).
	advance(clock, 12_000);
	assert.equal(read(clock), 0, "clock must be idle after reconstruct cleared the abandoned span");
});

test("readPreviousCutElapsed returns the reading at/before the newest compaction", () => {
	const branch = [clockEntry("e0", 100), compactionEntry("c1"), clockEntry("e2", 200)];
	assert.equal(readPreviousCutElapsed(branch, null), 100);
});

test("readPreviousCutElapsed excludes the just-created compaction (strictly-before)", () => {
	const branch = [
		clockEntry("e0", 100),
		compactionEntry("c1"),
		clockEntry("e2", 500),
		compactionEntry("c2"),
	];
	// The c2 cut just happened; the previous cut is c1 with reading 100, not 500.
	assert.equal(readPreviousCutElapsed(branch, "c2"), 100);
});

test("readPreviousCutElapsed returns null with no compaction, no clock entry, or no previous cut", () => {
	assert.equal(readPreviousCutElapsed([clockEntry("e0", 100)], null), null);
	assert.equal(readPreviousCutElapsed([compactionEntry("c1")], null), null);
	// Only the just-created cut exists — there is no previous cut.
	assert.equal(
		readPreviousCutElapsed([clockEntry("e0", 100), compactionEntry("c1")], "c1"),
		null,
	);
});

test("readPreviousCutElapsed with unknown beforeEntryId scans the whole branch", () => {
	const branch = [clockEntry("e0", 100), compactionEntry("c1")];
	assert.equal(readPreviousCutElapsed(branch, "nope"), 100);
});

test("tool readings apply only at their own retained result, never from the footer", () => {
	const pending = [clockEntry("base", 200), toolClockEntry("early", 1000, "a"), toolClockEntry("late", 5000, "b")];
	assert.equal(restoredElapsed(pending), 200);
	assert.equal(restoredElapsed([...pending, toolResultEntry("a-result", "a")]), 1000);
	assert.equal(restoredElapsed([...pending, toolResultEntry("b-result", "b")]), 5000);
	assert.equal(restoredElapsed([...pending, toolResultEntry("unmatched", "other")]), 200);
});

test("reverse completion order restores the retained result rather than the newest completion", () => {
	const pending = [toolClockEntry("early", 1000, "b"), toolClockEntry("late", 5000, "a")];
	assert.equal(restoredElapsed([...pending, toolResultEntry("a-result", "a")]), 5000);
	assert.equal(restoredElapsed([...pending, toolResultEntry("a-result", "a"), toolResultEntry("b-result", "b")]), 1000);
});

test("independent generation, UI and fallback boundaries override retained tool readings", () => {
	const branch = [toolClockEntry("tool", 1000, "a"), toolResultEntry("result", "a")];
	for (const boundary of ["generation", "ui-start", "ui-end", "fallback", "cut"]) {
		assert.equal(restoredElapsed([...branch, clockEntry(boundary, 2000), toolClockEntry("pending", 5000, "b")]), 2000);
	}
});

test("invalid tool associations cannot masquerade as independent boundaries", () => {
	for (const toolCallId of ["", null, 7, {}]) {
		assert.equal(restoredElapsed([clockEntry("base", 200), toolClockEntry("bad", 5000, toolCallId)]), 200);
	}
});

test("previous cut uses position-aware raw restoration and excludes unretained completions", () => {
	const branch = [
		clockEntry("base", 200), toolClockEntry("early", 1000, "a"), toolClockEntry("late", 5000, "b"),
		toolResultEntry("a-result", "a"), compactionEntry("cut"),
	];
	assert.equal(readPreviousCutElapsed(branch, null), 1000);
});

test("resolveCutAnchor computes elapsed, covered, and formatted anchor", () => {
	const clock = createClock(50_000);
	// now == lastMarkMs, so resolveCutAnchor's advance adds nothing; no span needed.
	restore(clock, 50_000, 50_000);
	const branch = [clockEntry("e0", 20_000), compactionEntry("c1")];
	const result = resolveCutAnchor(clock, branch, null, 50_000);
	assert.equal(result.elapsed, 50_000);
	assert.equal(result.covered, 30_000);
	assert.equal(result.anchor, "[task elapsed 50s; covers 30s]");
});

test("resolveCutAnchor clamps covered to zero when the previous cut reading exceeds the current", () => {
	// A rewind or clock skew must never render a negative span.
	const clock = createClock(0);
	restore(clock, 1_000, 0);
	const branch = [clockEntry("e0", 5_000), compactionEntry("c1")];
	const result = resolveCutAnchor(clock, branch, null, 0);
	assert.equal(result.covered, 0);
	assert.equal(result.anchor, "[task elapsed 1.0s; covers 0s]");
});
