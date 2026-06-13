// ── Shared test helpers ──────────────────────────────────────────
// Imported by other test files via `./helpers.js`
// Includes createTestPI(), test utilities, theme constants, etc.

import type { Theme } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

export const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export const ansiTheme = {
	fg: (_name: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
	bg: (_name: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as unknown as Theme;

export function createRenderContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		expanded: false,
		showImages: true,
		toolCallId: "tool-call-1",
		lastComponent: undefined,
		invalidate: () => {},
		...overrides,
	};
}

export function createSession(messages: any[]) {
	return {
		messages,
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as unknown as import("@earendil-works/pi-coding-agent").AgentSession;
}

export function createSubscribableSession(messages: any[] = []) {
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

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export function getRenderedLine(lines: string[], match: (plain: string) => boolean): string {
	const line = lines.find(candidate => match(stripAnsi(candidate)));
	assert.ok(line);
	return line;
}

export function getLineContaining(lines: string[], text: string): string {
	const line = lines.find(candidate => candidate.includes(text));
	assert.ok(line);
	return line;
}

export function assertShellBackgroundPreserved(line: string): void {
	assert.equal(line.includes("\u001b[0m"), false);
	assert.match(line, /\u001b\[48;/);
}

export function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

type Handler = (args: any, ctx: any) => any;

export function createTestPI() {
	const _handlers = new Map<string, any[]>();
	const _tools = new Map<string, any>();
	const _commands = new Map<string, any>();
	const _activeTools: string[] = [];
	const _allToolNames: string[] = [];
	const _toolSources = new Map<string, string>();
	const _sentUserMessages: Array<{ content: string; options: any }> = [];
	const _appendedEntries: Array<{ customType: string; data: any }> = [];

	const obj = {
		registerCommand: (name: string, def: any) => { _commands.set(name, def); },
		registerTool: (def: any) => { _tools.set(def.name, def); },
		on: (event: string, handler: any) => {
			const h = _handlers.get(event) ?? [];
			h.push(handler);
			_handlers.set(event, h);
		},
		getActiveTools: () => [..._activeTools],
		getAllTools: () =>
			(_allToolNames.length ? _allToolNames : [..._activeTools]).map((name) => ({
				name,
				description: "",
				parameters: {},
				sourceInfo: {
					path: `<${_toolSources.get(name) ?? "builtin"}:${name}>`,
					source: _toolSources.get(name) ?? "builtin",
					scope: "temporary" as const,
					origin: "top-level" as const,
				},
			})),
		getThinkingLevel: () => "medium" as const,
		setThinkingLevel: () => {},
		sendUserMessage: (content: string, options?: any) => {
			_sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data: any) => {
			_appendedEntries.push({ customType, data });
		},
		setActiveTools: (tools: string[]) => {
			_activeTools.length = 0;
			_activeTools.push(...tools);
			for (const tool of tools) {
				if (!_toolSources.has(tool)) _toolSources.set(tool, "builtin");
			}
		},
		setToolSource: (name: string, source: string) => {
			_toolSources.set(name, source);
		},
		setAllTools: (tools: string[]) => {
			_allToolNames.length = 0;
			_allToolNames.push(...tools);
			for (const tool of tools) {
				if (!_toolSources.has(tool)) _toolSources.set(tool, "builtin");
			}
		},
		sendMessage: () => Promise.resolve(),
		setSessionName: () => {},
		getSessionName: () => undefined,
		exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", code: 0, killed: false, signal: null } as any),
		getCommands: () => [],
		setModel: () => Promise.resolve(true),
		registerProvider: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		setLabel: () => {},
		unregisterProvider: () => {},
		events: { on: () => () => {}, emit: () => {} } as import("@earendil-works/pi-coding-agent").EventBus,
		setEditorText: () => {},
		get commands() { return _commands; },
		get tools() { return _tools; },
		get handlers() { return _handlers; },
		get activeTools() { return _activeTools; },
		set activeTools(tools: string[]) {
			_activeTools.length = 0;
			_activeTools.push(...tools);
		},
		get sentUserMessages() { return _sentUserMessages; },
		get appendedEntries() { return _appendedEntries; },
		get allToolNames() { return _allToolNames; },
		get toolSources() { return _toolSources; },
	};
	return obj;
}

// ── ExtensionAPI compile-time check ──────────────────────────────
// If ExtensionAPI adds new required members, this fails at compile
// time — forcing the test PI factory to be updated in sync.
type _TestPICoversExtensionAPI = typeof createTestPI extends () => import("@earendil-works/pi-coding-agent").ExtensionAPI ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _testPIVerified: _TestPICoversExtensionAPI = true;

export const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createTestAssistantMessage(model: any, content: any[], stopReason = "stop") {
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

export function createTestAssistantStream(message: any): any {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", reason: message.stopReason, message };
		},
		result: async () => message,
	};
}

export function messageText(message: any): string {
	return (message.content ?? [])
		.map((block: any) => block.type === "text" ? block.text : JSON.stringify(block))
		.join("\n");
}

// ── TUI context factory ───────────────────────────────────────────────

export function makeTUICtx(
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
