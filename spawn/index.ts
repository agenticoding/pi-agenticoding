/**
 * Spawn tool for the agenticoding extension.
 *
 * Creates an isolated in-memory child AgentSession for focused subtask execution.
 * Children inherit the parent's model, thinking level, cwd, and notebook access.
 * Children do not inherit the spawn tool (recursion prevention).
 *
 * Spawn is context isolation, not a security boundary. Child agents are trusted
 * extensions of the parent and inherit parent authority by design.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgenticodingState } from "../state.js";
import { formatPageList } from "../notebook/store.js";
import { createNotebookToolDefinitions } from "../notebook/tools.js";
import {
	renderSpawnCall,
	renderSpawnResult,
} from "./renderer.js";
import {
	getLastAssistantText,
	type SpawnOutcome,
	type SpawnResultDetails,
	type ThinkingValue,
} from "./shared.js";

// ── Constants ─────────────────────────────────────────────────────────

const CHILD_MAX_LINES = 2000;
const CHILD_MAX_BYTES = 50 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────

type AssistantMessageLike = {
	role: string;
	content?: { type: string; text?: string }[];
	stopReason?: unknown;
};

function getLastAssistantMessage(messages: AssistantMessageLike[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

function getLastAssistantOutcome(messages: AssistantMessageLike[]): SpawnOutcome {
	const stopReason = getLastAssistantMessage(messages)?.stopReason;
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return "success";
}

/**
 * Truncates text to stay within maxLines/maxBytes.
 * Line-count limit is applied first, then byte limit.
 * May end mid-line if the byte limit is the tighter constraint.
 */
function truncateText(text: string, maxLines: number, maxBytes: number): string {
	const lines = text.split("\n");
	let truncated = lines.slice(0, maxLines).join("\n");
	if (new TextEncoder().encode(truncated).length > maxBytes) {
		truncated = new TextDecoder().decode(
			new TextEncoder().encode(truncated).slice(0, maxBytes),
		);
	}
	return truncated;
}

/**
 * Truncates child agent output to CHILD_MAX_LINES lines / CHILD_MAX_BYTES bytes.
 * Appends a "[Result truncated...]" advisory when truncation occurs.
 * Returns { text, truncated }.
 */
function truncateResult(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const bytes = new TextEncoder().encode(text).length;

	if (lines.length <= CHILD_MAX_LINES && bytes <= CHILD_MAX_BYTES) {
		return { text, truncated: false };
	}

	const truncated = truncateText(text, CHILD_MAX_LINES, CHILD_MAX_BYTES);
	return {
		text:
			truncated +
			`\n\n[Result truncated to ${CHILD_MAX_LINES} lines / ${(CHILD_MAX_BYTES / 1024).toFixed(0)}KB. ` +
			`Ask the child to summarize further if needed.]`,
		truncated: true,
	};
}


/**
 * Build the final list of tool names for a child session.
 *
 * Child sessions inherit the parent's active built-in tools plus the local
 * child custom tools defined here. Parent-only custom tools are intentionally
 * excluded so the child never advertises a tool it cannot execute.
 *
 * handoff and spawn never carry into children.
 */
function getInheritableParentToolNames(parentToolNames: string[], availableTools: Pick<ToolInfo, "name" | "sourceInfo">[]): string[] {
	const activeToolNames = new Set(parentToolNames);
	return availableTools
		.filter((tool) => activeToolNames.has(tool.name) && tool.sourceInfo?.source === "builtin")
		.map((tool) => tool.name);
}

export function buildChildToolNames(
	parentToolNames: string[],
	childTools: ToolDefinition[],
	availableTools?: Pick<ToolInfo, "name" | "sourceInfo">[],
): string[] {
	const inheritableParentToolNames = availableTools
		? getInheritableParentToolNames(parentToolNames, availableTools)
		: parentToolNames;
	const inheritedTools = inheritableParentToolNames.filter((name) => name !== "spawn" && name !== "handoff");
	return [...new Set([...inheritedTools, ...childTools.map((tool) => tool.name)])];
}

// ── Spawn tool metadata ──

const SPAWN_DESCRIPTION =
	"Spawn an isolated child agent for a focused subtask. " +
	"Child inherits parent model, thinking level, cwd, supported built-in tools, and shared notebook tools; children cannot spawn further children. " +
	"Reference notebook pages by name — child will notebook_read them on demand.";

const SPAWN_PROMPT_SNIPPET = "Spawn a focused subtask agent";

const SPAWN_PROMPT_GUIDELINES = [
	"Use spawn to delegate isolated work to child agents. They are trusted extensions of you with their own context and the same authority. Only condensed results are returned.",
];

const SPAWN_PARAMETERS = Type.Object({
	prompt: Type.String({
		description:
			"Self-contained task description. Reference notebook pages by name — " +
			"child will notebook_read them on demand.",
	}),
	thinking: StringEnum(
		["off", "minimal", "low", "medium", "high", "xhigh"] as const,
		{
			description:
				"Override child thinking level. Inherits parent by default.",
		},
	),
});



/**
 * Build the custom tool set for child agent sessions.
 *
 * Produces notebook tools (write/read/index). Children do not receive the spawn
 * tool to prevent the LLM from attempting recursion.
 *
 * All tools read/write the shared parent state so notebook pages are visible
 * across parent and child contexts.
 */
export function createChildTools(
	pi: ExtensionAPI,
	state: AgenticodingState,
	options?: { isStale?: () => boolean },
): ToolDefinition[] {
	return createNotebookToolDefinitions(pi, state, { isStale: options?.isStale });
}



// ── Shared spawn execution logic ──────────────────────────────────────

/**
 * Creates an isolated child agent session, runs the given prompt, and returns
 * the result with usage stats.
 *
 * Error: "No model configured..." → ctx.model is undefined
 *
 * Side effects on state:
 *   - state.childSessions.set(toolCallId, session) on creation
 *   - state.liveChildSessions.set(toolCallId, session) on creation
 *   - both registries delete(toolCallId) on error and completion paths
 *
 * @param sessionFactory - Test seam for mocking createAgentSession.
 */
export async function executeSpawn(
	toolCallId: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: AgenticodingState,
	params: { prompt: string; thinking?: ThinkingValue },
	signal: AbortSignal | undefined,
	onUpdate:
		| ((result: {
				content: { type: string; text: string }[];
				details?: unknown;
		  }) => void)
		| undefined,
	defaultThinking: ThinkingValue,
	sessionFactory: typeof createAgentSession = createAgentSession,
) {

	const childModel = ctx.model;
	if (!childModel) {
		throw new Error("No model configured. Cannot spawn child agent.");
	}

	const childThinking: ThinkingValue = params.thinking ?? defaultThinking;

	const listing = formatPageList(state);
	const notebookListing = listing
		? "Available notebook pages:\n" + listing
		: "No notebook pages.";
	const fullPrompt =
		`You are a focused child agent spawned by a parent agent. ` +
		`You have the same authority as the parent. ` +
		`Children cannot spawn further children. ` +
		`Your result will be read by the parent, so be concise and complete.\n\n` +
		`${notebookListing}\n\n` +
		`If you write notebook pages, store only durable grounding knowledge for future contexts. ` +
		`Keep transient task state in your final reply to the parent.\n\n` +
		`## Task\n\n${params.prompt}\n\n` +
		`When complete, provide a concise summary of findings. ` +
		`Keep the result under ${CHILD_MAX_LINES} lines / ${(CHILD_MAX_BYTES / 1024).toFixed(0)}KB.`;

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const childSessionEpoch = state.childSessionEpoch;
	const isStale = () => state.childSessionEpoch !== childSessionEpoch;
	const childTools = createChildTools(pi, state, { isStale });
	const parentToolNames = pi.getActiveTools();
	const childToolNames = buildChildToolNames(parentToolNames, childTools, pi.getAllTools());

	const { session } = await sessionFactory({
		sessionManager: SessionManager.inMemory(),
		model: childModel,
		thinkingLevel: childThinking,
		cwd: ctx.cwd,
		tools: childToolNames,
		customTools: childTools,
		authStorage,
		modelRegistry,
	});

	const invalidatedError = new Error("Spawn invalidated by reset.");
	let wasAborted = false;
	const abortChild = () => {
		wasAborted = true;
		session.abort().catch(e => console.error("[spawn] abort failed:", toolCallId, e));
	};
	const clearChildSession = () => {
		if (state.childSessions.get(toolCallId) === session) {
			state.childSessions.delete(toolCallId);
		}
		if (state.liveChildSessions.get(toolCallId) === session) {
			state.liveChildSessions.delete(toolCallId);
		}
	};
	const abortAndInvalidate = async () => {
		clearChildSession();
		await session.abort().catch(e => console.error("[spawn] abort failed:", toolCallId, e));
		throw invalidatedError;
	};

	if (isStale()) {
		await abortAndInvalidate();
	}

	// liveChildSessions must be set before childSessions so the renderer can
	// attach with a fully-published live ownership record.
	state.liveChildSessions.set(toolCallId, session);
	state.childSessions.set(toolCallId, session);

	try {
		if (signal?.aborted) {
			wasAborted = true;
			await session.abort();
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Spawn aborted before child session started.");
		}

		if (isStale()) {
			await abortAndInvalidate();
		}

		onUpdate?.({
			content: [],
			details: {
				model: childModel.id,
				thinking: childThinking,
				truncated: false,
				outcome: "running",
			} satisfies SpawnResultDetails,
		});

		signal?.addEventListener("abort", abortChild, { once: true });
		await session.prompt(fullPrompt);
	} catch (error) {
		clearChildSession();
		if (isStale()) {
			throw invalidatedError;
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", abortChild);
	}

	if (isStale()) {
		clearChildSession();
		throw invalidatedError;
	}

	const resultText = getLastAssistantText(session.messages);
	if (!resultText) {
		clearChildSession();
		throw new Error("Child agent produced no output.");
	}
	const outcome = wasAborted ? "aborted" : getLastAssistantOutcome(session.messages);
	const { text: finalText, truncated } = truncateResult(resultText);

	// Execution should not retain live children after completion. If the TUI
	// already rendered the child, it still owns the session object itself.
	// Clearing here intentionally makes the component's dispose() a no-op for
	// liveChildSessions — the child already completed so there's nothing to abort.
	clearChildSession();

	let stats: Record<string, number> | undefined;
	let statsUnavailable = false;
	try {
		const sessionStats = session.getSessionStats();
		if (sessionStats) {
			stats = {
				inputTokens: sessionStats.tokens?.input ?? 0,
				outputTokens: sessionStats.tokens?.output ?? 0,
				cacheReadTokens: sessionStats.tokens?.cacheRead ?? 0,
				cacheWriteTokens: sessionStats.tokens?.cacheWrite ?? 0,
				totalTokens: sessionStats.tokens?.total ?? 0,
				cost: sessionStats.cost ?? 0,
				turns: sessionStats.assistantMessages ?? 0,
			};
		}
	} catch (error: unknown) {
		statsUnavailable = true;
		console.warn("[spawn] Failed to collect child session stats:", error, toolCallId);
	}

	if (isStale()) {
		throw invalidatedError;
	}

	const details: SpawnResultDetails = {
		model: childModel.id,
		thinking: childThinking,
		truncated,
		outcome,
	};
	if (stats) {
		details.stats = stats;
	} else if (statsUnavailable) {
		details.statsUnavailable = true;
	}

	return {
		content: [{ type: "text" as const, text: finalText }],
		details,
	};
}

/**
 * Register the spawn tool with pi's tool system.
 *
 * Creates a ToolDefinition that spawns an isolated child AgentSession
 * for focused subtasks. Children inherit the parent model, thinking
 * level, cwd, and notebook access.
 *
 * @param pi - Extension API instance for tool registration
 * @param state - Shared session state (child sessions, epoch, notebook)
 * @param sessionFactory - Optional test seam for mocking createAgentSession
 */
export function registerSpawnTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
	sessionFactory: typeof createAgentSession = createAgentSession,
): void {
	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description: SPAWN_DESCRIPTION,
		promptSnippet: SPAWN_PROMPT_SNIPPET,
		promptGuidelines: SPAWN_PROMPT_GUIDELINES,
		parameters: SPAWN_PARAMETERS,
		renderShell: "self",

		async execute(
			_toolCallId: string,
			params: { prompt: string; thinking?: ThinkingValue },
			signal: AbortSignal | undefined,
			onUpdate:
				| ((result: {
						content: { type: string; text: string }[];
						details?: unknown;
				  }) => void)
				| undefined,
			ctx: ExtensionContext,
		) {
			const parentThinking: ThinkingValue = pi.getThinkingLevel();
			return executeSpawn(_toolCallId, pi, ctx, state, params, signal, onUpdate, parentThinking, sessionFactory);
		},

		renderCall: renderSpawnCall,

		renderResult(result, { expanded }, theme, context) {
			return renderSpawnResult(result, expanded, theme, context, state);
		},
	});
}
