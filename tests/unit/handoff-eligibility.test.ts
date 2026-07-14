import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	isHandoffEligible,
	MIN_HANDOFF_TOKENS,
	normalizeContextPercent,
} from "../../handoff/eligibility.js";

test("handoff eligibility prefers explicit tokens", () => {
	assert.equal(estimateHandoffContextTokens({ tokens: MIN_HANDOFF_TOKENS, percent: 1, contextWindow: 1 }), MIN_HANDOFF_TOKENS);
	assert.equal(isHandoffEligible({ tokens: MIN_HANDOFF_TOKENS }), true);
	assert.equal(isHandoffEligible({ tokens: MIN_HANDOFF_TOKENS - 1 }), false);
});

test("handoff eligibility estimates tokens from percent and context window", () => {
	assert.equal(estimateHandoffContextTokens({ tokens: null, percent: 15, contextWindow: 200_000 }), 30_000);
	assert.equal(isHandoffEligible({ tokens: null, percent: 15.001, contextWindow: 200_000 }), true);
	assert.equal(isHandoffEligible({ tokens: null, percent: 125, contextWindow: 200_000 }), true);
	assert.equal(isHandoffEligible({ tokens: null, percent: 14.9, contextWindow: 200_000 }), false);
	assert.equal(estimateHandoffContextTokens({ tokens: null, percent: 14.9999, contextWindow: 200_000 }), 29_999.8);
	assert.equal(isHandoffEligible({ tokens: null, percent: 14.9999, contextWindow: 200_000 }), false);
});

test("context percentage normalization accepts finite non-negative usage, including overflow", () => {
	assert.equal(normalizeContextPercent(0), 0);
	assert.equal(normalizeContextPercent(100), 100);
	assert.equal(normalizeContextPercent(125), 125);
	for (const percent of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
		assert.equal(normalizeContextPercent(percent), null);
	}
});

test("handoff eligibility rejects malformed or unestimable usage", () => {
	for (const usage of [
		null,
		{ tokens: Number.NaN },
		{ tokens: -1 },
		{ tokens: null, percent: Number.NaN, contextWindow: 200_000 },
		{ tokens: null, percent: Number.POSITIVE_INFINITY, contextWindow: 200_000 },
		{ tokens: null, percent: -1, contextWindow: 200_000 },
		{ tokens: null, percent: 20, contextWindow: 0 },
	]) {
		assert.equal(estimateHandoffContextTokens(usage), null);
		assert.equal(isHandoffEligible(usage), false);
	}
});

test("handoff eligibility rejects arithmetic overflow", () => {
	const usage = { tokens: null, percent: 100, contextWindow: Number.MAX_VALUE };
	assert.equal(estimateHandoffContextTokens(usage), null);
	assert.equal(isHandoffEligible(usage), false);
	assert.equal(formatHandoffContextUsage(usage), "~unknown tokens estimated from context usage");
});

test("handoff eligibility is monotonic as explicit context tokens grow", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (base, additional) => {
			const initial = isHandoffEligible({ tokens: base });
			const larger = isHandoffEligible({ tokens: base + additional });
			assert.ok(!initial || larger, `${base} eligible but ${base + additional} was not`);
		}),
	);
});

test("handoff usage formatting distinguishes explicit and estimated values", () => {
	assert.equal(formatHandoffContextUsage({ tokens: 12_345 }), "12345 tokens");
	assert.equal(
		formatHandoffContextUsage({ tokens: null, percent: 10, contextWindow: 200_000 }),
		"~20000 tokens estimated from context usage",
	);
	assert.equal(formatHandoffContextUsage(null), "~unknown tokens estimated from context usage");
});
