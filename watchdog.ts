/**
 * Watchdog: advisory primacy-zone reminder.
 *
 * Exposes nudge text generation and records the latest context usage at
 * `agent_end` for UI/state purposes. Actual reminder injection happens in the
 * `context` hook so it can appear before every LLM call in the same agent run.
 *
 * Never force-disengages — the watchdog is advisory only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "./state.js";
import { STATUS_KEY_HANDOFF } from "./tui.js";

export function buildNudge(state: Pick<AgenticodingState, "activeNotebookTopic" | "pendingTopicBoundaryHint">, percent: number | null): string {
	const pct = percent === null ? null : Math.round(percent);
	const topic = state.activeNotebookTopic;
	const boundary = state.pendingTopicBoundaryHint;

	if (boundary) {
		return `Notebook topic changed from ${boundary.from ?? "(unset)"} to ${boundary.to}.
Treat this as a strong task-boundary signal. Prefer a deliberate handoff before
continuing under the new topic: save durable findings to the notebook, draft a
concise situational brief, and call handoff. Only continue inline if this was
merely a rename rather than a real pivot.`;
	}

	const contextLead = pct === null
		? "Topic-aware context reminder."
		: pct >= 70
			? `Context at ${pct}% — topic discipline is urgent.`
			: pct >= 50
				? `Context at ${pct}% — topic discipline matters now.`
				: `Context at ${pct}% — choose your next step by topic fit.`;

	if (topic) {
		const urgency = pct !== null && pct >= 70
			? "If the work no longer fits this topic, prefer a deliberate handoff now. If it still fits and only a focused noisy branch is needed, spawn it instead of polluting the parent context."
			: "If the current work still fits this topic, prefer spawn for isolated noisy subtasks. If it no longer fits, prefer handoff instead of dragging stale context forward.";
		return `${contextLead}
Active notebook topic: ${topic}.
Use the topic as the current semantic frame. ${urgency}
Save durable findings to the notebook before handoff.`;
	}

	const noTopicUrgency = pct !== null && pct >= 70
		? "Assign a fresh topic in the next clean context after handoff."
		: "Assign a short stable topic soon. If the work stays within that topic, prefer spawn for noisy subtasks. If the work shifts beyond it, prefer handoff.";
	return `${contextLead}
No active notebook topic is set. ${noTopicUrgency}`;
}

/**
 * Register the watchdog's `agent_end` handler.
 *
 * Must be called from the extension factory in index.ts after state creation.
 */
export function registerWatchdog(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		const requestedHandoff = state.pendingRequestedHandoff;
		if (requestedHandoff) {
			requestedHandoff.enforcementAttempts += 1;
			if (!requestedHandoff.toolCalled) {
				state.pendingRequestedHandoff = null;
				if (ctx.hasUI) {
					ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
				}
			}
		}

		// ── Primacy-zone nudge ──────────────────────────────────────
		const usage = ctx.getContextUsage();

		// Null usage / null percent — right after compaction, before next LLM response.
		if (!usage || usage.percent === null) {
			state.lastContextPercent = null;
			return;
		}

		state.lastContextPercent = usage.percent;

	});
}
