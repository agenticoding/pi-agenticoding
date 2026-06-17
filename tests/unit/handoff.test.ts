import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { registerHandoffCommand } from "../../handoff/command.js";
import { registerHandoffTool } from "../../handoff/tool.js";
import { registerHandoffCompaction } from "../../handoff/compact.js";
import registerAgenticoding from "../../index.js";
import { STATUS_KEY_HANDOFF, WIDGET_KEY_WARNING, updateIndicators } from "../../tui.js";
import { createTestPI, makeTUICtx } from "./helpers.js";

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const pi = createTestPI();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		readonlyBypassActive: false,
		resumeReadonlyAfterHandoff: false,
		enforcementAttempts: 0,
		toolCalled: false,
	});
	assert.equal(pi.sentUserMessages.length, 1);
	assert.match(pi.sentUserMessages[0].content, /Handoff direction: implement auth/);
	assert.match(pi.sentUserMessages[0].content, /You must perform a real handoff now/);
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
	state.pendingRequestedHandoff = { toolCalled: false, readonlyBypassActive: true, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);

	let compactOptions: any;
	const result = await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue auth-refresh" },
		undefined,
		undefined,
		{
			compact: (options: any) => {
				compactOptions = options;
			},
		},
	);

	assert.equal(state.pendingHandoff?.source, "tool");
	// Structural: verify the task contains the handoff template structure,
	// not exact phrasing (template wording may evolve).
	assert.match(state.pendingHandoff?.task ?? "", /## Handoff/);
	assert.match(state.pendingHandoff?.task ?? "", /notebook/i);
	assert.match(state.pendingHandoff?.task ?? "", /task|context|situational/i);
	// The user's task content is the actual contract — keep exact match.
	assert.match(state.pendingHandoff?.task ?? "", /Goal: continue auth-refresh/);
	assert.doesNotMatch(state.pendingHandoff?.task ?? "", /sensitive notebook body/);
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
	state.pendingHandoff = { task: "Goal: continue", source: "tool" };
	state.pendingRequestedHandoff = { enforcementAttempts: 1, toolCalled: true, readonlyBypassActive: false, resumeReadonlyAfterHandoff: false };
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
	assert.equal(result.compaction.summary, "Goal: continue");
	assert.equal(result.compaction.tokensBefore, 123);
	assert.equal(result.compaction.firstKeptEntryId, "leaf-1-handoff-cut");
	assert.deepEqual(result.compaction.details, { handoff: true, task: "Goal: continue" });
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
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
});

test("handoff compaction clears the handoff status indicator", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool" };
	registerHandoffCompaction(pi as any, state);
	const statuses = new Map<string, string | undefined>();
	const [handler] = pi.handlers.get("session_before_compact")!;

	await handler(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{ hasUI: true, ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); } } },
	);

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("handoff compaction error clears pending state and status", async () => {
	const pi = createTestPI();
	const state = createState();
	state.pendingRequestedHandoff = { toolCalled: false, readonlyBypassActive: true, resumeReadonlyAfterHandoff: true, enforcementAttempts: 0 };
	registerHandoffTool(pi as any, state);
	let compactOptions: any;
	const statuses = new Map<string, string | undefined>();

	await pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue" },
		undefined,
		undefined,
		{
			hasUI: true,
			ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); } },
			compact: (options: any) => { compactOptions = options; },
		},
	);
	compactOptions.onError({});

	assert.equal(state.pendingHandoff, null);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("turn_end fallback keeps requested handoff status sticky until real handoff happens", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
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

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff in progress");
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
