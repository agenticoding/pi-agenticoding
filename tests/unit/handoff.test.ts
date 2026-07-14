import test from "node:test";
import assert from "node:assert/strict";
import { createState, resetState } from "../../state.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { buildEnrichedTask } from "../../handoff/format.js";
import { registerHandoffCompaction } from "../../handoff/compact.js";
import registerAgenticoding from "../../index.js";
import { STATUS_KEY_HANDOFF, WIDGET_KEY_WARNING, updateIndicators } from "../../tui.js";
import { registerWatchdog } from "../../watchdog.js";
import { createTestPI, makeTUICtx } from "./helpers.js";

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		resumeReadonlyAfterHandoff: false,
		enforcementAttempts: 0,
		toolCalled: false,
	});
	assert.equal(pi.sentUserMessages.length, 1);
	assert.match(pi.sentUserMessages[0].content, /Handoff direction: implement auth/);
	assert.match(pi.sentUserMessages[0].content, /Prepare a handoff in the current session now/);
	assert.match(pi.sentUserMessages[0].content, /A real handoff is required in the current session/);
	assert.doesNotMatch(pi.sentUserMessages[0].content, /User explicitly requested|\/handoff/);
	assert.equal(pi.sentUserMessages[0].options, undefined);
});

test("/handoff requires a direction", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	const notifications: string[] = [];
	await pi.commands.get("handoff")!.handler("   ", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	});

	assert.deepEqual(notifications, ["Usage: /handoff <direction>"]);
	assert.deepEqual(pi.sentUserMessages, []);
});

test("handoff tool triggers compaction and resumes with the compacted task", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("auth-refresh", "sensitive notebook body");
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);

	let compactOptions: any;
	const result = await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue auth-refresh" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => {
				compactOptions = options;
			},
		},
	);

	assert.equal(state.pendingHandoff?.source, "tool");
	// Queue only the user brief. The compaction hook renders the primer at the
	// cut so it can include readonly mode as it exists at that moment.
	assert.equal(state.pendingHandoff?.task, "Goal: continue auth-refresh");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(typeof compactOptions?.onComplete, "function");
	assert.equal(result.content[0].text, "Handoff started.");
	assert.equal(result.terminate, true);

	compactOptions.onComplete({});
	assert.deepEqual(pi.sentUserMessages, [{ content: "Proceed.", options: undefined }]);
});

test("handoff compaction replaces old context with the queued task", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool", generation: state.handoffGeneration };
	state.pendingRequestedHandoff = { enforcementAttempts: 1, toolCalled: true, resumeReadonlyAfterHandoff: false };
	state.activeNotebookTopic = "oauth";
	state.activeNotebookTopicSource = "human";
	registerHandoffCompaction(pi as any, state);

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{
			preparation: { tokensBefore: 123 },
			branchEntries: [{ id: "leaf-1" }],
		},
		{},
	);

	assert.equal(state.pendingHandoff, null);
	assert.notEqual(state.pendingRequestedHandoff, null, "pendingRequestedHandoff stays until onComplete in tool.ts");
	// Notebook topic is cleared in handoff tool's onComplete, not in compaction itself
	assert.equal(state.activeNotebookTopic, "oauth");
	assert.equal(state.activeNotebookTopicSource, "human");
	const task = buildEnrichedTask("Goal: continue");
	assert.equal(result.compaction.summary, task);
	assert.equal(result.compaction.tokensBefore, 123);
	assert.equal(result.compaction.firstKeptEntryId, "leaf-1-handoff-cut");
	assert.deepEqual(result.compaction.details, { handoff: true, task });
});

test("/handoff sets the handoff status indicator", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	const statuses = new Map<string, string | undefined>();

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
		getContextUsage: () => null,
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("/handoff shows ready status when context is eligible", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	const statuses = new Map<string, string | undefined>();

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
});

test("handoff status becomes ready when later context becomes eligible", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const statuses = new Map<string, string | undefined>();
	const commandContext = {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	};
	await pi.commands.get("handoff")!.handler("implement auth", commandContext);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");

	const [context] = pi.handlers.get("context")!;
	await context(
		{ messages: [] },
		{
			hasUI: true,
			getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
			ui: commandContext.ui,
		},
	);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
});

test("handoff compaction clears the handoff status indicator", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool", generation: state.handoffGeneration };
	registerHandoffCompaction(pi as any, state);
	const statuses = new Map<string, string | undefined>();
	const [handler] = pi.handlers.get("session_before_compact")!;

	await handler(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{ hasUI: true, ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); } } },
	);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("handoff success sends a completion notification", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();

	await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: {
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
			},
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onComplete();

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.ok(notifications.some((n) => n.message.includes("Handoff complete") && n.level === "info"));
	assert.equal(pi.sentUserMessages.at(-1)?.content, "Proceed.");
});

test("handoff compaction error restores a ready retry status when eligible", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level: string }> = [];

	await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: {
				theme: { fg: (_name: string, text: string) => text },
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
			},
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onError(new Error("Nothing to compact (session too small)"));

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.deepEqual(notifications, [{ message: "Handoff compaction failed: Nothing to compact (session too small). The handoff can be retried.", level: "error" }]);
	// onError re-engages the LLM via sendUserMessage
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
});

test("synchronous compaction failure restores a retryable pending handoff", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"sync-failure",
			{ task: "continue work" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					theme: { fg: (_name: string, text: string) => text },
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: () => {},
				},
				getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
				compact: () => { throw new Error("synchronous compact failure"); },
			},
		),
		/synchronous compact failure/,
	);

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.match(pi.sentUserMessages.at(-1)?.content ?? "", /Handoff failed/);
});

test("failed handoff shows waiting status when usage becomes unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: false, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	let usage: { tokens: number; percent: number; contextWindow: number } | null = {
		tokens: 50_000, percent: 25, contextWindow: 200_000,
	};
	const statuses = new Map<string, string | undefined>();

	await pi.tools.get("handoff").execute("1", { task: "Goal: continue" }, undefined, undefined, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			notify: () => {},
		},
		getContextUsage: () => usage,
		compact: (options: any) => { compactOptions = options; },
	});
	usage = null;
	compactOptions.onError(new Error("host failed"));

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("handoff rejects overlapping compaction and preserves the first task", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute("first", { task: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});
	await assert.rejects(
		() => pi.tools.get("handoff").execute("second", { task: "second" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/handoff compaction already in progress/i,
	);
	assert.equal(state.pendingHandoff?.task, "first");

	firstCallbacks.onComplete();
	assert.equal(state.pendingHandoff, null);
	assert.deepEqual(pi.sentUserMessages.map((message: any) => message.content), ["Proceed."]);
});

test("/handoff rejects a replacement while compaction is reserved", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);

	await pi.commands.get("handoff")!.handler("first", { hasUI: false, isIdle: () => true } as any);
	await pi.tools.get("handoff").execute("first", { task: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});

	await assert.rejects(
		() => pi.commands.get("handoff")!.handler("second", { hasUI: false, isIdle: () => true } as any),
		/handoff compaction already in progress/i,
	);
	assert.equal(state.pendingHandoff?.task, "first");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);

	firstCallbacks.onComplete();
	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff, null);
});

test("failed compaction releases the overlap guard without mutating state twice", async () => {
	const pi = createTestPI();
	const state = createState();
	let firstCallbacks: any;
	let secondCallbacks: any;
	const notifications: string[] = [];
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute("first", { task: "first" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { firstCallbacks = options; },
	});
	await assert.rejects(
		() => pi.tools.get("handoff").execute("second", { task: "second" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: () => {},
		}),
		/handoff compaction already in progress/i,
	);

	firstCallbacks.onError(new Error("first failure"));
	assert.equal(state.pendingHandoff, null);
	assert.deepEqual(notifications, []);
	assert.match(pi.sentUserMessages.at(-1)?.content ?? "", /Handoff failed/);

	await pi.tools.get("handoff").execute("second", { task: "second" }, undefined, undefined, {
		hasUI: true,
		ui: { notify: () => {}, setStatus: () => {} } as any,
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { secondCallbacks = options; },
	});
	secondCallbacks.onComplete();
	assert.deepEqual((pi.sentUserMessages as any[]).map((message: any) => message.content), ["Handoff failed — first failure. No required handoff remains pending; retry when ready. Continue working in the current context.", "Proceed."]);
});

test("reset invalidates late handoff callbacks", async () => {
	const pi = createTestPI();
	const state = createState();
	let callbacks: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute("reset", { task: "reset" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { callbacks = options; },
	});
	resetState(state);
	state.pendingHandoff = { task: "new state", source: "tool", generation: state.handoffGeneration };
	state.pendingRequestedHandoff = { toolCalled: true, resumeReadonlyAfterHandoff: false, enforcementAttempts: 0 };
	callbacks.onComplete();

	assert.equal(state.pendingHandoff?.task, "new state");
	assert.equal(state.pendingRequestedHandoff?.toolCalled, true);
	assert.equal(pi.sentUserMessages.length, 0);
});

test("handoff terminal callbacks are idempotent", async () => {
	const pi = createTestPI();
	const state = createState();
	let compactOptions: any;
	registerHandoffTool(pi as any, state);

	await pi.tools.get("handoff").execute(
		"callbacks",
		{ task: "continue work" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => { compactOptions = options; },
		},
	);

	compactOptions.onComplete({});
	compactOptions.onComplete({});
	compactOptions.onError(new Error("late failure"));

	assert.equal(pi.sentUserMessages.filter((message: any) => message.content === "Proceed.").length, 1);
	assert.equal(state.pendingHandoff, null);
});

test("handoff rejects malformed numeric context usage", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	for (const usage of [
		{ tokens: Number.NaN, percent: 20, contextWindow: 200000 },
		{ tokens: Number.POSITIVE_INFINITY, percent: 20, contextWindow: 200000 },
		{ tokens: null, percent: Number.NaN, contextWindow: 200000 },
	]) {
		await assert.rejects(
			() => pi.tools.get("handoff").execute(
				"invalid-usage",
				{ task: "continue work" },
				undefined,
				undefined,
				{ getContextUsage: () => usage },
			),
			/Context usage unavailable/,
		);
	}
});

test("turn_end fallback keeps requested handoff status sticky until real handoff happens", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		getContextUsage: () => null,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: () => {},
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
		},
	});

	const [turnEnd] = pi.handlers.get("turn_end")!;
	await turnEnd({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff requested — waiting for eligible context");
});

test("handoff tool metadata explains the 30K minimum threshold", () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	const tool = pi.tools.get("handoff");
	assert.match(tool.description, /30K tokens/i);
	assert.match(tool.description, /cannot be estimated/i);
	assert.match(tool.description, /approximate/i);
	assert.match(tool.promptGuidelines!.join(" "), /~30K-token minimum/i);
	assert.match(tool.promptGuidelines!.join(" "), /cannot be estimated/i);
	assert.match(tool.promptGuidelines!.join(" "), /mid-teens percentage/i);
});

test("buildEnrichedTask includes execution constraints when resumeReadonlyAfterHandoff is true", () => {
	const task = buildEnrichedTask("continue billing work", { resumeReadonlyAfterHandoff: true });
	assert.match(task, /Execution Constraints/i);
	assert.match(task, /readonly mode/i);
	assert.match(task, /handoff-only exception.*no longer active/i);
});

test("buildEnrichedTask omits execution constraints when resumeReadonlyAfterHandoff is false", () => {
	const task = buildEnrichedTask("continue billing work", { resumeReadonlyAfterHandoff: false });
	assert.doesNotMatch(task, /Execution Constraints/i);
});

test("buildEnrichedTask omits execution constraints by default", () => {
	const task = buildEnrichedTask("continue billing work");
	assert.doesNotMatch(task, /Execution Constraints/i);
});

test("handoff tool rejects empty task with context usage", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ percent: 42 }) },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Empty handoff rejected") &&
			error.message.includes("42%"),
	);

	assert.equal(state.pendingHandoff, null, "empty handoff must not queue state");
});

test("handoff tool rejects small session with clear error", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("too small for handoff") &&
			error.message.includes("~3% (5000 tokens)") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.pendingHandoff, null, "small-session rejection must not queue state");
});

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous small-session rejection", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: Array<{ message: string; level: string }> = [];

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level: string) => { notifications.push({ message, level }); },
				},
				getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
			},
		),
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		resumeReadonlyAfterHandoff: true,
		enforcementAttempts: 0,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	// sendHandoffFailure re-engages the LLM
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /required handoff remains pending/);
});

test("command handoff waits for eligibility and retries without watchdog cancellation", async () => {
	const pi = createTestPI();
	const state = createState();
	let compactOptions: any;
	registerHandoffCommand(pi as any, state);
	registerHandoffTool(pi as any, state);
	registerWatchdog(pi as any, state);
	const [watchdogHandler] = pi.handlers.get("agent_end")!;

	await pi.commands.get("handoff")!.handler("continue work", { hasUI: false, isIdle: () => true } as any);
	await assert.rejects(
		() => pi.tools.get("handoff").execute("small", { task: "continue work" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
		}),
	);
	await watchdogHandler({}, { hasUI: false, getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any);
	assert.equal(state.pendingRequestedHandoff?.enforcementAttempts, 0);

	await pi.tools.get("handoff").execute("eligible", { task: "continue work" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});
	compactOptions.onComplete();
	assert.equal(state.pendingRequestedHandoff, null);
});

test("handoff tool rejects small session with null percent without crashing", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 5000, percent: null, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("too small for handoff") &&
			error.message.includes("(5000 tokens)") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.pendingHandoff, null, "null-percent rejection must not queue state");
});

test("handoff tool rejects small session estimated from percent when tokens are unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: null, percent: 10, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("too small for handoff") &&
			error.message.includes("~20000 tokens estimated from context usage") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.pendingHandoff, null, "estimated small-session rejection must not queue state");
});

test("handoff tool accepts large estimated session when tokens are unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: 200000 }),
				compact: () => {},
			},
		),
	);
	assert.equal(state.pendingHandoff?.source, "tool");
});

test("handoff tool accepts the exact 30000-token minimum", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 30000, percent: 15, contextWindow: 200000 }),
				compact: () => {},
			},
		),
	);
	assert.equal(state.pendingHandoff?.source, "tool");
});

test("handoff tool rejects session just below the 30000-token minimum", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: 29999, percent: 15, contextWindow: 200000 }) },
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("too small for handoff") &&
			error.message.includes("29999 tokens") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.pendingHandoff, null, "just-below-boundary rejection must not queue state");
});

test("handoff tool rejects whitespace-only task", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "   \t\n " },
			undefined,
			undefined,
			{ getContextUsage: () => null },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Empty handoff rejected") &&
			error.message.includes("?"),
	);
});

test("handoff tool rejects when context usage is unavailable", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => null },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Context usage unavailable") &&
			error.message.includes("rejected"),
	);

	assert.equal(state.pendingHandoff, null, "unavailable usage must not queue state");
});

test("handoff tool preserves pending requested handoff and re-engages LLM after synchronous unavailable-usage rejection", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "🤝 Handoff in progress"]]);
	const notifications: Array<{ message: string; level: string }> = [];

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
					notify: (message: string, level: string) => { notifications.push({ message, level }); },
				},
				getContextUsage: () => null,
			},
		),
	);

	assert.deepEqual(state.pendingRequestedHandoff, {
		toolCalled: false,
		resumeReadonlyAfterHandoff: true,
		enforcementAttempts: 0,
	});
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
	// sendHandoffFailure re-engages the LLM
	assert.ok(pi.sentUserMessages.length > 0);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /required handoff remains pending/);
});

test("handoff tool rejects when context usage cannot be estimated", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffTool(pi as any, state);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{ getContextUsage: () => ({ tokens: null, percent: 20, contextWindow: null }) },
		),
		(error: unknown) => error instanceof Error &&
			error.message.includes("Context usage unavailable") &&
			error.message.includes("Continue working"),
	);

	assert.equal(state.pendingHandoff, null, "unestimable usage must not queue state");
});

test("session_start new clears stale handoff status and warning widget", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);
	const widgets = new Map<string, string[] | undefined>([[WIDGET_KEY_WARNING, ["stale"]]]);
	const sessionStartHandlers = pi.handlers.get("session_start")!;
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: (key: string, value: string[] | undefined) => { widgets.set(key, value); },
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => null,
	};
	for (const sessionStart of sessionStartHandlers) {
		await sessionStart({ reason: "new" }, ctx);
	}

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

test("session_before_compact ignores a stale generation", async () => {
	const pi = createTestPI();
	const state = createState();
	// Queue a handoff at generation N, then bump the generation counter
	// as if a newer request superseded it.
	state.pendingHandoff = { task: "old", source: "tool", generation: 1 };
	state.handoffGeneration = 2;
	registerHandoffCompaction(pi as any, state);

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{ preparation: { tokensBefore: 100 }, branchEntries: [{ id: "leaf-1" }] },
		{} as any,
	);

	assert.equal(result, undefined, "generation mismatch must skip compaction");
	assert.equal(state.pendingHandoff?.task, "old", "pendingHandoff must not be cleared for stale generation");
});
