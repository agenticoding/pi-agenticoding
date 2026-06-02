/**
 * TUI rendering components for spawned child agent sessions.
 *
 * Provides the live-updating NestedAgentSessionComponent that renders a
 * child agent's ongoing work in the parent's TUI, plus the renderCall
 * and renderResult functions used by the spawn tool definitions.
 *
 * Event→render flow:
 *   High-frequency events (message_update, tool_execution_update) accumulate
 *   state cheaply per-event and defer expensive component operations to a
 *   frame-based scheduler (~30 FPS).  Low-frequency terminal events
 *   (message_start/end, tool_execution_start/end) apply immediately.
 *
 *   This decouples LLM streaming rate (50-100+ events/sec) from TUI update
 *   rate, keeping the main thread responsive.
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
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgenticodingState } from "../state.js";
import {
	getLastAssistantText,
	type SpawnOutcome,
	type SpawnResultDetails,
} from "./shared.js";

// ── Render-only constants ────────────────────────────────────────────

const COLLAPSED_PREVIEW_MAX_LINES = 5;
const SPAWN_INDENT = 4;
const PROMPT_PREVIEW_COLLAPSED_LINES = 3;
const TOOL_RESULT_PREVIEW_CHARS = 60;
const LIVE_TEXT_PREVIEW_CHARS = 80;
const COST_THRESHOLD_COMPACT = 1000;
const COST_THRESHOLD_DECIMAL = 10;
const SPAWN_SHELL_PADDING_X = 1;
const SPAWN_SHELL_PADDING_Y = 1;

/** Frame interval for the TUI render scheduler (~30 FPS). */
const RENDER_FRAME_MS = 33;

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

function equalStats(a?: Record<string, number>, b?: Record<string, number>): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

function padVisibleWidth(text: string, width: number): string {
	const vw = visibleWidth(text);
	return vw >= width ? text : text + " ".repeat(width - vw);
}

function getShellBackground(theme: Theme | undefined, outcome: SpawnOutcome): ((text: string) => string) | undefined {
	// Theme.bg() is a TUI extension API available on runtime themes beyond the
	// base Theme type. The typeof guard prevents crashes in tests or headless
	// mode where bg may not exist. The (theme as any) cast is unavoidable
	// without extending the Theme interface.
	if (!theme || typeof (theme as any).bg !== "function") return undefined;
	const bgName = outcome === "success"
		? "toolSuccessBg"
		: outcome === "error" || outcome === "aborted"
			? "toolErrorBg"
			: "toolPendingBg";
	return (text: string) => (theme as any).bg(bgName, text);
}

function wrapSpawnShell(lines: string[], width: number, theme: Theme | undefined, outcome: SpawnOutcome, expanded: boolean): string[] {
	const shellWidth = Math.max(1, width);
	const innerWidth = Math.max(1, shellWidth - (SPAWN_SHELL_PADDING_X * 2));
	const paddingY = expanded ? SPAWN_SHELL_PADDING_Y : 0;
	const bg = getShellBackground(theme, outcome);
	const fill = (text: string) => bg ? bg(text) : text;
	const blank = fill(" ".repeat(shellWidth));
	const wrapped = lines.map(line => fill(
		`${" ".repeat(SPAWN_SHELL_PADDING_X)}${padVisibleWidth(line, innerWidth)}${" ".repeat(SPAWN_SHELL_PADDING_X)}`,
	));
	return [
		...Array.from({ length: paddingY }, () => blank),
		...(wrapped.length > 0 ? wrapped : [blank]),
		...Array.from({ length: paddingY }, () => blank),
	];
}

function truncatePlainText(text: string, width: number): string {
	// truncateToWidth() may inject ANSI resets even when truncating plain
	// unicode text. Strip them here so outer shell/background styling stays intact.
	return truncateToWidth(text, width).replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateAndColor(text: string, width: number, color: (name: ThemeColor, text: string) => string, colorName: ThemeColor): string {
	return color(colorName, truncatePlainText(text, width));
}


function formatCollapsedStats(details: SpawnResultDetails): { text: string; color: ThemeColor } | undefined {
	if (details.stats) {
		const s = details.stats;
		const cost = s.cost ?? 0;
		const costStr = cost >= COST_THRESHOLD_COMPACT ? cost.toFixed(0) : cost >= COST_THRESHOLD_DECIMAL ? cost.toFixed(2) : cost.toFixed(4);
		return {
			// Intentionally dim — truncated spawns are routine, not alarming
			text: `tok ${s.inputTokens ?? "?"}/${s.outputTokens ?? "?"} · ${s.turns ?? "?"}t · $${costStr}${details.truncated ? " · trunc" : ""}`,
			color: "dim",
		};
	}
	if (details.statsUnavailable) {
		return { text: "stats unavailable", color: "muted" };
	}
	return undefined;
}

// ── NestedAgentSessionComponent forward reference ────────────────────

/**
 * Minimal interface the frame scheduler needs from a component.
 * Lets the scheduler batch without importing the full class.
 */
interface SpawnFrameTarget {
	flushPendingUpdates(): void;
	clearRenderCache(): void;
	flushScheduledRender(): (() => void) | undefined;
}

// ── Frame-based render scheduler ────────────────────────────────────

/**
 * Aggregates per-event dirty markers across all spawn components and flushes
 * expensive component work (updateContent, updateResult, cache clear, TUI
 * invalidate) at a fixed frame rate (~30 FPS by default).
 *
 * This replaces the previous microtask-per-event approach so that high-volume
 * streaming events (50-100+/sec) do not trigger an equal number of heavy
 * component mutations.
 */
class SpawnFrameScheduler {
	private readonly frameMs: number;
	private dirtyComponents = new Set<SpawnFrameTarget>();
	private frameTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(frameMs: number = RENDER_FRAME_MS) {
		this.frameMs = frameMs;
	}

	/** Mark a component as dirty — will be flushed on the next frame tick. */
	markDirty(component: SpawnFrameTarget): void {
		this.dirtyComponents.add(component);
		if (!this.frameTimer) {
			this.frameTimer = setTimeout(() => this.flush(), this.frameMs);
		}
	}

	/** Remove a component from the dirty set (dispose, stale, rebuild). */
	cancelDirty(component: SpawnFrameTarget): void {
		this.dirtyComponents.delete(component);
	}

	/** Flush all pending dirty components immediately. Used in tests and synchronous rebuild paths. */
	flushNow(): void {
		if (this.frameTimer) {
			clearTimeout(this.frameTimer);
			this.frameTimer = null;
		}
		this.flush();
	}

	/** Cancel the pending timer and clear all dirty state. */
	clear(): void {
		if (this.frameTimer) {
			clearTimeout(this.frameTimer);
			this.frameTimer = null;
		}
		this.dirtyComponents.clear();
	}

	private flush(): void {
		this.frameTimer = null;
		const batch = [...this.dirtyComponents];
		this.dirtyComponents.clear();

		const requestRenders = new Set<() => void>();
		for (const component of batch) {
			// 1. Apply accumulated event state to rendering components
			component.flushPendingUpdates();
			// 2. Invalidate render cache so render() recomputes on next TUI paint
			component.clearRenderCache();
			// 3. Collect TUI invalidate
			const r = component.flushScheduledRender();
			if (r) requestRenders.add(r);
		}
		// One invalidate per distinct callback per frame tick.
		for (const requestRender of requestRenders) {
			requestRender();
		}

		// If more components were dirtied during flush, schedule another frame
		if (this.dirtyComponents.size > 0) {
			this.frameTimer = setTimeout(() => this.flush(), this.frameMs);
		}
	}
}

/** Module-level singleton shared by all NestedAgentSessionComponent instances. */
const spawnFrameScheduler = new SpawnFrameScheduler();

// ── NestedAgentSessionComponent ───────────────────────────────────────

/**
 * Renders a live child agent session in the parent's TUI.
 *
 * Three responsibilities:
 *   1. Collapsed view — identity line with completion marker (✅ when done),
 *      live "last action" summary (tool name + result preview, or assistant
 *      text preview), 5-line preview of last assistant output when available,
 *      token/cost summary.
 *   2. Expanded view — full chat history with 4-space indent.
 *   3. Session lifecycle — subscribes to child session events, streams tool
 *      executions and assistant messages in real time, maintains live action
 *      tracking via lastAction field updated on every event.
 *
 * Event batching:
 *   High-frequency events (message_update, tool_execution_update) store the
 *   latest payload and mark the component dirty. A frame-based scheduler
 *   applies accumulated state to rendering components at ~30 FPS, preventing
 *   the TUI from being overwhelmed by LLM streaming volume.
 */
class NestedAgentSessionComponent extends Container implements SpawnFrameTarget {
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
	// Parent invalidation is one-way from child session events below; renderer-
	// internal invalidations must not re-enter the parent render loop.
	private readonly fakeUi = {
		requestRender: () => {},
	} as { requestRender: () => void };
	private details?: SpawnResultDetails;
	private nestTheme?: Theme;
	private ownedToolCallId?: string;
	private state?: AgenticodingState;
	private attachedChildSessionEpoch?: number;
	private liveOutcome: SpawnOutcome = "running";
	// States: "⏳ initializing…" → "💭 thinking…" → "[tool] …/preview" or live text → terminal outcome
	private lastAction = "";
	private toolNames = new Map<string, string>();
	private toolComponentFailures = new Set<string>();
	private cachedWidth?: number;
	private cachedExpanded?: boolean;
	private cachedLines?: string[];
	private cachedShowImages?: boolean;

	// ── Frame-batched accumulation state ──────────────────────────
	/** Latest assistant message from message_update events (overwritten per event). Applied at frame time. */
	private pendingAssistantMessage?: Extract<AgentSessionEvent, { type: "message_update" }>["message"];
	/** Tool calls seen in message_update that need ToolExecutionComponents created. */
	private pendingToolCallCreations = new Map<string, { name: string; id: string; args: Record<string, unknown> }>();
	/** Latest partial result per toolCallId from tool_execution_update events. Applied at frame time. */
	private pendingToolResults = new Map<string, ToolResultLike>();

	// ── Render scheduling state ───────────────────────────────────
	private renderQueued = false;
	private renderScheduleToken = 0;
	private queuedRenderToken?: number;

	clearRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedExpanded = undefined;
		this.cachedLines = undefined;
		this.cachedShowImages = undefined;
	}

	/** Cancel pending frame-scheduler work for this component. */
	private resetRenderBatching(): void {
		this.renderQueued = false;
		this.queuedRenderToken = undefined;
		this.renderScheduleToken++;
		spawnFrameScheduler.cancelDirty(this);
	}

	/**
	 * Schedule a TUI invalidate on the next frame tick.
	 * This is the only path that sets renderQueued for the scheduler to pick up.
	 * Called from non-event paths (setExpanded, setShowImages, etc.) and from
	 * terminal event handlers (message_end, tool_execution_end).
	 */
	private scheduleRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		this.queuedRenderToken = ++this.renderScheduleToken;
		spawnFrameScheduler.markDirty(this);
	}

	/**
	 * Called by the frame scheduler after flushPendingUpdates + clearRenderCache.
	 * Returns the TUI invalidate function if this component has work pending.
	 * Also detects stale sessions and triggers a full rebuild.
	 */
	flushScheduledRender(): (() => void) | undefined {
		if (!this.renderQueued || this.queuedRenderToken !== this.renderScheduleToken) {
			return undefined;
		}
		this.renderQueued = false;
		this.queuedRenderToken = undefined;
		if (this.isStaleSession()) {
			this.clearPendingState();
			this.rebuildFromSession();
			this.clearRenderCache();
			return undefined;
		}
		return this.requestRender;
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
		const prior = this.details;
		const changed = !prior
			|| prior.model !== details.model
			|| prior.thinking !== details.thinking
			|| prior.truncated !== details.truncated
			|| prior.outcome !== details.outcome
			|| !equalStats(prior.stats, details.stats)
			|| prior.statsUnavailable !== details.statsUnavailable
			|| this.nestTheme !== theme;
		this.details = details;
		this.nestTheme = theme;
		this.liveOutcome = details.outcome;
		if (changed) this.clearRenderCache();
	}

	attachSession(
		toolCallId: string,
		session: AgentSession,
		state: AgenticodingState,
	): void {
		if (
			this.session === session
			&& this.ownedToolCallId === toolCallId
			&& this.state === state
			&& this.attachedChildSessionEpoch === state.childSessionEpoch
		) {
			return;
		}

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.clearPendingState();
		this.session = session;
		this.ownedToolCallId = toolCallId;
		this.state = state;
		this.attachedChildSessionEpoch = state.childSessionEpoch;
		this.resetRenderBatching();
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
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
		// Events maintain the component tree incrementally via handleEvent().
		// rebuildFromSession() destructively resets lastAction to "",
		// causing "⏳ initializing…" to flash on every frame scheduler tick.
	}

	hasSession(): boolean {
		return !!this.session;
	}

	/**
	 * Returns the ownership invalidation reason for the attached session.
	 *
	 * Three stale paths:
	 *   1. resetState() bumped childSessionEpoch after attach, invalidating all
	 *      prior child sessions even if their objects still exist.
	 *   2. state.liveChildSessions no longer contains this toolCallId because the
	 *      child completed and cleared its live ownership.
	 *   3. state.liveChildSessions now points this toolCallId at a different
	 *      session, meaning a newer child claimed the slot.
	 */
	private getStaleSessionReason(): "epoch" | "completion" | "replacement" | undefined {
		if (!this.session || !this.ownedToolCallId) {
			return undefined;
		}
		if (this.state && this.attachedChildSessionEpoch !== this.state.childSessionEpoch) {
			return "epoch";
		}
		const liveChildSessions = this.state?.liveChildSessions;
		if (!liveChildSessions?.has(this.ownedToolCallId)) {
			return "completion";
		}
		return liveChildSessions.get(this.ownedToolCallId) !== this.session
			? "replacement"
			: undefined;
	}

	private isStaleSession(): boolean {
		return this.getStaleSessionReason() !== undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		spawnFrameScheduler.cancelDirty(this);
		this.clearPendingState();
		// Snapshot fields before clearing: if session.abort() triggers re-entrant
		// dispose, the nulled-out fields prevent double-abort.
		const session = this.session;
		const ownedToolCallId = this.ownedToolCallId;
		const liveChildSessions = this.state?.liveChildSessions;
		this.resetRenderBatching();
		this.requestRender = () => {};
		this.clearRenderCache();
		this.details = undefined;
		this.nestTheme = undefined;
		this.liveOutcome = "running";
		this.toolNames.clear();
		this.toolComponentFailures.clear();
		this.session = undefined;
		this.ownedToolCallId = undefined;
		this.state = undefined;
		this.attachedChildSessionEpoch = undefined;
		if (session && ownedToolCallId && liveChildSessions?.get(ownedToolCallId) === session) {
			session.abort().catch(() => {});
			liveChildSessions.delete(ownedToolCallId);
		}
	}

	// ── Frame-batched update support ─────────────────────────────────

	/** Clear all accumulated pending state (new session, dispose, rebuild). */
	private clearPendingState(): void {
		this.pendingAssistantMessage = undefined;
		this.pendingToolCallCreations.clear();
		this.pendingToolResults.clear();
	}

	/**
	 * Apply accumulated event state to actual rendering components.
	 * Called by the frame scheduler once per frame tick.
	 *
	 * Three operations deferred from per-event handlers:
	 *   1. Update the streaming AssistantMessageComponent with the latest message.
	 *   2. Create ToolExecutionComponents for tool calls announced in streaming chunks.
	 *   3. Apply the latest partial result to each live ToolExecutionComponent.
	 */
	flushPendingUpdates(): void {
		// 1. Apply latest streaming message to the assistant component
		if (this.pendingAssistantMessage && this.streamingComponent) {
			try {
				this.streamingComponent.updateContent(this.pendingAssistantMessage);
			} catch (error) {
				this.resetStreamingComponent(error, "message_update");
			}
			this.pendingAssistantMessage = undefined;
		}

		// 2. Create tool components for tool calls announced in streaming chunks
		if (this.pendingToolCallCreations.size > 0) {
			// If message_end already ran, streamingComponent is gone and
			// these new components missed the setArgsComplete() call.
			const streamingDone = !this.streamingComponent;
			for (const [id, info] of this.pendingToolCallCreations) {
				if (this.pendingTools.has(id)) continue;
				const component = this.createToolComponent(info.name, info.id, info.args);
				this.addToolComponent(component);
				if (component) {
					this.pendingTools.set(id, component);
					if (streamingDone) {
						component.setArgsComplete();
					}
				}
			}
			this.pendingToolCallCreations.clear();
		}

		// 3. Apply latest partial results to live tool components
		if (this.pendingToolResults.size > 0) {
			for (const [toolCallId, result] of this.pendingToolResults) {
				const component = this.pendingTools.get(toolCallId);
				if (component) {
					component.updateResult({ ...result, isError: false }, true);
				}
			}
			this.pendingToolResults.clear();
		}
	}

	// ── Component tree helpers ───────────────────────────────────────

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

		// Flush any pending state first so accumulated updates don't double-apply
		spawnFrameScheduler.cancelDirty(this);
		this.clearPendingState();

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
		const shellWidth = Math.max(1, width);
		const contentWidth = Math.max(1, shellWidth - (SPAWN_SHELL_PADDING_X * 2));
		const contentLines = this.expanded ? this.renderExpanded(contentWidth) : this.renderCollapsed(contentWidth);
		const lines = wrapSpawnShell(contentLines, shellWidth, this.nestTheme, this.liveOutcome, this.expanded);
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
			lines.push(truncateAndColor(
				`${getOutcomeMarker(outcome)}${details.model} • ${details.thinking}`,
				width,
				color,
				"dim",
			));
		}

		if (outcome === "running") {
			const liveSummary = this.lastAction || "⏳ initializing…";
			lines.push(truncateAndColor(liveSummary, width, color, "dim"));
		} else if (outcome !== "success") {
			const outcomeText = getOutcomeStatusText(outcome);
			if (outcomeText) {
				lines.push(truncateAndColor(outcomeText, width, color, outcome === "error" ? "warning" : "dim"));
			}
		}

		// Preview last assistant output — 5 lines for context without noise
		const summaryText = this.session ? getLastAssistantText(this.session.messages) : "";
		if (summaryText) {
			const textLines = summaryText.split("\n");
			const maxLines = COLLAPSED_PREVIEW_MAX_LINES;
			const shown = textLines.slice(0, maxLines);
			for (const line of shown) {
				lines.push(truncateAndColor(line, width, color, "toolOutput"));
			}
			const remaining = textLines.length - maxLines;
			if (remaining > 0) {
				lines.push(truncateAndColor(`... ${remaining} more lines`, width, color, "muted"));
			}
		}

		const statsLine = details ? formatCollapsedStats(details) : undefined;
		if (statsLine) {
			lines.push(truncateAndColor(statsLine.text, width, color, statsLine.color));
		}

		return lines;
	}

	private renderExpanded(width: number): string[] {
		// Renders children directly rather than via super.render() to apply
		// indentation. Container.render() from pi-tui is a simple
		// passthrough (no layout/decoration) so this is equivalent. If it ever
		// adds padding or inter-child spacing, switch to super.render() and
		// post-process lines to add indentation.
		const childWidth = Math.max(1, width - SPAWN_INDENT);
		const leftPad = " ".repeat(SPAWN_INDENT);
		const lines: string[] = [];

		// Show identity header when expanded — anchors which nested session this is
		const colorExpanded = (name: ThemeColor, text: string) => this.nestTheme ? this.nestTheme.fg(name, text) : text;
		// Expanded mode has no shell background — safe to color before truncation
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
	}

	// ── Event handlers ───────────────────────────────────────────────

	/**
	 * Handling strategy:
	 *
	 *   High-frequency              | Low-frequency (terminal)
	 *   ────────────────────────────┼────────────────────────────────
	 *   message_update: accumulate  | message_start:   apply immediately
	 *   tool_execution_update: acc  | message_end:     apply immediately
	 *                                | tool_execution_start: apply immediately
	 *                                | tool_execution_end: apply immediately
	 *
	 * "Terminal" events happen once per phase and must reach final state
	 * synchronously so the next phase (or child completion) sees correct data.
	 * "Update" events stream at high volume and only the latest snapshot
	 * matters for display.
	 */

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

	/**
	 * High-frequency: accumulates the latest message payload instead of calling
	 * updateContent per event. Expensive component work is deferred to the
	 * frame scheduler's flushPendingUpdates.
	 */
	private handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (event.message.role !== "assistant") return;

		// Store the latest message; only the last one before the frame tick matters
		this.pendingAssistantMessage = event.message;

		// Track new tool call IDs so flushPendingUpdates can create components
		for (const content of event.message.content ?? []) {
			if (content.type !== "toolCall") continue;
			if (this.pendingTools.has(content.id)) {
				// Already tracked — just update args (cheap)
				this.pendingTools.get(content.id)!.updateArgs(content.arguments ?? {});
			} else {
				// Keep the latest announced args until frame-time creation.
				// Streamed tool-call arguments often grow over multiple chunks before
				// the first flush, so first-write-wins would show stale/incomplete args.
				this.pendingToolCallCreations.set(content.id, {
					name: content.name,
					id: content.id,
					args: content.arguments ?? {},
				});
			}
		}

		// Cheap per-event: update the live action text preview
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

	/**
	 * Terminal event: applies final message state synchronously and clears the
	 * streaming component. Also updates outcome and pending tool states.
	 */
	private handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): void {
		if (event.message.role !== "assistant") return;

		// Clear any pending streaming message (the end event is authoritative)
		this.pendingAssistantMessage = undefined;

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
		// No scheduleRender call — the frame scheduler will pick up the state change
	}

	/**
	 * Terminal event: creates the tool component synchronously so the user sees
	 * the tool name immediately. Result content is deferred to frame-time updates.
	 */
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

	/**
	 * High-frequency: stores the latest partial result per toolCallId.
	 * Expensive updateResult call is deferred to the frame scheduler.
	 */
	private handleToolExecutionUpdate(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
		// Update live action regardless of component availability (cheap)
		const name = this.toolNames.get(event.toolCallId) ?? "tool";
		const preview = this.extractPreview(asToolResult(event.partialResult));
		this.lastAction = preview
			? `[${name}] ${preview}`
			: `[${name}] …`;

		// Store the latest partial result; overwritten per event — only the
		// latest matters at display time.
		if (this.pendingTools.has(event.toolCallId)) {
			this.pendingToolResults.set(event.toolCallId, asToolResult(event.partialResult));
		}
	}

	/**
	 * Terminal event: applies the final result synchronously and cleans up
	 * tracking maps.
	 */
	private handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		// Clear any pending results for this tool (the end event is authoritative)
		this.pendingToolResults.delete(event.toolCallId);

		const component = this.pendingTools.get(event.toolCallId);
		const name = this.toolNames.get(event.toolCallId) ?? "tool";
		this.toolNames.delete(event.toolCallId);
		this.pendingTools.delete(event.toolCallId);
		this.lastAction = event.isError
			? `[${name}] ✗`
			: `[${name}] ✓`;
		if (component) {
			component.updateResult({ ...asToolResult(event.result), isError: event.isError });
		}
		// No scheduleRender call — the frame scheduler will pick up the state change
	}

	/**
	 * Central event dispatch.
	 *
	 * Every event clears the cheap render cache (4 field assignments) so that
	 * render() returns fresh data.  The actual TUI invalidate is deferred to
	 * the frame scheduler via scheduleRender, which coalesces multiple events
	 * into one invalidate per frame tick.
	 *
	 * Expensive component work (updateContent, updateResult, component creation)
	 * is deferred by the per-handler accumulation pattern — see
	 * handleMessageUpdate and handleToolExecutionUpdate.
	 */
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
			// Per-event cache clear ensures render() returns fresh data if called
			// between frame ticks. The frame scheduler also clears the cache during
			// flush — this is intentionally redundant so the render cache is always
			// correct for synchronous access (tests, in-between paints).
			this.clearRenderCache();
			this.scheduleRender();
		} catch (error) {
			this.clearRenderCache();
			this.resetRenderBatching();
			// Prevent a single bad event from killing the subscription.
			// The TUI degrades gracefully — stale content until next successful event.
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
	return new Text(text, SPAWN_SHELL_PADDING_X, SPAWN_SHELL_PADDING_Y, getShellBackground(theme, "running"));
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
		component.attachSession(context.toolCallId, child, state);
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
	return new Text(text, SPAWN_SHELL_PADDING_X, SPAWN_SHELL_PADDING_Y, getShellBackground(theme, outcome));
}

export { NestedAgentSessionComponent, renderSpawnCall, renderSpawnResult };

// ── Test support ──────────────────────────────────────────────────────

/**
 * Synchronously flush all pending spawn frame work.
 * Exported for tests.  Not needed in production — the frame timer handles
 * everything automatically.
 */
export function flushSpawnFrameScheduler(): void {
	spawnFrameScheduler.flushNow();
}

/**
 * Reset the frame scheduler, discarding any pending dirty markers.
 * Exported for tests.  In production the scheduler lifecycle is tied to
 * component dispose(), so this is never needed.
 */
export function resetSpawnFrameScheduler(): void {
	spawnFrameScheduler.clear();
}
