/**
 * Spawn tool for the agenticoding extension.
 *
 * Creates an isolated in-memory child AgentSession for focused subtask execution.
 * Children inherit the parent's model, thinking level, cwd, and ledger access.
 * Max nesting depth: 2 edges (parent → child → grandchild).
 *
 * Spawn is context isolation, not a security boundary. Child agents are trusted
 * extensions of the parent and inherit parent authority by design.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	AgentSession,
	AssistantMessageComponent,
	AuthStorage,
	BashExecutionComponent,
	createAgentSession,
	CustomMessageComponent,
	getMarkdownTheme,
	keyHint,
	ModelRegistry,
	parseSkillBlock,
	SessionManager,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgenticodingState } from "../state.js";
import { saveLedgerEntry } from "../ledger/store.js";

// ── Constants ─────────────────────────────────────────────────────────

const MAX_SPAWN_DEPTH = 2;
const CHILD_MAX_LINES = 2000;
const CHILD_MAX_BYTES = 50 * 1024;

type ThinkingValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TextBlock = { type: string; text?: string };
type AssistantLikeMessage = {
	role?: string;
	content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
	stopReason?: string;
	errorMessage?: string;
};
type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
};
type SpawnResultDetails = {
	depth: number;
	model: string;
	thinking: ThinkingValue;
	truncated: boolean;
	stats?: Record<string, unknown>;
};

type ChildSessionRecord = {
	session: AgentSession;
};

const CHILD_SESSIONS = new Map<string, ChildSessionRecord>();

class NestedAgentSessionComponent extends Container {
	private session?: AgentSession;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private toolComponents = new Set<ToolExecutionComponent>();
	private streamingComponent?: AssistantMessageComponent;
	private streamingMessage?: AssistantLikeMessage;
	private unsubscribe?: () => void;
	private expanded = false;
	private showImages = true;
	private requestRender: () => void = () => {};
	private readonly markdownTheme = getMarkdownTheme();
	private readonly fakeUi = {
		requestRender: () => this.requestRender(),
	};

	setRequestRender(requestRender: () => void): void {
		this.requestRender = requestRender;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const component of this.toolComponents) {
			component.setExpanded(expanded);
		}
	}

	setShowImages(showImages: boolean): void {
		this.showImages = showImages;
		for (const component of this.toolComponents) {
			component.setShowImages(showImages);
		}
	}

	attachSession(session: AgentSession): void {
		if (this.session === session) {
			return;
		}

		this.unsubscribe?.();
		this.session = session;
		this.rebuildFromSession();
		this.unsubscribe = session.subscribe((event) => {
			this.handleEvent(event);
		});
	}

	override invalidate(): void {
		super.invalidate();
		if (this.session) {
			this.rebuildFromSession();
		}
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private addToolComponent(component: ToolExecutionComponent): void {
		component.setExpanded(this.expanded);
		component.setShowImages(this.showImages);
		this.toolComponents.add(component);
		this.addChild(component);
	}

	private createToolComponent(toolName: string, toolCallId: string, args: Record<string, unknown>): ToolExecutionComponent {
		return new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{ showImages: this.showImages },
			this.session?.getToolDefinition(toolName),
			this.fakeUi as never,
			this.session?.sessionManager.getCwd() ?? process.cwd(),
		);
	}

	private addMessageToChat(message: any): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.fakeUi as never, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, message.truncated ? { truncated: true } : undefined, message.fullOutputPath);
				this.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const component = new CustomMessageComponent(message, undefined, this.markdownTheme);
					component.setExpanded(this.expanded);
					this.addChild(component);
				}
				break;
			}
			case "user": {
				const blocks = Array.isArray(message.content) ? message.content : [];
				const text = blocks
					.filter((block: TextBlock) => block.type === "text" && typeof block.text === "string")
					.map((block: TextBlock) => block.text ?? "")
					.join("\n")
					.trim();
				if (!text) break;
				if (this.children.length > 0) {
					this.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(text);
				if (skillBlock) {
					const component = new SkillInvocationMessageComponent(skillBlock, this.markdownTheme);
					component.setExpanded(this.expanded);
					this.addChild(component);
					if (skillBlock.userMessage) {
						this.addChild(new UserMessageComponent(skillBlock.userMessage, this.markdownTheme));
					}
				} else {
					this.addChild(new UserMessageComponent(text, this.markdownTheme));
				}
				break;
			}
			case "assistant": {
				this.addChild(new AssistantMessageComponent(message, false, this.markdownTheme, "Thinking..."));
				break;
			}
			case "toolResult": {
				break;
			}
		}
	}

	private rebuildFromSession(): void {
		if (!this.session) return;

		this.clear();
		this.pendingTools.clear();
		this.toolComponents.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of this.session.messages as any[]) {
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				for (const content of message.content ?? []) {
					if (content.type !== "toolCall") continue;
					const component = this.createToolComponent(content.name, content.id, content.arguments ?? {});
					this.addToolComponent(component);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage = message.stopReason === "aborted"
							? message.errorMessage || "Operation aborted"
							: message.errorMessage || "Error";
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
				continue;
			}

			if (message.role === "toolResult") {
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
				continue;
			}

			this.addMessageToChat(message);
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
	}

	private handleEvent(event: any): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "custom" || event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.requestRender();
					return;
				}
				if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(undefined, false, this.markdownTheme, "Thinking...");
					this.streamingMessage = event.message;
					this.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message);
					this.requestRender();
				}
				return;
			case "message_update":
				if (!this.streamingComponent || event.message.role !== "assistant") return;
				this.streamingMessage = event.message;
				this.streamingComponent.updateContent(event.message);
				for (const content of event.message.content ?? []) {
					if (content.type !== "toolCall") continue;
					let component = this.pendingTools.get(content.id);
					if (!component) {
						component = this.createToolComponent(content.name, content.id, content.arguments ?? {});
						this.addToolComponent(component);
						this.pendingTools.set(content.id, component);
					} else {
						component.updateArgs(content.arguments ?? {});
					}
				}
				this.requestRender();
				return;
			case "message_end":
				if (!this.streamingComponent || event.message.role !== "assistant") return;
				this.streamingMessage = event.message;
				this.streamingComponent.updateContent(event.message);
				if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
					const errorMessage = event.message.stopReason === "aborted"
						? event.message.errorMessage || "Operation aborted"
						: event.message.errorMessage || "Error";
					for (const component of this.pendingTools.values()) {
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					}
					this.pendingTools.clear();
				} else {
					for (const component of this.pendingTools.values()) {
						component.setArgsComplete();
					}
				}
				this.streamingComponent = undefined;
				this.streamingMessage = undefined;
				this.requestRender();
				return;
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = this.createToolComponent(event.toolName, event.toolCallId, event.args ?? {});
					this.addToolComponent(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.requestRender();
				return;
			}
			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (!component) return;
				component.updateResult({ ...(event.partialResult as ToolResultLike), isError: false }, true);
				this.requestRender();
				return;
			}
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (!component) return;
				component.updateResult({ ...(event.result as ToolResultLike), isError: event.isError });
				this.pendingTools.delete(event.toolCallId);
				this.requestRender();
			}
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatLedgerListing(state: AgenticodingState): string {
	const names = Array.from(state.ledger.keys()).sort();
	if (names.length === 0) return "No ledger entries.";

	const lines = names.map((name) => {
		const content = state.ledger.get(name)!;
		const firstLine = content.split("\n")[0] ?? "";
		const preview =
			firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
		return `  ${name}: ${preview}`;
	});

	return `Available ledger entries:\n${lines.join("\n")}`;
}

function getLastAssistantText(messages: { role: string; content: { type: string; text?: string }[] }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					return block.text;
				}
			}
		}
	}
	return "";
}

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

function renderPromptPreview(prompt: string, expanded: boolean): { shown: string; remaining: number } {
	const lines = prompt.split("\n");
	const maxLines = expanded ? lines.length : 3;
	return {
		shown: lines.slice(0, maxLines).join("\n"),
		remaining: Math.max(0, lines.length - maxLines),
	};
}

const CHILD_BLOCKED_TOOLS = new Set(["handoff"]);

export function buildChildToolNames(parentToolNames: string[], childTools: ToolDefinition[]): string[] {
	const inheritedTools = parentToolNames.filter((name) => !CHILD_BLOCKED_TOOLS.has(name));
	return [...new Set([...inheritedTools, ...childTools.map((tool) => tool.name)])];
}

// ── Child tool factory ────────────────────────────────────────────────
// Builds the custom tool set for child/grandchild sessions.
// Reuses the shared parent state so ledger writes are visible across contexts.

export function createChildTools(
	pi: ExtensionAPI,
	state: AgenticodingState,
	defaultThinking: ThinkingValue,
	currentDepth: number,
): ToolDefinition[] {
	// Child sessions stay focused: they inherit normal worker tools and may recurse via spawn,
	// but handoff remains disabled so only the top-level agent can replace the active context.

	const childSpawnTool: ToolDefinition = {
		name: "spawn",
		label: "Spawn",
		description:
			"Spawn an isolated child agent for a focused subtask. " +
			"Child inherits parent model, thinking level, cwd, and ledger access. " +
			"Reference ledger entries by name — child will ledger_get them on demand.",
		promptSnippet: "Spawn a focused subtask agent",
		promptGuidelines: [
			"Use spawn to delegate isolated work to child agents. They are trusted extensions of you with their own context and the same authority. Only condensed results are returned.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task description. Reference ledger entries by name — " +
					"child will ledger_get them on demand.",
			}),
			thinking: StringEnum(
				["off", "minimal", "low", "medium", "high", "xhigh"] as const,
				{
					description:
						"Override child thinking level. Inherits parent by default.",
				},
			),
		}),
		async execute(
			toolCallId: string,
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
			return executeSpawn(toolCallId, pi, ctx, state, params, signal, onUpdate, defaultThinking, currentDepth);
		},
		renderCall(args, theme, context) {
			const prompt = typeof args.prompt === "string" ? args.prompt : "...";
			const { shown, remaining } = renderPromptPreview(prompt, context.expanded);
			let text = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", "child");
			if (typeof args.thinking === "string") {
				text += theme.fg("dim", ` [${args.thinking}]`);
			}
			text += `\n${theme.fg("dim", shown)}`;
			if (remaining > 0) {
				text += theme.fg("muted", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SpawnResultDetails | undefined;
			const component = (context.lastComponent as NestedAgentSessionComponent | undefined) ?? new NestedAgentSessionComponent();
			component.setRequestRender(context.invalidate);
			component.setExpanded(expanded);
			component.setShowImages(context.showImages);
			const child = CHILD_SESSIONS.get(context.toolCallId)?.session;
			if (child) {
				component.attachSession(child);
				return component;
			}

			const output = result.content
				.filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n\n")
				.trim();
			const summary = output || "(no output)";
			const meta = details ? `depth ${details.depth} • ${details.model} • ${details.thinking}` : "";
			return new Text(meta ? `${theme.fg("dim", meta)}\n${theme.fg("toolOutput", summary)}` : theme.fg("toolOutput", summary), 0, 0);
		},
	};

	// ── Child ledger_add ────────────────────────────────────────────
	const childLedgerAdd: ToolDefinition = {
		name: "ledger_add",
		label: "Ledger Add",
		description:
			"Save or refine a compact continuity entry. " +
			"Same name overwrites the previous entry (refinement). " +
			"Always returns the current list of up to date entries.",
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Kebab-case entry identifier. Using an existing name overwrites " +
					"that entry (refinement).",
			}),
			content: Type.String({
				description:
					"Compact markdown. Capture only reusable facts, decisions, " +
					"constraints, progress, and expensive discoveries. " +
					"Truncated at 50KB / 2000 lines.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { name: string; content: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const names = await saveLedgerEntry(pi, state, params.name, params.content);

			return {
				content: [
					{
						type: "text" as const,
						text: `Saved ledger entry "${params.name}".\n\n${formatLedgerListing(state)}`,
					},
				],
				details: { entries: names },
			};
		},
	};

	// ── Child ledger_get ────────────────────────────────────────────
	const childLedgerGet: ToolDefinition = {
		name: "ledger_get",
		label: "Ledger Get",
		description:
			"Retrieve a ledger entry's full body by name. " +
			"Always returns the current list of entry names.",
		parameters: Type.Object({
			name: Type.String({
				description: "Entry name to retrieve.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { name: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const content = state.ledger.get(params.name);
			const names = Array.from(state.ledger.keys()).sort();

			if (content === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Entry "${params.name}" not found.` +
								`\n\n${formatLedgerListing(state)}`,
						},
					],
					details: { entries: names, found: false },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`--- ${params.name} ---\n${content}\n` +
							`---\n${formatLedgerListing(state)}`,
					},
				],
				details: { entries: names, found: true },
			};
		},
	};

	// ── Child ledger_list ───────────────────────────────────────────
	const childLedgerList: ToolDefinition = {
		name: "ledger_list",
		label: "Ledger List",
		description:
			"List all ledger entries as name + first-line preview.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [
					{
						type: "text" as const,
						text: formatLedgerListing(state),
					},
				],
				details: { entries: Array.from(state.ledger.keys()).sort() },
			};
		},
	};

	return [childSpawnTool, childLedgerAdd, childLedgerGet, childLedgerList];
}

// ── Shared spawn execution logic ──────────────────────────────────────
// Used by both the parent-registered spawn tool and child custom spawn tools.

async function executeSpawn(
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
	currentDepth: number,
) {
	if (currentDepth >= MAX_SPAWN_DEPTH) {
		throw new Error(`Max spawn depth (${MAX_SPAWN_DEPTH}) reached. Cannot spawn further children.`);
	}

	const childModel = ctx.model;
	if (!childModel) {
		throw new Error("No model configured. Cannot spawn child agent.");
	}

	const childThinking: ThinkingValue = params.thinking ?? defaultThinking;
	const depth = currentDepth + 1;

	const ledgerListing = formatLedgerListing(state);
	const fullPrompt =
		`You are a focused child agent spawned by a parent agent. ` +
		`You have the same authority and tools as the parent. ` +
		`Your result will be read by the parent, so be concise and complete.\n\n` +
		`${ledgerListing}\n\n` +
		`## Task\n\n${params.prompt}\n\n` +
		`When complete, provide a concise summary of findings. ` +
		`Keep the result under ${CHILD_MAX_LINES} lines / ${(CHILD_MAX_BYTES / 1024).toFixed(0)}KB.`;

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const childTools = createChildTools(pi, state, childThinking, depth);
	const parentToolNames = pi.getActiveTools();
	const childToolNames = buildChildToolNames(parentToolNames, childTools);

	const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: childModel,
			thinkingLevel: childThinking,
			cwd: ctx.cwd,
			tools: childToolNames,
			customTools: childTools,
			authStorage,
			modelRegistry,
		});

		CHILD_SESSIONS.set(toolCallId, { session });
		onUpdate?.({
			content: [],
			details: {
				depth,
				model: childModel.id,
				thinking: childThinking,
				truncated: false,
			} satisfies SpawnResultDetails,
		});

		const abortChild = () => {
			void session.abort();
		};

		try {
			if (signal?.aborted) abortChild();
			signal?.addEventListener("abort", abortChild, { once: true });
			await session.prompt(fullPrompt);
		} finally {
			signal?.removeEventListener("abort", abortChild);
		}

		const resultText = getLastAssistantText(session.messages);
		if (!resultText) {
			throw new Error("Child agent produced no output.");
		}

		const { text: finalText, truncated } = truncateResult(resultText);

		let stats: Record<string, unknown> | undefined;
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
		} catch {
			// Stats collection is best-effort
		}

		const details: SpawnResultDetails = {
			depth,
			model: childModel.id,
			thinking: childThinking,
			truncated,
		};
		if (stats) {
			details.stats = stats;
		}

	return {
		content: [{ type: "text" as const, text: finalText }],
		details,
	};
}

// ── Registration ──────────────────────────────────────────────────────

export function registerSpawnTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description:
			"Spawn an isolated child agent for a focused subtask. " +
			"Child inherits parent model, thinking level, cwd, and ledger access. " +
			"Reference ledger entries by name — child will ledger_get them on demand.",

		promptSnippet: "Spawn a focused subtask agent",
		promptGuidelines: [
			"Use spawn to delegate isolated work to child agents. They are trusted extensions of you with their own context and the same authority. Only condensed results are returned.",
		],

		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task description. Reference ledger entries by name — " +
					"child will ledger_get them on demand.",
			}),
			thinking: StringEnum(
				["off", "minimal", "low", "medium", "high", "xhigh"] as const,
				{
					description:
						"Override child thinking level. Inherits parent by default.",
				},
			),
		}),

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
			return executeSpawn(_toolCallId, pi, ctx, state, params, signal, onUpdate, parentThinking, 0);
		},

		renderCall(args, theme, context) {
			const prompt = typeof args.prompt === "string" ? args.prompt : "...";
			const { shown, remaining } = renderPromptPreview(prompt, context.expanded);
			let text = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", "child");
			if (typeof args.thinking === "string") {
				text += theme.fg("dim", ` [${args.thinking}]`);
			}
			text += `\n${theme.fg("dim", shown)}`;
			if (remaining > 0) {
				text += theme.fg("muted", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SpawnResultDetails | undefined;
			const component = (context.lastComponent as NestedAgentSessionComponent | undefined) ?? new NestedAgentSessionComponent();
			component.setRequestRender(context.invalidate);
			component.setExpanded(expanded);
			component.setShowImages(context.showImages);
			const child = CHILD_SESSIONS.get(context.toolCallId)?.session;
			if (child) {
				component.attachSession(child);
				return component;
			}

			const output = result.content
				.filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n\n")
				.trim();
			const summary = output || "(no output)";
			const meta = details ? `depth ${details.depth} • ${details.model} • ${details.thinking}` : "";
			return new Text(meta ? `${theme.fg("dim", meta)}\n${theme.fg("toolOutput", summary)}` : theme.fg("toolOutput", summary), 0, 0);
		},
	});
}
