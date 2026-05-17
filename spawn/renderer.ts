/**
 * TUI rendering components for spawned child agent sessions.
 *
 * Provides the live-updating NestedAgentSessionComponent that renders a
 * child agent's ongoing work in the parent's TUI, plus the renderCall
 * and renderResult functions used by the spawn tool definitions.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	keyHint,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgenticodingState } from "../state.js";
import {
	getLastAssistantText,
	type SpawnOutcome,
	type SpawnResultDetails,
} from "./shared.js";

// ── Render-only constants ────────────────────────────────────────────

const COLLAPSED_PREVIEW_MAX_LINES = 5;
const INDENT_SPACES_PER_DEPTH = 4;
const PROMPT_PREVIEW_COLLAPSED_LINES = 3;
const TOOL_RESULT_PREVIEW_CHARS = 60;
const LIVE_TEXT_PREVIEW_CHARS = 80;
const COST_THRESHOLD_COMPACT = 1000;
const COST_THRESHOLD_DECIMAL = 10;

// ── Render-only types ────────────────────────────────────────────────

type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
};

/**
 * Message shapes from a spawned child session.
 * Covers both standard LLM messages and extension-injected custom types
 * (bashExecution, custom) without depending on SDK module augmentation types.
 */
type SpawnChildMessage = {
	role: string;
	content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
	stopReason?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	customType?: string;
	display?: boolean;
	details?: unknown;
};

// ── Render-only helpers ──────────────────────────────────────────────

/** Runtime guard: validate that a value is structurally compatible with ToolResultLike. */
function asToolResult(value: unknown): ToolResultLike {
	if (typeof value === "object" && value !== null && Array.isArray((value as any).content)) {
		return value as ToolResultLike;
	}
	return { content: [] };
}

function getStopReasonOutcome(stopReason: unknown): SpawnOutcome | undefined {
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return undefined;
}

function getOutcomeMarker(outcome: SpawnOutcome): string {
	switch (outcome) {
		case "success":
			return "✅ ";
		case "aborted":
			return "✗ ";
		case "error":
			return "⚠ ";
		default:
			return "";
	}
}

function getOutcomeStatusText(outcome: SpawnOutcome): string | undefined {
	switch (outcome) {
		case "success":
			return "💬 done";
		case "aborted":
			return "💬 aborted";
		case "error":
			return "💬 error";
		default:
			return undefined;
	}
}

function isExpectedToolComponentFailure(error: unknown): boolean {
	return error instanceof Error && (
		/missing tool definition/i.test(error.message)
		|| /theme not initialized/i.test(error.message)
	);
}

function renderPromptPreview(prompt: string, expanded: boolean): { shown: string; remaining: number } {
	const lines = prompt.split("\n");
	const maxLines = expanded ? lines.length : PROMPT_PREVIEW_COLLAPSED_LINES;
	return {
		shown: lines.slice(0, maxLines).join("\n"),
		remaining: Math.max(0, lines.length - maxLines),
	};
}

/**
 * Safe wrapper around keyHint().
 * keyHint() may throw when the TUI keybinding registry isn't initialized
 * (e.g., during tests or headless mode). Returns the fallback in that case.
 */
function safeKeyHint(action: string, fallback: string): string {
	try {
		return keyHint(action, fallback);
	} catch {
		return fallback;
	}
}

// ── NestedAgentSessionComponent ───────────────────────────────────────

/**
 * Renders a live child agent session in the parent's TUI.
 *
 * Three responsibilities:
 *   1. Collapsed view — identity line with completion marker (✅ when done),
 *      live "last action" summary (tool name + result preview, or assistant
 *      text preview), 5-line preview of last assistant output when available,
 *      token/cost summary.
 *   2. Expanded view — full chat history with 4-space indent per depth level.
 *   3. Session lifecycle — subscribes to child session events, streams tool
 *      executions and assistant messages in real time, maintains live action
 *      tracking via lastAction field updated on every event.
 *
 * Render caching: caches output by width/expanded/showImages to avoid
 * unnecessary re-renders when none of those inputs changed.
 */
class NestedAgentSessionComponent extends Container {
	private session?: AgentSession;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private toolComponents = new Set<ToolExecutionComponent>();
	private streamingComponent?: AssistantMessageComponent;
	private unsubscribe?: () => void;
	private expanded = false;
	private showImages = true;
	private requestRender: () => void = () => {};
	private readonly markdownTheme = getMarkdownTheme();
	// Minimal TUI mock for ToolExecutionComponent/BashExecutionComponent.
	// Spawn runs in-memory without a real TUI — only requestRender is needed
	// to trigger parent re-renders when child events arrive.
	private readonly fakeUi = {
		requestRender: () => this.requestRender(),
	} as { requestRender: () => void };
	private details?: SpawnResultDetails;
	private nestTheme?: Theme;
	private ownedToolCallId?: string;
	private liveChildSessions?: Map<string, AgentSession>;
	private liveOutcome: SpawnOutcome = "running";
	// States: "⏳ initializing…" → "💭 thinking…" → "[tool] …/preview" or live text → terminal outcome
	private lastAction = "";
	private toolNames = new Map<string, string>();
	private toolComponentFailures = new Set<string>();
	private cachedWidth?: number;
	private cachedExpanded?: boolean;
	private cachedLines?: string[];
	private cachedShowImages?: boolean;

	private clearRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedExpanded = undefined;
		this.cachedLines = undefined;
		this.cachedShowImages = undefined;
	}

	setRequestRender(requestRender: () => void): void {
		this.requestRender = requestRender;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.clearRenderCache();
		for (const component of this.toolComponents) {
			component.setExpanded(expanded);
		}
	}

	setShowImages(showImages: boolean): void {
		if (this.showImages === showImages) return;
		this.showImages = showImages;
		this.clearRenderCache();
		for (const component of this.toolComponents) {
			component.setShowImages(showImages);
		}
	}

	setDetails(details: SpawnResultDetails, theme: Theme): void {
		const changed = this.details !== details || this.nestTheme !== theme;
		this.details = details;
		this.nestTheme = theme;
		this.liveOutcome = details.outcome;
		if (changed) this.clearRenderCache();
	}

	attachSession(toolCallId: string, session: AgentSession, liveChildSessions?: Map<string, AgentSession>): void {
		if (
			this.session === session
			&& this.ownedToolCallId === toolCallId
			&& this.liveChildSessions === liveChildSessions
		) {
			return;
		}

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = session;
		this.ownedToolCallId = toolCallId;
		this.liveChildSessions = liveChildSessions;
		this.liveOutcome = this.details?.outcome ?? "running";
		this.toolNames.clear();
		this.toolComponentFailures.clear();
		this.clearRenderCache();
		this.rebuildFromSession();
		try {
			this.unsubscribe = typeof session.subscribe === "function"
				? session.subscribe((event) => {
					this.handleEvent(event);
				})
				: undefined;
		} catch (error) {
			this.unsubscribe = undefined;
			console.warn("[spawn] Failed to subscribe to child session events:", this.ownedToolCallId, error);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
		if (this.session) {
			this.rebuildFromSession();
		}
	}

	hasSession(): boolean {
		return !!this.session;
	}

	/**
	 * Returns true when the session held by this component has been replaced
	 * in the liveChildSessions map (e.g., after a resetState). When stale, the
	 * component silently drops all events to avoid operating on a different
	 * session than what it was attached to.
	 */
	private isStaleSession(): boolean {
		return !!(
			this.session
			&& this.ownedToolCallId
			&& this.liveChildSessions
			&& this.liveChildSessions.get(this.ownedToolCallId) !== this.session
		);
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// Snapshot fields before clearing: if session.abort() triggers re-entrant
		// dispose, the nulled-out fields prevent double-abort.
		const session = this.session;
		const ownedToolCallId = this.ownedToolCallId;
		const liveChildSessions = this.liveChildSessions;
		this.clearRenderCache();
		this.details = undefined;
		this.nestTheme = undefined;
		this.liveOutcome = "running";
		this.toolNames.clear();
		this.toolComponentFailures.clear();
		this.session = undefined;
		this.ownedToolCallId = undefined;
		this.liveChildSessions = undefined;
		if (session && ownedToolCallId && liveChildSessions?.get(ownedToolCallId) === session) {
			session.abort().catch(e => console.error("[spawn] abort failed:", ownedToolCallId, e));
			liveChildSessions.delete(ownedToolCallId);
		}
	}

	private addToolComponent(component?: ToolExecutionComponent): void {
		if (!component) return;
		component.setExpanded(this.expanded);
		component.setShowImages(this.showImages);
		this.toolComponents.add(component);
		this.addChild(component);
	}

	private createToolComponent(toolName: string, toolCallId: string, args: Record<string, unknown>): ToolExecutionComponent | undefined {
		try {
			return new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{ showImages: this.showImages },
				this.session?.getToolDefinition(toolName),
				this.fakeUi as unknown as TUI,
				this.session?.sessionManager.getCwd() ?? process.cwd(),
			);
		} catch (error) {
			if (isExpectedToolComponentFailure(error)) {
				return undefined;
			}
			const failureKey = `${toolCallId}:${toolName}`;
			if (!this.toolComponentFailures.has(failureKey)) {
				this.toolComponentFailures.add(failureKey);
				console.warn("[spawn] Failed to create tool component:", toolCallId, toolName, error);
			}
			return undefined;
		}
	}

	private addMessageToChat(message: SpawnChildMessage): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.fakeUi as unknown as TUI, message.excludeFromContext);
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
					.filter((block: { type: string; text?: string }) => block.type === "text" && typeof block.text === "string")
					.map((block: { type: string; text?: string }) => block.text ?? "")
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
		this.liveOutcome = this.details?.outcome ?? "running";
		this.lastAction = getOutcomeStatusText(this.liveOutcome) ?? "";
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of this.session.messages as SpawnChildMessage[]) {
			if (message.role === "assistant") {
				const stopOutcome = getStopReasonOutcome(message.stopReason);
				if (stopOutcome) {
					this.liveOutcome = stopOutcome;
					this.lastAction = getOutcomeStatusText(stopOutcome) ?? this.lastAction;
				}
				this.addMessageToChat(message);
				for (const content of message.content ?? []) {
					if (content.type !== "toolCall") continue;
					const component = this.createToolComponent(content.name, content.id, content.arguments ?? {});
					this.addToolComponent(component);
					if (!component) continue;
					if (stopOutcome) {
						const errorMessage = stopOutcome === "aborted"
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

	override render(width: number): string[] {
		if (
			this.cachedLines
			&& this.cachedWidth === width
			&& this.cachedExpanded === this.expanded
			&& this.cachedShowImages === this.showImages
		) {
			return this.cachedLines;
		}
		const lines = this.expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
		this.cachedWidth = width;
		this.cachedExpanded = this.expanded;
		this.cachedShowImages = this.showImages;
		this.cachedLines = lines;
		return lines;
	}

	private extractPreview(result: ToolResultLike): string {
		const text = result.content?.find(c => c.type === "text" && c.text)?.text;
		if (!text) return "";
		return text.trim().split("\n")[0].slice(0, TOOL_RESULT_PREVIEW_CHARS);
	}

	private renderCollapsed(width: number): string[] {
		const lines: string[] = [];
		const details = this.details;
		const theme = this.nestTheme;
		const outcome = this.liveOutcome;
		// Theme may be undefined in tests or before setDetails — fall back to plain text
		const color = (name: ThemeColor, text: string) => theme ? theme.fg(name, text) : text;

		// Identity line — distinguishes nested spawns in collapsed view
		if (details) {
			const depthLabel = details.depth > 0 ? `[depth ${details.depth}] ` : "";
			lines.push(truncateToWidth(
				color("dim", `${getOutcomeMarker(outcome)}${depthLabel}${details.model} • ${details.thinking}`),
				width,
			));
		}

		if (outcome === "running") {
			const liveSummary = this.lastAction || "⏳ initializing…";
			lines.push(truncateToWidth(color("dim", liveSummary), width));
		} else if (outcome !== "success") {
			const outcomeText = getOutcomeStatusText(outcome);
			if (outcomeText) {
				lines.push(truncateToWidth(color(outcome === "error" ? "warning" : "dim", outcomeText), width));
			}
		}

		// Preview last assistant output — 5 lines for context without noise
		const summaryText = this.session ? getLastAssistantText(this.session.messages) : "";
		if (summaryText) {
			const textLines = summaryText.split("\n");
			const maxLines = COLLAPSED_PREVIEW_MAX_LINES;
			const shown = textLines.slice(0, maxLines);
			for (const line of shown) {
				lines.push(truncateToWidth(color("toolOutput", line), width));
			}
			const remaining = textLines.length - maxLines;
			if (remaining > 0) {
				lines.push(truncateToWidth(
					color("muted", `... ${remaining} more lines`),
					width,
				));
			}
		}

		// Token/cost summary — quick usage check without expanding
		if (details?.stats) {
			const s = details.stats;
			const cost = s.cost ?? 0;
			const costStr = cost >= COST_THRESHOLD_COMPACT ? cost.toFixed(0) : cost >= COST_THRESHOLD_DECIMAL ? cost.toFixed(2) : cost.toFixed(4);
			const truncated = details.truncated ? color("warning", " [truncated]") : "";
			const statsLine = `tokens: ${s.inputTokens ?? "?"}/${s.outputTokens ?? "?"} · ${s.turns ?? "?"} turns · $${costStr}${truncated}`;
			lines.push(truncateToWidth(color("dim", statsLine), width));
		} else if (details?.statsUnavailable) {
			lines.push(truncateToWidth(color("muted", "stats unavailable"), width));
		}

		return lines;
	}

	private renderExpanded(width: number): string[] {
		// Renders children directly rather than via super.render() to apply
		// depth-based indentation. Container.render() from pi-tui is a simple
		// passthrough (no layout/decoration) so this is equivalent. If it ever
		// adds padding or inter-child spacing, switch to super.render() and
		// post-process lines to add indentation.
		const depth = this.details?.depth ?? 0;
		const indent = depth * INDENT_SPACES_PER_DEPTH;
		const childWidth = Math.max(1, width - indent);
		const leftPad = " ".repeat(indent);
		const lines: string[] = [];

		// Show identity header when expanded — anchors which nested session this is
		const colorExpanded = (name: ThemeColor, text: string) => this.nestTheme ? this.nestTheme.fg(name, text) : text;
		if (this.details) {
			const header = `${getOutcomeMarker(this.liveOutcome)}${this.details.model} • ${this.details.thinking}`;
			lines.push(leftPad + truncateToWidth(
				colorExpanded("dim", header),
				childWidth,
			));
		}

		for (const child of this.children) {
			const childLines = child.render(childWidth);
			for (const line of childLines) {
				lines.push(leftPad + line);
			}
		}
		return lines;
	}

	private resetStreamingComponent(error: unknown, eventType: string): void {
		this.streamingComponent = undefined;
		if (isExpectedToolComponentFailure(error)) {
			return;
		}
		console.warn(`[spawn] streaming component error (${eventType}):`, this.ownedToolCallId, error);
	}

	private handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): void {
		if (event.message.role === "custom" || event.message.role === "user") {
			this.addMessageToChat(event.message);
			return;
		}
		if (event.message.role === "assistant") {
			this.liveOutcome = "running";
			this.lastAction = "💭 thinking…";
			try {
				this.streamingComponent = new AssistantMessageComponent(undefined, false, this.markdownTheme, "Thinking...");
				this.addChild(this.streamingComponent);
				this.streamingComponent.updateContent(event.message);
			} catch (error) {
				this.resetStreamingComponent(error, "message_start");
			}
		}
	}

	private handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (event.message.role !== "assistant") return;
		if (this.streamingComponent) {
			try {
				this.streamingComponent.updateContent(event.message);
			} catch (error) {
				this.resetStreamingComponent(error, "message_update");
			}
		}
		for (const content of event.message.content ?? []) {
			if (content.type !== "toolCall") continue;
			let component = this.pendingTools.get(content.id);
			if (!component) {
				component = this.createToolComponent(content.name, content.id, content.arguments ?? {});
				this.addToolComponent(component);
				if (component) {
					this.pendingTools.set(content.id, component);
				}
			} else {
				component.updateArgs(content.arguments ?? {});
			}
		}
		const textBlock = event.message.content?.find(
			(c: any) => c.type === "text" && c.text,
		);
		if (textBlock?.text) {
			const firstLine = textBlock.text.trim().split("\n")[0];
			if (firstLine) {
				this.lastAction = firstLine.slice(0, LIVE_TEXT_PREVIEW_CHARS);
			}
		}
	}

	private handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): void {
		if (event.message.role !== "assistant") return;
		if (this.streamingComponent) {
			try {
				this.streamingComponent.updateContent(event.message);
			} catch (error) {
				this.resetStreamingComponent(error, "message_end");
			}
		}
		const stopOutcome = getStopReasonOutcome(event.message.stopReason);
		if (stopOutcome) {
			const errorMessage = stopOutcome === "aborted"
				? event.message.errorMessage || "Operation aborted"
				: event.message.errorMessage || "Error";
			this.liveOutcome = stopOutcome;
			this.lastAction = getOutcomeStatusText(stopOutcome) ?? this.lastAction;
			for (const component of this.pendingTools.values()) {
				component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
			}
			this.pendingTools.clear();
		} else {
			this.liveOutcome = "success";
			this.lastAction = "💬 done";
			for (const component of this.pendingTools.values()) {
				component.setArgsComplete();
			}
		}
		this.streamingComponent = undefined;
	}

	private handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		this.liveOutcome = "running";
		let component = this.pendingTools.get(event.toolCallId);
		if (!component) {
			component = this.createToolComponent(event.toolName, event.toolCallId, event.args ?? {});
			this.addToolComponent(component);
			if (component) {
				this.pendingTools.set(event.toolCallId, component);
			}
		}
		this.toolNames.set(event.toolCallId, event.toolName);
		this.lastAction = `[${event.toolName}] …`;
		component?.markExecutionStarted();
	}

	private handleToolExecutionUpdate(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
		const component = this.pendingTools.get(event.toolCallId);
		// Update live action and flush render cache even when the tool
		// component isn't tracked (e.g. createToolComponent failed in
		// test or degraded environment).
		const name = this.toolNames.get(event.toolCallId) ?? "tool";
		const preview = this.extractPreview(asToolResult(event.partialResult));
		this.lastAction = preview
			? `[${name}] ${preview}`
			: `[${name}] …`;
		if (component) {
			component.updateResult({ ...asToolResult(event.partialResult), isError: false }, true);
		}
	}

	private handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const component = this.pendingTools.get(event.toolCallId);
		// Update live action and flush render cache even without a
		// tracked tool component, so the "✓"/"✗" state is always
		// reflected in the next render.
		const name = this.toolNames.get(event.toolCallId) ?? "tool";
		this.toolNames.delete(event.toolCallId);
		this.pendingTools.delete(event.toolCallId);
		this.lastAction = event.isError
			? `[${name}] ✗`
			: `[${name}] ✓`;
		if (component) {
			component.updateResult({ ...asToolResult(event.result), isError: event.isError });
		}
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (this.isStaleSession()) {
			return;
		}

		try {
			switch (event.type) {
				case "message_start": this.handleMessageStart(event); break;
				case "message_update": this.handleMessageUpdate(event); break;
				case "message_end": this.handleMessageEnd(event); break;
				case "tool_execution_start": this.handleToolExecutionStart(event); break;
				case "tool_execution_update": this.handleToolExecutionUpdate(event); break;
				case "tool_execution_end": this.handleToolExecutionEnd(event); break;
			}
			this.clearRenderCache();
			this.requestRender();
		} catch (error) {
			// Prevent a single bad event from killing the subscription.
			// The TUI degrades gracefully — stale content until next successful event.
			console.warn("[spawn] Event handler error:", event.type, this.ownedToolCallId, error);
		}
	}
}

// ── Spawn call/result renderers ───────────────────────────────────────

/**
 * Renders the spawn tool call in the parent's TUI.
 *
 * Collapsed: shows up to PROMPT_PREVIEW_COLLAPSED_LINES of the prompt with
 *   "... N more lines, to expand" hint when truncated.
 * Expanded: shows the full prompt text.
 * Returns a static Text component — live updates come through renderResult.
 */
function renderSpawnCall(args: any, theme: Theme, context: { expanded: boolean }): Text {
	const prompt = typeof args.prompt === "string" ? args.prompt : "...";
	const { shown, remaining } = renderPromptPreview(prompt, context.expanded);
	let text = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", "child");
	if (typeof args.thinking === "string") {
		text += theme.fg("dim", ` [${args.thinking}]`);
	}
	text += `\n${theme.fg("dim", shown)}`;
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines, ${safeKeyHint("app.tools.expand", "to expand")})`);
	}
	return new Text(text, 0, 0);
}

/**
 * Renders the result of a spawn execution into a TUI component.
 *
 * Three return paths:
 *   1. Live session in state → attach to component, delete from state
 *      (ownership transfer), return the component.
 *   2. Component already has a session (from a prior render) → return as-is.
 *   3. Neither → dispose component, return static Text with model/thinking + output.
 *
 * Side effect on path (1): mutates state.childSessions via .delete().
 */
function renderSpawnResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	expanded: boolean,
	theme: Theme,
	context: { toolCallId: string; lastComponent?: unknown; invalidate: () => void; showImages: boolean },
	state: AgenticodingState,
): NestedAgentSessionComponent | Text {
	// Runtime guard — both parent and child use executeSpawn which produces matching shape,
	// but an explicit check ensures we don't crash on unexpected input
	const details: SpawnResultDetails | undefined = result.details && typeof result.details === "object"
		? (result.details as SpawnResultDetails)
		: undefined;
	const component = context.lastComponent instanceof NestedAgentSessionComponent
		? context.lastComponent
		: new NestedAgentSessionComponent();
	component.setRequestRender(context.invalidate);
	component.setExpanded(expanded);
	component.setShowImages(context.showImages);
	if (details) {
		component.setDetails(details, theme);
	}
	const child = state.childSessions.get(context.toolCallId);
	if (child) {
		const liveChildSessions = state.liveChildSessions.get(context.toolCallId) === child
			? state.liveChildSessions
			: undefined;
		component.attachSession(context.toolCallId, child, liveChildSessions);
		state.childSessions.delete(context.toolCallId);
		return component;
	}
	if (component.hasSession()) {
		return component;
	}

	component.dispose();

	const output = result.content
		.filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
	const summary = output || "(no output)";
	const outcome = details?.outcome ?? "running";
	const meta = details ? `${getOutcomeMarker(outcome)}${details.model} • ${details.thinking}` : "";
	const status = getOutcomeStatusText(outcome);
	const text = [
		meta ? theme.fg("dim", meta) : "",
		status ? theme.fg(outcome === "error" ? "warning" : "dim", status) : "",
		theme.fg("toolOutput", summary),
	].filter(Boolean).join("\n");
	return new Text(text, 0, 0);
}

export { NestedAgentSessionComponent, renderSpawnCall, renderSpawnResult };
