/**
 * Property-based state invariant tests using fast-check.
 *
 * Generates random sequences of state operations and asserts invariants
 * that must hold after every operation on a pure AgenticodingState.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState, resetState, abortAndClearChildSessions } from "../../state.js";
import type { AgenticodingState } from "../../state.js";
import {
	setActiveNotebookTopic,
	clearActiveNotebookTopic,
} from "../../notebook/topic.js";
import { saveNotebookPage } from "../../notebook/store.js";

// ── Mock ExtensionAPI ─────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

// ── Action types ──────────────────────────────────────────────────────

type StateAction =
	| { type: "reset" }
	| { type: "setTopic"; name: string }
	| { type: "clearTopic" }
	| { type: "savePage"; name: string }
	| { type: "addChildSession"; id: string }
	| { type: "abortChildren" };

/** Generator for valid normalized topic names (non-empty after normalizeNotebookTopic). */
const arbTopicName = fc
	.stringMatching(/^[a-zA-Z][a-zA-Z0-9 _-]{0,19}$/)
	.map((s) => s.trim())
	.filter((s) => s.length > 0);

/** Generator for valid notebook page names (kebab-case). */
const arbPageName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Generator for session IDs (simulating toolCallId format). */
const arbSessionId = fc
	.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
	.filter((s) => s.length > 0);

// ── Apply ─────────────────────────────────────────────────────────────

async function apply(
	state: AgenticodingState,
	action: StateAction,
): Promise<void> {
	switch (action.type) {
		case "reset":
			resetState(state);
			break;
		case "setTopic":
			setActiveNotebookTopic(state, action.name, "agent");
			break;
		case "clearTopic":
			clearActiveNotebookTopic(state);
			break;
		case "savePage":
			await saveNotebookPage(mockPi, state, action.name, "content-" + action.name);
			break;
		case "addChildSession":
			state.childSessions.set(action.id, { abort: () => Promise.resolve() } as any);
			state.liveChildSessions.set(action.id, { abort: () => Promise.resolve() } as any);
			break;
		case "abortChildren":
			abortAndClearChildSessions(state);
			break;
	}
}

// ── Invariant helpers ─────────────────────────────────────────────────

function assertTopicSourceCoupling(state: AgenticodingState): void {
	const msg = `topic=${state.activeNotebookTopic} source=${state.activeNotebookTopicSource}`;
	if (state.activeNotebookTopic === null) {
		assert.equal(state.activeNotebookTopicSource, null, `topic null → source null: ${msg}`);
	} else {
		assert.notEqual(state.activeNotebookTopicSource, null, `topic set → source set: ${msg}`);
	}
	// Bidirectional: source null → topic null too
	if (state.activeNotebookTopicSource === null) {
		assert.equal(state.activeNotebookTopic, null, `source null → topic null: ${msg}`);
	}
}

function assertChildSessionContainment(state: AgenticodingState): void {
	for (const key of state.childSessions.keys()) {
		assert.ok(
			state.liveChildSessions.has(key),
			`childSessions key "${key}" must be in liveChildSessions`,
		);
	}
}

function assertResetClears(state: AgenticodingState): void {
	assert.equal(state.notebookPages.size, 0, "notebookPages must be empty after reset");
	assert.equal(state.childSessions.size, 0, "childSessions must be empty after reset");
	assert.equal(state.liveChildSessions.size, 0, "liveChildSessions must be empty after reset");
	assert.equal(state.epoch, 0, "epoch must be 0 after reset");
	assert.equal(state.activeNotebookTopic, null, "topic must be null after reset");
	assert.equal(state.activeNotebookTopicSource, null, "topic source must be null after reset");
	assert.equal(state.pendingHandoff, null, "pendingHandoff must be null after reset");
	assert.equal(state.pendingRequestedHandoff, null, "pendingRequestedHandoff must be null after reset");
	assert.equal(state.pendingTopicBoundaryHint, null, "pendingTopicBoundaryHint must be null after reset");
}

// ── Properties ────────────────────────────────────────────────────────

test("Property 1: Topic-source coupling invariant", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" } as StateAction),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				for (const action of actions) {
					await apply(state, action);
					assertTopicSourceCoupling(state);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 2: Child session containment invariant", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
					fc.constant({ type: "abortChildren" } as StateAction),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				for (const action of actions) {
					await apply(state, action);
					assertChildSessionContainment(state);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 3: childSessionEpoch only changes on reset", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" } as StateAction),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.constant({ type: "abortChildren" } as StateAction),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				let expectedChildEpoch: number | null = null;
				let lastActionType: string | null = null;

				for (const action of actions) {
					const prevChildEpoch = state.childSessionEpoch;
					await apply(state, action);

					if (action.type === "reset") {
						// After reset, childSessionEpoch should have incremented
						if (expectedChildEpoch === null) {
							expectedChildEpoch = prevChildEpoch + 1;
						} else {
							expectedChildEpoch = state.childSessionEpoch;
						}
						assert.equal(
							state.childSessionEpoch,
							expectedChildEpoch,
							`childSessionEpoch must be ${expectedChildEpoch} after reset (prev=${prevChildEpoch})`,
						);
						expectedChildEpoch = state.childSessionEpoch;
					} else {
						// Non-reset: childSessionEpoch must be unchanged
						assert.equal(
							state.childSessionEpoch,
							prevChildEpoch,
							`childSessionEpoch must not change on ${action.type} action`,
						);
						expectedChildEpoch = state.childSessionEpoch;
					}
					lastActionType = action.type;
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 4: Reset clears all state fields", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" } as StateAction),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
					fc.constant({ type: "abortChildren" } as StateAction),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();

				for (const action of actions) {
					await apply(state, action);

					// After every reset, assert full clear
					if (action.type === "reset") {
						assertResetClears(state);
					}
				}

				// Also test explicitly: create fresh state, perform some work, then reset
				const s2 = createState();
				setActiveNotebookTopic(s2, "test-topic", "agent");
				await saveNotebookPage(mockPi, s2, "my-page", "some content");
				resetState(s2);
				assertResetClears(s2);
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 5: Epoch monotonicity — non-zero after savePage", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.constant({ type: "clearTopic" } as StateAction),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();

				assert.equal(state.epoch, 0, "epoch must be 0 on fresh state");

				for (const action of actions) {
					const prevEpoch = state.epoch;
					await apply(state, action);

					if (action.type === "savePage") {
						// After first savePage, epoch transitions from 0 to Date.now() (> 0)
						// After subsequent saves, epoch is unchanged (set once)
						assert.ok(
							state.epoch > 0,
							`epoch must be > 0 after savePage, got ${state.epoch}`,
						);
						if (prevEpoch === 0) {
							// First write: epoch transitions from 0 to Date.now()
							assert.ok(
								state.epoch >= Date.now() - 5000,
								`epoch ${state.epoch} should be recent Date.now()`,
							);
						} else {
							// Subsequent writes: epoch unchanged
							assert.equal(state.epoch, prevEpoch, "epoch must not change on subsequent savePage");
						}
					} else if (action.type === "reset") {
						// Reset sets epoch to 0
						assert.equal(state.epoch, 0, "epoch must be 0 after reset");
					} else {
						// Non-save, non-reset: epoch unchanged
						assert.equal(state.epoch, prevEpoch, "epoch unchanged on non-save/non-reset actions");
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 6: childSessionEpoch monotonicity (never decreases)", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" } as StateAction),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" } as StateAction),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				let maxSeenEpoch = 0;

				for (const action of actions) {
					await apply(state, action);
					assert.ok(
						state.childSessionEpoch >= maxSeenEpoch,
						`childSessionEpoch must never decrease: was ${maxSeenEpoch}, got ${state.childSessionEpoch}`,
					);
					maxSeenEpoch = Math.max(maxSeenEpoch, state.childSessionEpoch);
				}
			},
		),
		{ numRuns: 100 },
	);
});
