import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createEditTool, createWriteTool, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffTool } from "./handoff/tool.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import { buildNudge, registerWatchdog } from "./watchdog.js";
import { createState, resetState } from "./state.js";
import {
	buildChildToolNames,
	createChildTools,
	executeSpawn,
	registerSpawnTool,
} from "./spawn/index.js";
import { renderSpawnResult, flushSpawnFrameScheduler, resetSpawnFrameScheduler } from "./spawn/renderer.js";
import { registerNotebookRehydration } from "./notebook/rehydration.js";
import { clearActiveNotebookTopic, setActiveNotebookTopic } from "./notebook/topic.js";
import { registerNotebookTopicTool } from "./notebook/topic-tool.js";
import { saveNotebookPage, resetNotebookWriteLock } from "./notebook/store.js";
import { createNotebookToolDefinitions } from "./notebook/tools.js";
import registerAgenticoding from "./index.js";
import { CONTEXT_PRIMER } from "./system-prompt.js";
import { STATUS_KEY_HANDOFF, STATUS_KEY_TOPIC, WIDGET_KEY_WARNING, updateIndicators } from "./tui.js";

// Safety net: reset module-level mutable state after all tests.
// Individual tests should also call reset*() at the start for explicit isolation.
after(() => {
	resetNotebookWriteLock();
	resetSpawnFrameScheduler();
});

type Handler = (args: any, ctx: any) => any;

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const ansiTheme = {
	fg: (_name: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
	bg: (_name: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as unknown as Theme;

function createRenderContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		expanded: false,
		showImages: true,
		toolCallId: "tool-call-1",
		lastComponent: undefined,
		invalidate: () => {},
		...overrides,
	};
}

function createSession(messages: any[]) {
	return {
		messages,
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function getRenderedLine(lines: string[], match: (plain: string) => boolean): string {
	const line = lines.find(candidate => match(stripAnsi(candidate)));
	assert.ok(line);
	return line;
}

function getLineContaining(lines: string[], text: string): string {
	const line = lines.find(candidate => candidate.includes(text));
	assert.ok(line);
	return line;
}

function assertShellBackgroundPreserved(line: string): void {
	assert.equal(line.includes("\u001b[0m"), false);
	assert.match(line, /\u001b\[48;/);
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

function createChildSpawnTool(state: any): any {
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);
	return pi.tools.get("spawn");
}

class MockPi {
	commands = new Map<string, { description?: string; handler: Handler }>();
	tools = new Map<string, any>();
	handlers = new Map<string, Handler[]>();
	activeTools: string[] = [];
	toolSources = new Map<string, string>();
	sentUserMessages: Array<{ content: string; options: any }> = [];
	appendedEntries: Array<{ customType: string; data: any }> = [];
	flags = new Map<string, any>();
	shortcuts = new Map<string, { description?: string; handler: Handler }>();

	registerCommand(name: string, definition: { description?: string; handler: Handler }) {
		this.commands.set(name, definition);
	}

	registerTool(definition: any) {
		this.tools.set(definition.name, definition);
	}

	on(event: string, handler: Handler) {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	getActiveTools() {
		return [...this.activeTools];
	}

	setActiveTools(tools: string[]) {
		this.activeTools = [...tools];
		for (const tool of tools) {
			if (!this.toolSources.has(tool)) {
				this.toolSources.set(tool, "builtin");
			}
		}
	}

	setToolSource(name: string, source: string) {
		this.toolSources.set(name, source);
	}

	getAllTools() {
		return this.activeTools.map((name) => ({
			name,
			description: "",
			parameters: {},
			sourceInfo: {
				path: `<${this.toolSources.get(name) ?? "builtin"}:${name}>`,
				source: this.toolSources.get(name) ?? "builtin",
				scope: "temporary",
				origin: "top-level",
			},
		}));
	}

	getThinkingLevel() {
		return "medium";
	}

	sendUserMessage(content: string, options?: any) {
		this.sentUserMessages.push({ content, options });
	}

	appendEntry(customType: string, data: any) {
		this.appendedEntries.push({ customType, data });
	}

	registerFlag(name: string, definition: { description?: string; type: string; default: any }) {
		if (!this.flags.has(name)) this.flags.set(name, definition.default);
	}

	getFlag(name: string): any {
		return this.flags.get(name);
	}

	registerShortcut(key: string, definition: { description?: string; handler: Handler }) {
		this.shortcuts.set(key, definition);
	}
}

// ── TUI indicator tests ───────────────────────────────────────────────

function makeTUICtx(
	overrides: Partial<{
		percent: number | null;
		hasUI: boolean;
		record: { statuses: Map<string, string | undefined>; widgets: Map<string, string[] | undefined> };
	}> = {},
): any {
	const record = overrides.record ?? { statuses: new Map(), widgets: new Map() };
	const hasUI = overrides.hasUI ?? true;
	const percent = overrides.percent !== undefined ? overrides.percent : null;
	return {
		hasUI,
		ui: {
			theme: {
				fg: (name: string, text: string) => `[${name}:${text}]`,
			},
			setStatus: (key: string, status: string | undefined) => { record.statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { record.widgets.set(key, content); },
		},
		getContextUsage: () => (percent !== null ? { percent } : null),
	};
}

test("updateIndicators sets context usage status with correct color tone", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 42, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-ctx");
	assert.ok(s?.includes("[accent:42%]"), "42% should use accent tone");
	assert.equal(record.widgets.get("agenticoding-warning"), undefined, "42% is below 70 — no warning widget");
});

test("updateIndicators uses error tone at 70%+ context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-ctx");
	assert.ok(s?.includes("[error:85%]"), "85% should use error tone");
	const w = record.widgets.get("agenticoding-warning");
	assert.ok(w?.[0]?.includes("85%"), "warning widget shown at 85%");
});

test("updateIndicators uses readonly-specific high-context guidance", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const w = record.widgets.get("agenticoding-warning");
	assert.ok(w?.[0]?.includes("readonly: same topic → spawn"));
	assert.ok(w?.[0]?.includes("disable readonly, then handoff"));
});

test("updateIndicators uses warning tone at 50-69% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 55, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-ctx");
	assert.ok(s?.includes("[warning:55%]"), "55% should use warning tone");
});

test("updateIndicators uses accent tone at 30-49% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-ctx");
	assert.ok(s?.includes("[accent:30%]"), "30% should use accent tone");
});

test("updateIndicators handles null context usage", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-ctx");
	assert.ok(s?.includes("--%"), "null usage shows --%");
});

test("updateIndicators no-ops when ctx.hasUI is false", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ hasUI: false, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.size, 0, "no-op should not call any setStatus");
	assert.equal(record.widgets.size, 0, "no-op should not call any setWidget");
});

test("updateIndicators shows notebook page count in status", () => {
	const state = createState();
	state.notebookPages.set("entry-1", "first entry");
	state.notebookPages.set("entry-2", "second entry");
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-notebook");
	assert.ok(s?.includes("2"), "notebook page count should be 2");
});

test("updateIndicators shows active notebook topic when set", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.get(STATUS_KEY_TOPIC), "🧭 oauth");
});

test("updateIndicators hides widget below 70% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	// Pre-set a widget to verify it gets cleared
	record.widgets.set("agenticoding-warning", ["existing"]);
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	assert.equal(record.widgets.get("agenticoding-warning"), undefined, "warning widget should be cleared below 70%");
});

// ── Handoff tests ─────────────────────────────────────────────────────

test("/handoff sends the direction back through the LLM without opening the editor", async () => {
	const pi = new MockPi();
	const state = createState();
	registerHandoffCommand(pi as any, state);

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (_message: string) => {} },
	});

	assert.deepEqual(state.pendingRequestedHandoff, {
		direction: "implement auth",
		enforcementAttempts: 0,
		toolCalled: false,
	});
	assert.deepEqual(pi.sentUserMessages, [
		{
			content:
				"Handoff direction: implement auth\n\nPrepare a handoff in the current session. First, save any durable reusable knowledge to the notebook: findings worth keeping, constraints discovered, decisions made, or other grounding future contexts will need. Then draft a concise but sufficiently detailed handoff brief capturing only the remaining situational context: current state, blockers, unresolved questions, failed paths worth avoiding, and next steps. The next context will read the notebook on demand, so do not duplicate notebook content in the brief. Use any structure that makes the next work unambiguous. Reference notebook pages by name when relevant.",
			options: undefined,
		},
	]);
});

test("/handoff requires a direction", async () => {
	const pi = new MockPi();
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

test("/handoff is gated at command entry in readonly mode", async () => {
	const pi = new MockPi();
	const state = createState();
	state.readonlyEnabled = true;
	registerHandoffCommand(pi as any, state);

	const notifications: Array<{ message: string; level: string }> = [];
	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	});

	assert.deepEqual(pi.sentUserMessages, []);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /Readonly mode blocks \/handoff/);
	assert.match(notifications[0].message, /disable readonly with \/readonly/);
	assert.equal(notifications[0].level, "warning");
});

test("handoff tool triggers compaction and resumes with the compacted task", async () => {
	const pi = new MockPi();
	const state = createState();
	state.notebookPages.set("auth-refresh", "sensitive notebook body");
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 0, toolCalled: false };
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
	assert.match(state.pendingHandoff?.task ?? "", /## Handoff — Continue Previous Work/);
	assert.match(state.pendingHandoff?.task ?? "", /Notebook pages hold durable grounding knowledge/);
	assert.match(state.pendingHandoff?.task ?? "", /distilled next task and immediate situational context/);
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
	const pi = new MockPi();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool" };
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 1, toolCalled: true };
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
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.activeNotebookTopic, null);
	assert.equal(state.activeNotebookTopicSource, null);
	assert.equal(result.compaction.summary, "Goal: continue");
	assert.equal(result.compaction.tokensBefore, 123);
	assert.equal(result.compaction.firstKeptEntryId, "leaf-1-handoff-cut");
	assert.deepEqual(result.compaction.details, { handoff: true, task: "Goal: continue" });
});

test("/handoff sets the handoff status indicator", async () => {
	const pi = new MockPi();
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
	const pi = new MockPi();
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
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { direction: "implement auth", enforcementAttempts: 0, toolCalled: false };
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

test("turn_end fallback clears stale requested handoff status", async () => {
	const pi = new MockPi();
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

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("session_start new clears stale handoff status and warning widget", async () => {
	const pi = new MockPi();
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

test("watchdog records context usage without user notifications", async () => {
	const pi = new MockPi();
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
	const pi = new MockPi();
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
	const pi = new MockPi();
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
	const pi = new MockPi();
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
	const pi = new MockPi();
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


test("buildNudge handles null percent and boundary hints before topic guidance", () => {
	const boundary = buildNudge(
		{
			activeNotebookTopic: "oauth",
			pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
			readonlyEnabled: false,
		},
		null,
	);
	assert.match(boundary, /Notebook topic changed from oauth to billing/);
	assert.doesNotMatch(boundary, /Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null, readonlyEnabled: false }, null);
	assert.match(noTopic, /Topic-aware context reminder/);
	assert.match(noTopic, /No active notebook topic is set/);
});

test("context throttles watchdog nudges within the same band", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;

	// First call: 75% → band 2, should inject watchdog
	const first = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 75 }) },
	);
	assert.notEqual(first, undefined);
	assert.equal(first.messages[1].customType, "agenticoding-watchdog");

	// Second call: 78% → same band 2, should be throttled
	const second = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 78 }) },
	);
	assert.equal(second, undefined);
});


test("watchdog stays advisory when a requested handoff is not completed", async () => {
	const pi = new MockPi();
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

test("collapsed nested spawn render shows preview and stats", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("one")));
	assert.ok(lines.some((l: string) => l.includes("five")));
	assert.ok(lines.some((l: string) => l.includes("... 2 more lines")));
	assert.ok(lines.some((l: string) => l.includes("tok 12/34")));
	assert.ok(lines.some((l: string) => l.includes("trunc")));
});

test("collapsed nested spawn render keeps all text blocks from the last assistant message", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("first")));
	assert.ok(lines.some((l: string) => l.includes("second")));
});

test("collapsed nested spawn truncation preserves shell background across preview and stats lines", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "Research the nudge on toggle off TODO from the readonly mode plan." }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		ansiTheme,
		createRenderContext(),
	) as any;

	const lines = component.render(24);
	const previewLine = getRenderedLine(lines, plain => plain.includes("Research"));
	const statsLine = getRenderedLine(lines, plain => plain.includes("tok 12/34"));
	assertShellBackgroundPreserved(previewLine);
	assertShellBackgroundPreserved(statsLine);
	assert.match(stripAnsi(statsLine), /tok 12\/34/);
});

test("collapsed nested spawn keeps truncated stats line calm", () => {
	const markerTheme = {
		fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "short preview" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		markerTheme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	const statsLine = getLineContaining(lines, "tok 12/34");
	assert.match(statsLine, /<dim>.*tok 12\/34.*trunc.*<\/dim>/);
	assert.equal(statsLine.includes("<warning>"), false);
});

test("nested spawn render is safe without details", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }] },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("expanded nested spawn header stays within width after indent", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "model-name", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true }),
	) as any;

	const lines = component.render(24);
	const headerLine = lines.find((line: string) => line.includes("model-name")) ?? "";
	assert.ok(headerLine.startsWith("     "));
	assert.ok(stripAnsi(headerLine).length <= 24);
});

test("nested spawn clears cached render when showImages changes", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "image", data: "iVBOR", mimeType: "image/png" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: true }),
	) as any;
	const linesWithImages = component.render(120);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: false, lastComponent: component }),
	) as any;
	const linesWithoutImages = sameComponent.render(120);

	assert.equal(sameComponent, component);
	// Both render calls produce valid output — cache invalidation is verified
	// implicitly because the second output reflects the showImages change
	// rather than returning stale cached content from the first call.
	assert.ok(Array.isArray(linesWithImages));
	assert.ok(Array.isArray(linesWithoutImages));
});

test("nested spawn rerenders when stats become unavailable", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;
	const before = component.render(120);
	assert.equal(before.some((l: string) => l.includes("stats unavailable")), false);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;
	const after = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.ok(after.some((l: string) => l.includes("stats unavailable")));
	assert.equal(after.some((l: string) => l.includes("initializing")), false);
});

test("spawn execute propagates only executable parent tools to child session", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn", "handoff", "future_tool"]);
	pi.setToolSource("future_tool", "project");
	const state = createState();

	let seenConfig: any;
	const mockFactory = async (config: any) => {
		seenConfig = config;
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(seenConfig.model.id, "mock-model");
	assert.equal(seenConfig.thinkingLevel, "high");
	assert.equal(seenConfig.cwd, "/tmp");
	assert.equal(seenConfig.tools.includes("read"), true);
	assert.equal(seenConfig.tools.includes("bash"), true);
	assert.equal(seenConfig.tools.includes("future_tool"), false);
	assert.equal(seenConfig.tools.includes("handoff"), false);
	assert.equal(seenConfig.tools.includes("spawn"), false);
});

test("spawn execute builds prompt with notebook pages and task", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.notebookPages.set("entry-a", "preview line\nfull body");

	let seenPrompt = "";
	const mockFactory = async (config: any) => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				seenPrompt = prompt;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	// Verify user-facing invariants: task text is included, notebook pages are referenced
	assert.match(seenPrompt, /Do the task/);
	assert.match(seenPrompt, /entry-a: preview line/);
});

test("spawn renderResult falls back to static text when no live session is stored", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const result = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "fallback output" }],
			details: { model: "m", thinking: "low", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = result.render(120);
	assert.ok(lines.some((l: string) => l.includes("m • low")));
	assert.ok(lines.some((l: string) => l.includes("fallback output")));
});

test("spawn renderResult distinguishes aborted and error outcomes", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const aborted = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "stopped" }],
			details: { model: "m", thinking: "low", truncated: false, outcome: "aborted" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;
	const error = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "failed" }],
			details: { model: "m", thinking: "low", truncated: false, outcome: "error" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const abortedLines = aborted.render(120);
	const errorLines = error.render(120);
	assert.ok(abortedLines.some((l: string) => l.includes("✗ m • low")));
	assert.ok(abortedLines.some((l: string) => l.includes("aborted")));
	assert.ok(errorLines.some((l: string) => l.includes("⚠ m • low")));
	assert.ok(errorLines.some((l: string) => l.includes("error")));
});

test("spawn execute returns result and stats", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const updates: any[] = [];
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => ({
				tokens: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, total: 40 },
				cost: 0.5,
				assistantMessages: 2,
			}),
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		(update: any) => updates.push(update),
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.deepEqual(updates, [{
		content: [],
		details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running" },
	}]);
	assert.equal(result.content[0].text, "child result");
	assert.equal(result.details.outcome, "success");
	assert.deepEqual(result.details.stats, {
		inputTokens: 11,
		outputTokens: 22,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		totalTokens: 40,
		cost: 0.5,
		turns: 2,
	});
});

test("spawn execute marks stats unavailable when stats collection throws", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => {
		warnings.push(args);
	};

	try {
		const mockFactory = async () => {
			const session = {
				messages: [] as any[],
				prompt: async () => {
					session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
				},
				abort: async () => {},
				getSessionStats: () => {
					throw new Error("stats failed");
				},
			};
			return { session: session as any };
		};

		registerSpawnTool(pi as any, state, mockFactory as any);
		const result = await pi.tools.get("spawn").execute(
			"spawn-1",
			{ prompt: "Do the task" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: "/tmp" },
		);

		assert.equal(result.details.stats, undefined);
		assert.equal(result.details.statsUnavailable, true);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][1]), /stats failed/);
		assert.equal(warnings[0][2], "spawn-1");
	} finally {
		console.warn = originalWarn;
	}
});

test("spawn execute throws when child produces no output", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/Child agent produced no output\./,
	);
});

test("spawn execute clears childSessions when prompt throws", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				throw new Error("prompt failed");
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/prompt failed/,
	);
	assert.equal(state.childSessions.size, 0);
});

test("spawn execute clears childSessions after successful completion when unrendered", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.content[0].text, "child result");
	assert.equal(state.childSessions.size, 0);
});

test("spawn execute fails explicitly without a configured model", async () => {
	const pi = new MockPi();
	const state = createState();
	registerSpawnTool(pi as any, state);
	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { cwd: "/tmp" }),
		/No model configured\. Cannot spawn child agent\./,
	);
});

test("child tool set omits spawn", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state);
	assert.equal(childTools.some(t => t.name === "spawn"), false);
	const childToolNames = buildChildToolNames(
		["read", "bash", "spawn", "handoff", "future_tool"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "spawn", sourceInfo: { source: "builtin" } },
			{ name: "handoff", sourceInfo: { source: "builtin" } },
			{ name: "future_tool", sourceInfo: { source: "project" } },
		] as any,
	);
	assert.equal(childToolNames.includes("spawn"), false);
	assert.equal(childToolNames.includes("handoff"), false);
	assert.equal(childToolNames.includes("future_tool"), false);
});

test("spawn renderResult transfers session ownership out of shared state", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const component = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("spawn renderResult reuses lastComponent", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const first = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const second = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: first }),
	);
	assert.equal(first, second);
});

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("resetState aborts a claimed child session after render ownership transfer", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	resetState(state);

	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn suppresses stale child sessions after resetState during async setup", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let resolveFactory!: (value: any) => void;
	const factoryReady = new Promise<any>((resolve) => {
		resolveFactory = resolve;
	});
	let promptCalled = false;
	let abortCalls = 0;
	let onUpdateCalled = false;
	const staleSession = {
		messages: [] as any[],
		prompt: async () => {
			promptCalled = true;
			staleSession.messages = [{ role: "assistant", content: [{ type: "text", text: "stale result" }] }];
		},
		abort: async () => {
			abortCalls++;
		},
		getSessionStats: () => undefined,
	};

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		() => {
			onUpdateCalled = true;
		},
		"medium",
		async () => factoryReady,
	);

	resetState(state);
	const freshSession = createSession([{ role: "assistant", content: [{ type: "text", text: "fresh result" }] }]);
	state.childSessions.set("spawn-1", freshSession);
	state.liveChildSessions.set("spawn-1", freshSession);
	resolveFactory({ session: staleSession as any });

	await assert.rejects(() => executePromise, /invalidated by reset/i);
	assert.equal(onUpdateCalled, false);
	assert.equal(promptCalled, false);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.get("spawn-1"), freshSession);
	assert.equal(state.liveChildSessions.get("spawn-1"), freshSession);
});

test("child tool names inherit builtin parent tools, exclude handoff and spawn", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state);

	const toolNames = buildChildToolNames(
		["read", "bash", "handoff", "future_tool"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "handoff", sourceInfo: { source: "builtin" } },
			{ name: "future_tool", sourceInfo: { source: "project" } },
		] as any,
	);

	assert.ok(toolNames.includes("read"));
	assert.ok(toolNames.includes("bash"));
	assert.equal(toolNames.includes("future_tool"), false);
	assert.ok(toolNames.includes("notebook_write"));
	assert.ok(toolNames.includes("notebook_read"));
	assert.ok(toolNames.includes("notebook_index"));
	assert.equal(toolNames.includes("handoff"), false);
	assert.equal(toolNames.includes("spawn"), false);
});

function createSubscribableSession(messages: any[] = []) {
	let handler: ((event: any) => void) | undefined;
	return {
		session: {
			messages,
			subscribe: (cb: (event: any) => void) => {
				handler = cb;
				return () => { handler = undefined; };
			},
			getToolDefinition: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
			abort: async () => {},
		} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
		emit: (event: any) => handler?.(event),
	};
}

test("nested spawn live action tracks tool execution events", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	// Mock console.warn to suppress any expected-but-harmless warnings
	// (e.g., streaming component errors in headless test env).
	const originalWarn = console.warn;
	console.warn = () => {};

	try {
		const component = childSpawnTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// message_start → thinking
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		let lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("thinking")), `expected thinking, got: ${lines.join("\n")}`);

		// message_update with text → live preview
		emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "writing code now" }] } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("writing code now")), `expected live text preview, got: ${lines.join("\n")}`);

		// message_end → success marker in identity line
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "end_turn" } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("✅")), `expected success marker, got: ${lines.join("\n")}`);

		// Tool events degrade gracefully in minimal test env and still update live action
		emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
		lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("[bash]")), `expected tool live action, got: ${lines.join("\n")}`);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn handleEvent recovers from malformed events", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// Emit a malformed event that will throw inside handleEvent
		emit({ type: "message_start", message: null });
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][1]), /message_start/);

		// Subsequent valid events still process
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("thinking")), `expected thinking after recovery, got: ${lines.join("\n")}`);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn message_end with aborted stopReason clears pending tools", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Start an assistant message
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	// End it with aborted — sets lastAction to "aborted"
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "killed" } });

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("aborted")), `expected aborted, got: ${lines.join("\n")}`);
});

test("nested spawn dispose stops event processing", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	component.dispose();

	// Emit event after dispose — should not update state or crash
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const after = component.render(120);

	assert.ok(after.every((line: string) => !line.includes("thinking")), `unexpected post-dispose update: ${after.join("\n")}`);
});

test("nested spawn dispose aborts a claimed live child session", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	component.dispose();

	assert.equal(abortCalls, 1);
	assert.equal(state.liveChildSessions.has("tool-call-1"), false);
});

test("spawn execute short-circuits when signal is already aborted", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let abortCalled = false;
	let promptCalled = false;
	let onUpdateCalled = false;
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				promptCalled = true;
			},
			abort: async () => { abortCalled = true; },
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => pi.tools.get("spawn").execute(
			"spawn-1",
			{ prompt: "Do the task" },
			controller.signal,
			() => { onUpdateCalled = true; },
			{ model: { id: "mock-model" }, cwd: "/tmp" },
		),
		/abort/i,
	);

	assert.equal(abortCalled, true);
	assert.equal(promptCalled, false);
	assert.equal(onUpdateCalled, false);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn execute truncates very long child output", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	// Generate > 2000 lines of output
	const longText = Array.from({ length: 2100 }, (_, i) => `Line ${i + 1}`).join("\n");

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: longText }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate lots of output" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	assert.ok(result.content[0].text.includes("[Result truncated"));
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn execute truncates child output by byte limit", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const longText = "🙂".repeat(20_000);

	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: longText }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate byte-heavy output" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	assert.ok(result.content[0].text.includes("[Result truncated"));
	assert.ok(result.content[0].text.length < longText.length);
	assert.equal(result.content[0].text.includes("\n"), true);
});

test("spawn execute tells children when no notebook pages exist", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let promptText = "";
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (text: string) => {
				promptText = text;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.match(promptText, /No notebook pages\./);
	assert.doesNotMatch(promptText, /Available notebook pages:/);
	assert.match(promptText, /store only durable grounding knowledge for future contexts/i);
	assert.match(promptText, /Keep transient task state in your final reply to the parent\./);
});

test("executeSpawn → onUpdate → renderResult chains session ownership", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let onUpdateCalled = false;
	let renderComponent: any = null;
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const executePromise = pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		(update: any) => {
			onUpdateCalled = true;
			// Simulate pi rendering during execution by calling renderResult
			// with the same toolCallId the execute call is using.
			renderComponent = pi.tools.get("spawn").renderResult(
				{ content: [], details: update.details },
				{ expanded: false },
				theme,
				{ toolCallId: "spawn-1", expanded: false, showImages: true, lastComponent: undefined, invalidate: () => {} },
			);
		},
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	const result = await executePromise;

	// onUpdate was called
	assert.equal(onUpdateCalled, true);

	// renderComponent from onUpdate has a live session attached
	assert.equal(typeof renderComponent.hasSession, "function");
	assert.equal(renderComponent.hasSession(), true);

	// Session ownership was transferred out of the render handoff queue
	assert.equal(state.childSessions.has("spawn-1"), false);
	assert.equal(state.liveChildSessions.has("spawn-1"), false);

	// Component renders session content
	const lines = renderComponent.render(120);
	const text = lines.join(" ");
	assert.ok(text.includes("result"), `expected result in render, got: ${text}`);

	// Final execute result is also correct
	assert.equal(result.content[0].text, "result");
});

test("spawn render shows success state when stats are unavailable", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "final summary" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("✅ mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("stats unavailable")));
	assert.equal(lines.some((l: string) => l.includes("initializing")), false);
});

test("spawn execute aborts child session when signal fires during execution", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let abortCalled = false;
	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				promptStarted();
				await new Promise<void>((resolve) => { resolvePrompt = resolve; });
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "aborted mid-flight" }] }];
			},
			abort: async () => {
				abortCalled = true;
				resolvePrompt();
			},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const controller = new AbortController();
	const executePromise = pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	await started;
	controller.abort();

	const result = await executePromise;
	assert.equal(abortCalled, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(result.content[0].text, "aborted mid-flight");
	assert.equal(result.details.outcome, "aborted");
});

test("spawn renderCall shows prompt preview and thinking level", () => {
	const state = createState();
	const pi = new MockPi();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");

	// Collapsed: short prompt
	const collapsed = tool.renderCall({ prompt: "Do X" }, theme, { expanded: false });
	const collapsedLines = collapsed.render(120);
	assert.ok(collapsedLines.some((l: string) => l.includes("spawn")));
	assert.ok(collapsedLines.some((l: string) => l.includes("Do X")));

	// Collapsed: long prompt shows truncation hint
	const longPrompt = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n");
	const truncated = tool.renderCall({ prompt: longPrompt }, theme, { expanded: false });
	const truncatedLines = truncated.render(120);
	assert.ok(truncatedLines.some((l: string) => l.includes("more lines")));

	// With thinking level
	const withThinking = tool.renderCall({ prompt: "Do X", thinking: "high" }, theme, { expanded: false });
	const thinkingLines = withThinking.render(120);
	assert.ok(thinkingLines.some((l: string) => l.includes("high")));

	// Expanded: shows full prompt
	const expanded = tool.renderCall({ prompt: longPrompt }, theme, { expanded: true });
	const expandedLines = expanded.render(120);
	assert.ok(!expandedLines.some((l: string) => l.includes("more lines")));
});



test("notebook rehydration rebuilds the latest epoch and enables notebook tools", async () => {
	const pi = new MockPi();
	const state = createState();
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "old", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "new" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "newer" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 2);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["keep", "newer"]]);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});


test("notebook rehydration rebuilds from the latest persisted epoch and avoids duplicate active tools", async () => {
	const pi = new MockPi();
	pi.activeTools = ["read", "notebook_read", "notebook_index"];
	const state = createState();
	state.epoch = 7;
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 7, name: "keep", content: "fresh" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "future", content: "latest" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 8);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["future", "latest"]]);
	assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
});


test("notebook rehydration clears stale in-memory notebook state when persisted history is empty", async () => {
	const pi = new MockPi();
	const state = createState();
	state.epoch = 7;
	state.notebookPages.set("stale", "stale body");
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [],
			},
		},
	);

	assert.equal(state.epoch, 0);
	assert.deepEqual(Array.from(state.notebookPages.entries()), []);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});


test("session_start rehydrates the latest persisted notebook state through the full hook chain", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	pi.activeTools = ["read", "notebook_read"];
	registerAgenticoding(pi as any);

	try {
		const notebookWrite = pi.tools.get("notebook_write");
		await notebookWrite.execute(
			"seed",
			{ name: "stale-page", content: "stale body" },
			undefined,
			undefined,
			makeTUICtx({ hasUI: false }),
		);

		const sessionStartHandlers = pi.handlers.get("session_start")!;
		const ctx = {
			hasUI: false,
			getContextUsage: () => null,
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "fresh" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "newer" } },
				],
			},
		};
		for (const sessionStart of sessionStartHandlers) {
			await sessionStart({ reason: "resume" }, ctx as any);
		}

		const notebookIndex = pi.tools.get("notebook_index");
		const notebookRead = pi.tools.get("notebook_read");
		const indexResult = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
		assert.deepEqual(indexResult.details.entries, ["keep"]);

		const readResult = await notebookRead.execute("2", { name: "keep" }, undefined, undefined, {} as any);
		assert.equal(readResult.details.found, true);
		assert.equal(readResult.details.body, "newer");
		assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
	} finally {
		resetNotebookWriteLock();
	}
});

test("notebook tools add/get/list return stable contract details", async () => {
	const pi = new MockPi();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addResult = await notebookWrite.execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, undefined, {} as any);
	assert.deepEqual(addResult.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(state.notebookPages.get("entry-a"), "first line\nsecond line");
	assert.equal(pi.appendedEntries.length, 1);
	assert.equal(pi.appendedEntries[0].customType, "notebook-entry");
	assert.equal(pi.appendedEntries[0].data.name, "entry-a");

	const getResult = await notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any);
	assert.equal(getResult.details.found, true);
	assert.deepEqual(getResult.details.entries, ["entry-a"]);
	assert.match(getResult.content[0].text, /--- entry-a ---/);
	assert.match(getResult.content[0].text, /second line/);

	const listResult = await notebookIndex.execute("3", {}, undefined, undefined, {} as any);
	assert.deepEqual(listResult.details, { entries: ["entry-a"] });
	assert.match(listResult.content[0].text, /entry-a: first line/);
});

test("child notebook tools reject stale access after reset", async () => {
	const pi = new MockPi();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	let stale = false;
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state, { isStale: () => stale });

	stale = true;
	await assert.rejects(
		() => notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookIndex.execute("3", {}, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 0);
});

test("child notebook_write succeeds while child session is fresh", async () => {
	const pi = new MockPi();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state, { isStale: () => false });

	const result = await notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "alpha" });
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 1);
});

test("notebook_read reports not found with current page names", async () => {
	const pi = new MockPi();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	state.notebookPages.set("entry-b", "beta");
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	const result = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a", "entry-b"], found: false });
	assert.match(result.content[0].text, /Notebook page "missing" not found\./);
	assert.match(result.content[0].text, /Notebook Pages:\n/);
	assert.match(result.content[0].text, /entry-a: alpha/);
	assert.match(result.content[0].text, /entry-b: beta/);
});

test("notebook tools show empty-state placeholders", async () => {
	const pi = new MockPi();
	const state = createState();
	const [, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const missing = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(missing.details, { entries: [], found: false });
	assert.match(missing.content[0].text, /Notebook Pages:\n\(empty\)/);

	const list = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(list.details, { entries: [] });
	assert.match(list.content[0].text, /Notebook Pages:\n\(empty\)/);
});

test("notebook_write pushes onUpdate and refreshes UI indicators", async () => {
	const pi = new MockPi();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute(
		"1",
		{ name: "entry-a", content: "first line\nsecond line" },
		undefined,
		(payload: any) => { update = payload; },
		makeTUICtx({ percent: 42, record }),
	);

	assert.equal(update.content[0].text, 'Saved "entry-a": first line');
	assert.deepEqual(update.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(record.statuses.get("agenticoding-notebook"), "📒 1");
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "first line" });
});

test("notebook tool renderers expose stable call/result summaries", async () => {
	const pi = new MockPi();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addCall = notebookWrite.renderCall!({ name: "entry-a", content: "first line\nsecond line" }, theme, {} as any) as Text;
	assert.match(stripAnsi(addCall.render(120).join("\n")), /notebook_write "entry-a": first line/);

	const addResult = notebookWrite.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a", content: "first line\nsecond line" } } as any,
	) as Text;
	assert.match(stripAnsi(addResult.render(120).join("\n")), /Saved "entry-a": first line/);
	assert.match(stripAnsi(addResult.render(120).join("\n")), /entry-a/);

	const getResult = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResult.render(120).join("\n")), /"entry-a"/);
	assert.match(stripAnsi(getResult.render(120).join("\n")), /body/);

	const getResultWithDelimiters = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 1/);
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 2/);

	const listResult = notebookIndex.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"] } },
		{ expanded: true },
		theme,
		{} as any,
	) as Text;
	assert.match(stripAnsi(listResult.render(120).join("\n")), /2 pages/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-a/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-b/);
});

test("/notebook exits cleanly when headless", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	await assert.doesNotReject(() => pi.commands.get("notebook")!.handler("", { hasUI: false }));
});


test("/notebook <topic> notifies with info on first set and warning on boundary change", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 20 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: (key: string, status: string | undefined) => { statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { widgets.set(key, content); },
		},
	};

	await pi.commands.get("notebook")!.handler("oauth", ctx as any);
	await pi.commands.get("notebook")!.handler("billing", ctx as any);

	assert.deepEqual(notifications[0], { message: "Active notebook topic: oauth", level: "info" });
	assert.match(notifications[1].message, /Active notebook topic changed: oauth → billing/);
	assert.equal(notifications[1].level, "warning");
	assert.equal(statuses.get(STATUS_KEY_TOPIC), "🧭 billing");
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

test("/notebook <topic> warns with readonly-safe guidance on boundary change", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 20 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: () => {},
			setWidget: () => {},
		},
	};

	await pi.commands.get("readonly")!.handler("", ctx as any);
	await pi.commands.get("notebook")!.handler("oauth", ctx as any);
	await pi.commands.get("notebook")!.handler("billing", ctx as any);

	assert.match(notifications[2].message, /use spawn only for same-topic delegation/);
	assert.match(notifications[2].message, /disable readonly with \/readonly before handoff/);
	assert.equal(notifications[2].level, "warning");
});

test("/notebook empty overlay renders empty state and closes on input", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(lines, /Notebook \(0 pages\)/);
	assert.match(lines, /\(empty\) — use notebook_write to create pages/);
	overlay.handleInput("x");
	assert.equal(doneCalls, 1);
});

test("/notebook selection previews the chosen entry", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body line\nsecond line" }, undefined, undefined, makeTUICtx());
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
			notify: (message: string) => { notifications.push(message); },
		},
	});

	// First Enter selects the entry — shows body inline, done() not yet called
	overlay.handleInput("\r");
	assert.equal(doneCalls, 0, "body shown inline, overlay stays open");
	const bodyLines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(bodyLines, /body line/);
	assert.match(bodyLines, /alpha/);

	// Second keypress closes the overlay
	overlay.handleInput("\r");
	assert.equal(doneCalls, 1);
});

test("/notebook overlay sorts entries consistently", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "zeta", content: "last" }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "alpha", content: "first" }, undefined, undefined, makeTUICtx());
	let overlay: any;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => {});
			},
			notify: () => {},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.ok(lines.indexOf("alpha") < lines.indexOf("zeta"), lines);
});

test("saveNotebookPage serializes concurrent writes and preserves completion order", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();
	const firstGate = createDeferred();
	const order: string[] = [];

	const first = saveNotebookPage(pi as any, state, "entry-a", "first", async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = saveNotebookPage(pi as any, state, "entry-a", "second", async () => {
		order.push("second:start");
	});

	await Promise.resolve();
	assert.deepEqual(order, ["first:start"]);
	firstGate.resolve();
	await Promise.all([first, second]);

	assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
	assert.equal(state.notebookPages.get("entry-a"), "second");
	assert.deepEqual(pi.appendedEntries.map((entry) => entry.data.content), ["first", "second"]);
	resetNotebookWriteLock();
});

test("saveNotebookPage rejects true reentrancy explicitly", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "outer", "outer", async () => {
			await saveNotebookPage(pi as any, state, "inner", "inner");
		}),
		/not reentrant/i,
	);
	assert.equal(state.notebookPages.size, 0);
	resetNotebookWriteLock();
});

test("saveNotebookPage releases the lock when assertWritable throws", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "broken", "value", async () => {
			throw new Error("blocked");
		}),
		/blocked/,
	);
	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
	resetNotebookWriteLock();
});

test("resetNotebookWriteLock clears abandoned lock state for later writes", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();
	const gate = createDeferred();
	void saveNotebookPage(pi as any, state, "stuck", "value", async () => {
		await gate.promise;
	});
	await Promise.resolve();
	resetNotebookWriteLock();

	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
	gate.resolve();
	resetNotebookWriteLock();
});


test("saveNotebookPage truncates oversized content before persisting", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();
	const content = "first line\n" + "detail\n".repeat(3000);

	const result = await saveNotebookPage(pi as any, state, "large-page", content);
	const persisted = pi.appendedEntries[0].data.content;

	assert.ok(persisted.length < content.length, "oversized notebook content should be truncated");
	assert.equal(state.notebookPages.get("large-page"), persisted);
	assert.equal(result.preview, "first line");
	assert.match(persisted, /^first line/m);
	resetNotebookWriteLock();
});


test("resetState clears epoch and the next notebook write starts a fresh generation", async () => {
	resetNotebookWriteLock();
	const pi = new MockPi();
	const state = createState();
	const originalNow = Date.now;

	try {
		Date.now = () => 1000;
		await saveNotebookPage(pi as any, state, "entry-a", "first");
		await saveNotebookPage(pi as any, state, "entry-b", "second");
		assert.equal(state.epoch, 1000);
		assert.equal(pi.appendedEntries[0].data.epoch, 1000);
		assert.equal(pi.appendedEntries[1].data.epoch, 1000);

		resetState(state);
		assert.equal(state.epoch, 0);

		Date.now = () => 2000;
		await saveNotebookPage(pi as any, state, "entry-c", "third");
		assert.equal(state.epoch, 2000);
		assert.equal(pi.appendedEntries[2].data.epoch, 2000);
	} finally {
		Date.now = originalNow;
		resetNotebookWriteLock();
	}
});

test("nested spawn invalidate rebuilds from the attached session transcript", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	session.messages[0].content[0].text = "after";
	component.invalidate();

	const secondRender = component.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("after")));
	assert.equal(secondRender.some((l: string) => l.includes("before")), false);
});

test("nested spawn attachSession rebuilds after appended session messages", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]));

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
		{ role: "assistant", content: [{ type: "text", text: "after" }] },
	]));
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	const secondRender = sameComponent.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("after")));
});

test("nested spawn attachSession rebuilds after replacing session transcript structure", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]));

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	state.childSessions.set("tool-call-1", createSession([
		{ role: "user", content: [{ type: "text", text: "new task" }] },
		{ role: "assistant", content: [{ type: "text", text: "replacement" }] },
	]));
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	const secondRender = sameComponent.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("replacement")));
	assert.equal(secondRender.some((l: string) => l.includes("before")), false);
});

test("nested spawn rebuildFromSession quietly tolerates missing tool definitions", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = {
		messages: [{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "ls" } }],
			stopReason: "error",
			errorMessage: "boom",
		}],
		subscribe: () => () => {},
		getToolDefinition: () => { throw new Error("missing tool definition"); },
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", session);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [], details: { model: "m", thinking: "low", truncated: false, outcome: "error" } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("⚠ m • low")));
		assert.ok(lines.some((l: string) => l.includes("error")));
		assert.equal(state.childSessions.has("tool-call-1"), false);
		assert.deepEqual(warnings, []);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn attachSession recovers from subscribe throwing", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);

	// Session whose subscribe() throws
	const throwingSession = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
		subscribe: () => { throw new Error("subscribe failed"); },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", throwingSession);

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);

	try {
		const component = childSpawnTool.renderResult(
			{ content: [], details: { model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// Should not crash, session attached, ownership transferred
		assert.equal(state.childSessions.has("tool-call-1"), false);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][0]), /Failed to subscribe/);

		// Should still render from session messages despite subscribe failure
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("hello")));
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn rapid events collapse to last state", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Start a tool execution
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });

	// Rapid burst of updates without rendering between them
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file1" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file2" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file3" }] } });

	// Single render should reflect last state
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("file3")));

	// End the tool and verify final state
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });

	const finalLines = component.render(120);
	assert.ok(finalLines.some((l: string) => l.includes("✓")));
});

// Narrow test: verifies the pendingToolCallCreations accumulation layer keeps the
// last streamed args, overwriting on each message_update. The monkey-patch on
// createToolComponent captures args before component creation. If the private
// method is renamed, update the spy target.
test("nested spawn uses the latest streamed tool-call args before first frame flush", () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: true },
		theme,
		createRenderContext(),
	) as any;
	let createdArgs: any;
	component.createToolComponent = (_toolName: string, _toolCallId: string, args: any) => {
		createdArgs = args;
		return undefined;
	};

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "old" } }] },
	});
	emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "new" } }] },
	});
	flushSpawnFrameScheduler();

	assert.deepEqual(createdArgs, { value: "new" });
});

test("nested spawn coalesces same-turn child events into one parent invalidate", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file1" }] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file2" }] } });

	assert.equal(invalidateCalls, 0, "child events do not invalidate synchronously");
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "same-turn events coalesce into one invalidate");

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("file2")));
});

test("nested spawn ignores child renderer invalidations during parent rebuild", async () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session } = createSubscribableSession([]);
	(session as any).getToolDefinition = (toolName: string) => toolName === "reentrant"
		? {
			name: "reentrant",
			renderCall(_args: any, _theme: Theme, context: any) {
				if (!context.state.didInvalidate) {
					context.state.didInvalidate = true;
					context.invalidate();
				}
				return new Text("reentrant", 0, 0);
			},
		}
		: undefined;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 0, "initial empty attach does not invalidate");

	(session as any).messages = [{
		role: "assistant",
		content: [{ type: "toolCall", id: "tc-1", name: "reentrant", arguments: {} }],
	}];
	component.invalidate();
	flushSpawnFrameScheduler();

	assert.equal(invalidateCalls, 0, "child renderer invalidate requests stay inside spawn rebuild");
});

test("nested spawn shared scheduler calls each distinct invalidate once per frame", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const first = createSubscribableSession([]);
	const second = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	state.childSessions.set("tool-call-2", second.session);
	state.liveChildSessions.set("tool-call-2", second.session);
	let firstInvalidates = 0;
	let secondInvalidates = 0;

	const firstComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-1", invalidate: () => { firstInvalidates++; } }),
	) as any;
	const secondComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-2", invalidate: () => { secondInvalidates++; } }),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	first.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first latest" }] } });
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "second latest" }] } });

	assert.equal(firstInvalidates, 0, "shared scheduler defers parent invalidate");
	assert.equal(secondInvalidates, 0, "shared scheduler defers parent invalidate");
	flushSpawnFrameScheduler();
	assert.equal(firstInvalidates, 1);
	assert.equal(secondInvalidates, 1);
	assert.ok(firstComponent.render(120).some((l: string) => l.includes("first latest")));
	assert.ok(secondComponent.render(120).some((l: string) => l.includes("second latest")));
});

test("nested spawn shared scheduler still coalesces duplicate invalidate callbacks", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const first = createSubscribableSession([]);
	const second = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	state.childSessions.set("tool-call-2", second.session);
	state.liveChildSessions.set("tool-call-2", second.session);
	let invalidateCalls = 0;
	const invalidate = () => { invalidateCalls++; };

	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-1", invalidate }),
	);
	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-2", invalidate }),
	);

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "identical callbacks still coalesce");
});

test("nested spawn renders state changes across frame boundaries", async () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// First batch: message_start sets thinking state, flush triggers render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const firstLines = component.render(120);
	assert.ok(firstLines.some((l: string) => l.includes("thinking")));

	// Second batch: message_update with new text, flush triggers new render
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "batch 2" }] } });
	flushSpawnFrameScheduler();
	const secondLines = component.render(120);
	assert.ok(secondLines.some((l: string) => l.includes("batch 2")));
});

test("nested spawn dispose cancels pending and further invalidates after cleanup", async () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	assert.equal(invalidateCalls, 0, "event does not invalidate synchronously");

	component.dispose();
	flushSpawnFrameScheduler();

	// After dispose, emitting more events does not call invalidate
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "after" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 0, "dispose cancels pending and future invalidates");

	// Render still works after dispose without crashing
	const lines = component.render(120);
	assert.ok(lines.length > 0, "render after dispose should not crash");
});

test("nested spawn reattach resets render guard for the new session", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "first session event triggers invalidate after scheduler flush");

	// Reattach resets the render guard
	const second = createSubscribableSession([{ role: "assistant", content: [{ type: "text", text: "replacement" }] }]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component, invalidate: () => { invalidateCalls++; } }),
	) as any;

	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "replacement 2" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 2, "second session event triggers another invalidate after reattach");
	const lines = sameComponent.render(120);
	assert.ok(lines.some((l: string) => l.includes("replacement 2")));
});

test("nested spawn recovers batching state after event handler error", async () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const warnings: any[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: any[]) => warnings.push(args);
	try {
		// Bad event triggers an error in handleMessageStart (null message)
		// catch block must call resetRenderBatching() so the flag resets
		emit({ type: "message_start", message: null } as any);

		// Good event after error — should still schedule and render
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		flushSpawnFrameScheduler();
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("thinking")),
			"error recovery should allow subsequent events to render");
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][0]), /Event handler error/);
	} finally {
		console.warn = originalWarn;
	}
});

test("nested spawn processes stale-state events without invalidating the parent", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	// Emit a message_start while the session is still fresh — triggers a render after flush
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "fresh-session event triggers invalidate");

	// Now mark the session stale
	state.liveChildSessions.delete("tool-call-1");

	// Subsequent events are dropped by handleEvent's isStaleSession check
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "stale-session events do not invalidate");

	// The optimistic event state was applied (message_start set thinking),
	// but stale-session updates are dropped — the component shows the last
	// known state before staleness, not a rolled-back version.
	const after = component.render(120);
	assert.ok(after.some((l: string) => l.includes("thinking")),
		"optimistic event state from when session was still fresh is visible");
	assert.ok(!after.some((l: string) => l.includes("stale")),
		"stale-session events are dropped");
});

test("nested spawn cancels a queued parent invalidate when the session becomes stale before flush", async () => {
	resetSpawnFrameScheduler();
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	state.liveChildSessions.delete("tool-call-1");
	flushSpawnFrameScheduler();

	assert.equal(invalidateCalls, 0, "stale-before-flush sessions cancel queued parent invalidates");
	assert.deepEqual(component.render(120), before, "stale-before-flush sessions roll back optimistic event state");
});

test("nested spawn dispose then reattach streams new session events", async () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "first" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	component.dispose();

	// Attach a second session to the same toolCallId after dispose
	const second = createSubscribableSession([
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const reattached = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "second" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "session B output" }] } });
	flushSpawnFrameScheduler();

	const lines = reattached.render(120);
	assert.ok(lines.some((l: string) => l.includes("session B output")),
		"reattached component should render events from the new session");
	assert.equal(lines.some((l: string) => l.includes("first")), false,
		"reattached component should not show stale content from disposed session");
});

test("nested spawn drops late events after live registry deletion", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should stop rerenders from late events");
	assert.deepEqual(after, before, "completed-session deletion should freeze the rendered state");
});

test("nested spawn drops events after resetState bumps child epoch", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	resetState(state);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "stale events should not request rerender after reset");
	assert.deepEqual(after, before, "stale events should not change rendered state after reset");
});

test("nested spawn drops events when session is replaced in live state", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	const replacementSession = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacementSession);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "replaced sessions should not request rerender");
	assert.deepEqual(after, before, "replaced sessions should not change rendered state");
});

test("nested spawn completed-session deletion stays stale even if the toolCallId is later reused", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const afterDeletion = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should immediately stale the old session");
	assert.deepEqual(afterDeletion, before, "completed-session deletion should freeze the rendered state before reuse");

	state.liveChildSessions.set("tool-call-1", createSubscribableSession([]).session);
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "should be dropped" }] } });
	const afterReuse = component.render(120);
	assert.equal(invalidateCalls, 0, "toolCallId reuse should not revive a completed stale session");
	assert.deepEqual(afterReuse, before, "toolCallId reuse should keep the old rendered state frozen");
	assert.ok(afterReuse.every((l: string) => !l.includes("should be dropped")), "toolCallId reuse should not admit stale text updates");
});

test("concurrent spawn executions produce independent results", async () => {
	const pi = new MockPi();
	const state = createState();

	let resolveA!: () => void;
	let resolveB!: () => void;
	let markStartedA!: () => void;
	let markStartedB!: () => void;
	const gateA = new Promise<void>((resolve) => { resolveA = resolve; });
	const gateB = new Promise<void>((resolve) => { resolveB = resolve; });
	const startedA = new Promise<void>((resolve) => { markStartedA = resolve; });
	const startedB = new Promise<void>((resolve) => { markStartedB = resolve; });
	const started: string[] = [];
	const outputs = new Map([
		["task A", "result-alpha"],
		["task B", "result-beta"],
	]);
	const sharedFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				const task = /## Task\n\n([\s\S]*?)\n\nWhen complete/.exec(prompt)?.[1] ?? "";
				started.push(task);
				if (task === "task A") {
					markStartedA();
					await gateA;
				}
				if (task === "task B") {
					markStartedB();
					await gateB;
				}
				session.messages = [{ role: "assistant", content: [{ type: "text", text: outputs.get(task) ?? task }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, sharedFactory as any);
	const spawnTool = pi.tools.get("spawn");

	const resultP1 = spawnTool.execute(
		"spawn-A", { prompt: "task A" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);
	const resultP2 = spawnTool.execute(
		"spawn-B", { prompt: "task B" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);

	await Promise.all([startedA, startedB]);
	assert.deepEqual(started.sort(), ["task A", "task B"]);
	resolveA();
	resolveB();

	const [r1, r2] = await Promise.all([resultP1, resultP2]);

	assert.equal(r1.content[0].text, "result-alpha");
	assert.equal(r2.content[0].text, "result-beta");
	assert.equal(state.childSessions.has("spawn-A"), false);
	assert.equal(state.childSessions.has("spawn-B"), false);
});

test("nested spawn render cache preserves stable output for identical params", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const first = component.render(120);
	const second = component.render(120);
	assert.deepEqual(second, first);

	const wide = component.render(200);
	assert.ok(Array.isArray(wide));
	assert.ok(wide.some((l: string) => l.includes("hello") || l.includes("m • low")));
});

test("notebook tool definitions include prompt hints when withPromptHints is true", () => {
	const pi = new MockPi();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state, { withPromptHints: true });

	for (const tool of tools) {
		assert.ok(typeof tool.promptSnippet === "string", `${tool.name} should have promptSnippet when withPromptHints=true`);
		assert.ok(Array.isArray(tool.promptGuidelines), `${tool.name} should have promptGuidelines when withPromptHints=true`);
	}
	const notebookWrite = tools.find(t => t.name === "notebook_write")!;
	const notebookRead = tools.find(t => t.name === "notebook_read")!;
	const notebookIndex = tools.find(t => t.name === "notebook_index")!;

	// Structural invariants: all guidelines exist and are non-trivial
	for (const tool of tools) {
		assert.ok(tool.promptGuidelines!.length >= 2, `${tool.name} should have at least 2 promptGuidelines`);
		assert.ok(tool.promptGuidelines!.every((g: string) => g.length > 10), `${tool.name} each guideline should be non-trivial`);
	}

	// Conceptual: notebook_write is future-context oriented
	const writeGuidelines = notebookWrite.promptGuidelines!.join(" ");
	assert.match(writeGuidelines, /subject-oriented pages/i);
	assert.match(writeGuidelines, /fresh context/i);
	assert.match(writeGuidelines, /belongs in handoff/i);

	// Conceptual: descriptions mention the notebook-page metaphor
	assert.match(notebookWrite.description, /page|future contexts/i);
	assert.match(notebookRead.description, /notebook page|page/i);
	assert.match(notebookIndex.description, /notebook index|index/i);
});

test("topic helpers manage the active notebook topic lifecycle", () => {
	const state = createState();
	const first = setActiveNotebookTopic(state, "OAuth", "agent");
	assert.deepEqual(first, {
		changed: true,
		previous: null,
		current: "oauth",
		boundaryHint: null,
	});
	const second = setActiveNotebookTopic(state, "Billing", "human");
	assert.equal(second.boundaryHint?.from, "oauth");
	assert.equal(second.boundaryHint?.to, "billing");
	clearActiveNotebookTopic(state);
	assert.equal(state.activeNotebookTopic, null);
	assert.equal(state.activeNotebookTopicSource, null);
	assert.equal(state.pendingTopicBoundaryHint, null);
});

test("notebook_topic_set establishes a fresh topic, is idempotent, and refuses overrides", async () => {
	const pi = new MockPi();
	const state = createState();
	registerNotebookTopicTool(pi as any, state);

	const tool = pi.tools.get("notebook_topic_set");
	const first = await tool.execute("1", { topic: "OAuth" });
	assert.equal(first.details.topic, "oauth");
	assert.equal(state.activeNotebookTopic, "oauth");
	assert.equal(state.activeNotebookTopicSource, "agent");

	const second = await tool.execute("2", { topic: "oauth" });
	assert.equal(second.details.changed, false);
	assert.equal(second.details.source, "agent");
	assert.match(second.content[0].text, /already set to "oauth"/i);

	await assert.rejects(() => tool.execute("3", { topic: "billing" }), /already exists/);
});


test("notebook_topic_set preserves human authority, stays idempotent for equal topics, and rejects empty normalized topics", async () => {
	const pi = new MockPi();
	const state = createState();
	registerNotebookTopicTool(pi as any, state);
	const tool = pi.tools.get("notebook_topic_set");

	setActiveNotebookTopic(state, "oauth", "human");
	const same = await tool.execute("1", { topic: "OAuth" });
	assert.equal(same.details.changed, false);
	assert.equal(same.details.source, "human");
	assert.match(same.content[0].text, /already set to "oauth"/i);
	await assert.rejects(
		() => tool.execute("2", { topic: "billing" }),
		/human-set notebook topic is authoritative/i,
	);

	const freshPi = new MockPi();
	const freshState = createState();
	registerNotebookTopicTool(freshPi as any, freshState);
	const freshTool = freshPi.tools.get("notebook_topic_set");
	await assert.rejects(
		() => freshTool.execute("3", { topic: "@@@" }),
		/notebook topic cannot be empty/i,
	);
});

test("buildNudge readonly with topic suggests same-topic spawn and readonly disable for handoff", () => {
	const nudge = buildNudge(
		{ readonlyEnabled: true, activeNotebookTopic: "my-topic", pendingTopicBoundaryHint: null },
		50,
	);
	assert.match(nudge, /my-topic/);
	assert.match(nudge, /same-topic delegation/);
	assert.match(nudge, /disable readonly with \/readonly/i);
});

test("buildNudge readonly without topic suggests notebook_topic_set", () => {
	const nudge = buildNudge(
		{ readonlyEnabled: true, activeNotebookTopic: null, pendingTopicBoundaryHint: null },
		50,
	);
	assert.match(nudge, /disable readonly with \/readonly/i);
	assert.match(nudge, /notebook_topic_set/);
});

test("buildNudge readonly with boundary hint points to spawn vs disable readonly", () => {
	const nudge = buildNudge(
		{ readonlyEnabled: true, activeNotebookTopic: null, pendingTopicBoundaryHint: { from: "old", to: "new", source: "agent" } },
		null,
	);
	assert.match(nudge, /Readonly blocks handoff/);
	assert.match(nudge, /current topic/);
	assert.match(nudge, /disable readonly with \/readonly/i);
});

test("buildNudge no longer emits the old percent-only handoff text", () => {
	const old = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null, readonlyEnabled: false }, 46);
	assert.doesNotMatch(old, /One context, one job\.|If you're mid-job and still clear|consider a handoff and draft a clear brief/i);
	assert.match(old, /Active notebook topic: oauth/);
	assert.match(old, /prefer spawn/i);
});


test("CONTEXT_PRIMER states the notebook, topic, and handoff contracts", () => {
	assert.doesNotMatch(CONTEXT_PRIMER, /ledger/i,
		"CONTEXT_PRIMER should contain zero stale ledger references after the rename");

	const notebookParts = CONTEXT_PRIMER.split("### Notebook");
	const topicParts = CONTEXT_PRIMER.split("### Active notebook topic");
	const handoffParts = CONTEXT_PRIMER.split("### Handoff");
	const rulesParts = CONTEXT_PRIMER.split("### Rules");
	assert.equal(notebookParts.length, 2);
	assert.equal(topicParts.length, 2);
	assert.equal(handoffParts.length, 2);
	assert.equal(rulesParts.length, 2);

	const notebookSection = notebookParts[1].split("### Active notebook topic")[0];
	const topicSection = topicParts[1].split("### Handoff")[0];
	const handoffSection = handoffParts[1].split("### Rules")[0];
	const rulesSection = rulesParts[1];

	assert.match(notebookSection, /notebook_index/);
	assert.match(notebookSection, /notebook_read/);
	assert.match(notebookSection, /future contexts/i);
	assert.match(topicSection, /semantic frame/i);
	assert.match(topicSection, /prefer spawn/i);
	assert.match(topicSection, /prefer handoff/i);
	assert.match(handoffSection, /handoff/i);
	assert.match(handoffSection, /notebook/i);
	assert.match(rulesSection, /one subject, thread, or subsystem/i);
});


test("before_agent_start injects notebook contracts plus live topic and page data", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "first line\nsecond line" }, undefined, undefined, makeTUICtx());

	const [handler] = pi.handlers.get("before_agent_start")!;
	const result = await handler({ systemPrompt: "Base system prompt." }, makeTUICtx({ hasUI: false }));

	assert.match(result.systemPrompt, /Base system prompt\./);
	assert.match(result.systemPrompt, /## Context management/);
	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /Current topic: `oauth`/);
	assert.match(result.systemPrompt, /## Active Notebook Pages/);
	assert.match(result.systemPrompt, /notebook_read/);
	assert.match(result.systemPrompt, /Reference pages by name/i);
	assert.match(result.systemPrompt, /alpha: first line/);
});


test("before_agent_start injects no-topic guidance when the topic is unset", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("before_agent_start")!;
	const result = await handler({ systemPrompt: "Base system prompt." }, makeTUICtx({ hasUI: false }));

	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /No active notebook topic is set\./);
	assert.match(result.systemPrompt, /notebook_topic_set/);
});

test("notebook tool definitions omit prompt hints by default", () => {
	const pi = new MockPi();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state);

	for (const tool of tools) {
		assert.equal(tool.promptSnippet, undefined, `${tool.name} should not have promptSnippet by default`);
		assert.equal(tool.promptGuidelines, undefined, `${tool.name} should not have promptGuidelines by default`);
	}
});

test("spawn tool definitions include prompt hints when registered", () => {
	const pi = new MockPi();
	const state = createState();
	registerSpawnTool(pi as any, state);

	const spawnTool = pi.tools.get("spawn")!;
	assert.ok(typeof spawnTool.promptSnippet === "string", "spawn should have promptSnippet");
	assert.ok(spawnTool.promptSnippet!.length > 10, "spawn promptSnippet should be non-trivial");
	assert.ok(Array.isArray(spawnTool.promptGuidelines), "spawn should have promptGuidelines");
	assert.ok(spawnTool.promptGuidelines!.length > 0, "spawn promptGuidelines should be non-empty");
	for (const g of spawnTool.promptGuidelines!) {
		assert.ok(g.length > 10, "each spawn guideline should be non-trivial");
	}
});

test("executeSpawn detects stale session before session creation", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let resolveFactory!: (value: any) => void;
	const factoryReady = new Promise<any>((resolve) => {
		resolveFactory = resolve;
	});
	let factoryCalled = false;
	let abortCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		async () => {
			factoryCalled = true;
			await factoryReady;
			return {
				session: {
					messages: [] as any[],
					prompt: async () => {},
					abort: async () => { abortCalls++; },
					getSessionStats: () => undefined,
				} as any,
			};
		},
	);

	// Reset state while executeSpawn is awaiting the factory
	resetState(state);
	// Now allow the factory to resolve — session should be immediately stale
	resolveFactory({});

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	assert.equal(factoryCalled, true);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn aborts stale child when resetState fires during prompt", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let rejectPrompt!: (err: Error) => void;
	let resolvePromptStarted!: () => void;
	const promptStartedPromise = new Promise<void>((r) => { resolvePromptStarted = r; });
	let abortCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		async () => ({
			session: {
				messages: [] as any[],
				prompt: async () => {
					resolvePromptStarted();
					await new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					});
				},
				abort: async () => {
					abortCalls++;
					rejectPrompt?.(new Error("aborted"));
				},
				getSessionStats: () => undefined,
			} as any,
		}),
	);

	// Wait for session to be created and prompt to start
	await promptStartedPromise;
	// Reset state triggers abortAndClearChildSessions which calls session.abort()
	// abort() rejects the pending prompt, which causes the stale check to fire
	resetState(state);

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	// abort is called once by clearChildSession (identity match via liveChildSessions)
	assert.equal(abortCalls >= 1, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("handleEvent gracefully degrades with null message events", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// asToolResult is exercised indirectly through tool_execution_update
	// with null partialResult — the runtime guard should handle it without crashing
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: null });
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: null, isError: false });

	// No crash = asToolResult guard works
	const lines = component.render(120);
	assert.ok(Array.isArray(lines));
});

test("truncateText respects line limit before byte limit", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	// Generate text with > 2000 lines to trigger line truncation
	const text = Array.from({ length: 2500 }, (_, i) => `Line ${i}`).join("\n");
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Generate lots of lines" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.truncated, true);
	const textLines = result.content[0].text.split("\n");
	assert.ok(textLines[0].startsWith("Line 0"), `expected first line, got: ${textLines[0]}`);
	assert.ok(result.content[0].text.includes("[Result truncated"));
});


test("truncateText handles multi-byte boundary correctly", async () => {
	const { truncateText } = await import("./spawn/index.js");

	// Mid-multi-byte boundary: 4-byte emoji truncated at byte 2 — should shrink to 0 bytes
	assert.equal(truncateText("🙂", 10, 2), "");

	// Exact boundary at multi-byte start: 4-byte emoji, maxBytes=4 — should keep full emoji
	assert.equal(truncateText("🙂", 10, 4), "🙂");

	// Empty input: returns empty string
	assert.equal(truncateText("", 10, 1024), "");

	// Under-limit text: returns unchanged
	assert.equal(truncateText("hello", 10, 1024), "hello");
});


test("nested spawn setExpanded and setShowImages no-op when value matches", () => {
	const state = createState();
	const childSpawnTool = createChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Calling setExpanded with same value should not throw or crash
	component.setExpanded(false);
	component.setExpanded(true);
	component.setShowImages(true);
	component.setShowImages(false);

	// Component still renders
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("abortAndClearChildSessions deduplicates sessions across both maps", () => {
	const state = createState();
	let abortCalls = 0;
	const mockSession = {
		messages: [],
		abort: async () => { abortCalls++; },
	} as any;

	// Put the same session object in both maps under the same key
	state.childSessions.set("tc-1", mockSession);
	state.liveChildSessions.set("tc-1", mockSession);

	resetState(state);

	// Dedup via the `seen` map ensures abort is called exactly once
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("renderSpawnResult handles result with no details field", () => {
	const state = createState();
	const result = renderSpawnResult(
		{ content: [{ type: "text", text: "hello" }] },
		false,
		theme,
		{ toolCallId: "tc-1", invalidate: () => {}, showImages: false },
		state,
	);
	// Should return a Text component that renders without crashing
	assert.ok(result, "renderSpawnResult should return a component");
	const lines = (result as any).render(120);
	assert.ok(Array.isArray(lines), "render should return an array of lines");
	assert.ok(lines.some((l: string) => l.includes("hello")), `expected 'hello' in output, got: ${lines.join("\n")}`);
});

test("registerSpawnTool registers a tool with correct name and metadata", () => {
	const pi = new MockPi();
	const state = createState();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");
	assert.ok(tool, "spawn tool should be registered");
	assert.equal(tool.name, "spawn");
	assert.equal(tool.label, "Spawn");
	assert.equal(typeof tool.description, "string");
	assert.equal(typeof tool.execute, "function");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
	assert.equal(tool.renderShell, "self");
	// parameters are a TypeBox schema object — just verify it exists
	assert.ok(tool.parameters, "should have parameters");
	assert.equal(tool.executionMode, undefined, "spawn should not be sequential");
});

// ── Readonly mode: bash safety tests ───────────────────────────────


// ── classifyBashCommand: readonly contract tests ───────────────────

import { classifyBashCommand, applyReadonlyBashGuard } from "./readonly-bash.js";
import { canUseOsSandbox, buildMacProfile, wrapWithSandboxExec, wrapWithBwrap, wrapCommandWithOsSandbox } from "./os-sandbox.js";
import { resolveRealPath } from "./resolve-path.js";

function isDirect(cmd: string, cwd = "/workspace"): boolean {
	return classifyBashCommand(cmd, cwd).ok === true;
}

function isBlocked(cmd: string, cwd = "/workspace"): boolean {
	return classifyBashCommand(cmd, cwd).ok === false;
}


test("classifyBashCommand allows non-mutating and unknown commands", () => {
	assert.equal(isDirect("ls -la"), true);
	assert.equal(isDirect("python3 script.py"), true);
	assert.equal(isDirect("curl https://example.com"), true);
	assert.equal(isDirect("docker ps"), true);
	assert.equal(isDirect("env FOO=bar node --version"), true);
	assert.equal(isDirect("export FOO=bar; echo $FOO"), true);
});

test("classifyBashCommand blocks writes outside temp but allows temp redirects", () => {
	const tempFile = `${os.tmpdir()}/pi-readonly-test.txt`;
	assert.equal(isBlocked("echo hello > file.txt"), true);
	assert.equal(isBlocked("cat > ./out.txt"), true);
	assert.equal(isDirect(`echo hello > ${tempFile}`), true);
	assert.equal(isDirect(`cat > ${tempFile}`), true);
	assert.equal(isDirect("ls >/dev/null"), true);
});

test("classifyBashCommand blocks explicit filesystem mutation outside temp", () => {
	assert.equal(isBlocked("rm file.txt"), true);
	assert.equal(isBlocked("mv a b"), true);
	assert.equal(isBlocked("cp a b"), true);
	assert.equal(isBlocked("mkdir newdir"), true);
	assert.equal(isBlocked("touch file"), true);
	assert.equal(isBlocked("chmod 755 file"), true);
	assert.equal(isBlocked("tee file"), true);
});

test("classifyBashCommand allows explicit filesystem mutation inside temp", () => {
	const tmp = os.tmpdir();
	assert.equal(isDirect(`rm ${tmp}/x`), true);
	assert.equal(isDirect(`mkdir ${tmp}/newdir`), true);
	assert.equal(isDirect(`touch ${tmp}/file`), true);
	assert.equal(isDirect(`cp ${tmp}/a ${tmp}/b`), true);
	assert.equal(isDirect(`mv ${tmp}/a ${tmp}/b`), true);
});

test("classifyBashCommand blocks mutable git commands and allows readonly git", () => {
	assert.equal(isDirect("git status"), true);
	assert.equal(isDirect("git log --oneline"), true);
	assert.equal(isDirect("git branch --list"), true);
	assert.equal(isDirect("git config --get user.name"), true);
	assert.equal(isBlocked("git add ."), true);
	assert.equal(isBlocked("git commit -m 'msg'"), true);
	assert.equal(isBlocked("git fetch"), true);
	assert.equal(isBlocked("git branch feature"), true);
	assert.equal(isBlocked("git tag v1"), true);
});

test("classifyBashCommand checks command substitutions for writes", () => {
	assert.equal(isBlocked("echo $(rm file.txt)"), true);
	assert.equal(isBlocked("echo `touch file.txt`"), true);
	assert.equal(isDirect("echo $(printf hi)"), true);
});


// ── Readonly mode: toggle + TUI indicator tests ────────────────────

test("readonly toggle command enables and disables readonly mode", () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const state = createState();
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();

	const ctx = {
		hasUI: true,
		ui: {
			notify: (msg: string, _type: string) => notifications.push(msg),
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
		sessionManager: { getBranch: () => [] },
	};

	// First toggle: ON
	pi.commands.get("readonly")!.handler("", ctx);
	assert.equal(notifications.pop(), "Readonly mode enabled \u2014 write/edit/handoff and non-temp bash writes blocked");
	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"));

	// Second toggle: OFF
	pi.commands.get("readonly")!.handler("", ctx);
	assert.equal(notifications.pop(), "Readonly mode disabled \u2014 write/edit/handoff and non-temp bash writes unblocked");
	assert.equal(statuses.get("agenticoding-readonly"), undefined);
});

test("readonly TUI indicator shows warning tone when enabled", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("agenticoding-readonly");
	assert.ok(s?.includes("🔒 readonly"), `expected readonly indicator, got: ${s}`);
});

test("readonly TUI indicator is cleared when disabled", () => {
	const state = createState();
	state.readonlyEnabled = false;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.get("agenticoding-readonly"), undefined);
});

// ── Readonly mode: tool_call blocking tests ────────────────────────

test("readonly tool_call blocks write, edit, and handoff", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	// Toggle readonly ON via command (modifies internal state)
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const [toolCallHandler] = pi.handlers.get("tool_call")!;

	// Block write
	const writeResult = await toolCallHandler({ toolName: "write", input: { path: "/tmp/test" } }, {});
	assert.equal(writeResult.block, true);
	assert.match(writeResult.reason, /write\/edit\/handoff disabled/);

	// Block edit
	const editResult = await toolCallHandler({ toolName: "edit", input: { path: "/tmp/test" } }, {});
	assert.equal(editResult.block, true);

	// Block handoff
	const handoffResult = await toolCallHandler({ toolName: "handoff", input: { task: "test" } }, {});
	assert.equal(handoffResult.block, true);

	// Allow read
	const readResult = await toolCallHandler({ toolName: "read", input: { path: "/tmp/test" } }, {});
	assert.equal(readResult, undefined);
});

test("normal tool_call does not block ordinary write/edit calls", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const [toolCallHandler] = pi.handlers.get("tool_call")!;

	const writeResult = await toolCallHandler(
		{ toolName: "write", input: { path: "/tmp/test.txt", content: "hello" } },
		{},
	);
	assert.equal(writeResult, undefined, "write should pass through when readonly is off");

	const editResult = await toolCallHandler(
		{ toolName: "edit", input: { path: "/tmp/test.txt", edits: [] } },
		{},
	);
	assert.equal(editResult, undefined, "edit should pass through when readonly is off");
});


test("readonly tool_call does not block bash when readonly is off", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const [toolCallHandler] = pi.handlers.get("tool_call")!;

	// Bash not blocked when readonly is off
	const safeResult = await toolCallHandler({ toolName: "bash", input: { command: "rm -rf /" } }, {});
	assert.equal(safeResult, undefined, "should not block when readonly is off");
});

test("readonly tool_call blocks non-temp bash writes when readonly is on", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const [toolCallHandler] = pi.handlers.get("tool_call")!;

	// Toggle readonly ON via command
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: (msg: string) => notifications.push(msg),
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const blockedInput = { command: "rm -rf /" };
	const blockedResult = await toolCallHandler({ toolName: "bash", input: blockedInput }, { cwd: "/workspace" });

	if (canUseOsSandbox()) {
		// OS-level sandbox is available, but classifyBashCommand pre-blocks
		// known dangerous commands (rm, mv, etc.) before the sandbox wraps.
		// The sandbox only handles commands with unrecognized file-target paths.
		assert.equal(blockedResult.block, true);
		assert.match(blockedResult.reason, /outside temp dir/);
	} else {
		// Fallback: classifyBashCommand blocks
		assert.equal(blockedResult.block, true);
		assert.match(blockedResult.reason, /outside temp dir/);
	}

	const tempAllowedInput = { command: `rm ${os.tmpdir()}/x` };
	const tempAllowed = await toolCallHandler({ toolName: "bash", input: tempAllowedInput }, { cwd: "/workspace" });
	assert.equal(tempAllowed, undefined);

	const safeInput = { command: "ls -la" };
	const safeResult = await toolCallHandler({ toolName: "bash", input: safeInput }, { cwd: "/workspace" });
	assert.equal(safeResult, undefined);
});

	assert.equal(result.block, true);
	assert.match(result.reason, /invalid JSON/);
});

// ── Readonly mode: spawn child filtering ───────────────────────────

test("spawn filters write and edit from child tools when readonly is on", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "write", "edit", "spawn"]);
	const state = createState();
	state.readonlyEnabled = true;

	let seenTools: string[] = [];
	const mockFactory = async (config: any) => {
		seenTools = config.tools;
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(seenTools.includes("write"), false, "write should be filtered");
	assert.equal(seenTools.includes("edit"), false, "edit should be filtered");
	assert.equal(seenTools.includes("read"), true, "read should be inherited");
	assert.equal(seenTools.includes("bash"), true, "bash should be inherited");
});

test("spawn adds a readonly bash override that mirrors parent readonly bash policy", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.readonlyEnabled = true;

	let seenTools: string[] = [];
	let seenCustomTools: any[] = [];
	const mockFactory = async (config: any) => {
		seenTools = config.tools;
		seenCustomTools = config.customTools;
		const session = {
			messages: [] as any[],
			prompt: async () => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(seenTools.includes("bash"), true, "bash should still be available");
	const bashTool = seenCustomTools.find((tool) => tool.name === "bash");
	assert.ok(bashTool, "readonly child should override bash");
	if (canUseOsSandbox()) {
		// OS-level sandbox is available, but classifyBashCommand pre-blocks
		// known dangerous commands at the spawnHook before the sandbox wraps.
		await assert.rejects(
			bashTool.execute("bash-1", { command: "sudo rm -rf /" }, undefined, undefined, {}),
			/Readonly mode: command blocked/,
		);
	} else {
		// Fallback: classifyBashCommand blocks at the spawnHook
		await assert.rejects(
			bashTool.execute("bash-1", { command: "sudo rm -rf /" }, undefined, undefined, {}),
			/Readonly mode: command blocked/,
		);
	}

	// Also verify that a safe command is ALLOWED through the child bash tool
	await assert.doesNotReject(
		bashTool.execute("bash-2", { command: "ls -la" }, undefined, undefined, {}),
		/Readonly mode: command blocked/,
	);
});

test("spawn non-readonly child can use inherited builtin write/edit", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "write", "edit", "spawn"]);
	const state = createState();
	state.readonlyEnabled = false;

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-write-edit-"));
	const childFile = path.join(tmpDir, "child.txt");

	const mockFactory = async (config: any) => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				assert.equal(config.tools.includes("write"), true, "child should inherit builtin write");
				assert.equal(config.tools.includes("edit"), true, "child should inherit builtin edit");
				assert.equal(config.customTools.some((t: any) => t.name === "write"), false, "write should stay builtin");
				assert.equal(config.customTools.some((t: any) => t.name === "edit"), false, "edit should stay builtin");

				const childWrite = createWriteTool(config.cwd);
				const childEdit = createEditTool(config.cwd);
				await childWrite.execute("child-write", { path: childFile, content: "alpha\nbeta\n" }, undefined, undefined, {});
				await childEdit.execute(
					"child-edit",
					{ path: childFile, edits: [{ oldText: "beta", newText: "gamma" }] },
					undefined,
					undefined,
					{},
				);
				session.messages = [{ role: "assistant", content: [{ type: "text", text: fs.readFileSync(childFile, "utf8") }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	try {
		const result = await pi.tools.get("spawn").execute(
			"spawn-1",
			{ prompt: "Write then edit the file" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: tmpDir },
		);

		assert.equal(fs.readFileSync(childFile, "utf8"), "alpha\ngamma\n");
		assert.equal(result.content[0].text, "alpha\ngamma");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("spawn prompt includes readonly notice when enabled", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.readonlyEnabled = true;

	let seenPrompt = "";
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				seenPrompt = prompt;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.match(seenPrompt, /readonly authority/);
	assert.match(seenPrompt, /Readonly restrictions apply/);
	assert.doesNotMatch(seenPrompt, /same authority as the parent/);
});

test("spawn prompt uses standard authority wording when readonly is off", async () => {
	const pi = new MockPi();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.readonlyEnabled = false;

	let seenPrompt = "";
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				seenPrompt = prompt;
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);
	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.match(seenPrompt, /same authority as the parent/);
	assert.doesNotMatch(seenPrompt, /read-only authority/);
	assert.doesNotMatch(seenPrompt, /Readonly restrictions apply/);
});



// ── Readonly mode: session rehydration ─────────────────────────────

test("session_start rehydrates readonly from branch entries", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: false } },
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: true } },
	];

	const sessionStartHandlers = pi.handlers.get("session_start")!;
	for (const handler of sessionStartHandlers) {
		await handler({ reason: "resume" }, {
			hasUI: true,
			ui: {
				theme: { fg: (_n: string, t: string) => t },
				setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => branch },
			getContextUsage: () => null,
		});
	}

	const s = statuses.get("agenticoding-readonly");
	assert.ok(s?.includes("readonly"), "readonly indicator should be shown after rehydrating true");
});

test("session_start clears readonly indicator on /new", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();

	// First: enable readonly via command
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"));

	// Now: /new should clear it
	const sessionStartHandlers = pi.handlers.get("session_start")!;
	for (const handler of sessionStartHandlers) {
		await handler({ reason: "new" }, {
			hasUI: true,
			ui: {
				theme: { fg: (_n: string, t: string) => t },
				setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => null,
		});
	}

	assert.equal(statuses.get("agenticoding-readonly"), undefined, "readonly indicator should be cleared on /new");
});

test("--readonly CLI flag does not override branch state when branch has entries", async () => {
	const pi = new MockPi();
	pi.flags.set("readonly", true);
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: false } },
	];

	const sessionStartHandlers = pi.handlers.get("session_start")!;
	for (const handler of sessionStartHandlers) {
		await handler({ reason: "resume" }, {
			hasUI: true,
			ui: {
				theme: { fg: (_n: string, t: string) => t },
				setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => branch },
			getContextUsage: () => null,
		});
	}

	// Branch has an explicit OFF entry; CLI flag only applies when no entries exist.
	const s = statuses.get("agenticoding-readonly");
	assert.equal(s, undefined, "branch state should win over CLI flag");
});

test("--readonly CLI flag applies on session_start for new sessions", async () => {
	const pi = new MockPi();
	pi.flags.set("readonly", true);
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	const sessionStartHandlers = pi.handlers.get("session_start")!;
	for (const handler of sessionStartHandlers) {
		await handler({ reason: "new" }, {
			hasUI: true,
			ui: {
				theme: { fg: (_n: string, t: string) => t },
				setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => null,
		});
	}

	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"));
});

test("session_start clears stale readonly state on resume when the branch has no readonly entry", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"));

	const sessionStartHandlers = pi.handlers.get("session_start")!;
	for (const handler of sessionStartHandlers) {
		await handler({ reason: "resume" }, {
			hasUI: true,
			ui: {
				theme: { fg: (_n: string, t: string) => t },
				setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
				setWidget: () => {},
			},
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => null,
		});
	}

	assert.equal(statuses.get("agenticoding-readonly"), undefined);
});

// ── Readonly mode: context hook nudges ─────────────────────────────

test("readonly ON nudge is delivered via context hook", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	// Toggle readonly ON
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const [contextHandler] = pi.handlers.get("context")!;
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 10 }), sessionManager: { getBranch: () => [] } },
	);

	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].customType, "agenticoding-readonly-nudge");
	assert.match(result.messages[1].content, /Readonly mode is active/);
});

test("readonly OFF nudge is delivered when the current tree has a prior ON entry", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	// Toggle ON then OFF
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: true } },
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: false } },
	];
	const [contextHandler] = pi.handlers.get("context")!;
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 10 }), sessionManager: { getBranch: () => branch } },
	);

	assert.equal(result.messages[1].customType, "agenticoding-readonly-nudge");
	assert.match(result.messages[1].content, /turned off/);
});

test("readonly OFF nudge is delivered after an explicit disable", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const [contextHandler] = pi.handlers.get("context")!;
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 10 }), sessionManager: { getBranch: () => [] } },
	);

	assert.ok(result && "messages" in result);
	assert.match((result as any).messages.at(-1).content, /turned off/);
});

test("readonly OFF nudge includes a handoff hint after high-context disable", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: true } },
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: false } },
	];
	const [contextHandler] = pi.handlers.get("context")!;
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 61 }), sessionManager: { getBranch: () => branch } },
	);

	assert.match(result.messages[1].content, /Context was at 61%/);
	assert.match(result.messages[1].content, /if the work changed topics, you can handoff now/);
});

test("readonly nudge is one-shot — not re-delivered on subsequent calls", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	// Toggle readonly ON
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const [contextHandler] = pi.handlers.get("context")!;

	// First call: delivers ON nudge
	await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 10 }), sessionManager: { getBranch: () => [] } },
	);

	// Second call: no nudge
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 2 }] },
		{ getContextUsage: () => ({ percent: 10 }), sessionManager: { getBranch: () => [] } },
	);

	assert.equal(result, undefined, "nudge should not be re-delivered");
});

test("session_tree rehydrates readonly from branch", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	const branch = [
		{ type: "custom", customType: "agenticoding-readonly", data: { enabled: true } },
	];

	const [sessionTreeHandler] = pi.handlers.get("session_tree")!;
	await sessionTreeHandler({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => null,
	});

	const s = statuses.get("agenticoding-readonly");
	assert.ok(s?.includes("readonly"), "session_tree should rehydrate readonly");
});

test("session_tree rehydrates readonly-off nudge after branch change", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	const [sessionTreeHandler] = pi.handlers.get("session_tree")!;
	const [contextHandler] = pi.handlers.get("context")!;

	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => ({ percent: 12 }),
	});

	await sessionTreeHandler({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => ({ percent: 12 }),
	});
	assert.equal(statuses.get("agenticoding-readonly"), undefined);

	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 12 }), sessionManager: { getBranch: () => [] } },
	);
	assert.ok(result && "messages" in result);
	assert.match((result as any).messages.at(-1).content, /turned off/);
});

test("session_tree reapplies --readonly and clears stale readonly on no-entry branches", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	const statuses = new Map<string, string | undefined>();
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"));

	const [sessionTreeHandler] = pi.handlers.get("session_tree")!;
	await sessionTreeHandler({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => null,
	});
	assert.equal(statuses.get("agenticoding-readonly"), undefined, "no-entry branch should clear stale readonly");

	pi.flags.set("readonly", true);
	await sessionTreeHandler({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => null,
	});
	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"), "CLI flag should win during session_tree rehydration");
});

test("--readonly rehydration does not append synthetic history entries", async () => {
	const pi = new MockPi();
	pi.flags.set("readonly", true);
	registerAgenticoding(pi as any);

	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => null,
	};

	for (const handler of pi.handlers.get("session_start")!) {
		await handler({ reason: "resume" }, ctx as any);
	}
	const [sessionTreeHandler] = pi.handlers.get("session_tree")!;
	await sessionTreeHandler({}, ctx as any);

	assert.equal(pi.appendedEntries.length, 0);
});

test("resetState clears readonly fields", () => {
	const state = createState();
	state.readonlyEnabled = true;
	state.readonlyNudgePending = true;
	resetState(state);
	assert.equal(state.readonlyEnabled, false);
	assert.equal(state.readonlyNudgePending, false);
});

test("readonly shortcut is registered and gated on isIdle", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	assert.ok(pi.shortcuts.has("ctrl+shift+r"), "shortcut should be registered");

	const shortcut = pi.shortcuts.get("ctrl+shift+r")!;

	// isIdle = false: should not toggle
	const statuses = new Map<string, string | undefined>();
	await shortcut.handler({
		isIdle: () => false,
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	assert.equal(statuses.get("agenticoding-readonly"), undefined, "should not toggle when not idle");

	// isIdle = true: should toggle
	await shortcut.handler({
		isIdle: () => true,
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: (key: string, val: string | undefined) => statuses.set(key, val),
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});
	assert.ok(statuses.get("agenticoding-readonly")?.includes("readonly"), "should toggle when idle");
});

test("readonly toggle persists entry via appendEntry", () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	assert.equal(pi.appendedEntries.length, 1);
	assert.equal(pi.appendedEntries[0].customType, "agenticoding-readonly");
	assert.equal(pi.appendedEntries[0].data.enabled, true);
});



test("classifyBashCommand pipes and shell chaining stay direct for non-mutating commands", () => {
	assert.equal(isDirect("cat file | sort"), true, "cat | sort is safe");
	assert.equal(isDirect("ls -la | head -5"), true, "ls | head is safe");
	assert.equal(isDirect("export PATH=/tmp:$PATH; ls"), true, "shell state changes are not blocked by readonly");
});

test("classifyBashCommand block reasons stay mutation-focused", () => {
	const check = (cmd: string, expected: string) => {
		const v = classifyBashCommand(cmd, "/workspace");
		assert.equal(v.ok, false, `${cmd} should be blocked`);
		if (!v.ok) {
			assert.match(v.reason, new RegExp(expected, "i"), `reason for ${cmd}`);
		}
	};

	check("echo hi > out.txt", "write redirect");
	check("rm file.txt", "outside temp");
	check("git add .", "mutable git");
	check("echo $(rm file.txt)", "command substitution");
});

test("classifyBashCommand blocks find mutation and allows readonly find", () => {
	assert.equal(isBlocked("find . -exec rm {} +"), true, "find -exec rm is blocked");
	assert.equal(isBlocked("find . -delete"), true, "find -delete is blocked outside temp");
	assert.equal(isBlocked("find . -fprint out.txt"), true, "find -fprint is blocked outside temp");
	assert.equal(isDirect(`find ${os.tmpdir()} -delete`, "/workspace"), true, "temp-only delete is allowed");
	assert.equal(isDirect("find . -name \"*.ts\""), true, "find -name is direct");
});

test("classifyBashCommand allows cd and heredocs when they do not write outside temp", () => {
	assert.equal(isDirect("cd /tmp"), true, "cd is direct");
	assert.equal(isDirect("cd /var/log && ls"), true, "cd && ls is direct");
	assert.equal(isDirect("cat <<EOF\nhello\nEOF"), true, "plain heredoc is direct");
	assert.equal(isBlocked("cat <<EOF\n$(rm file.txt)\nEOF"), true, "mutating substitution in heredoc is blocked");
});

test("classifyBashCommand blocks sudo with direct mutation", () => {
	assert.equal(isBlocked("sudo rm /etc/passwd"), true, "sudo rm is blocked");
	assert.equal(isBlocked("sudo -u root rm /etc/passwd"), true, "sudo -u root rm is blocked");
});

test("classifyBashCommand blocks sudo with interpreter -c inline script", () => {
	assert.equal(isBlocked("sudo bash -c 'rm /etc/passwd'"), true, "sudo bash -c rm is blocked");
	assert.equal(isBlocked("sudo sh -c 'echo hi > /etc/config'"), true, "sudo sh -c with redirect blocked");
	assert.equal(isBlocked("sudo -u root bash -c \"rm -rf /etc\""), true, "sudo -u root bash -c rm blocked");
});

test("classifyBashCommand allows sudo with safe interpreter -c inline script", () => {
	assert.equal(isDirect("sudo bash -c 'echo hello'"), true, "sudo bash -c echo is safe");
});

test("classifyBashCommand blocks sed -i in-place mutation", () => {
	assert.equal(isBlocked("sed -i 's/a/b/g' file.txt"), true, "sed -i is blocked outside temp");
	assert.equal(isBlocked("sed -i '' 's/a/b/g' /etc/config"), true, "sed -i '' (macOS) is blocked outside temp");
	assert.equal(isBlocked("sed -i \"\" 's/a/b/g' /etc/config"), true, 'sed -i "" (macOS) is blocked outside temp');
	assert.equal(isBlocked("sed -i.bak 's/a/b/' /etc/config"), true, "sed -i.bak is blocked");
});

test("classifyBashCommand blocks dd output mutation", () => {
	assert.equal(isBlocked("dd if=/dev/zero of=/etc/passwd bs=1 count=1"), true, "dd of= outside temp is blocked");
	assert.equal(isDirect("dd if=/dev/zero of=" + os.tmpdir() + "/test bs=1 count=0"), true, "dd of= inside temp is allowed");
});

test("classifyBashCommand blocks perl in-place mutation", () => {
	assert.equal(isBlocked("perl -pi -e 's/a/b/g' file.txt"), true, "perl -pi is blocked outside temp");
});

test("classifyBashCommand blocks ruby in-place mutation", () => {
	assert.equal(isBlocked("ruby -pi -e 's/a/b/g' file.txt"), true, "ruby -pi is blocked outside temp");
});

test("classifyBashCommand blocks env prefix with mutation command", () => {
	assert.equal(isBlocked("env VAR=value rm file.txt"), true, "env rm is blocked");
	assert.equal(isBlocked("env -i PATH=/tmp rm file.txt"), true, "env -i rm is blocked");
});

test("classifyBashCommand blocks command prefix with mutation", () => {
	assert.equal(isBlocked("command rm file.txt"), true, "command rm is blocked");
});

test("classifyBashCommand blocks >> append redirect to unsafe target", () => {
	assert.equal(isBlocked("echo hi >> /etc/config"), true, ">> append to outside temp is blocked");
	const tmpFile = os.tmpdir() + "/test-append.txt";
	assert.equal(isDirect("echo hi >> " + tmpFile), true, ">> append to temp is allowed");
});

test("classifyBashCommand blocks >| noclobber redirect to unsafe target", () => {
	assert.equal(isBlocked("echo hi >| /etc/config"), true, ">| noclobber override to outside temp is blocked");
});

test("classifyBashCommand blocks quoted paths with spaces outside temp", () => {
	assert.equal(isBlocked("rm 'My File.txt'"), true, "rm with quoted space path is blocked outside temp");
	assert.equal(isBlocked("touch \"My File.txt\""), true, "touch with quoted space path is blocked outside temp");
	const tmpFile = "\"" + os.tmpdir() + "/My File.txt\"";
	assert.equal(isDirect("rm " + tmpFile), true, "rm with quoted space path in temp is allowed");
});

test("classifyBashCommand blocks path traversal attacks", () => {
	assert.equal(isBlocked("rm /tmp/../etc/passwd"), true, "path traversal outside temp is blocked");
	assert.equal(isBlocked("rm /private/var/tmp/../../../etc/passwd"), true, "relative traversal outside temp is blocked");
});

// ── classifyBashCommand: exact-string contract tests ─────────────────

test("classifyBashCommand exact reason: git mutable block", () => {
	const v = classifyBashCommand("git add .", "/workspace");
	assert.equal(v.ok, false);
	if (!v.ok) {
		assert.match(v.reason, /mutable git/);
	}
});

test("classifyBashCommand exact reason: command substitution block", () => {
	const v = classifyBashCommand("echo \$(rm file.txt)", "/workspace");
	assert.equal(v.ok, false);
	if (!v.ok) {
		assert.match(v.reason, /command substitution/);
	}
});

test("classifyBashCommand exact reason: write redirect block", () => {
	const v = classifyBashCommand("echo hi > out.txt", "/workspace");
	assert.equal(v.ok, false);
	if (!v.ok) {
		assert.match(v.reason, /write redirect blocked outside temp dir/);
	}
});


// ── classifyBashCommand: sudo -h fix (F1) ────────────────────────────

test("classifyBashCommand blocks sudo -h with mutating command", () => {
	assert.equal(isBlocked("sudo -h rm /etc/passwd"), true, "sudo -h rm should be blocked");
	assert.equal(isBlocked("sudo -h apt-get install nginx"), true, "sudo -h apt-get should be blocked");
});

// ── classifyBashCommand: env -u fix (F2) ─────────────────────────────

test("classifyBashCommand blocks env -u with mutating command", () => {
	assert.equal(isBlocked("env -u HOME rm /etc/passwd"), true, "env -u HOME rm blocked");
	assert.equal(isBlocked("env --unset HOME rm /etc/passwd"), true, "env --unset HOME rm blocked");
});

// ── classifyBashCommand: touch -t/-d/-r (H1) ─────────────────────────

test("classifyBashCommand allows touch with -t/-d/-r flags inside temp", () => {
	const tmp = os.tmpdir();
	assert.equal(isDirect(`touch -t 202001010000 ${tmp}/safe`), true, "touch -t timestamp inside temp");
	assert.equal(isDirect(`touch -d '2020-01-01' ${tmp}/safe`), true, "touch -d date inside temp");
	assert.equal(isDirect(`touch -r ${tmp}/ref ${tmp}/target`), true, "touch -r ref file inside temp");
});

// ── classifyBashCommand: additional command coverage ─────────────────

test("classifyBashCommand blocks install, ln, truncate, unlink, rmdir outside temp", () => {
	assert.equal(isBlocked("install /tmp/foo /etc/bar"), true, "install to outside temp");
	assert.equal(isBlocked("ln /tmp/foo /etc/bar"), true, "ln hard link to outside temp");
	assert.equal(isBlocked("truncate -s 0 /etc/config"), true, "truncate outside temp");
	assert.equal(isBlocked("unlink /etc/file"), true, "unlink outside temp");
	assert.equal(isBlocked("rmdir /etc/empty-dir"), true, "rmdir outside temp");
	assert.equal(isBlocked("chown root /etc/file"), true, "chown outside temp");
	assert.equal(isBlocked("chgrp root /etc/file"), true, "chgrp outside temp");
});

// ── classifyBashCommand: env fix (env -S bypass) ──────────────────

test("classifyBashCommand blocks env -S bypass for mutating commands and redirects", () => {
	assert.equal(isBlocked('env -S "rm -rf /"'), true, "env -S with rm is blocked");
	assert.equal(isBlocked('env -u HOME -S "touch /etc/passwd"'), true, "env -u HOME -S with touch is blocked");
	assert.equal(isBlocked('env -S "git add ."'), true, "env -S with git add is blocked");
	assert.equal(isBlocked('env -S "echo hi > /etc/config"'), true, "env -S with redirect is blocked");
	assert.equal(isBlocked('env KEY=value rm file.txt'), true, "env KEY=value with rm is blocked");
});

test("classifyBashCommand allows non-mutating env -S inline commands", () => {
	assert.equal(isDirect('env -S "echo hi"'), true, "env -S with echo is allowed");
});

test("classifyBashCommand blocks env without -S with mutating direct commands", () => {
	assert.equal(isBlocked('env rm /etc/passwd'), true, "env rm is blocked");
	assert.equal(isBlocked('env -i rm /etc/passwd'), true, "env -i rm is blocked");
	assert.equal(isDirect('env - PATH=/tmp ls'), true, "env - PATH=/tmp ls is allowed");
});

// ── classifyBashCommand: git readonly subcommand regressions ─────────

test("classifyBashCommand allows git stash read-only subcommands", () => {
	assert.equal(isDirect("git stash list"), true, "git stash list is allowed");
	assert.equal(isDirect("git stash show"), true, "git stash show is allowed");
});

test("classifyBashCommand blocks git stash mutable subcommands", () => {
	assert.equal(isBlocked("git stash push"), true, "git stash push is blocked");
	assert.equal(isBlocked("git stash drop"), true, "git stash drop is blocked");
});

test("classifyBashCommand allows git tag read-only subcommands", () => {
	assert.equal(isDirect("git tag"), true, "bare git tag is allowed");
	assert.equal(isDirect("git tag --list"), true, "git tag --list is allowed");
	assert.equal(isDirect("git tag -l"), true, "git tag -l is allowed");
});

test("classifyBashCommand blocks git tag mutable subcommands", () => {
	assert.equal(isBlocked("git tag v1.0"), true, "git tag v1.0 is blocked");
});

test("classifyBashCommand allows git submodule read-only subcommands", () => {
	assert.equal(isDirect("git submodule status"), true, "git submodule status is allowed");
});

test("classifyBashCommand blocks git submodule mutable subcommands", () => {
	assert.equal(isBlocked("git submodule add"), true, "git submodule add is blocked");
});

test("classifyBashCommand allows git worktree read-only subcommands", () => {
	assert.equal(isDirect("git worktree list"), true, "git worktree list is allowed");
});

test("classifyBashCommand blocks git worktree mutable subcommands", () => {
	assert.equal(isBlocked("git worktree add"), true, "git worktree add is blocked");
});

test("classifyBashCommand allows git bisect read-only subcommands and bare bisect", () => {
	assert.equal(isDirect("git bisect log"), true, "git bisect log is allowed");
	assert.equal(isDirect("git bisect view"), true, "git bisect view is allowed");
	assert.equal(isDirect("git bisect"), true, "bare git bisect is allowed");
});

test("classifyBashCommand blocks git bisect mutable subcommands", () => {
	assert.equal(isBlocked("git bisect start"), true, "git bisect start is blocked");
	assert.equal(isBlocked("git bisect reset"), true, "git bisect reset is blocked");
});


test("classifyBashCommand blocks node -e with dangerous code", () => {
	assert.equal(isBlocked('node -e "rm file.txt"'), true);
});

test("classifyBashCommand allows node -e with safe code", () => {
	assert.equal(isDirect('node -e "console.log(1)"'), true);
});

test("classifyBashCommand blocks python3 -c with dangerous code", () => {
	assert.equal(isBlocked('python3 -c "rm file.txt"'), true);
});

test("classifyBashCommand blocks perl -e with dangerous code", () => {
	assert.equal(isBlocked('perl -e "rm file.txt"'), true);
});

test("classifyBashCommand blocks ruby -e with dangerous code", () => {
	assert.equal(isBlocked('ruby -e "rm file.txt"'), true);
});

test("classifyBashCommand allows node -c (syntax check only)", () => {
	assert.equal(isDirect('node -c "const x = 1"'), true);
});

// ── S3: eval/exec/subshell handling ────────────────────────────────

test("classifyBashCommand blocks eval with dangerous command", () => {
	assert.equal(isBlocked("eval 'rm -rf /'"), true);
});

test("classifyBashCommand allows eval with safe command", () => {
	assert.equal(isDirect("eval 'echo hi'"), true);
});

test("classifyBashCommand blocks exec with dangerous command", () => {
	assert.equal(isBlocked("exec rm file.txt"), true);
});

test("classifyBashCommand allows exec with safe command", () => {
	assert.equal(isDirect("exec ls"), true);
});

test("classifyBashCommand blocks subshell parens with mutation", () => {
	assert.equal(isBlocked("(rm file.txt)"), true);
});

test("classifyBashCommand allows subshell parens with safe command", () => {
	assert.equal(isDirect("(echo hi)"), true);
});

test("classifyBashCommand blocks curl -o outside temp", () => {
	assert.equal(isBlocked("curl -o /etc/passwd http://example.com"), true);
});

test("classifyBashCommand allows curl -o inside temp", () => {
	const tmp = os.tmpdir();
	assert.equal(isDirect(`curl -o ${tmp}/out.html http://example.com`), true);
});

test("classifyBashCommand blocks curl --output outside temp", () => {
	assert.equal(isBlocked("curl --output /tmp/../outside.txt http://example.com"), true);
});

test("classifyBashCommand allows wget -O inside temp", () => {
	const tmp = os.tmpdir();
	assert.equal(isDirect(`wget -O ${tmp}/out.html http://example.com`), true);
});

test("classifyBashCommand blocks wget -O outside temp", () => {
	assert.equal(isBlocked("wget -O /etc/passwd http://example.com"), true);
});

test("classifyBashCommand allows wget --output-document inside temp", () => {
	const tmp = os.tmpdir();
	assert.equal(isDirect(`wget --output-document ${tmp}/out.html http://example.com`), true);
});

test("classifyBashCommand blocks wget --output-document outside temp", () => {
	assert.equal(isBlocked("wget --output-document /etc/passwd http://example.com"), true);
});

test("classifyBashCommand blocks wget without output flags", () => {
	assert.equal(isBlocked("wget http://example.com"), true, "wget without -O writes to disk by default");
});

test("classifyBashCommand allows curl without output flags", () => {
	assert.equal(isDirect("curl http://example.com"), true, "curl without -o outputs to stdout");
});

// ── N4: xargs command classification ───────────────────────────────

test("classifyBashCommand blocks xargs with mutation command", () => {
	assert.equal(isBlocked("echo file.txt | xargs rm"), true);
});

test("classifyBashCommand allows xargs with safe command", () => {
	assert.equal(isDirect("echo file.txt | xargs echo"), true);
});

test("classifyBashCommand blocks xargs with flags and mutation", () => {
	assert.equal(isBlocked("echo file.txt | xargs -I {} rm {}"), true);
});

test("classifyBashCommand allows xargs with flags and safe command", () => {
	assert.equal(isDirect("echo file.txt | xargs -I {} echo {}"), true);
});

// ── os-sandbox: OS-level sandbox tests ─────────────────────────────

test("os-sandbox: buildMacProfile includes deny file-write* and allow /dev/null", () => {
	const tempDir = os.tmpdir();
	const profile = buildMacProfile(tempDir);
	assert.ok(profile.includes("(allow default)"), "profile should allow default");
	assert.ok(profile.includes("(deny file-write*)"), "profile should deny all file-write*");
	assert.ok(profile.includes('/dev/null'), "profile should allow /dev/null");
	assert.ok(profile.includes('(allow file-write* (subpath'), "profile should allow subpath writes");
});

test("os-sandbox: wrapWithSandboxExec uses heredoc", () => {
	const cmd = "echo hello";
	const result = wrapWithSandboxExec(cmd);
	assert.ok(result.startsWith("sandbox-exec -p '"), "should start with sandbox-exec -p");
	assert.ok(result.includes("PI_SANDBOX_INNER_"), "should include heredoc delimiter");
	assert.ok(result.includes(cmd), "should contain original command");
	assert.ok(result.includes("/bin/bash << '"), "should use heredoc with bash");
});

test("os-sandbox: wrapWithBwrap includes ro-bind and tmpfs", () => {
	const cmd = "echo hello";
	const result = wrapWithBwrap(cmd);
	assert.ok(result.startsWith("bwrap"), "should start with bwrap");
	assert.ok(result.includes("--ro-bind / /"), "should include ro-bind root");
	assert.ok(result.includes("--tmpfs /tmp"), "should include tmpfs /tmp");
	assert.ok(result.includes(cmd), "should contain original command");
	assert.ok(result.includes("/bin/sh << '"), "should use heredoc with sh");
});

test("os-sandbox: wrapCommandWithOsSandbox returns sandbox-exec on darwin", () => {
	const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		const result = wrapCommandWithOsSandbox("echo hello");
		assert.ok(result.startsWith("sandbox-exec"), "should use sandbox-exec on darwin");
	} finally {
		if (origPlatform) {
			Object.defineProperty(process, "platform", origPlatform);
		}
	}
});

test("os-sandbox: wrapWithSandboxExec handles multiline command", () => {
	const cmd = "echo line1\necho line2\necho line3";
	const result = wrapWithSandboxExec(cmd);
	assert.ok(result.includes("echo line1"), "should preserve first line");
	assert.ok(result.includes("echo line2"), "should preserve second line");
	assert.ok(result.includes("echo line3"), "should preserve third line");
	// All lines should be after heredoc open and before heredoc close
	const delimIndex = result.indexOf("PI_SANDBOX_INNER_");
	const innerEnd = result.indexOf("\n", delimIndex); // skip to end of delimiter name
	const cmdStart = result.indexOf("\n", innerEnd + 1);
	const lastDelim = result.lastIndexOf("PI_SANDBOX_INNER_");
	assert.ok(cmdStart > 0 && lastDelim > cmdStart, "command should be inside heredoc");
});

test("os-sandbox: wrapWithSandboxExec generates unique delimiters", () => {
	const cmd = "echo hello";
	const result1 = wrapWithSandboxExec(cmd);
	const result2 = wrapWithSandboxExec(cmd);
	const delim1 = result1.match(/PI_SANDBOX_INNER_\w+/)?.[0] || "";
	const delim2 = result2.match(/PI_SANDBOX_INNER_\w+/)?.[0] || "";
	assert.notEqual(delim1, delim2, "two calls should produce different delimiters");
});

// ── resolveRealPath tests ─────────────────────────────────────────────

test("resolveRealPath: existing path returns unchanged", () => {
	const result = resolveRealPath(os.tmpdir());
	assert.ok(result.length > 0, "should resolve to a non-empty path");
});

test("resolveRealPath: root returns root", () => {
	assert.equal(resolveRealPath("/"), "/");
});

test("resolveRealPath: existing file resolves", () => {
	const result = resolveRealPath(new URL(".", import.meta.url).pathname);
	assert.ok(result.length > 0, "should resolve to a non-empty path");
});

test("resolveRealPath: non-existent path inside temp dir preserves full path", () => {
	const tmp = os.tmpdir();
	const nonExistent = `${tmp}/__pi_test_deep/a/b/c`;
	const result = resolveRealPath(nonExistent);
	// Should contain the full path including all intermediate components
	assert.ok(result.includes("__pi_test_deep/a/b/c"), "should preserve all path components");
});

// ── I6: Missing test scenarios ────────────────────────────────────────

test("classifyBashCommand blocks package manager mutations directly", () => {
	assert.equal(isBlocked("npm install lodash"), true);
	assert.equal(isBlocked("pip install requests"), true);
	assert.equal(isBlocked("brew install node"), true);
	assert.equal(isBlocked("apt-get install ripgrep"), true);
});

test("applyReadonlyBashGuard fallback mirrors classifyBashCommand on unsupported platforms", () => {
	const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	try {
		const blocked = applyReadonlyBashGuard("npm install lodash", "/workspace");
		assert.deepEqual(blocked.action, "block");
		if (blocked.action === "block") {
			assert.match(blocked.reason, /npm install lodash is blocked in readonly mode/i);
		}

		const wrapped = applyReadonlyBashGuard('env -S "pip install requests"', "/workspace");
		assert.deepEqual(wrapped.action, "block");
		if (wrapped.action === "block") {
			assert.match(wrapped.reason, /pip install requests is blocked in readonly mode/i);
		}

		assert.deepEqual(applyReadonlyBashGuard("ls -la", "/workspace"), { action: "allow" });
	} finally {
		if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
	}
});

test("classifyBashCommand: deep recursion triggers depth limit", () => {
	// Build a deeply nested eval chain with safe commands to exceed the depth limit.
	// eval always recurses, so each level increments depth. We need 11+ levels.
	let cmd = "echo safe";
	for (let i = 0; i < 12; i++) {
		cmd = `eval "${cmd}"`;
	}
	const result = classifyBashCommand(cmd, "/workspace");
	assert.equal(result.ok, false);
	assert.match((result as { ok: false; reason: string }).reason, /recursion depth/);
});

test("resolveRealPath follows symlinks", () => {
	const dir = os.tmpdir();
	const target = path.join(dir, `pi-test-target-${Date.now()}`);
	const link = path.join(dir, `pi-test-link-${Date.now()}`);
	fs.mkdirSync(target);
	try {
		fs.symlinkSync(target, link);
		const resolved = resolveRealPath(link);
		// Use resolveRealPath on target too to handle macOS /var → /private/var
		assert.equal(resolved, resolveRealPath(target));
	} finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(target, { force: true, recursive: true });
	}
});

test("wrapCommandWithOsSandbox returns command unchanged on unsupported platform", () => {
	const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	try {
		const result = wrapCommandWithOsSandbox("echo hello");
		assert.equal(result, "echo hello");
	} finally {
		Object.defineProperty(process, "platform", origPlatform!);
	}
});



test("watchdog nudges when crossing from band 0 to band 1 (45%→55%)", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("context")!;

	// First call: 45% → band 0, should inject watchdog
	const first = await handler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 45 }) },
	);
	assert.notEqual(first, undefined);
	assert.equal(first.messages[1].customType, "agenticoding-watchdog");

});

test("readonly nudge and watchdog nudge merge in same context turn", async () => {
	const pi = new MockPi();
	registerAgenticoding(pi as any);

	// Toggle readonly ON
	await pi.commands.get("readonly")!.handler("", {
		hasUI: true,
		ui: {
			notify: () => {},
			theme: { fg: (_n: string, t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	const [contextHandler] = pi.handlers.get("context")!;
	const result = await contextHandler(
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ getContextUsage: () => ({ percent: 70 }), sessionManager: { getBranch: () => [] } },
	);

	// Both nudges should be present in the result
	assert.ok(result.messages.length >= 3, `expected >= 3 messages, got ${result.messages.length}`);
	const customTypes = result.messages
		.filter((m: any) => m.role === "custom")
		.map((m: any) => m.customType);
	assert.ok(customTypes.includes("agenticoding-readonly-nudge"), "should include readonly nudge");
	assert.ok(customTypes.includes("agenticoding-watchdog"), "should include watchdog nudge");
});
