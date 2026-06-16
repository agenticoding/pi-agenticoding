import test from "node:test";
import assert from "node:assert/strict";
import registerAgenticoding from "../../index.js";
import { createTestPI, makeReadonlyUICtx } from "./helpers.js";

function createHandoffPI() {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [toolCall] = pi.handlers.get("tool_call")!;
	const [beforeCompact] = pi.handlers.get("session_before_compact")!;
	const sessionStartHandlers = pi.handlers.get("session_start") ?? [];
	const sessionStart = async (event: unknown, ctx: unknown) => {
		for (const handler of sessionStartHandlers) {
			await handler(event, ctx);
		}
	};
	return { pi, toolCall, beforeCompact, sessionStart };
}

function makeReadonlyResumeCtx(branch: unknown[]) {
	return {
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => branch,
		},
	};
}

test("/handoff command creates temporary bypass for handoff tool only", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	assert.equal(await toolCall({ toolName: "handoff", input: { task: "continue readonly work" } }, {}), undefined,
		"handoff should be unblocked after explicit /handoff");
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, true,
		"write should stay blocked");
});

test("after handoff compaction, bypass is cleared and readonly persists", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	// Execute handoff tool and capture the compact callback
	let compactOptions: any;
	await pi.tools.get("handoff").execute(
		"handoff-1",
		{ task: "Continue readonly work" },
		undefined,
		undefined,
		{
			hasUI: true,
			ui: { setStatus: () => {} },
			compact: (options: any) => { compactOptions = options; },
		},
	);

	// Trigger onComplete (simulates successful compaction)
	compactOptions.onComplete({});

	// Observable contract: bypass cleared, readonly still active
	assert.equal((await toolCall({ toolName: "handoff", input: { task: "direct call" } }, {})).block, true,
		"bypass cleared: direct handoff should be blocked");
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, true,
		"readonly persists: write should still be blocked after compaction");
});

test("retry succeeds after a failed compaction attempt", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	// Execute handoff tool and capture the compact callback
	let compactOptions: any;
	await pi.tools.get("handoff").execute(
		"handoff-1",
		{ task: "Continue readonly work" },
		undefined,
		undefined,
		{
			hasUI: true,
			ui: { setStatus: () => {} },
			compact: (options: any) => { compactOptions = options; },
		},
	);

	// Trigger onError — simulates failed compaction
	compactOptions.onError();

	// Observable contract: a retry handoff call succeeds after failed compaction
	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"handoff-retry",
			{ task: "retry handoff" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { setStatus: () => {} },
				compact: () => {},
			},
		),
		"retry handoff should succeed after failed compaction",
	);

	// Readonly still active
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, true,
		"readonly persists: write should still be blocked after failed compaction");
});

test("/handoff re-enables bypass after compaction", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	// Create bypass, then complete the handoff to clear it
	await pi.commands.get("handoff").handler("first handoff", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	let compactOptions: any;
	await pi.tools.get("handoff").execute(
		"handoff-1",
		{ task: "first handoff" },
		undefined,
		undefined,
		{
			hasUI: true,
			ui: { setStatus: () => {} },
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onComplete({});

	// Second /handoff re-enables the bypass
	await pi.commands.get("handoff").handler("second readonly handoff", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);
	assert.equal(await toolCall({ toolName: "handoff", input: { task: "second readonly handoff" } }, {}), undefined,
		"second /handoff should re-enable the bypass");
});

test("session resume restores readonly enforcement from persisted state", async () => {
	const { toolCall, sessionStart } = createHandoffPI();
	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: false } },
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: true } },
	];

	await sessionStart({ reason: "resume" }, makeReadonlyResumeCtx(branch) as any);

	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	assert.equal(await toolCall({ toolName: "read", input: { path: "/tmp/x" } }, {}), undefined);
});
