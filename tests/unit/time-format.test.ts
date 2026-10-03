import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
	formatDuration,
	formatBlockFooter,
	formatCutAnchor,
	formatCurrentPeriod,
} from "../../time/format.js";

// ── formatDuration ────────────────────────────────────────────────────

test("formatDuration boundary table", () => {
	const cases: Array<[number, string]> = [
		[0, "0s"],
		[1, "0.1s"],
		[50, "0.1s"],
		[99, "0.1s"],
		[100, "0.1s"],
		[950, "0.9s"],
		[999, "0.9s"],
		[1000, "1.0s"],
		[3250, "3.2s"],
		[9999, "9.9s"],
		[10000, "10s"],
		[42000, "42s"],
		[59999, "59s"],
		[60000, "1m00s"],
		[134000, "2m14s"],
		[3599999, "59m59s"],
		[3600000, "1h00m"],
		[3720000, "1h02m"],
	];
	for (const [ms, expected] of cases) {
		assert.equal(formatDuration(ms), expected, `formatDuration(${ms})`);
	}
});

test("formatDuration never emits ISO/date/timezone markers", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 3_600_000 * 500 }), (ms) => {
			const out = formatDuration(ms);
			// No dashes, T, Z, colons, or a 4-digit year token (hours are always
			// followed by 'h', so no bounded 4-digit run exists).
			assert.doesNotMatch(out, /[-TZ:]|\b\d{4}\b/);
		}),
	);
});

test("formatDuration: nonzero input never renders 0.0s", () => {
	fc.assert(
		fc.property(fc.integer({ min: 1, max: 999_999_999 }), (ms) => {
			assert.notEqual(formatDuration(ms), "0.0s");
		}),
	);
});

test("formatDuration: inputs under 10000 render one decimal place (or 0s only when zero)", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 9999 }), (ms) => {
			const out = formatDuration(ms);
			if (ms === 0) {
				assert.equal(out, "0s");
			} else {
				// exactly one decimal digit + "s" (e.g. ".9s", ".0s")
				assert.match(out, /\.\ds$/);
			}
		}),
	);
});

// ── formatBlockFooter ─────────────────────────────────────────────────

test("formatBlockFooter labels the kind, the step delta, and the task reading", () => {
	assert.equal(formatBlockFooter("read", 134000, 3250), "[read +3.2s | task 2m14s]");
	assert.equal(formatBlockFooter("read", 134000, 6100), "[read +6.1s | task 2m14s]");
	assert.equal(formatBlockFooter("bash", 3000, 50), "[bash +0.1s | task 3.0s]");
});

test("formatBlockFooter always renders the step delta, even sub-500ms", () => {
	assert.equal(formatBlockFooter("read", 134000, 400), "[read +0.4s | task 2m14s]");
});

test("formatBlockFooter floors a zero step to +0.1s so an abort never reads +0s", () => {
	assert.equal(formatBlockFooter("bash", 134000, 0), "[bash +0.1s | task 2m14s]");
});

test("formatBlockFooter omits the step clause when the span was never recorded", () => {
	assert.equal(formatBlockFooter("read", 134000, null), "[read | task 2m14s]");
});

// ── formatCutAnchor ───────────────────────────────────────────────────

test("formatCutAnchor omits covers when coveredMs is null", () => {
	assert.equal(formatCutAnchor(2832000, null), "[task elapsed 47m12s]");
});

test("formatCutAnchor includes covers when coveredMs is non-null", () => {
	assert.equal(formatCutAnchor(2832000, 134000), "[task elapsed 47m12s; covers 2m14s]");
});

test("formatCutAnchor elapsed is computed once and appears exactly once", () => {
	const elapsed = 2832000; // "47m12s"
	const elapsedStr = formatDuration(elapsed);
	// null covered -> no covers clause, elapsed once
	assert.equal(formatCutAnchor(elapsed, null), "[task elapsed 47m12s]");
	// non-null covered -> covers clause present, elapsed still once
	for (const covered of [0, 1000, 134000, 3600000]) {
		const out = formatCutAnchor(elapsed, covered);
		assert.match(out, /; covers/);
		assert.equal(out.split(elapsedStr).length - 1, 1, `elapsed should appear once for covered=${covered}`);
	}
});

// ── formatCurrentPeriod ───────────────────────────────────────────────

test("formatDuration clamps negative, non-finite, and NaN input to 0s", () => {
	assert.equal(formatDuration(-1), "0s");
	assert.equal(formatDuration(-5000), "0s");
	assert.equal(formatDuration(-0), "0s");
	assert.equal(formatDuration(NaN), "0s");
	assert.equal(formatDuration(Infinity), "0s");
	assert.equal(formatDuration(-Infinity), "0s");
});

test("formatCurrentPeriod renders local month name + year", () => {
	assert.equal(formatCurrentPeriod(new Date(2025, 0, 1)), "January 2025");
	assert.equal(formatCurrentPeriod(new Date(2025, 6, 15)), "July 2025");
	assert.equal(formatCurrentPeriod(new Date(2025, 11, 31)), "December 2025");
});
