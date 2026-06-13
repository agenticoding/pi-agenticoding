import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { registerWatchdog } from "../../watchdog.js";
import { buildNudge } from "../../watchdog.js";
import registerAgenticoding from "../../index.js";
import { createTestPI } from "./helpers.js";

test("watchdog records context usage without user notifications", async () => {
	const pi = createTestPI();
	const state = createState();
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.equal(state.lastContextPercent, 70);
	assert.deepEqual(notifications, []);
});

test("context injects watchdog reminder before each LLM call", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{
			getContextUsage: () => ({ percent: 70 }),
		},
	);

	assert.equal(result.messages.length, 2);
	assert.deepEqual(result.messages[0], { role: "user", content: "hi", timestamp: 1 });
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "agenticoding-watchdog");
	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /Context at 70%/);
	assert.match(result.messages[1].content, /Active notebook topic: oauth/);
	assert.match(result.messages[1].content, /spawn it instead of polluting the parent context/i);
	assert.doesNotMatch(result.messages[1].content, /If you're mid-job and still clear|consider a handoff and draft a clear brief for what comes next/i);
});


test("context injects a boundary nudge below 30% after an explicit topic change", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	await pi.commands.get("notebook")!.handler("billing", { hasUI: false, getContextUsage: () => null });

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);

	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /Notebook topic changed from oauth to billing/);
});


test("context injects a no-topic nudge when context is high", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 70 }) },
	);

	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "agenticoding-watchdog");
	assert.equal(result.messages[1].display, false);
	assert.match(result.messages[1].content, /No active notebook topic is set/);
	assert.match(result.messages[1].content, /Assign a fresh topic in the next clean context after handoff/i);
});


test("context consumes a boundary hint after the first injected nudge", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	await pi.commands.get("notebook")!.handler("billing", { hasUI: false, getContextUsage: () => null });

	const first = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);
	assert.match(first.messages[1].content, /Notebook topic changed from oauth to billing/);

	const second = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);
	assert.equal(second, undefined);
});


test("buildNudge no longer emits the old percent-only handoff text", () => {
	const old = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null }, 46);
	assert.doesNotMatch(old, /One context, one job\.|If you're mid-job and still clear|consider a handoff and draft a clear brief/i);
	assert.match(old, /Active notebook topic: oauth/);
	assert.match(old, /prefer spawn/i);
});


test("buildNudge handles null percent and boundary hints before topic guidance", () => {
	const boundary = buildNudge(
		{
			activeNotebookTopic: "oauth",
			pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
		},
		null,
	);
	assert.match(boundary, /Notebook topic changed from oauth to billing/);
	assert.doesNotMatch(boundary, /Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null }, null);
	assert.match(noTopic, /Topic-aware context reminder/);
	assert.match(noTopic, /No active notebook topic is set/);
});

test("watchdog stays advisory when a requested handoff is not completed", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 0, toolCalled: false };
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: string[] = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
			},
			getContextUsage: () => ({ percent: 20 }),
		},
	);

	assert.equal(state.pendingRequestedHandoff, null);
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentUserMessages, []);
});
