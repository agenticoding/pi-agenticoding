import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerAgenticoding from "../../index.js";
import { createState } from "../../state.js";
import { canPromoteBoundary, discardNonHumanBoundary } from "../../readonly-boundary.js";
import { setActiveNotebookTopic } from "../../notebook/topic.js";
import { createTestPI, makeReadonlyUICtx } from "./helpers.js";
import { STATUS_KEY_HANDOFF } from "../../tui.js";
import { MAX_HANDOFF_ATTEMPTS } from "../../watchdog.js";

function createHandoffPI() {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [toolCall] = pi.handlers.get("tool_call")!;
	const [agentEnd] = pi.handlers.get("agent_end")!;
	const [beforeCompact] = pi.handlers.get("session_before_compact")!;
	const [sessionTree] = pi.handlers.get("session_tree")!;
	const sessionStartHandlers = pi.handlers.get("session_start") ?? [];
	const sessionStart = async (event: unknown, ctx: unknown) => {
		for (const handler of sessionStartHandlers) {
			await handler(event, ctx);
		}
	};
	return { pi, toolCall, agentEnd, beforeCompact, sessionTree, sessionStart };
}

async function dispatchTool(pi: any, toolName: string, input: Record<string, unknown>, ctx: any): Promise<any> {
	const [toolCall] = pi.handlers.get("tool_call")!;
	const block = await toolCall({ toolName, input }, ctx);
	if (block?.block) return block;
	return pi.tools.get(toolName).execute("dispatch-test", input, undefined, undefined, ctx);
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

async function compactSummaryAfterPostToolToggle(initialReadonly: boolean): Promise<string> {
	const { pi, beforeCompact } = createHandoffPI();
	if (initialReadonly) await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue work", { ...makeReadonlyUICtx(), isIdle: () => true } as any);
	await pi.tools.get("handoff").execute("handoff-1", { task: "Continue work" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: () => {},
	});
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const result = await beforeCompact({ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] }, {});
	return result.compaction.summary;
}

async function assertNonTempBashBlocked(toolCall: (event: any, ctx: any) => Promise<any>): Promise<void> {
	const target = path.join(os.homedir(), `readonly-handoff-test-${process.pid}-${Date.now()}`);
	const command = `touch "${target}"`;
	await rm(target, { force: true });
	try {
		const event = { toolName: "bash", input: { command } };
		const result = await toolCall(event, { cwd: process.cwd() });
		if (!result?.block) {
			try {
				execFileSync("bash", ["-lc", event.input.command], { cwd: process.cwd(), stdio: "ignore" });
			} catch {
				// A sandbox may reject the command with a non-zero exit status.
			}
		}
		assert.equal(result?.block, true, "non-temp bash mutations must be blocked before execution");
		await assert.rejects(() => access(target), /ENOENT/);
	} finally {
		await rm(target, { force: true });
	}
}

async function handoffAllowedAtUsage(usage: { tokens?: number | null; percent?: number | null; contextWindow?: number | null }): Promise<boolean> {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler({ messages: [{ role: "user", content: "continue", timestamp: 2 }] }, { getContextUsage: () => usage } as any);
	return (await toolCall({ toolName: "handoff", input: { task: "continue billing" } }, {})) === undefined;
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
	await assertNonTempBashBlocked(toolCall);
});

test("blocked readonly handoff never invokes compaction", async () => {
	const { pi } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	let compactCalled = false;
	const result = await dispatchTool(
		pi,
		"handoff",
		{ task: "must remain in current context" },
		{
			...makeReadonlyUICtx(),
			cwd: process.cwd(),
			getContextUsage: () => ({ tokens: 50_000, percent: 80, contextWindow: 64_000 }),
			compact: () => { compactCalled = true; },
		},
	);
	assert.equal(result?.block, true);
	assert.equal(compactCalled, false, "blocked handoff must not reach the tool executor");
});

test("watchdog cancellation clears the readonly handoff bypass", async () => {
	const { pi, toolCall, agentEnd } = createHandoffPI();
	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			notify: () => {},
		},
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
	};
	for (let i = 0; i < MAX_HANDOFF_ATTEMPTS; i++) await agentEnd({}, ctx as any);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true,
		"readonly handoff should be blocked after watchdog cancellation");
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
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: { setStatus: () => {}, notify: () => {} },
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

test("synchronous handoff rejection preserves the readonly bypass contract", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("handoff").handler("continue readonly work", {
		...makeReadonlyUICtx(),
		isIdle: () => true,
	} as any);

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"handoff-1",
			{ task: "Continue readonly work" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { setStatus: () => {} },
				getContextUsage: () => null,
			},
		),
	);

	assert.equal(await toolCall({ toolName: "handoff", input: { task: "retry readonly handoff" } }, {}), undefined,
		"readonly bypass should remain active after synchronous rejection");
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, true,
		"write should stay blocked while the bypass remains active");
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
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: { setStatus: () => {}, notify: () => {} },
			compact: (options: any) => { compactOptions = options; },
		},
	);

	// Trigger onError — simulates failed compaction
	const userMessagesBefore = pi.sentUserMessages.length;
	compactOptions.onError(new Error("Nothing to compact (session too small)"));

	// onError re-engages the LLM
	assert.ok(pi.sentUserMessages.length > userMessagesBefore);
	assert.match(pi.sentUserMessages[pi.sentUserMessages.length - 1].content, /Handoff failed/);

	// Observable contract: a retry handoff call succeeds after failed compaction
	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute(
			"handoff-retry",
			{ task: "retry handoff" },
			undefined,
			undefined,
			{
				getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
				hasUI: true,
				ui: { setStatus: () => {}, notify: () => {} },
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
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			hasUI: true,
			ui: { setStatus: () => {}, notify: () => {} },
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

test("handoff summary follows readonly toggles after tool execution", async () => {
	const readonlyDisabled = await compactSummaryAfterPostToolToggle(true);
	assert.equal(readonlyDisabled.includes("Fresh context resumes in readonly mode."), false);

	const readonlyEnabled = await compactSummaryAfterPostToolToggle(false);
	assert.equal(readonlyEnabled.includes("Fresh context resumes in readonly mode."), true);
});

test("readonly topic boundary derives eligibility from percentage when tokens are unavailable", async () => {
	assert.equal(await handoffAllowedAtUsage({ tokens: null, percent: 15, contextWindow: 200000 }), true,
		"15% of a 200K context is exactly the 30K minimum");
	assert.equal(await handoffAllowedAtUsage({ tokens: null, percent: 14.999, contextWindow: 200000 }), false,
		"just below the 30K minimum must remain blocked");
});

test("readonly topic boundary creates the same bypass contract as explicit /handoff", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	// Drain the initial readonly nudge
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);

	// Set initial topic, then change it to create a boundary hint
	await pi.commands.get("notebook").handler(
		"oauth",
		{ hasUI: false, getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler(
		"billing",
		{ hasUI: false, getContextUsage: () => null } as any,
	);

	// Context hook should create the bypass from the boundary hint
	await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) },
	);

	// Same observable contract as explicit /handoff: handoff tool is unblocked
	assert.equal(await toolCall({ toolName: "handoff", input: { task: "continue billing work" } }, {}), undefined,
		"handoff should be unblocked after topic boundary creates bypass");
	// write and non-temp bash mutations stay blocked
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/test", content: "x" } }, {})).block, true,
		"write should stay blocked");
	await assertNonTempBashBlocked(toolCall);
});

test("promoted readonly boundary preserves bypass across execute-time eligibility failures", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler(
		{ messages: [{ role: "user", content: "promote", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	for (const usage of [
		() => null,
		() => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }),
	]) {
		await assert.rejects(
			() => pi.tools.get("handoff").execute("boundary-retry", { task: "continue billing" }, undefined, undefined, {
				getContextUsage: usage,
			}),
		);
		assert.equal(await toolCall({ toolName: "handoff", input: {} }, {}), undefined,
			"execute-time rejection must preserve the promoted readonly bypass");
	}

	let compactOptions: any;
	await pi.tools.get("handoff").execute("boundary-success", { task: "continue billing" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { compactOptions = options; },
	});
	compactOptions.onComplete();
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true);
});

test("readonly topic boundary promotion exposes the handoff status", async () => {
	const { pi } = createHandoffPI();
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler({ messages: [{ role: "user", content: "drain", timestamp: 1 }] }, { getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{
			hasUI: true,
			ui: {
				theme: { fg: (_name: string, text: string) => text },
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				notify: (message: string) => { notifications.push(message); },
			},
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		} as any,
	);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff required — ready to compact");
	assert.match(notifications[0] ?? "", /handoff exception is now active/i);
});

test("readonly topic boundary stays advisory until handoff is eligible", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{ getContextUsage: () => null } as any,
	);

	assert.match(result.messages.at(-1)?.content ?? "", /topic changed/i);
	assert.doesNotMatch(result.messages.at(-1)?.content ?? "", /call handoff/i);
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true,
		"ineligible boundary must not unblock handoff");
});

test("readonly human topic boundary promotes exactly at the 30K threshold without repeated advisory nudges", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	const first = await contextHandler(
		{ messages: [{ role: "user", content: "still small", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 29_999, percent: 15, contextWindow: 200000 }) } as any,
	);
	assert.match(first.messages.at(-1)?.content ?? "", /topic changed/i);
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true);

	const second = await contextHandler(
		{ messages: [{ role: "user", content: "still ineligible", timestamp: 3 }] },
		{ getContextUsage: () => ({ tokens: 29_999, percent: 15, contextWindow: 200000 }) } as any,
	);
	assert.equal(second, undefined, "an ineligible boundary should not repeat its advisory nudge");

	await contextHandler(
		{ messages: [{ role: "user", content: "now eligible", timestamp: 4 }] },
		{ getContextUsage: () => ({ tokens: 30_000, percent: 15, contextWindow: 200000 }) } as any,
	);
	assert.equal(await toolCall({ toolName: "handoff", input: {} }, {}), undefined);
});

test("readonly topic boundary handoff clears its bypass after successful compaction", async () => {
	const { pi, toolCall, beforeCompact } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);
	await contextHandler(
		{ messages: [{ role: "user", content: "handoff", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	let compactOptions: any;
	await pi.tools.get("handoff").execute(
		"boundary-handoff",
		{ task: "Continue billing work" },
		undefined,
		undefined,
		{
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => { compactOptions = options; },
		},
	);
	const result = await beforeCompact(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{},
	);
	compactOptions.onComplete({});

	assert.match(result.compaction.summary, /Fresh context resumes in readonly mode/);
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true);
	assert.equal((await toolCall({ toolName: "write", input: {} }, {})).block, true);
});

test("readonly agent topic transitions cannot promote or remain queued", () => {
	const state = createState();
	setActiveNotebookTopic(state, "oauth", "agent");
	setActiveNotebookTopic(state, "billing", "agent");

	assert.equal(canPromoteBoundary(state, { tokens: 50_000, percent: 80, contextWindow: 64_000 }), false);
	assert.equal(discardNonHumanBoundary(state), true);
	assert.equal(state.pendingTopicBoundaryHint, null);
});

test("readonly agent topic boundary is not promoted to handoff bypass", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	// Drain the initial readonly toggle nudge
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);

	// Set the initial topic via notebook_topic_set (agent source). The public
	// tool intentionally rejects agent overrides, so transition behavior is
	// covered by the pure state/helper test above.
	const notebookTopicTool = pi.tools.get("notebook_topic_set");
	await notebookTopicTool.execute("1", { topic: "oauth" }, undefined, undefined, {
		hasUI: false,
		getContextUsage: () => null,
	} as any);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "continue", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) } as any,
	);

	assert.equal(result, undefined);
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true,
		"agent topic without boundary must not unblock handoff in readonly mode");
});

test("advisoryDelivered flag prevents repeated advisory nudges for ineligible boundary", async () => {
	const { pi, toolCall } = createHandoffPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	const [contextHandler] = pi.handlers.get("context")!;
	// Drain the initial readonly toggle nudge
	await contextHandler(
		{ messages: [{ role: "user", content: "drain", timestamp: 1 }] },
		{ getContextUsage: () => null } as any,
	);
	// Set human topic boundary
	await pi.commands.get("notebook").handler("oauth", { hasUI: false, getContextUsage: () => null } as any);
	await pi.commands.get("notebook").handler("billing", { hasUI: false, getContextUsage: () => null } as any);

	// First context hook at ineligible usage — should deliver advisory
	const first = await contextHandler(
		{ messages: [{ role: "user", content: "small", timestamp: 2 }] },
		{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any,
	);
	assert.ok(first, "first call should return messages");
	assert.match(first.messages.at(-1)?.content ?? "", /topic changed/i);

	// Second context hook at same ineligible usage — should NOT repeat advisory
	const second = await contextHandler(
		{ messages: [{ role: "user", content: "still small", timestamp: 3 }] },
		{ getContextUsage: () => ({ tokens: 5000, percent: 2.5, contextWindow: 200000 }) } as any,
	);
	assert.equal(second, undefined, "ineligible boundary should not repeat its advisory nudge");

	// Handoff should still be blocked
	assert.equal((await toolCall({ toolName: "handoff", input: {} }, {})).block, true);
});

test("session tree invalidates pending handoff work, releases the overlap guard, and ignores stale callbacks", async () => {
	const { pi, toolCall, sessionTree } = createHandoffPI();
	let staleCompactOptions: any;
	let freshCompactOptions: any;
	const statuses = new Map<string, string | undefined>([[STATUS_KEY_HANDOFF, "stale"]]);

	await pi.tools.get("handoff").execute("branch-handoff", { task: "continue branch work" }, undefined, undefined, {
		getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
		compact: (options: any) => { staleCompactOptions = options; },
	});
	await sessionTree({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
		},
		getContextUsage: () => null,
	} as any);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.equal(await toolCall({ toolName: "handoff", input: {} }, {}), undefined,
		"non-readonly branch should not retain a stale readonly handoff block");
	await assert.doesNotReject(
		() => pi.tools.get("handoff").execute("fresh-branch-handoff", { task: "continue fresh branch work" }, undefined, undefined, {
			getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			compact: (options: any) => { freshCompactOptions = options; },
		}),
		"session_tree must release the overlap guard for a fresh branch handoff",
	);

	staleCompactOptions.onComplete();
	assert.deepEqual(pi.sentUserMessages, [], "stale callback must not touch the fresh branch state");
	freshCompactOptions.onComplete();
	assert.deepEqual(pi.sentUserMessages, [{ content: "Proceed.", options: undefined }]);
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
