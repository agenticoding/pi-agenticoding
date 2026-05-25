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

/** Update TUI indicators: context usage, notebook count, warning widget. */
export function updateIndicators(ctx: ExtensionContext, state: AgenticodingState): void {
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

	// High-context warning widget (above editor)
	if (usage && usage.percent !== null && usage.percent >= 70) {
		ctx.ui.setWidget(WIDGET_KEY_WARNING, [
			theme.fg("error", "\u26A0 ") +
				theme.fg("warning", `Context at ${Math.round(usage.percent)}% — consider handoff`),
		]);
	} else {
		ctx.ui.setWidget(WIDGET_KEY_WARNING, undefined);
	}
}
