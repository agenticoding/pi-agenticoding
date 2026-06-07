import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createState, resetState } from "../../state.js";
import {
	buildChildToolNames,
	createChildTools,
	executeSpawn,
	registerSpawnTool,
} from "../../spawn/index.js";
import { renderSpawnResult, flushSpawnFrameScheduler } from "../../spawn/renderer.js";
import { createTestPI, theme, ansiTheme, createRenderContext, createSession, createSubscribableSession, stripAnsi, getRenderedLine, getLineContaining, assertShellBackgroundPreserved, createDeferred, createTestAssistantMessage, createTestAssistantStream, messageText, makeTUICtx } from "./helpers.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

let h: TestHarness;

function makeChildSpawnTool(state: any) {
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
});

afterEach(() => {
	h.teardown();
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

		const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

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
		assert.equal(h.warnings.length, 1);
		assert.match(String(h.warnings[0].args[1]), /stats failed/);
		assert.equal(h.warnings[0].args[2], "spawn-1");

});

test("spawn execute throws when child produces no output", async () => {
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
	const state = createState();
	registerSpawnTool(pi as any, state);
	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { cwd: "/tmp" }),
		/No model configured\. Cannot spawn child agent\./,
	);
});

test("child tool names inherit active registered builtins and exclude recursive controls", () => {
	const state = createState();
	const childTools = createChildTools(createTestPI() as any, state);
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

	const pi = createTestPI();
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

	const pi = createTestPI();
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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
	const childTools = createChildTools(createTestPI() as any, state);

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
	const childTools = createChildTools(createTestPI() as any, state);

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
	const childTools = createChildTools(createTestPI() as any, state);

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



test("nested spawn live action tracks tool execution events", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

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

});

test("nested spawn handleEvent recovers from malformed events", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Emit a malformed event that will throw inside handleEvent
	emit({ type: "message_start", message: null });
	assert.equal(h.warnings.length, 1);
	assert.match(String(h.warnings[0].args[1]), /message_start/);

	// Subsequent valid events still process
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("thinking")), `expected thinking after recovery, got: ${lines.join("\n")}`);

});

test("nested spawn message_end with aborted stopReason clears pending tools", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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


test("nested spawn invalidate rebuilds from the attached session transcript", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
		assert.equal(h.warnings.length, 0);

});

test("nested spawn attachSession recovers from subscribe throwing", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);

	// Session whose subscribe() throws
	const throwingSession = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
		subscribe: () => { throw new Error("subscribe failed"); },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", throwingSession);

		const component = childSpawnTool.renderResult(
			{ content: [], details: { model: "m", thinking: "low", truncated: false } },
			{ expanded: false },
			theme,
			createRenderContext(),
		) as any;

		// Should not crash, session attached, ownership transferred
		assert.equal(state.childSessions.has("tool-call-1"), false);
		assert.equal(h.warnings.length, 1);
		assert.match(String(h.warnings[0].args[0]), /Failed to subscribe/);

		// Should still render from session messages despite subscribe failure
		const lines = component.render(120);
		assert.ok(lines.some((l: string) => l.includes("hello")));

});

test("nested spawn rapid events collapse to last state", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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

// Verifies pendingToolCallCreations accumulation: the last streamed args
// overwrite on each message_update before the first frame flush.
//
// Uses a spy on createToolComponent because ToolExecutionComponent (from
// pi-tui) cannot be constructed in the unit test environment. The spy wraps
// the real method to capture args while preserving the original behavior
// (which will gracefully return undefined when construction fails).
test("nested spawn uses the latest streamed tool-call args before first frame flush", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: true },
		theme,
		createRenderContext(),
	) as any;

	// Spy on createToolComponent to capture args while preserving original behavior
	let createdArgs: any;
	const original = component.createToolComponent.bind(component);
	component.createToolComponent = (toolName: string, toolCallId: string, args: any) => {
		createdArgs = args;
		return original(toolName, toolCallId, args);
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
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Bad event triggers an error in handleMessageStart (null message)
	// catch block must call resetRenderBatching() so the flag resets
	emit({ type: "message_start", message: null } as any);

	// Good event after error — should still schedule and render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("thinking")),
		"error recovery should allow subsequent events to render");
	assert.equal(h.warnings.length, 1);
	assert.match(String(h.warnings[0].args[0]), /Event handler error/);

});

test("nested spawn processes stale-state events without invalidating the parent", async () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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

test("spawn tool definitions include prompt hints when registered", () => {
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const pi = createTestPI();
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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
	const childSpawnTool = makeChildSpawnTool(state);
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
	const pi = createTestPI();
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
