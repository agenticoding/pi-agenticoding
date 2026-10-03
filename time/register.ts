/**
 * Time-awareness event wiring: the tool-result footer, clock persistence at
 * every boundary, and the native-compaction cut anchor.
 *
 * WHY one registration function: all clock transitions live in one place so
 * the depth-counter pairing (start/end) stays auditable; a missed end would
 * leak depth and inflate every later reading.
 *
 * WHY persist at every boundary (not just compaction): the branch is the
 * durable clock. Each persisted reading is a rewind point; without
 * per-boundary writes a crash or rewind would lose all uncompacted work.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import {
	advance,
	endGeneration,
	endTool,
	endUiPrompt,
	monotonicNow,
	startGeneration,
	startTool,
	startUiPrompt,
} from "./clock.js";
import { formatBlockFooter } from "./format.js";
import { persistClock, resolveCutAnchor } from "./store.js";

/** Cut anchor for native compactions, sent as a model-visible custom message. */
const TIME_ANCHOR_CUSTOM_TYPE = "pi-schematic-time-anchor";

/** Active branch, tolerating hosts without a session manager (tests). */
function getBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager?.getBranch?.() ?? [];
}

function registerMessageHooks(pi: ExtensionAPI, state: SchematicState, now: () => number): void {
	pi.on("message_start", async (event, _ctx: ExtensionContext) => {
		if (event.message.role === "assistant") startGeneration(state.clock, now());
	});

	pi.on("message_end", async (event, _ctx: ExtensionContext) => {
		if (event.message.role !== "assistant") return;
		// Generation still advances L; it is simply no longer annotated.
		endGeneration(state.clock, now());
		persistClock(pi, state.clock);
	});
}

/** True when the result carries a body that separates its footer from the previous block. */
function hasResultBody(content: readonly unknown[]): boolean {
	return content.some((block) => {
		const b = block as { type?: string; text?: string };
		return b.type === "image" || (b.type === "text" && (b.text ?? "").trim().length > 0);
	});
}

function onToolResult(
	pi: ExtensionAPI,
	state: SchematicState,
	event: ToolResultEvent,
	now: () => number,
): ToolResultEventResult | undefined {
	if (event.parentToolCallId) return;
	const { elapsed, delta } = endTool(state.clock, event.toolCallId, now());
	// Pi appends parallel result messages in call order, after completion hooks.
	persistClock(pi, state.clock, event.toolCallId);
	return annotateToolResult(event, elapsed, delta);
}

function annotateToolResult(
	event: ToolResultEvent,
	elapsed: number,
	delta: number | null,
): ToolResultEventResult {
	const content = [...(event.content ?? [])];
	// A footer must never be a result's only block: two consecutive body-less
	// results would then place two footers adjacent, unassignable to an element.
	// The tool name is the minimal non-stamp separator (and names the owner).
	if (!hasResultBody(content)) content.push({ type: "text", text: event.toolName });
	content.push({ type: "text", text: formatBlockFooter(event.toolName, elapsed, delta) });
	return {
		content,
		structuredContent: event.structuredContent,
	};
}

function registerToolHooks(pi: ExtensionAPI, state: SchematicState, now: () => number): void {
	pi.on("tool_execution_start", async (event, _ctx: ExtensionContext) => {
		if (event.parentToolCallId) return;
		startTool(state.clock, event.toolCallId, now());
	});

	pi.on("tool_result", async (event, _ctx: ExtensionContext) => {
		return onToolResult(pi, state, event, now);
	});

	pi.on("tool_execution_end", async (event, _ctx: ExtensionContext) => {
		if (event.parentToolCallId || !state.clock.toolStarts.has(event.toolCallId)) return;
		endTool(state.clock, event.toolCallId, now());
		persistClock(pi, state.clock);
	});
}

function registerUiPromptHooks(pi: ExtensionAPI, state: SchematicState, now: () => number): void {
	pi.on("ui_prompt_start", async (_event, _ctx: ExtensionContext) => {
		startUiPrompt(state.clock, now());
		persistClock(pi, state.clock);
	});

	pi.on("ui_prompt_end", async (_event, _ctx: ExtensionContext) => {
		endUiPrompt(state.clock, now());
		persistClock(pi, state.clock);
	});
}

function registerCompactionHooks(pi: ExtensionAPI, state: SchematicState, now: () => number): void {
	pi.on("session_before_compact", async (_event, _ctx: ExtensionContext) => {
		advance(state.clock, now());
		persistClock(pi, state.clock);
	});

	pi.on("session_compact", async (event, ctx: ExtensionContext) => {
		if (event.fromExtension) return;
		const { anchor } = resolveCutAnchor(state.clock, getBranch(ctx), event.compactionEntry.id, now());
		// Pi 0.99.2 queues streaming sends until turn end. Between-turn cuts
		// therefore lack a durable anchor for immediate continuation; the public
		// session_compact contract cannot insert boundary entries.
		await pi.sendMessage(
			{ customType: TIME_ANCHOR_CUSTOM_TYPE, content: anchor, display: false },
			{ triggerTurn: false },
		);
	});
}

export function registerTimeAwareness(
	pi: ExtensionAPI,
	state: SchematicState,
	now: () => number = monotonicNow,
): void {
	registerMessageHooks(pi, state, now);
	registerToolHooks(pi, state, now);
	registerUiPromptHooks(pi, state, now);
	registerCompactionHooks(pi, state, now);
}
