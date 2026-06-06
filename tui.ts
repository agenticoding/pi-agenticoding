/**
 * Shared TUI indicator updates for the agenticoding extension.
 *
 * Extracted from index.ts so that tool execute handlers can push live
 * updates to the TUI during tool execution — not just at turn boundaries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "./state.js";

// ── TUI status / widget keys ─────────────────────────────────────────

/** Status bar key for the handoff-in-progress indicator. */
export const STATUS_KEY_HANDOFF = "agenticoding-handoff";

/** Widget key for the high-context warning banner above the editor. */
export const WIDGET_KEY_WARNING = "agenticoding-warning";

/** Status bar key for context usage percentage. */
export const STATUS_KEY_CTX = "agenticoding-ctx";

/** Status bar key for notebook page count. */
export const STATUS_KEY_NOTEBOOK = "agenticoding-notebook";

/** Status bar key for the active notebook topic. */
export const STATUS_KEY_TOPIC = "agenticoding-topic";

/** Update TUI indicators: context usage, notebook count, topic, warning widget. */
export function updateIndicators(ctx: ExtensionContext, state: AgenticodingState, handoffAutomaticEnabled = true): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;

	// Context usage
	const usage = ctx.getContextUsage();
	if (usage && usage.percent !== null) {
		const pct = Math.round(usage.percent);
		const tone = pct >= 70 ? "error" : pct >= 50 ? "warning" : pct >= 30 ? "accent" : "dim";
		ctx.ui.setStatus(STATUS_KEY_CTX, theme.fg("dim", "ctx ") + theme.fg(tone, `${pct}%`));
	} else {
		ctx.ui.setStatus(STATUS_KEY_CTX, theme.fg("dim", "ctx --%"));
	}

	// Notebook page count — show 📒 0 in dim tone when empty so the feature is discoverable
	const count = state.notebookPages.size;
	ctx.ui.setStatus(STATUS_KEY_NOTEBOOK, count > 0
		? `\u{1F4D2} ${count}`
		: theme.fg("dim", "\u{1F4D2} 0"),
	);

	// Active notebook topic — show a dim placeholder when unset so the frame is discoverable
	ctx.ui.setStatus(
		STATUS_KEY_TOPIC,
		state.activeNotebookTopic
			? `\u{1F9ED} ${state.activeNotebookTopic}`
			: theme.fg("dim", "\u{1F9ED} -"),
	);

	// High-context warning widget (above editor)
	if (usage && usage.percent !== null && usage.percent >= 70) {
		const manualHandoffRequest = state.pendingRequestedHandoff !== null && !state.pendingRequestedHandoff.toolCalled;
		const warning = manualHandoffRequest
			? `Context at ${Math.round(usage.percent)}% — manual /handoff request is ${state.pendingRequestedHandoff!.awaitingAgentTurn ? "queued" : "active"}; follow the request, save durable findings, draft the brief, and call the handoff tool`
			: handoffAutomaticEnabled
				? (state.activeNotebookTopic
					? `Context at ${Math.round(usage.percent)}% — use topic fit: same topic → spawn, different topic → handoff`
					: `Context at ${Math.round(usage.percent)}% — no active topic; handoff soon unless you can assign one cleanly`)
				: (state.activeNotebookTopic
					? `Context at ${Math.round(usage.percent)}% — use topic fit: same topic → spawn, different topic → save notes and tell operator if a clean transition is needed`
					: `Context at ${Math.round(usage.percent)}% — no active topic; save notebook findings and continue inline only if safe`);
		ctx.ui.setWidget(WIDGET_KEY_WARNING, [
			theme.fg("error", "\u26A0 ") + theme.fg("warning", warning),
		]);
	} else {
		ctx.ui.setWidget(WIDGET_KEY_WARNING, undefined);
	}
}
