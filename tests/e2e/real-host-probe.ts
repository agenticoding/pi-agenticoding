/**
 * real-host-probe.ts — Probe extension loaded into the real pi CLI by the
 * real-host E2E harness (`real-host.ts`).
 *
 * Registers a scripted provider whose responses the test arms through
 * `/e2e-script`, plus commands that drain runs, navigate the tree, start runs
 * without a user turn, and inject delivery and compaction failures. Every
 * observation is appended as one JSON line to `PI_SCHEMATIC_E2E_PROBE_LOG`.
 *
 * Runs inside the pi process: never write to stdout or stderr here.
 */

import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ScriptedCall = { name: string; arguments: ToolCall["arguments"] };

const PROVIDER = "schematic-e2e";
const API = "schematic-e2e-api";
const MODEL_ID = "schematic-e2e-model";
const NEXT_INSTRUCTION_PREFIX = "## Next instruction";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
// Above MIN_HANDOFF_TOKENS (handoff/eligibility.ts) whatever the context size.
const usage = {
	input: 50000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50000,
	cost: zeroCost,
};

function parseScript(args: string): ScriptedCall[] {
	const parsed: unknown = JSON.parse(args);
	if (!Array.isArray(parsed)) throw new Error(`/e2e-script expects a JSON array, got: ${args}`);
	return parsed.map((call: unknown, index) => {
		if (typeof call !== "object" || call === null) throw new Error(`/e2e-script call ${index} is not an object`);
		const { name, arguments: callArguments } = call as Record<string, unknown>;
		if (typeof name !== "string" || !name) throw new Error(`/e2e-script call ${index} has no name`);
		if (typeof callArguments !== "object" || callArguments === null || Array.isArray(callArguments)) {
			throw new Error(`/e2e-script call ${index} has no arguments object`);
		}
		// JSON.parse output: every value is JSON.
		return { name, arguments: callArguments as ToolCall["arguments"] };
	});
}

/** Text of every context message: block arrays reduced to their text blocks, strings as is. */
function contextTexts(messages: ReadonlyArray<{ content?: unknown }>): string[] {
	return messages.flatMap((message) => {
		const content = message.content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text);
		}
		return typeof content === "string" ? [content] : [];
	});
}

export default function realHostProbe(pi: ExtensionAPI): void {
	const logPath = process.env.PI_SCHEMATIC_E2E_PROBE_LOG;
	if (!logPath) throw new Error("PI_SCHEMATIC_E2E_PROBE_LOG is not set");
	const log = (record: Record<string, unknown>) => appendFileSync(logPath, JSON.stringify(record) + "\n");

	let armedScript: ScriptedCall[] | null = null;
	let runScript: ScriptedCall[] | null = null;
	let step = 0;
	let runEntryCount = 0;
	let dropNextSuccessor = false;
	let cancelNextCompaction = false;

	pi.registerProvider(PROVIDER, {
		api: API, apiKey: "test-key", baseUrl: "http://localhost.invalid",
		models: [{
			id: MODEL_ID, name: "Schematic E2E Model", reasoning: false,
			input: ["text"], cost: zeroCost, contextWindow: 200000, maxTokens: 1024,
		}],
		streamSimple(model, context) {
			const i = step++;
			log({ kind: "request", step: i, calls: runScript, texts: contextTexts(context.messages) });
			const id = `e2e-${runEntryCount}-${i}`;
			const toolCall: ToolCall | null = runScript
				? i < runScript.length ? { type: "toolCall", id, ...runScript[i] } : null
				: i === 0 ? { type: "toolCall", id, name: "e2e_noop", arguments: {} } : null;
			const stopReason = toolCall ? "toolUse" : "stop";
			const message: AssistantMessage = {
				role: "assistant",
				content: toolCall ? [toolCall] : [{ type: "text", text: "ack" }],
				api: model.api, provider: model.provider, model: model.id,
				usage, stopReason, timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			});
			return stream;
		},
	});

	pi.registerTool({
		name: "e2e_noop",
		label: "E2E noop",
		description: "Does nothing and returns noop.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "noop" }], details: {} };
		},
	});

	pi.on("agent_start", async (_event, ctx) => {
		runScript = armedScript;
		armedScript = null;
		step = 0;
		runEntryCount = ctx.sessionManager.getEntries().length;
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension" || !event.text.startsWith(NEXT_INSTRUCTION_PREFIX)) return { action: "continue" };
		const dropped = dropNextSuccessor;
		dropNextSuccessor = false;
		log({ kind: "successor-send", text: event.text, dropped });
		return dropped ? { action: "handled" } : { action: "continue" };
	});

	pi.on("session_before_compact", async () => {
		if (!cancelNextCompaction) return;
		cancelNextCompaction = false;
		return { cancel: true };
	});

	pi.on("session_compact", async (event) => {
		log({ kind: "compact", entryId: event.compactionEntry.id });
	});

	pi.registerCommand("e2e-script", {
		description: "Arm a scripted tool-call sequence for the next run",
		handler: async (args) => {
			if (armedScript) throw new Error(`a script is already armed: ${JSON.stringify(armedScript)}`);
			armedScript = parseScript(args);
		},
	});

	pi.registerCommand("e2e-barrier", {
		description: "Return once every run, deferred settled action and queued message has drained",
		handler: async (_args, ctx) => {
			for (;;) {
				await ctx.waitForIdle();
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (ctx.isIdle() && !ctx.hasPendingMessages()) return;
			}
		},
	});

	pi.registerCommand("e2e-tree", {
		description: "Navigate the session tree to an entry",
		handler: async (args, ctx) => {
			const entryId = args.trim();
			if (!entryId) throw new Error("/e2e-tree needs an entry id");
			await ctx.navigateTree(entryId);
		},
	});

	pi.registerCommand("e2e-turn", {
		description: "Start a run without a user turn",
		handler: async () => {
			pi.sendMessage({ customType: "schematic-e2e-turn", content: "e2e tick", display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand("e2e-drop-next-successor", {
		description: "Drop the next successor send before it reaches the session",
		handler: async () => {
			dropNextSuccessor = true;
		},
	});

	pi.registerCommand("e2e-cancel-next-compaction", {
		description: "Cancel the next compaction from session_before_compact",
		handler: async () => {
			cancelNextCompaction = true;
		},
	});

	pi.registerCommand("e2e-tools", {
		description: "Log the names of every registered tool",
		handler: async () => {
			log({ kind: "tools", names: pi.getAllTools().map((tool) => tool.name) });
		},
	});
}
