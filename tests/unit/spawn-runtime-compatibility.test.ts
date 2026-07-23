import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import { createState } from "../../state.js";
import { executeSpawn, registerSpawnTool } from "../../spawn/index.js";
import { createTestPI } from "./helpers.js";

async function runRealChildInvocation(params: { prompt: string; thinking?: "max" }) {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-agenticoding-runtime-"));
	const cwd = join(tempRoot, "project");
	const agentDir = join(tempRoot, "agent");
	const extensionDir = join(cwd, ".pi", "extensions");
	const sentinel = "AGENTIC_E2E_PROBE_OK";
	const provider = "agentic-e2e";
	const modelId = "agentic-e2e-model";
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
	const previousPiOffline = process.env.PI_OFFLINE;
	const previousFetch = globalThis.fetch;
	const outboundFetches: string[] = [];

	try {
		await mkdir(extensionDir, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(extensionDir, "agentic-e2e-probe.js"),
			`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export default function(pi) {
	pi.registerProvider("${provider}", {
		api: "agentic-e2e-api", apiKey: "test-key", baseUrl: "http://localhost.invalid",
		models: [{
			id: "${modelId}", name: "Agentic E2E Model", reasoning: false,
			input: ["text"], cost: usage.cost, contextWindow: 128000, maxTokens: 1024,
		}],
		streamSimple(model, context) {
			globalThis.__agenticE2eStreamCalls = (globalThis.__agenticE2eStreamCalls ?? 0) + 1;
			const toolResult = context.messages.find((message) =>
				message.role === "toolResult" && message.toolName === "agentic_e2e_probe"
			);
			const content = toolResult
				? [{ type: "text", text: model.provider + "/" + model.id + ":${sentinel}" }]
				: [{ type: "toolCall", id: "probe-call-1", name: "agentic_e2e_probe", arguments: {} }];
			const message = {
				role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage, stopReason: toolResult ? "stop" : "toolUse", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
	pi.registerTool({
		name: "agentic_e2e_probe", label: "Agentic E2E Probe",
		description: "Return the deterministic compatibility sentinel.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			globalThis.__agenticE2eProbeCalls = (globalThis.__agenticE2eProbeCalls ?? 0) + 1;
			return { content: [{ type: "text", text: "${sentinel}" }], details: {} };
		},
	});
}
`,
		);

		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.OPENAI_API_KEY = "test-openai-key";
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			outboundFetches.push(input instanceof Request ? input.url : String(input));
			throw new Error(`offline fixture blocked outbound fetch: ${outboundFetches.at(-1)}`);
		}) as typeof fetch;
		(globalThis as any).__agenticE2eProbeCalls = 0;
		(globalThis as any).__agenticE2eStreamCalls = 0;
		const model = {
			id: modelId, name: "Agentic E2E Model", api: "agentic-e2e-api", provider,
			reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 1024,
		};
		const pi = createTestPI();
		pi.setToolSource("agentic_e2e_probe", "project");
		pi.setActiveTools(["read", "agentic_e2e_probe", "spawn"]);
		pi.setAllTools(["read", "agentic_e2e_probe", "spawn"]);
		registerSpawnTool(pi as any, createState());
		const result = await pi.tools.get("spawn").execute(
			`spawn-${params.thinking ?? "inherited"}`,
			params,
			undefined,
			undefined,
			{ model, cwd },
		);
		return {
			result,
			expectedText: `${provider}/${modelId}:${sentinel}`,
			modelId,
			probeCalls: (globalThis as any).__agenticE2eProbeCalls,
			streamCalls: (globalThis as any).__agenticE2eStreamCalls,
			outboundFetches,
		};
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousPiOffline;
		globalThis.fetch = previousFetch;
		delete (globalThis as any).__agenticE2eProbeCalls;
		delete (globalThis as any).__agenticE2eStreamCalls;
		await rm(tempRoot, { recursive: true, force: true });
	}
}

test("exact Pi floor real child completes through inherited/default thinking", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	assert.equal(proof.result.content[0].text, proof.expectedText);
	assert.equal(proof.result.details.model, proof.modelId);
	assert.equal(proof.probeCalls, 1);
	assert.equal(proof.streamCalls, 2);
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});

test("exact Pi floor real child preserves selected identity and reports effective thinking", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	assert.equal(proof.result.content[0].text, proof.expectedText);
	assert.equal(proof.result.details.model, proof.modelId);
	assert.equal(proof.result.details.thinking, "off", "non-reasoning model clamps requested max to off");
	assert.equal(proof.probeCalls, 1);
	assert.equal(proof.streamCalls, 2);
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});

test("spawn routes through the public registry but uses only the selected-model child session boundary", async () => {
	const source = await readFile(new URL("../../spawn/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bAuthStorage\b|\bModelRegistry\b/);
	assert.doesNotMatch(source, /\bauthStorage\s*:/);
	assert.doesNotMatch(source, /sessionFactory\(\{[\s\S]*?\bmodelRegistry\s*:/);
	assert.doesNotMatch(source, /modelRuntime\s*[:.]|as\s+any[^\n]*(?:auth|runtime)/i);
	assert.match(source, /modelRegistry:\s*ctx\.modelRegistry/);
	assert.match(source, /model:\s*childModel/);
});

test("spawn accepts max and forwards the public ctx.model unchanged", async () => {
	const pi = createTestPI();
	const state = createState();
	const model = { id: "selected-model", provider: "selected-provider" };
	const requestedCwd = "/tmp";
	let options: any;
	const session = {
		messages: [] as any[],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		},
		abort: async () => {},
		dispose: () => {},
		getSessionStats: () => undefined,
	};
	registerSpawnTool(pi as any, state, async (value: any) => {
		options = value;
		return { session: session as any, extensionsResult: undefined as any };
	});
	const tool = pi.tools.get("spawn");
	const schemaText = JSON.stringify(tool.parameters);
	assert.match(schemaText, /max/);
	assert.equal(Value.Check(tool.parameters, { prompt: "work" }), true, "registered schema accepts inherited/default thinking");
	assert.equal(
		Value.Check(tool.parameters, { prompt: "work", group: "review", thinking: "max" }),
		true,
		"registered schema composes Model Group routing with explicit thinking",
	);
	await tool.execute("spawn-max", { prompt: "work", thinking: "max" }, undefined, undefined, {
		model,
		cwd: requestedCwd,
	});
	assert.equal(options.model, model);
	assert.equal(options.thinkingLevel, "max");
	assert.equal(options.cwd, requestedCwd);
	assert.equal(options.sessionManager.getCwd(), resolve(requestedCwd));
});

test("selected-model creation failure remains authoritative and never attempts a fallback model", async () => {
	const pi = createTestPI();
	const state = createState();
	const selectedModel = { id: "transient-model", provider: "transient-provider" };
	const fallbackModel = { id: "fallback-model", provider: "fallback-provider" };
	const sentinel = new Error("selected model unavailable sentinel");
	const attemptedModels: unknown[] = [];

	await assert.rejects(
		() => executeSpawn(
			"spawn-no-fallback", pi as any, { model: selectedModel, cwd: "/tmp" } as any, state,
			{ prompt: "work" }, undefined, undefined, "medium",
			async (options: any) => {
				attemptedModels.push(options.model);
				if (options.model === fallbackModel) throw new Error("fallback sentinel reached");
				throw sentinel;
			},
		),
		(error: unknown) => error === sentinel,
	);
	assert.deepEqual(attemptedModels, [selectedModel]);
});

test("a parent-transient selected model fails explicitly in the real child runtime without fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agenticoding-transient-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = createTestPI();
		const state = createState();
		const model = {
			id: "transient-model",
			name: "Transient Parent Model",
			provider: "transient-parent",
			api: "transient-parent-api",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		};
		await assert.rejects(
			() => executeSpawn(
				"spawn-transient", pi as any, { model, cwd } as any, state,
				{ prompt: "work" }, undefined, undefined, "medium",
			),
			/error|provider|auth|transient|model/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
