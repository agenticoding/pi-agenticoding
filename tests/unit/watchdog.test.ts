import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { registerWatchdog } from "../../watchdog.js";
import { buildNudge } from "../../watchdog.js";
import registerAgenticoding from "../../index.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { createTestPI, makeReadonlyUICtx } from "./helpers.js";

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
	assert.match(result.messages[1].content, /70%/);
	assert.match(result.messages[1].content, /oauth/);
	assert.match(result.messages[1].content, /spawn/i);
	assert.match(result.messages[1].content, /parent context/i);
	assert.doesNotMatch(result.messages[1].content, /draft a clear brief|what comes next/i);
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
	assert.match(result.messages[1].content, /oauth/i);
	assert.match(result.messages[1].content, /billing/i);
	assert.match(result.messages[1].content, /topic changed/i);
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
	assert.match(result.messages[1].content, /no active notebook topic/i);
	assert.match(result.messages[1].content, /fresh topic/i);
	assert.match(result.messages[1].content, /handoff/i);
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
	assert.match(first.messages[1].content, /oauth/i);
	assert.match(first.messages[1].content, /billing/i);
	assert.match(first.messages[1].content, /topic changed/i);

	const second = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 20 }) },
	);
	assert.equal(second, undefined);
});


test("buildNudge emits topic and spawn guidance", () => {
	const nudge = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, 46);
	assert.match(nudge, /Active notebook topic: oauth/);
	assert.match(nudge, /prefer spawn/i);
});


test("buildNudge handles null percent and boundary hints before topic guidance", () => {
	const boundary = buildNudge(
		{
			activeNotebookTopic: "oauth",
			pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
			readonlyEnabled: false,
			pendingRequestedHandoff: null,
		},
		null,
	);
	assert.match(boundary, /Notebook topic changed from oauth to billing/);
	assert.doesNotMatch(boundary, /Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null, readonlyEnabled: false, pendingRequestedHandoff: null }, null);
	assert.match(noTopic, /Topic-aware context reminder/);
	assert.match(noTopic, /No active notebook topic is set/);
});

test("watchdog stays advisory for a fresh user-requested handoff", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff").handler("implement auth", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

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

	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.ok(state.pendingRequestedHandoff, "handoff request should remain active after one turn");
	assert.deepEqual(notifications, []);
});

test("watchdog auto-cancels a user-requested handoff after enough unanswered turns", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff").handler("implement auth", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const notifications: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: { notify: (message: unknown) => notifications.push(message), setStatus: () => {} },
		getContextUsage: () => ({ percent: 20 }),
	};

	for (let i = 0; i < 5; i++) {
		await handler({}, ctx);
	}

	assert.equal(state.pendingRequestedHandoff, null, "pending handoff should be auto-cancelled");
	assert.ok(notifications.length > 0, "user should receive a cancellation notification");
	assert.match(notifications[0] as string, /cancelled/i, "notification should mention cancellation");
});

// ── Readonly-specific injection contracts ─────────────────────────

test("context injects a readonly-mode nudge after toggle", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [handler] = pi.handlers.get("context")!;

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => null },
	);

	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].customType, "agenticoding-readonly-nudge");
	assert.match(result.messages[1].content, /readonly/i);
	assert.match(result.messages[1].content, /write/i);
	assert.match(result.messages[1].content, /edit/i);
	assert.match(result.messages[1].content, /handoff/i);
	assert.match(result.messages[1].content, /bash/i);
});

test("context injects readonly handoff guidance after explicit user /handoff", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await handler(
		{ messages: [{ role: "user", content: "clear initial readonly nudge", timestamp: 1 }] },
		{ getContextUsage: () => null },
	);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const result = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 70 }) },
	);
	const watchdogMessage = result.messages.find((message: any) => message.customType === "agenticoding-watchdog");

	assert.ok(watchdogMessage, "requested handoff should inject watchdog guidance");
	assert.match(watchdogMessage.content, /handoff/i);
	assert.match(watchdogMessage.content, /readonly/i);
	assert.match(watchdogMessage.content, /resume/i);
});
