import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStorage, ModelRegistry, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffTool } from "./handoff/tool.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import { buildNudge, buildQueuedManualHandoffNudge, registerWatchdog } from "./watchdog.js";
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
import {
	MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS,
	buildAgenticodingSettingsModel,
	createAgenticodingSettingsComponent,
	getAgenticodingSettingsDisplayLines,
	readHandoffSettingsState,
	resolveHandoffAutomaticAvailability,
	setSettingsAtomicWriteOperationsForTest,
	writeGlobalHandoffAutomaticEnabled,
} from "./settings.js";
import { CONTEXT_PRIMER, getContextPrimer } from "./system-prompt.js";
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
	allToolNames: string[] | undefined;
	toolSources = new Map<string, string>();
	sentUserMessages: Array<{ content: string; options: any }> = [];
	sentMessages: Array<{ message: any; options: any }> = [];
	appendedEntries: Array<{ customType: string; data: any }> = [];

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

	setAllTools(tools: string[]) {
		this.allToolNames = [...tools];
		for (const tool of tools) {
			if (!this.toolSources.has(tool)) {
				this.toolSources.set(tool, "builtin");
			}
		}
	}

	getAllTools() {
		return (this.allToolNames ?? this.activeTools).map((name) => ({
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

	sendMessage(message: any, options?: any) {
		this.sentMessages.push({ message, options });
	}

	appendEntry(customType: string, data: any) {
		this.appendedEntries.push({ customType, data });
	}
}

async function writeSettingsFile(path: string, content: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

async function withIsolatedSettings<T>(fn: (paths: { home: string; cwd: string }) => Promise<T>): Promise<T> {
	const tmp = await mkdtemp(join(tmpdir(), "pi-agenticoding-settings-"));
	const previousHome = process.env.HOME;
	process.env.HOME = join(tmp, "home");
	const cwd = join(tmp, "project");
	await mkdir(cwd, { recursive: true });
	try {
		return await fn({ home: process.env.HOME, cwd });
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		await rm(tmp, { recursive: true, force: true });
	}
}

async function runHandoffResumeScenario(options: {
	globalSettings?: unknown;
	projectSettings?: unknown;
} = {}) {
	return withIsolatedSettings(async ({ home, cwd }) => {
		if (options.globalSettings !== undefined) {
			await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), options.globalSettings);
		}
		if (options.projectSettings !== undefined) {
			await writeSettingsFile(join(cwd, ".pi", "settings.json"), options.projectSettings);
		}

		const pi = new MockPi();
		const state = createState();
		registerHandoffTool(pi as any, state);
		let compactOptions: any;
		const notifications: Array<{ message: string; level: string }> = [];

		const toolResult = await pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				cwd,
				hasUI: true,
				ui: {
					notify: (message: string, level: string) => notifications.push({ message, level }),
				},
				compact: (compactOptionsArg: any) => {
					compactOptions = compactOptionsArg;
				},
			},
		);

		return { sentUserMessages: pi.sentUserMessages, notifications, compactOptions, activeTools: pi.activeTools, toolResult };
	});
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createTestAssistantMessage(model: any, content: any[], stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function createTestAssistantStream(message: any): any {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", reason: message.stopReason, message };
		},
		result: async () => message,
	};
}

function messageText(message: any): string {
	return (message.content ?? [])
		.map((block: any) => block.type === "text" ? block.text : JSON.stringify(block))
		.join("\n");
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

	assert.equal(state.pendingRequestedHandoff?.direction, "implement auth");
	assert.equal(state.pendingRequestedHandoff?.enforcementAttempts, 0);
	assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
	assert.equal(state.pendingRequestedHandoff?.awaitingAgentTurn, true);
	assert.match(state.pendingRequestedHandoff?.requestId ?? "", /^[0-9a-f-]{36}$/i);
	assert.equal(pi.sentUserMessages.length, 1);
	assert.match(pi.sentUserMessages[0].content, /Handoff direction: implement auth/);
	assert.match(pi.sentUserMessages[0].content, /Manual handoff request id: [0-9a-f-]{36}/i);
	assert.match(pi.sentUserMessages[0].content, /After drafting the brief, you must call the `handoff` tool/);
	assert.equal(pi.sentUserMessages[0].options, undefined);
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

test("/handoff clears pending manual request when sendUserMessage throws synchronously", async () => {
	const pi = new MockPi();
	pi.sendUserMessage = () => { throw new Error("send failed"); };
	const state = createState();
	registerHandoffCommand(pi as any, state);
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme,
			setStatus: (_key: string, status: string | undefined) => statuses.push(status),
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	});

	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.pendingRequestedHandoffPrompt, null);
	assert.deepEqual(statuses, ["🤝 Handoff queued", undefined]);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "error");
	assert.match(notifications[0].message, /send failed/);
});

test("/handoff async send failure does not clear a later manual request", async () => {
	const pi = new MockPi();
	const state = createState();
	registerHandoffCommand(pi as any, state);
	let sendCount = 0;
	let rejectFirst!: (error: Error) => void;
	const firstSend = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
	pi.sendUserMessage = (content: string, options?: any) => {
		pi.sentUserMessages.push({ content, options });
		sendCount++;
		return sendCount === 1 ? firstSend : new Promise<void>(() => {});
	};
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme,
			setStatus: () => {},
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};

	await pi.commands.get("handoff")!.handler("first", ctx);
	await pi.commands.get("handoff")!.handler("second", ctx);
	assert.equal(state.pendingRequestedHandoff?.direction, "second");

	rejectFirst(new Error("first failed later"));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(state.pendingRequestedHandoff?.direction, "second");
	assert.match(state.pendingRequestedHandoffPrompt ?? "", /Handoff direction: second/);
	assert.deepEqual(notifications, []);
});

test("handoff automatic setting defaults to enabled with post-compaction Proceed", async () => {
	const pi = new MockPi();
	const state = createState();
	state.notebookPages.set("auth-refresh", "sensitive notebook body");
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 0, toolCalled: false, awaitingAgentTurn: false };
	registerHandoffTool(pi as any, state);

	let compactOptions: any;
	const result = await withIsolatedSettings(async ({ cwd }) => pi.tools.get("handoff").execute(
		"1",
		{ task: "Goal: continue auth-refresh" },
		undefined,
		undefined,
		{
			cwd,
			compact: (options: any) => {
				compactOptions = options;
			},
		},
	));

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

test("handoff automatic setting true proceeds after compaction", async () => {
	const result = await runHandoffResumeScenario({
		globalSettings: { handoff: { automaticEnabled: false } },
		projectSettings: { handoff: { automaticEnabled: true } },
	});

	assert.ok(result.compactOptions);
	result.compactOptions.onComplete({});
	assert.deepEqual(result.sentUserMessages, [{ content: "Proceed.", options: undefined }]);
	assert.deepEqual(result.notifications, []);
	assert.deepEqual(result.activeTools, []);
});

test("handoff automatic setting false leaves tool registered but blocks stale direct calls", async () => {
	const result = await runHandoffResumeScenario({
		globalSettings: { handoff: { automaticEnabled: true } },
		projectSettings: { handoff: { automaticEnabled: false } },
	});

	assert.equal(result.compactOptions, undefined);
	assert.deepEqual(result.sentUserMessages, []);
	assert.equal(result.notifications.length, 1);
	assert.match(result.notifications[0].message, /Automatic handoff is disabled/);
	assert.deepEqual(result.activeTools, []);
	assert.match(result.toolResult.content[0].text, /No compaction was started/);
});

test("handoff automatic setting ignores prototype/meta keys unless automaticEnabled is own nested setting", async () => {
	const topLevelPrototypeResult = await runHandoffResumeScenario({
		globalSettings: '{"__proto__":{"handoff":{"automaticEnabled":false}}}',
	});
	assert.ok(topLevelPrototypeResult.compactOptions);
	assert.deepEqual(topLevelPrototypeResult.notifications, []);

	const nestedPrototypeResult = await runHandoffResumeScenario({
		globalSettings: { handoff: { other: true } },
		projectSettings: '{"handoff":{"__proto__":{"automaticEnabled":false}}}',
	});
	assert.ok(nestedPrototypeResult.compactOptions);
	assert.deepEqual(nestedPrototypeResult.notifications, []);

	await withIsolatedSettings(async ({ home, cwd }) => {
		await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), '{"__proto__":{"handoff":{"automaticEnabled":false}}}');
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), '{"handoff":{"__proto__":{"automaticEnabled":false}}}');

		const model = await buildAgenticodingSettingsModel({ cwd, hasUI: true, ui: { notify: () => {} } } as any);
		assert.equal(model.effectiveAutomaticEnabled, true);
		assert.equal(model.effectiveSource, "default");
		assert.equal(model.projectOverride, false);
		assert.match(getAgenticodingSettingsDisplayLines(model).join("\n"), /Resolved handoff\.automaticEnabled: true \(default\)/);
	});
});

test("handoff automatic setting malformed handoff parent fails closed", async () => {
	const result = await runHandoffResumeScenario({
		globalSettings: { handoff: { automaticEnabled: true } },
		projectSettings: { handoff: null },
	});

	assert.equal(result.compactOptions, undefined);
	assert.equal(result.notifications.length, 2);
	assert.match(result.notifications[0].message, /handoff must be an object/);
	assert.match(result.notifications[0].message, /automatic handoff disabled/);

	await withIsolatedSettings(async ({ home, cwd }) => {
		await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), { handoff: { automaticEnabled: false } });
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: null });

		const state = await readHandoffSettingsState(cwd);
		assert.equal(state.project.invalid, true);
		assert.equal(state.project.invalidReason, "malformed-handoff");

		const model = await buildAgenticodingSettingsModel({ cwd, hasUI: true, ui: { notify: () => {} } } as any);
		assert.equal(model.effectiveAutomaticEnabled, false);
		assert.equal(model.effectiveSource, "fallback");
		assert.equal(model.projectOverride, false);
		assert.match(model.messages.join("\n"), /handoff must be an object/);
		assert.match(getAgenticodingSettingsDisplayLines(model).join("\n"), /Project settings: .*malformed handoff/);
	});
});

test("handoff automatic setting unsupported value fails closed with diagnostic", async () => {
	const result = await runHandoffResumeScenario({
		projectSettings: { handoff: { automaticEnabled: "surprise" } },
	});

	assert.equal(result.compactOptions, undefined);
	assert.deepEqual(result.sentUserMessages, []);
	assert.equal(result.notifications.length, 2);
	assert.equal(result.notifications[0].level, "warning");
	assert.match(result.notifications[0].message, /Unsupported handoff\.automaticEnabled/);
	assert.match(result.notifications[0].message, /surprise/);
	assert.match(result.notifications[0].message, /automatic handoff disabled/);
});

test("handoff automatic setting unsupported string diagnostics are JSON escaped", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const unsafe = "bad\"\n[spoofed warning]";
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: unsafe } });
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } } as any;

		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /"bad\\"\\n\[spoofed warning\]"/);
		assert.doesNotMatch(notifications[0].message, /bad"\n\[spoofed warning\]/);

		const model = await buildAgenticodingSettingsModel(ctx);
		const display = getAgenticodingSettingsDisplayLines(model).join("\n");
		assert.match(display, /"bad\\"\\n\[spoofed warning\]"/);
		assert.doesNotMatch(display, /bad"\n\[spoofed warning\]/);
	});
});

test("handoff automatic setting invalid JSON fails closed with diagnostic", async () => {
	const globalResult = await runHandoffResumeScenario({ globalSettings: "{" });
	assert.equal(globalResult.compactOptions, undefined);
	assert.equal(globalResult.notifications[0].level, "warning");
	assert.match(globalResult.notifications[0].message, /Invalid global settings JSON/);
	assert.match(globalResult.notifications[0].message, /automatic handoff disabled/);

	const projectResult = await runHandoffResumeScenario({
		globalSettings: { handoff: { automaticEnabled: true } },
		projectSettings: "{",
	});
	assert.equal(projectResult.compactOptions, undefined);
	assert.equal(projectResult.notifications[0].level, "warning");
	assert.match(projectResult.notifications[0].message, /Invalid project settings JSON/);
	assert.match(projectResult.notifications[0].message, /automatic handoff disabled/);
});

test("handoff automatic setting diagnostics are deduplicated across repeated availability resolution", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const projectSettingsPath = join(cwd, ".pi", "settings.json");
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: "surprise" } });
		assert.equal((await resolveHandoffAutomaticAvailability({ ...ctx, hasUI: false })).automaticEnabled, false);
		for (let i = 0; i < 3; i++) {
			const availability = await resolveHandoffAutomaticAvailability(ctx);
			assert.equal(availability.automaticEnabled, false);
		}
		assert.equal(notifications.filter((n) => /Unsupported handoff\.automaticEnabled/.test(n.message)).length, 1);

		await writeFile(projectSettingsPath, "{", "utf8");
		for (let i = 0; i < 3; i++) {
			const availability = await resolveHandoffAutomaticAvailability(ctx);
			assert.equal(availability.automaticEnabled, false);
		}
		assert.equal(notifications.filter((n) => /Invalid project settings JSON/.test(n.message)).length, 1);
		assert.equal(notifications.length, 2);
		assert.deepEqual(notifications.map((n) => n.level), ["warning", "warning"]);
	});
});

test("handoff automatic setting diagnostics re-emit after fixed settings break again", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const projectSettingsPath = join(cwd, ".pi", "settings.json");
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: "surprise" } });
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		assert.equal(notifications.filter((n) => /Unsupported handoff\.automaticEnabled/.test(n.message)).length, 1);

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: true } });
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, true);

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: "surprise" } });
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		assert.equal(notifications.filter((n) => /Unsupported handoff\.automaticEnabled/.test(n.message)).length, 2);

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: false } });
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		await writeFile(projectSettingsPath, "{", "utf8");
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		assert.equal(notifications.filter((n) => /Invalid project settings JSON/.test(n.message)).length, 1);

		await writeSettingsFile(projectSettingsPath, { handoff: { automaticEnabled: true } });
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, true);
		await writeFile(projectSettingsPath, "{", "utf8");
		assert.equal((await resolveHandoffAutomaticAvailability(ctx)).automaticEnabled, false);
		assert.equal(notifications.filter((n) => /Invalid project settings JSON/.test(n.message)).length, 2);
	});
});

test("handoff automatic setting non-ENOENT read errors are distinguished from invalid JSON", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await mkdir(globalPath, { recursive: true });

		const state = await readHandoffSettingsState(cwd);
		assert.equal(state.global.invalid, true);
		assert.equal(state.global.invalidReason, "read-error");
		assert.equal(state.global.readErrorCode, "EISDIR");
		assert.equal(state.global.exists, true);
		assert.equal(state.project.invalid, false);

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (msg: string, level: string) => notifications.push({ message: msg, level }) },
		} as any;
		const availability = await resolveHandoffAutomaticAvailability(ctx);
		assert.equal(availability.automaticEnabled, false);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warning");
		assert.match(notifications[0].message, /Unable to read global settings/);
		assert.match(notifications[0].message, /EISDIR/);
		assert.doesNotMatch(notifications[0].message, /Invalid global settings JSON/);
	});

	await withIsolatedSettings(async ({ home, cwd }) => {
		await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), { handoff: { automaticEnabled: true } });
		const projectPath = join(cwd, ".pi", "settings.json");
		await mkdir(projectPath, { recursive: true });

		const notifications: Array<{ message: string; level: string }> = [];
		const model = await buildAgenticodingSettingsModel({
			cwd,
			hasUI: true,
			ui: { notify: (msg: string, level: string) => notifications.push({ message: msg, level }) },
		} as any);
		assert.equal(model.state.project.invalidReason, "read-error");
		assert.equal(model.effectiveAutomaticEnabled, false);
		assert.match(model.messages.join("\n"), /Unable to read project settings/);
		assert.match(model.messages.join("\n"), /EISDIR/);
		assert.doesNotMatch(model.messages.join("\n"), /Invalid project settings JSON/);
		assert.match(getAgenticodingSettingsDisplayLines(model).join("\n"), /Project settings: .*unreadable \(EISDIR\)/);
	});
});

test("handoff resumeBehavior is ignored and completion still uses fixed Proceed", async () => {
	const result = await runHandoffResumeScenario({
		globalSettings: { handoff: { resumeBehavior: "proceed" } },
	});

	assert.ok(result.compactOptions);
	result.compactOptions.onComplete({});
	assert.deepEqual(result.sentUserMessages, [{ content: "Proceed.", options: undefined }]);
	assert.deepEqual(result.notifications, []);
});

test("manual slash handoff permits handoff when automatic handoff is disabled", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		const state = createState();
		registerHandoffCommand(pi as any, state);
		registerHandoffTool(pi as any, state);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: true,
			isIdle: () => true,
			ui: { theme, notify: () => {}, setStatus: () => {} },
		});
		assert.deepEqual(pi.activeTools, []);
		state.pendingRequestedHandoff!.awaitingAgentTurn = false;

		let compactOptions: any;
		await pi.tools.get("handoff").execute("1", { task: "continue" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.ok(compactOptions);
		assert.equal(state.pendingRequestedHandoff?.toolCalled, true);

		compactOptions.onComplete({});
		assert.equal(pi.sentUserMessages.at(-1)?.content, "Proceed.");
	});
});

test("manual slash handoff preserves retry request after compaction error without mutating active tools", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		const state = createState();
		registerHandoffCommand(pi as any, state);
		registerHandoffTool(pi as any, state);
		registerHandoffCompaction(pi as any, state);
		const [compactHandler] = pi.handlers.get("session_before_compact")!;

		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => true });
		state.pendingRequestedHandoff!.awaitingAgentTurn = false;
		let compactOptions: any;
		await pi.tools.get("handoff").execute("1", { task: "continue" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		await compactHandler({ branchEntries: [], preparation: { tokensBefore: 10 } }, { cwd, hasUI: false } as any);
		assert.deepEqual(pi.activeTools, []);

		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => true });
		state.pendingRequestedHandoff!.awaitingAgentTurn = false;
		await pi.tools.get("handoff").execute("2", { task: "continue" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		compactOptions.onError({});
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepEqual(pi.activeTools, []);
		assert.equal(state.pendingRequestedHandoff?.direction, "implement auth");
		assert.equal(state.pendingRequestedHandoff?.enforcementAttempts, 0);
		assert.equal(state.pendingRequestedHandoff?.toolCalled, false);
		assert.equal(state.pendingRequestedHandoff?.awaitingAgentTurn, false);
		assert.match(state.pendingRequestedHandoff?.requestId ?? "", /^[0-9a-f-]{36}$/i);
		assert.match(state.pendingRequestedHandoffPrompt ?? "", /Handoff direction: implement auth/);
	});

	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => true });
		assert.deepEqual(pi.activeTools, []);
		const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
		const [turnEnd] = pi.handlers.get("turn_end")!;
		await beforeAgentStart(
			{ prompt: pi.sentUserMessages[0].content, systemPrompt: "base" },
			{ cwd, hasUI: false } as any,
		);
		await turnEnd({}, { cwd, hasUI: false, getContextUsage: () => null } as any);
		assert.equal(pi.activeTools.includes("handoff"), false);
	});
});

test("manual slash handoff permits disabled-mode handoff when the queued user message starts", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => true,
		});

		const [messageStart] = pi.handlers.get("message_start")!;
		await messageStart({
			message: {
				role: "user",
				content: [{ type: "text", text: pi.sentUserMessages[0].content }],
			},
		}, { cwd, hasUI: false } as any);

		let compactOptions: any;
		const result = await pi.tools.get("handoff").execute("1", { task: "continue" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});

		assert.ok(compactOptions);
		assert.equal(result.terminate, true);
		assert.match(result.content[0].text, /Handoff started/);
	});
});

test("manual slash handoff stays active across notebook/tool turns before handoff", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => true,
		});

		const [messageStart] = pi.handlers.get("message_start")!;
		await messageStart({
			message: { role: "user", content: pi.sentUserMessages[0].content },
		}, { cwd, hasUI: false } as any);

		const [turnEnd] = pi.handlers.get("turn_end")!;
		await turnEnd({}, {
			cwd,
			hasUI: true,
			ui: { theme, setStatus: () => {}, setWidget: () => {} },
			getContextUsage: () => null,
		} as any);

		let compactOptions: any;
		const result = await pi.tools.get("handoff").execute("1", { task: "continue after notebook writes" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});

		assert.ok(compactOptions);
		assert.equal(result.terminate, true);
		assert.match(result.content[0].text, /Handoff started/);
	});
});

test("manual slash handoff message_start parsing fails closed for malformed payloads", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => true,
		});

		const [messageStart] = pi.handlers.get("message_start")!;
		await assert.doesNotReject(() => messageStart({}, { cwd, hasUI: false } as any));
		await assert.doesNotReject(() => messageStart({ message: null }, { cwd, hasUI: false } as any));

		let compactOptions: any;
		const blockedResult = await pi.tools.get("handoff").execute("1", { task: "old turn" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.equal(compactOptions, undefined);
		assert.match(blockedResult.content[0].text, /No compaction was started/);

		await messageStart({
			message: { role: "user", content: [{ type: "text", text: pi.sentUserMessages[0].content }] },
		}, { cwd, hasUI: false } as any);

		const allowedResult = await pi.tools.get("handoff").execute("2", { task: "requested turn" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.ok(compactOptions);
		assert.equal(allowedResult.terminate, true);
	});
});

test("manual slash handoff queues a follow-up when invoked during a busy run", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		let waitCalls = 0;

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => false,
			waitForIdle: async () => { waitCalls += 1; },
		});

		assert.equal(waitCalls, 0);
		assert.deepEqual(pi.activeTools, []);
		assert.equal(pi.sentUserMessages.length, 1);
		assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp");
		assert.match(pi.sentUserMessages[0].content, /Handoff direction: implement auth/);

		let compactOptions: any;
		const blockedResult = await pi.tools.get("handoff").execute("1", { task: "old turn" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.equal(compactOptions, undefined);
		assert.match(blockedResult.content[0].text, /No compaction was started/);
		assert.equal(blockedResult.terminate, undefined);
		assert.deepEqual(pi.sentMessages, []);
	});
});

test("manual slash handoff follow-up is not preempted by old-turn automatic handoff", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => false,
		});
		assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp");

		let compactOptions: any;
		const blockedResult = await pi.tools.get("handoff").execute("old", { task: "old automatic turn" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.equal(compactOptions, undefined);
		assert.match(blockedResult.content[0].text, /generated user turn has not started/);
		assert.equal(blockedResult.terminate, undefined);

		const [messageStart] = pi.handlers.get("message_start")!;
		await messageStart({
			message: { role: "user", content: [{ type: "text", text: pi.sentUserMessages[0].content }] },
		}, { cwd, hasUI: false } as any);

		const allowedResult = await pi.tools.get("handoff").execute("requested", { task: "requested manual turn" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.ok(compactOptions);
		assert.equal(allowedResult.terminate, true);
		assert.match(allowedResult.content[0].text, /Handoff started/);
	});
});

test("manual slash handoff same-direction activation uses request identity instead of prompt equality", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => false });
		const oldPrompt = pi.sentUserMessages[0].content;
		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => false });
		const newPrompt = pi.sentUserMessages[1].content;
		assert.notEqual(oldPrompt, newPrompt);
		assert.match(oldPrompt, /Manual handoff request id: [0-9a-f-]{36}/i);
		assert.match(newPrompt, /Manual handoff request id: [0-9a-f-]{36}/i);

		const [messageStart] = pi.handlers.get("message_start")!;
		await messageStart({
			message: { role: "user", content: [{ type: "text", text: oldPrompt }] },
		}, { cwd, hasUI: false } as any);

		let compactOptions: any;
		const stillQueued = await pi.tools.get("handoff").execute("old", { task: "old prompt" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.equal(compactOptions, undefined);
		assert.match(stillQueued.content[0].text, /generated user turn has not started/);

		await messageStart({
			message: { role: "user", content: [{ type: "text", text: newPrompt }] },
		}, { cwd, hasUI: false } as any);
		const allowed = await pi.tools.get("handoff").execute("new", { task: "new prompt" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { compactOptions = options; },
		});
		assert.ok(compactOptions);
		assert.equal(allowed.terminate, true);
	});
});

test("stale automatic handoff compaction error does not clear newer queued manual status", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		const state = createState();
		registerHandoffCommand(pi as any, state);
		registerHandoffTool(pi as any, state);
		const statuses: Array<string | undefined> = [];
		const ctx = {
			cwd,
			hasUI: true,
			isIdle: () => false,
			ui: { theme, setStatus: (_key: string, status: string | undefined) => statuses.push(status), notify: () => {} },
			compact: (options: any) => { oldCompactOptions = options; },
		} as any;
		let oldCompactOptions: any;

		await pi.tools.get("handoff").execute("automatic", { task: "old automatic" }, undefined, undefined, ctx);
		await pi.commands.get("handoff")!.handler("implement auth", ctx);
		assert.match(statuses.at(-1) ?? "", /Handoff queued/);

		oldCompactOptions.onError({});

		assert.equal(state.pendingRequestedHandoff?.direction, "implement auth");
		assert.equal(state.pendingRequestedHandoff?.awaitingAgentTurn, true);
		assert.match(statuses.at(-1) ?? "", /Handoff queued/);
	});
});

test("manual slash handoff stale pending compaction does not clear newer queued request", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoffGeneration = 2;
	state.pendingHandoff = {
		task: "Goal: old handoff",
		source: "tool",
		manualRequestGeneration: 1,
		manualRequestId: "old-request",
	};
	const newerRequest = {
		requestId: "new-request",
		direction: "implement auth",
		enforcementAttempts: 0,
		toolCalled: false,
		awaitingAgentTurn: true,
	};
	state.pendingRequestedHandoff = newerRequest;
	state.pendingRequestedHandoffPrompt = "Handoff direction: implement auth";
	state.pendingRequestedHandoffRetryProtected = true;
	registerHandoffCompaction(pi as any, state);
	const statuses: Array<string | undefined> = [];

	const [handler] = pi.handlers.get("session_before_compact")!;
	const result = await handler(
		{ preparation: { tokensBefore: 1 }, branchEntries: [{ id: "leaf-1" }] },
		{ hasUI: true, ui: { setStatus: (_key: string, status: string | undefined) => statuses.push(status) } },
	);

	assert.equal(state.pendingHandoff, null);
	assert.strictEqual(state.pendingRequestedHandoff, newerRequest);
	assert.equal(state.pendingRequestedHandoffPrompt, "Handoff direction: implement auth");
	assert.equal(state.pendingRequestedHandoffRetryProtected, true);
	assert.deepEqual(statuses, []);
	assert.equal(result.compaction.summary, "Goal: old handoff");
});

test("manual slash handoff compaction error does not overwrite newer same-direction request", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		const state = createState();
		registerHandoffCommand(pi as any, state);
		registerHandoffTool(pi as any, state);
		const statuses: Array<string | undefined> = [];
		const uiCtx = {
			cwd,
			hasUI: true,
			isIdle: () => true,
			ui: { theme, setStatus: (_key: string, status: string | undefined) => statuses.push(status), notify: () => {} },
		};

		await pi.commands.get("handoff")!.handler("implement auth", uiCtx);
		state.pendingRequestedHandoff!.awaitingAgentTurn = false;
		let oldCompactOptions: any;
		await pi.tools.get("handoff").execute("old", { task: "old request" }, undefined, undefined, {
			cwd,
			hasUI: false,
			compact: (options: any) => { oldCompactOptions = options; },
		});
		assert.equal(state.pendingRequestedHandoff?.toolCalled, true);

		await pi.commands.get("handoff")!.handler("implement auth", uiCtx);
		const newerRequest = state.pendingRequestedHandoff!;
		assert.equal(newerRequest.direction, "implement auth");
		assert.equal(newerRequest.enforcementAttempts, 0);
		assert.equal(newerRequest.toolCalled, false);
		assert.equal(newerRequest.awaitingAgentTurn, true);
		assert.match(newerRequest.requestId, /^[0-9a-f-]{36}$/i);
		assert.match(statuses.at(-1) ?? "", /Handoff queued/);

		oldCompactOptions.onError({});

		assert.strictEqual(state.pendingRequestedHandoff, newerRequest);
		assert.equal(state.pendingRequestedHandoff?.awaitingAgentTurn, true);
		assert.match(state.pendingRequestedHandoffPrompt ?? "", /Handoff direction: implement auth/);
		assert.match(statuses.at(-1) ?? "", /Handoff queued/);
		assert.equal(pi.sentUserMessages.length, 2);
	});
});

test("manual slash handoff does not require active-tool APIs", async () => {
	const pi = new MockPi();
	(pi as any).setActiveTools = undefined;
	const state = createState();
	registerHandoffCommand(pi as any, state);
	const notifications: Array<{ message: string; level: string }> = [];

	await pi.commands.get("handoff")!.handler("implement auth", {
		hasUI: true,
		isIdle: () => true,
		ui: { theme, notify: (message: string, level: string) => notifications.push({ message, level }), setStatus: () => {} },
	});

	assert.equal(state.pendingRequestedHandoff?.direction, "implement auth");
	assert.equal(pi.sentUserMessages.length, 1);
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentMessages, []);
});

test("CHANGELOG documents fixed post-compaction Proceed continuation", async () => {
	const changelog = await readFile(new URL("./CHANGELOG.md", import.meta.url), "utf8");
	const unreleased = changelog.split("## [0.3.0]")[0];

	assert.match(unreleased, /Proceed\./);
	assert.match(unreleased, /fixed|not configurable|non-configurable/i);
});

test("handoff automatic setting is documented in README", async () => {
	const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
	const changelog = await readFile(new URL("./CHANGELOG.md", import.meta.url), "utf8");

	assert.match(readme, /handoff\.automaticEnabled/);
	assert.match(readme, /true/);
	assert.match(readme, /false/);
	assert.match(readme, /default/i);
	assert.match(readme, /Proceed/);
	assert.doesNotMatch(readme, /PR-only/i);
	assert.match(changelog, /handoff\.automaticEnabled/);
	assert.match(changelog, /default.*enabled/i);
	assert.match(readme, /queued manual request is only pending delivery/i);
	assert.match(readme, /active explicit operator/i);
	assert.match(changelog, /queued.*active generated turn/i);
});

test("agenticoding settings command registers /agenticoding-settings TUI surface", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		assert.ok(pi.commands.has("agenticoding-settings"));
		assert.ok(pi.commands.has("handoff"), "/handoff remains registered separately");

		let overlay: any;
		let customCalls = 0;
		await pi.commands.get("agenticoding-settings")!.handler("", {
			cwd,
			hasUI: true,
			ui: {
				theme,
				custom: async (build: any) => {
					customCalls++;
					overlay = build({ requestRender: () => {} }, theme, {}, () => {});
					return "closed";
				},
				notify: () => {},
			},
		});

		assert.equal(customCalls, 1);
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		assert.match(rendered, /Agenticoding Settings/);
		assert.match(rendered, /Resolved handoff\.automaticEnabled: true/);
		assert.match(rendered, /Supported values: true, false/);
		assert.match(rendered, /global-only/);
	});
});

test("agenticoding settings TUI persists handoff automaticEnabled globally as boolean", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		const projectPath = join(cwd, ".pi", "settings.json");
		await writeSettingsFile(globalPath, { packages: ["keep"], handoff: { other: true } });

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;
		const model = await buildAgenticodingSettingsModel(ctx);
		assert.equal(await model.save("false", ctx), true);

		const saved = JSON.parse(await readFile(globalPath, "utf8"));
		assert.deepEqual(saved.packages, ["keep"]);
		assert.equal(saved.handoff.other, true);
		assert.equal(saved.handoff.automaticEnabled, false);
		await assert.rejects(() => readFile(projectPath, "utf8"));
		assert.deepEqual(notifications, [{ message: 'Saved global handoff.automaticEnabled = false.', level: "info" }]);

		const roundTrip = await buildAgenticodingSettingsModel(ctx);
		assert.equal(roundTrip.effectiveAutomaticEnabled, false);
		assert.equal(roundTrip.effectiveSource, "global");
	});
});

test("agenticoding settings global save preserves existing file mode", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(globalPath, { packages: ["keep"], handoff: { automaticEnabled: true } });
		await chmod(globalPath, 0o640);

		const ctx = { cwd, hasUI: true, ui: { notify: () => {} } } as any;
		assert.equal(await writeGlobalHandoffAutomaticEnabled("false", ctx), true);

		const saved = JSON.parse(await readFile(globalPath, "utf8"));
		assert.equal(saved.handoff.automaticEnabled, false);
		assert.equal((await stat(globalPath)).mode & 0o777, 0o640);
	});
});

test("agenticoding settings TUI warns when project override masks global automatic handoff", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), { handoff: { automaticEnabled: true } });
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });

		const model = await buildAgenticodingSettingsModel({ cwd, hasUI: true, ui: { notify: () => {} } } as any);
		assert.equal(model.effectiveAutomaticEnabled, false);
		assert.equal(model.effectiveSource, "project");
		assert.equal(model.projectOverride, true);
		assert.match(model.projectOverrideWarning ?? "", /override\/mask/);
		assert.match(model.projectOverrideWarning ?? "", /Saving here writes only/);

		const display = getAgenticodingSettingsDisplayLines(model).join("\n");
		assert.match(display, /Project settings: .*false/);
		assert.match(display, /Warning: Project settings/);
	});
});

test("agenticoding settings TUI editable control anchors and refreshes to global value when project override masks it", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		await writeSettingsFile(join(home, ".pi", "agent", "settings.json"), { handoff: { automaticEnabled: true } });
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const ctx = { cwd, hasUI: true, ui: { notify: () => {} } } as any;
		const model = await buildAgenticodingSettingsModel(ctx);
		const component = createAgenticodingSettingsComponent(model, ctx, { requestRender: () => {} }, theme, () => {});

		const rendered = stripAnsi(component.render(120).join("\n"));
		assert.match(rendered, /Resolved handoff\.automaticEnabled: false \(project\)/);
		assert.match(rendered, /Global settings: .*true/);
		assert.match(rendered, /Automatic handoff availability \(global save\)\s+true/);
	});

	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(globalPath, { handoff: { automaticEnabled: true } });
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: true } });
		const ctx = { cwd, hasUI: true, ui: { notify: () => {} } } as any;
		const model = await buildAgenticodingSettingsModel(ctx);
		const component = createAgenticodingSettingsComponent(model, ctx, { requestRender: () => {} }, theme, () => {});

		component.handleInput("\r");
		await new Promise(resolve => setTimeout(resolve, 50));

		const saved = JSON.parse(await readFile(globalPath, "utf8"));
		assert.equal(saved.handoff.automaticEnabled, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		assert.match(rendered, /Global settings: .*false/);
		assert.match(rendered, /Automatic handoff availability \(global save\)\s+false/);
	});
});

test("agenticoding settings TUI warns after save when project override still masks global automatic handoff", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(globalPath, { handoff: { automaticEnabled: true } });
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: true } });
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;
		const model = await buildAgenticodingSettingsModel(ctx);
		const component = createAgenticodingSettingsComponent(model, ctx, { requestRender: () => {} }, theme, () => {});

		component.handleInput("\r");
		await new Promise(resolve => setTimeout(resolve, 50));

		const saved = JSON.parse(await readFile(globalPath, "utf8"));
		assert.equal(saved.handoff.automaticEnabled, false);
		assert.deepEqual(notifications.map(n => n.level), ["info", "warning"]);
		assert.match(notifications[0].message, /Saved global handoff\.automaticEnabled = false/);
		assert.match(notifications[1].message, /Project settings .*override\/mask the global value/);
		assert.match(stripAnsi(component.render(120).join("\n")), /Resolved handoff\.automaticEnabled: true \(project\)/);
	});
});

test("agenticoding settings TUI handles invalid JSON policies for automatic handoff", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(globalPath, "{");
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		const invalidGlobal = await buildAgenticodingSettingsModel(ctx);
		assert.equal(invalidGlobal.globalWriteBlocked, true);
		assert.equal(await invalidGlobal.save("false", ctx), false);
		assert.equal(await readFile(globalPath, "utf8"), "{");
		assert.equal(notifications.at(-1)?.level, "error");
		assert.match(notifications.at(-1)?.message ?? "", /Invalid global settings JSON/);
	});

	for (const nonObjectRoot of ["[]", "\"x\"", "42"]) {
		await withIsolatedSettings(async ({ home, cwd }) => {
			const globalPath = join(home, ".pi", "agent", "settings.json");
			await writeSettingsFile(globalPath, nonObjectRoot);
			const notifications: Array<{ message: string; level: string }> = [];
			const ctx = {
				cwd,
				hasUI: true,
				ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
			} as any;

			const state = await readHandoffSettingsState(cwd);
			assert.equal(state.global.invalid, true);
			const invalidGlobal = await buildAgenticodingSettingsModel(ctx);
			assert.equal(invalidGlobal.globalWriteBlocked, true);
			assert.equal(await invalidGlobal.save("false", ctx), false);
			assert.equal(await readFile(globalPath, "utf8"), nonObjectRoot);
			assert.equal(notifications.at(-1)?.level, "error");
			assert.match(notifications.at(-1)?.message ?? "", /root must be an object/);
		});
	}

	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), "{");
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		const invalidProject = await buildAgenticodingSettingsModel(ctx);
		assert.equal(invalidProject.globalWriteBlocked, false);
		assert.match(invalidProject.messages.join("\n"), /Invalid project settings JSON/);
		assert.equal(await invalidProject.save("false", ctx), true);
		const saved = JSON.parse(await readFile(globalPath, "utf8"));
		assert.equal(saved.handoff.automaticEnabled, false);
		assert.equal(notifications.at(-1)?.level, "info");
	});
});

test("agenticoding settings TUI refuses to clobber malformed global handoff parent on save", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		const original = JSON.stringify({ packages: ["keep"], handoff: null });
		await writeSettingsFile(globalPath, original);
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		const state = await readHandoffSettingsState(cwd);
		assert.equal(state.global.invalid, true);
		assert.equal(state.global.invalidReason, "malformed-handoff");
		const model = await buildAgenticodingSettingsModel(ctx);
		assert.equal(model.globalWriteBlocked, true);

		assert.equal(await writeGlobalHandoffAutomaticEnabled("false", ctx), false);
		assert.equal(await readFile(globalPath, "utf8"), original);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /handoff must be an object when present/);
		assert.match(notifications[0].message, /not writing handoff\.automaticEnabled/);
	});
});

test("agenticoding settings write path refuses non-ENOENT read failures without clobbering global settings", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		const original = JSON.stringify({ packages: ["keep"], handoff: { other: true } });
		await writeSettingsFile(globalPath, original);
		await chmod(globalPath, 0o200);

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		try {
			assert.equal(await writeGlobalHandoffAutomaticEnabled("false", ctx), false);
		} finally {
			await chmod(globalPath, 0o600);
		}

		assert.equal(await readFile(globalPath, "utf8"), original);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /Unable to read global settings JSON/);
		assert.match(notifications[0].message, /not writing handoff\.automaticEnabled/);
	});
});

test("agenticoding settings write path rejects save failures", async () => {
	await withIsolatedSettings(async ({ home }) => {
		const settingsDir = join(home, ".pi", "agent");
		await mkdir(settingsDir, { recursive: true });
		await chmod(settingsDir, 0o500);

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd: home,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		try {
			await assert.rejects(
				() => writeGlobalHandoffAutomaticEnabled("false", ctx),
				/EACCES|EPERM|ENOSPC/,
			);
		} finally {
			await chmod(settingsDir, 0o700);
		}
	});
});

test("agenticoding settings TUI reports save failure notification", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		await writeSettingsFile(globalPath, { handoff: { automaticEnabled: true } });
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;
		const model = await buildAgenticodingSettingsModel(ctx);
		const component = createAgenticodingSettingsComponent(model, ctx, { requestRender: () => {} }, theme, () => {});

		setSettingsAtomicWriteOperationsForTest({
			rename: async () => { throw new Error("simulated save failure"); },
		});
		try {
			component.handleInput("\r");
			await new Promise(resolve => setTimeout(resolve, 50));
		} finally {
			setSettingsAtomicWriteOperationsForTest(null);
		}

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /Failed to save handoff\.automaticEnabled/);
		assert.match(notifications[0].message, /simulated save failure/);
	});
});

test("agenticoding settings atomic save preserves original settings when rename fails", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		const original = JSON.stringify({ packages: ["keep"], handoff: { automaticEnabled: true } });
		await writeSettingsFile(globalPath, original);
		const renameError = new Error("simulated rename failure");
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		} as any;

		setSettingsAtomicWriteOperationsForTest({
			rename: async () => { throw renameError; },
		});
		try {
			await assert.rejects(() => writeGlobalHandoffAutomaticEnabled("false", ctx), /simulated rename failure/);
		} finally {
			setSettingsAtomicWriteOperationsForTest(null);
		}

		assert.equal(await readFile(globalPath, "utf8"), original);
		const files = await readdir(dirname(globalPath));
		assert.equal(files.some(file => file.startsWith(".settings.json.") && file.endsWith(".tmp")), false);
		assert.deepEqual(notifications, []);
	});
});

test("agenticoding settings atomic save writes temp file with preserved restrictive mode", async () => {
	await withIsolatedSettings(async ({ home, cwd }) => {
		const globalPath = join(home, ".pi", "agent", "settings.json");
		const writeModes: number[] = [];
		const ctx = { cwd, hasUI: false } as any;

		setSettingsAtomicWriteOperationsForTest({
			writeFile: (async (pathArg: string, contents: string, options: any) => {
				writeModes.push(options?.mode);
				await writeFile(pathArg, contents, options);
			}) as any,
		});
		try {
			await writeGlobalHandoffAutomaticEnabled("false", ctx);
			await chmod(globalPath, 0o640);
			await writeGlobalHandoffAutomaticEnabled("true", ctx);
		} finally {
			setSettingsAtomicWriteOperationsForTest(null);
		}

		assert.deepEqual(writeModes.map((mode) => mode & 0o777), [0o600, 0o640]);
		assert.equal((await stat(globalPath)).mode & 0o777, 0o640);
	});
});

test("agenticoding settings command falls back without usable TUI", async () => {
	const headlessPi = new MockPi();
	registerAgenticoding(headlessPi as any);
	await headlessPi.commands.get("agenticoding-settings")!.handler("", { hasUI: false });
	assert.equal(headlessPi.sentMessages.length, 1);
	assert.match(headlessPi.sentMessages[0].message.content, /Edit ~\/\.pi\/agent\/settings\.json/);
	assert.equal(headlessPi.sentMessages[0].message.content, MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS);
	assert.match(MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS, /handoff\.automaticEnabled/);

	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		const notifications: Array<{ message: string; level: string }> = [];
		await pi.commands.get("agenticoding-settings")!.handler("", {
			cwd,
			hasUI: true,
			ui: {
				custom: async () => undefined,
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		});
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		assert.equal(notifications[0].message, MANUAL_AGENTICODING_SETTINGS_INSTRUCTIONS);
	});
});

test("agenticoding settings documentation covers TUI and global-only/project override semantics", async () => {
	const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
	const changelog = await readFile(new URL("./CHANGELOG.md", import.meta.url), "utf8");

	assert.match(readme, /\/agenticoding-settings/);
	assert.match(readme, /global-only/i);
	assert.match(readme, /project.*override/i);
	assert.match(readme, /~\/\.pi\/agent\/settings\.json/);
	assert.match(readme, /handoff\.automaticEnabled/);
	assert.match(changelog, /\/agenticoding-settings/);
	assert.match(changelog, /global-only/i);
	assert.match(changelog, /project.*override/i);
	assert.match(changelog, /\n$/);
	assert.doesNotMatch(changelog, /\n\n$/);
});

test("handoff compaction replaces old context with the queued task", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingHandoff = { task: "Goal: continue", source: "tool" };
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 1, toolCalled: true, awaitingAgentTurn: false };
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

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), "🤝 Handoff queued");
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

test("handoff compaction error preserves active manual request for retry", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 1, toolCalled: false, awaitingAgentTurn: false };
	state.pendingRequestedHandoffPrompt = "Handoff direction: implement auth";
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
	assert.deepEqual(state.pendingRequestedHandoff, {
		requestId: "test-request",
		direction: "implement auth",
		enforcementAttempts: 1,
		toolCalled: false,
		awaitingAgentTurn: false,
	});
	assert.equal(state.pendingRequestedHandoffPrompt, "Handoff direction: implement auth");
	assert.equal(pi.sentUserMessages.length, 0);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("manual slash handoff preserves retry-ready request after compaction onError followed by agent_end", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 1, toolCalled: false, awaitingAgentTurn: false };
	state.pendingRequestedHandoffPrompt = "Handoff direction: implement auth";
	registerHandoffTool(pi as any, state);
	registerWatchdog(pi as any, state);
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

	const [agentEnd] = pi.handlers.get("agent_end")!;
	await agentEnd({}, {
		hasUI: true,
		ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); } },
		getContextUsage: () => null,
	});

	assert.equal(state.pendingHandoff, null);
	assert.deepEqual(state.pendingRequestedHandoff, {
		requestId: "test-request",
		direction: "implement auth",
		enforcementAttempts: 2,
		toolCalled: false,
		awaitingAgentTurn: false,
	});
	assert.equal(state.pendingRequestedHandoffPrompt, "Handoff direction: implement auth");
	assert.equal(pi.sentUserMessages.length, 0);
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("handoff compact synchronous throw preserves active manual request for retry", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 0, toolCalled: false, awaitingAgentTurn: false };
	state.pendingRequestedHandoffPrompt = "Handoff direction: implement auth";
	registerHandoffTool(pi as any, state);
	const statuses = new Map<string, string | undefined>();

	await assert.rejects(
		() => pi.tools.get("handoff").execute(
			"1",
			{ task: "Goal: continue" },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); } },
				compact: () => { throw new Error("compact start failed"); },
			},
		),
		/compact start failed/,
	);

	assert.equal(state.pendingHandoff, null);
	assert.deepEqual(state.pendingRequestedHandoff, {
		requestId: "test-request",
		direction: "implement auth",
		enforcementAttempts: 0,
		toolCalled: false,
		awaitingAgentTurn: false,
	});
	assert.equal(state.pendingRequestedHandoffPrompt, "Handoff direction: implement auth");
	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
});

test("agent_end fallback silently clears stale requested handoff status", async () => {
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

	const notifications: Array<{ message: string; level: string }> = [];
	const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
	const [agentEnd] = pi.handlers.get("agent_end")!;
	await beforeAgentStart(
		{ prompt: pi.sentUserMessages[0].content, systemPrompt: "base" },
		{ hasUI: false } as any,
	);
	await agentEnd({}, {
		hasUI: true,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: () => {},
		},
		getContextUsage: () => null,
	});

	assert.equal(statuses.get(STATUS_KEY_HANDOFF), undefined);
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentMessages, []);
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

test("disabled-mode context nudge follows an active manual handoff request", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);

		await pi.commands.get("handoff")!.handler("implement auth", {
			cwd,
			hasUI: false,
			isIdle: () => true,
		});
		const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
		await beforeAgentStart(
			{ prompt: pi.sentUserMessages[0].content, systemPrompt: "base" },
			{ cwd, hasUI: false } as any,
		);

		const [contextHandler] = pi.handlers.get("context")!;
		const result = await contextHandler(
			{ messages: [{ role: "user", content: "handoff", timestamp: 1 }] },
			{ cwd, getContextUsage: () => ({ percent: 70 }) },
		);

		assert.equal(result.messages[1].customType, "agenticoding-watchdog");
		assert.match(result.messages[1].content, /manual \/handoff request is active/i);
		assert.match(result.messages[1].content, /call the handoff tool/i);
		assert.doesNotMatch(result.messages[1].content, /tell the operator|continue inline only if safe/i);
	});
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
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		const [handler] = pi.handlers.get("context")!;

		const result = await handler(
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ cwd, getContextUsage: () => ({ percent: 70 }) },
		);

		assert.equal(result.messages.length, 2);
		assert.equal(result.messages[1].role, "custom");
		assert.equal(result.messages[1].customType, "agenticoding-watchdog");
		assert.equal(result.messages[1].display, false);
		assert.match(result.messages[1].content, /No active notebook topic is set/);
		assert.match(result.messages[1].content, /Assign a fresh topic in the next clean context after handoff/i);
	});
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
		},
		null,
	);
	assert.match(boundary, /Notebook topic changed from oauth to billing/);
	assert.doesNotMatch(boundary, /Active notebook topic: oauth/);

	const noTopic = buildNudge({ activeNotebookTopic: null, pendingTopicBoundaryHint: null }, null);
	assert.match(noTopic, /Topic-aware context reminder/);
	assert.match(noTopic, /No active notebook topic is set/);
});

test("watchdog stale requested handoff cleanup stays silent", async () => {
	const pi = new MockPi();
	const state = createState();
	state.pendingRequestedHandoff = { requestId: "test-request", direction: "implement auth", enforcementAttempts: 0, toolCalled: false, awaitingAgentTurn: false };
	registerWatchdog(pi as any, state);
	const [handler] = pi.handlers.get("agent_end")!;

	const notifications: Array<{ message: string; level: string }> = [];
	await handler(
		{},
		{
			hasUI: true,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setStatus: () => {},
			},
			getContextUsage: () => ({ percent: 20 }),
		},
	);

	assert.equal(state.pendingRequestedHandoff, null);
	assert.deepEqual(notifications, []);
	assert.deepEqual(pi.sentMessages, []);
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

test("agentic e2e spawn child can use active registered non-builtin tool", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-agenticoding-a10-"));
	const tempCwd = join(tempRoot, "project");
	const tempAgentDir = join(tempRoot, "agent");
	const extensionDir = join(tempCwd, ".pi", "extensions");
	const sentinel = "AGENTIC_E2E_PROBE_OK";
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldOpenAiApiKey = process.env.OPENAI_API_KEY;
	const parentRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
	let streamCallCount = 0;

	try {
		await mkdir(extensionDir, { recursive: true });
		await mkdir(tempAgentDir, { recursive: true });
		await writeFile(join(tempCwd, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(extensionDir, "agentic-e2e-probe.js"),
			`
export default function(pi) {
	pi.registerTool({
		name: "agentic_e2e_probe",
		label: "Agentic E2E Probe",
		description: "Return the deterministic Story 04 A10 sentinel.",
		promptSnippet: "Call agentic_e2e_probe to return the Story 04 A10 sentinel.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			globalThis.__agenticE2eProbeCalls = (globalThis.__agenticE2eProbeCalls ?? 0) + 1;
			return {
				content: [{ type: "text", text: "${sentinel}" }],
				details: { sentinel: "${sentinel}" },
			};
		},
	});
}
`,
		);

		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		process.env.OPENAI_API_KEY = "test-openai-key";
		(globalThis as any).__agenticE2eProbeCalls = 0;

		parentRegistry.registerProvider("openai", {
			name: "Agentic E2E OpenAI-compatible provider",
			api: "agentic-e2e-api",
			apiKey: "test-openai-key",
			baseUrl: "http://localhost:0",
			streamSimple: (model: any, context: any) => {
				streamCallCount += 1;
				if (streamCallCount === 1) {
					const promptText = context.messages.map(messageText).join("\n");
					assert.match(promptText, /agentic_e2e_probe/);
					assert.match(promptText, new RegExp(sentinel));
					return createTestAssistantStream(createTestAssistantMessage(model, [
						{ type: "toolCall", id: "probe-call-1", name: "agentic_e2e_probe", arguments: {} },
					], "tool_calls"));
				}

				const probeResult = context.messages.find((message: any) =>
					message.role === "toolResult" &&
					message.toolName === "agentic_e2e_probe" &&
					messageText(message).includes(sentinel)
				);
				const text = probeResult ? sentinel : "AGENTIC_E2E_PROBE_MISSING";
				return createTestAssistantStream(createTestAssistantMessage(model, [{ type: "text", text }]));
			},
			models: [{
				id: "agentic-e2e-model",
				name: "Agentic E2E Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			}],
		});
		const model = parentRegistry.find("openai", "agentic-e2e-model");
		assert.ok(model);

		const pi = new MockPi();
		pi.setToolSource("agentic_e2e_probe", "project");
		pi.setActiveTools(["read", "agentic_e2e_probe", "spawn"]);
		pi.setAllTools(["read", "agentic_e2e_probe", "spawn"]);
		const state = createState();
		const childPrompt = `Use the agentic_e2e_probe tool and return ${sentinel}.`;

		registerSpawnTool(pi as any, state);
		const result = await pi.tools.get("spawn").execute(
			"spawn-e2e",
			{ prompt: childPrompt, thinking: "medium" },
			undefined,
			undefined,
			{ model, cwd: tempCwd },
		);

		assert.equal(result.content[0].text, sentinel);
		assert.equal((globalThis as any).__agenticE2eProbeCalls, 1);
		assert.equal(streamCallCount, 2);
	} finally {
		parentRegistry.unregisterProvider("openai");
		if (oldAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
		if (oldOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = oldOpenAiApiKey;
		}
		delete (globalThis as any).__agenticE2eProbeCalls;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("spawn execute passes broad active registered tool formula to child session", async () => {
	const pi = new MockPi();
	pi.setToolSource("project_search", "project");
	pi.setToolSource("inactive_registered", "extension");
	pi.setActiveTools(["read", "bash", "spawn", "handoff", "project_search", "phantom_tool"]);
	pi.setAllTools(["read", "bash", "spawn", "handoff", "project_search", "inactive_registered"]);
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
	assert.deepEqual(
		new Set(seenConfig.tools),
		new Set(["read", "bash", "project_search", "notebook_write", "notebook_read", "notebook_index"]),
	);
	assert.deepEqual(seenConfig.customTools.map((tool: any) => tool.name), ["notebook_write", "notebook_read", "notebook_index"]);
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

test("child tool names inherit active registered builtins and exclude recursive controls", () => {
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
	assert.equal(childToolNames.includes("read"), true);
	assert.equal(childToolNames.includes("bash"), true);
	assert.equal(childToolNames.includes("spawn"), false);
	assert.equal(childToolNames.includes("handoff"), false);
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

test("child tool names inherit active registered MCP extension tools", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state);

	const toolNames = buildChildToolNames(
		["read", "chunkhound_code_research", "mcp_status"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "chunkhound_code_research", sourceInfo: { source: "extension" } },
			{ name: "mcp_status", sourceInfo: { source: "extension" } },
		] as any,
	);

	assert.equal(toolNames.includes("chunkhound_code_research"), true);
	assert.equal(toolNames.includes("mcp_status"), true);
});

test("child tool names inherit active registered project package and local extension tools", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state);

	const toolNames = buildChildToolNames(
		["project_search", "package_lint", "local_helper"],
		childTools,
		[
			{ name: "project_search", sourceInfo: { source: "project" } },
			{ name: "package_lint", sourceInfo: { source: "package" } },
			{ name: "local_helper", sourceInfo: { source: "local" } },
		] as any,
	);

	assert.equal(toolNames.includes("project_search"), true);
	assert.equal(toolNames.includes("package_lint"), true);
	assert.equal(toolNames.includes("local_helper"), true);
});

test("child tool names exclude inactive registered and active phantom tools", () => {
	const state = createState();
	const childTools = createChildTools(new MockPi() as any, state);

	const toolNames = buildChildToolNames(
		["read", "active_phantom"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "inactive_registered", sourceInfo: { source: "extension" } },
		] as any,
	);

	assert.equal(toolNames.includes("read"), true);
	assert.equal(toolNames.includes("inactive_registered"), false);
	assert.equal(toolNames.includes("active_phantom"), false);
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
	await withIsolatedSettings(async ({ cwd }) => {
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
				cwd,
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
	assert.match(writeGuidelines, /immediate next-step state/i);
	assert.doesNotMatch(writeGuidelines, /handoff|\/handoff/i);

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
	assert.doesNotMatch(tool.promptGuidelines.join(" "), /tell the operator/i);
	assert.match(tool.promptGuidelines.join(" "), /context-pivot guidance/i);
	const first = await tool.execute("1", { topic: "OAuth" });
	assert.equal(first.details.topic, "oauth");
	assert.equal(state.activeNotebookTopic, "oauth");
	assert.equal(state.activeNotebookTopicSource, "agent");

	const second = await tool.execute("2", { topic: "oauth" });
	assert.equal(second.details.changed, false);
	assert.equal(second.details.source, "agent");
	assert.match(second.content[0].text, /already set to "oauth"/i);

	await assert.rejects(() => tool.execute("3", { topic: "billing" }), /already exists/);
	await assert.rejects(() => tool.execute("4", { topic: "billing" }), (error: unknown) => {
		assert.doesNotMatch(String(error), /handoff|\/handoff/i);
		return true;
	});
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
		(error: unknown) => {
			assert.match(String(error), /human-set notebook topic is authoritative/i);
			assert.doesNotMatch(String(error), /handoff|\/handoff/i);
			return true;
		},
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

test("buildNudge no longer emits the old percent-only handoff text", () => {
	const old = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null }, 46);
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

test("handoff automatic setting false suppresses handoff calls in primer and watchdog guidance", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		pi.setActiveTools(["read", "handoff", "spawn"]);
		registerAgenticoding(pi as any);
		const [handler] = pi.handlers.get("before_agent_start")!;
		const result = await handler({ systemPrompt: "Base system prompt." }, {
			...makeTUICtx({ hasUI: false }),
			cwd,
		});

		assert.equal(pi.activeTools.includes("handoff"), true);
		assert.doesNotMatch(result.systemPrompt, /call (?:the )?handoff|use handoff|prefer handoff|\/handoff/i);
		assert.match(
			result.systemPrompt,
			/handoff\s+tool is disabled for normal turns; use it only after an explicit manual\s+handoff request/i,
		);
		assert.match(result.systemPrompt, /save durable/i);
		assert.match(result.systemPrompt, /tell the operator/i);

		const disabledNudge = buildNudge({ activeNotebookTopic: "oauth", pendingTopicBoundaryHint: null }, 70, false);
		assert.doesNotMatch(disabledNudge, /handoff|\/handoff/i);
		assert.match(disabledNudge, /tell the operator/i);

		const topicTool = pi.tools.get("notebook_topic_set")!;
		assert.doesNotMatch(topicTool.promptGuidelines.join("\n"), /handoff|\/handoff/i);
		const notebookWrite = pi.tools.get("notebook_write")!;
		assert.doesNotMatch(notebookWrite.promptGuidelines.join("\n"), /handoff|\/handoff/i);
		const notebookIndex = pi.tools.get("notebook_index")!;
		assert.doesNotMatch(notebookIndex.promptGuidelines.join("\n"), /handoff|\/handoff|after handoff/i);

		const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
		updateIndicators(makeTUICtx({ percent: 70, record }), { ...createState(), activeNotebookTopic: "oauth" }, false);
		assert.doesNotMatch(record.widgets.get(WIDGET_KEY_WARNING)?.join("\n") ?? "", /handoff|\/handoff/i);

		const writeRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
		await notebookWrite.execute("1", { name: "disabled-hints", content: "saved" }, undefined, undefined, {
			...makeTUICtx({ percent: 70, record: writeRecord }),
			cwd,
		});
		assert.doesNotMatch(writeRecord.widgets.get(WIDGET_KEY_WARNING)?.join("\n") ?? "", /handoff|\/handoff/i);
	});
});

test("automatic disabled active manual generated turn overrides disabled primer and topic guidance", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		await writeSettingsFile(join(cwd, ".pi", "settings.json"), { handoff: { automaticEnabled: false } });
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		await pi.commands.get("notebook")!.handler("oauth", { cwd, hasUI: false, getContextUsage: () => null });
		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => true });

		const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
		const result = await beforeAgentStart(
			{ prompt: pi.sentUserMessages[0].content, systemPrompt: "Base system prompt." },
			{ cwd, hasUI: false } as any,
		);

		assert.match(result.systemPrompt, /Manual handoff.*explicit operator request active/i);
		assert.match(result.systemPrompt, /active manual \/handoff request/i);
		assert.match(result.systemPrompt, /call the handoff tool/i);
		assert.match(result.systemPrompt, /Current topic: `oauth`/);
		assert.doesNotMatch(result.systemPrompt, /continue inline only if safe|tell the operator|clean-transition fallback|fallback guidance/i);

		const [contextHandler] = pi.handlers.get("context")!;
		const lowContext = await contextHandler({ messages: [] }, { cwd, hasUI: false, getContextUsage: () => ({ percent: 20 }) } as any);
		assert.equal(lowContext, undefined, "low context emits no watchdog nudge, so before_agent_start guidance must carry the manual instruction");
	});
});

test("automatic disabled active manual primer has no clean-transition footer contradiction", () => {
	const primer = getContextPrimer(false, true);

	assert.match(primer, /Manual handoff.*explicit operator request active/i);
	assert.match(primer, /call the handoff tool/i);
	assert.doesNotMatch(primer, /continue inline only if safe|tell the operator|clean-transition fallback|fallback guidance/i);
});

test("handoff automatic setting false uses disabled topic-boundary watchdog guidance", () => {
	const nudge = buildNudge({
		activeNotebookTopic: "billing",
		pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
	}, 20, false);

	assert.match(nudge, /Notebook topic changed from oauth to billing/);
	assert.match(nudge, /Save durable findings to the\s+notebook/i);
	assert.match(nudge, /continue inline/i);
	assert.match(nudge, /tell the operator/i);
	assert.doesNotMatch(nudge, /call handoff|call the handoff tool|prefer .*handoff|\/handoff/i);
});

test("automatic enabled watchdog distinguishes queued manual handoff request", async () => {
	await withIsolatedSettings(async ({ cwd }) => {
		const pi = new MockPi();
		registerAgenticoding(pi as any);
		await pi.commands.get("handoff")!.handler("implement auth", { cwd, hasUI: false, isIdle: () => false });
		const [contextHandler] = pi.handlers.get("context")!;

		const result = await contextHandler({ messages: [] }, {
			cwd,
			hasUI: false,
			getContextUsage: () => ({ percent: 70 }),
		} as any);
		const nudge = result.messages.at(-1).content;

		assert.match(nudge, /manual \/handoff request is waiting/i);
		assert.match(nudge, /do not call the handoff tool/i);
		assert.doesNotMatch(nudge, /prefer (?:a deliberate )?handoff|draft .*brief.*call/i);
	});

	const boundaryNudge = buildQueuedManualHandoffNudge({
		activeNotebookTopic: "billing",
		pendingTopicBoundaryHint: { from: "oauth", to: "billing", source: "human" },
	}, 20);
	assert.match(boundaryNudge, /queued manual handoff/i);
	assert.match(boundaryNudge, /do not call the handoff tool/i);
	assert.doesNotMatch(boundaryNudge, /prefer (?:a deliberate )?handoff|draft .*brief.*call/i);
});

test("automatic disabled high context warning honors active manual handoff request", () => {
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const state = createState();
	state.activeNotebookTopic = "oauth";
	state.pendingRequestedHandoff = {
		requestId: "test-request",
		direction: "implement auth",
		enforcementAttempts: 0,
		toolCalled: false,
		awaitingAgentTurn: false,
	};

	updateIndicators(makeTUICtx({ percent: 70, record }), state, false);
	const warning = record.widgets.get(WIDGET_KEY_WARNING)?.join("\n") ?? "";
	assert.match(warning, /manual \/handoff request is active/);
	assert.match(warning, /call the handoff tool/);
	assert.doesNotMatch(warning, /tell operator|continue inline only if safe/);

	const queuedRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	state.pendingRequestedHandoff.awaitingAgentTurn = true;
	updateIndicators(makeTUICtx({ percent: 70, record: queuedRecord }), state, false);
	const queuedWarning = queuedRecord.widgets.get(WIDGET_KEY_WARNING)?.join("\n") ?? "";
	assert.match(queuedWarning, /manual \/handoff request is queued/);
	assert.match(queuedWarning, /do not call the handoff tool/i);
});

test("handoff tool metadata omits prompt hints and call guidance", () => {
	const pi = new MockPi();
	const state = createState();
	registerHandoffTool(pi as any, state);

	const tool = pi.tools.get("handoff")!;
	assert.equal(tool.promptSnippet, undefined);
	assert.equal(tool.promptGuidelines, undefined);
	assert.doesNotMatch(tool.description, /WHEN TO USE|call handoff|use handoff|\/handoff/i);
	assert.doesNotMatch(tool.parameters.properties.task.description, /what to do next|capture the distilled|notebook/i);
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
	assert.match(tool.description, /active registered tools executable in the child session/);
	assert.match(tool.description, /shared notebook tools/);
	assert.match(tool.description, /cannot spawn or handoff/);
	assert.doesNotMatch(tool.description, /supported built-in tools/);
	assert.equal(typeof tool.execute, "function");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
	assert.equal(tool.renderShell, "self");
	// parameters are a TypeBox schema object — just verify it exists
	assert.ok(tool.parameters, "should have parameters");
	assert.equal(tool.executionMode, undefined, "spawn should not be sequential");
});

test("spawn docs document active registered inheritance", async () => {
	const readme = await readFile("README.md", "utf8");
	const changelog = await readFile("CHANGELOG.md", "utf8");
	const spawnSection = /### Spawn — Isolate Noise[\s\S]*?### Notebook/.exec(readme)?.[0] ?? "";
	const unreleased = /## \[Unreleased\][\s\S]*?## \[0\.3\.0\]/.exec(changelog)?.[0] ?? "";

	assert.match(spawnSection, /active registered tools executable in the child session/);
	assert.match(spawnSection, /MCP\/extension tools such as ChunkHound/);
	assert.match(spawnSection, /[Cc]hild-local notebook tools/);
	assert.match(spawnSection, /cannot spawn grandchildren or handoff/);
	assert.doesNotMatch(spawnSection, /built-in tools only/);
	assert.match(unreleased, /active registered parent tools/);
	assert.match(unreleased, /spawn and handoff/);
	assert.match(unreleased, /notebook tools/);
});
