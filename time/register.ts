/**
 * Tool-run timing: the tool-result footer, the only model-visible time surface.
 *
 * WHY a per-`toolCallId` start map: a tool delta is `now − start` at the same
 * event that renders it. There is no accumulated clock and no branch state —
 * a footer is a historical fact, written once and never edited, so it needs no
 * restoration across resume, rewind, or compaction.
 *
 * WHY one registration function: the start/result pairing stays auditable. A
 * missing `tool_result` (blocked, aborted, truncated) simply produces no footer;
 * `tool_execution_end` drops the orphaned start so the map cannot grow.
 *
 * WHY the map is process-long: `registerToolTimings` is called once at extension
 * registration (index.ts), so its `starts` closure outlives `/new` and tree
 * navigation. This is safe because `toolCallId` is a UUID unique to each call,
 * so a stale entry can never collide with a new call — it just sits inert until
 * `tool_result` or `tool_execution_end` removes it. There is no shared reading to
 * reset (each delta is independent), unlike the removed clock which had to be
 * cleared on `/new` to avoid inflating every subsequent footer. No accumulation
 * beyond transient in-flight entries can occur.
 */

import type {
	ExtensionAPI,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { formatBlockFooter } from "./format.js";

/** Process-local monotonic source; wall-clock time is never read. */
function monotonicNow(): number {
	return performance.now();
}

/** True when the result carries a body that separates its footer from the previous block. */
function hasResultBody(content: readonly unknown[]): boolean {
	return content.some((block) => {
		const b = block as { type?: string; text?: string };
		return b.type === "image" || (b.type === "text" && (b.text ?? "").trim().length > 0);
	});
}

function annotateToolResult(event: ToolResultEvent, delta: number | null): ToolResultEventResult {
	const content = [...(event.content ?? [])];
	// A footer must never be a result's only block: two consecutive body-less
	// results would then place two footers adjacent, unassignable to an element.
	// The tool name is the minimal non-stamp separator (and names the owner).
	if (!hasResultBody(content)) content.push({ type: "text", text: event.toolName });
	content.push({ type: "text", text: formatBlockFooter(event.toolName, delta) });
	return {
		content,
		structuredContent: event.structuredContent,
	};
}

/**
 * Register tool-run timing.
 *
 * WHY skip nested calls (`parentToolCallId`): their results never reach the
 * transcript, and their time is already inside the parent's interval.
 */
export function registerToolTimings(
	pi: ExtensionAPI,
	now: () => number = monotonicNow,
): void {
	const starts = new Map<string, number>();

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (event.parentToolCallId) return;
		starts.set(event.toolCallId, now());
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.parentToolCallId) return;
		const started = starts.get(event.toolCallId);
		starts.delete(event.toolCallId);
		const delta = started === undefined ? null : Math.max(0, now() - started);
		return annotateToolResult(event, delta);
	});

	// Cleanup only: a started call whose `tool_result` hook Pi skips must not leak
	// its start entry. No footer is fabricated for a result that was never surfaced.
	pi.on("tool_execution_end", async (event, _ctx) => {
		if (event.parentToolCallId) return;
		starts.delete(event.toolCallId);
	});
}
