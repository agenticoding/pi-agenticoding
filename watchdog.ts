/**
 * Watchdog: primacy-zone reminder plus sticky enforcement for user-requested handoff.
 *
 * Exposes nudge text generation and records the latest context usage at
 * `agent_end` for UI/state purposes. Actual reminder injection happens in the
 * `context` hook so it can appear before every LLM call in the same agent run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "./state.js";
import { STATUS_KEY_HANDOFF } from "./tui.js";

/** Max turns a user-requested handoff remains sticky before auto-clear.
 * 5 turns gives the LLM ~2-3 response cycles to draft and execute
 * a handoff brief before we give up and notify the user. */
const MAX_HANDOFF_ATTEMPTS = 5;

export function buildNudge(
	state: Pick<AgenticodingState, "activeNotebookTopic" | "pendingTopicBoundaryHint" | "readonlyEnabled" | "pendingRequestedHandoff">,
	percent: number | null,
): string {
	const pct = percent === null ? null : Math.round(percent);
	const topic = state.activeNotebookTopic;
	const boundary = state.pendingTopicBoundaryHint;
	const readonly = state.readonlyEnabled;
	const requestedHandoff = state.pendingRequestedHandoff;

	if (requestedHandoff) {
		const readonlyContinuation = requestedHandoff.resumeReadonlyAfterHandoff
			? "Readonly remains active for normal mutations. A temporary exception allows only the handoff tool for this request. After handoff, the fresh context will resume in readonly mode and the exception will be cleared. Draft the brief for readonly continuation."
			: "Complete a real handoff now rather than continuing normal work. Draft the brief so the next context can start cleanly.";
		return `User explicitly requested /handoff.
You must complete a real handoff in this session now.
Save durable findings to the notebook if needed, then call handoff.
${readonlyContinuation}`;
	}

	if (boundary) {
		if (readonly) {
			return `Notebook topic changed from ${boundary.from ?? "(unset)"} to ${boundary.to}.
Readonly mode is active. Use spawn only for subtasks that still fit the current topic. If the user explicitly requests /handoff, complete it and ensure the brief says the fresh context resumes in readonly mode.`;
		}
		return `Notebook topic changed from ${boundary.from ?? "(unset)"} to ${boundary.to}.
Treat this as a strong task-boundary signal. Prefer a deliberate handoff before
continuing under the new topic: save durable findings to the notebook, draft a
concise situational brief, and call handoff. Only continue inline if this was
merely a rename rather than a real pivot.`;
	}

	if (readonly) {
		const contextLead = pct === null
			? "Readonly mode is active."
			: `Context at ${pct}% — readonly mode is active.`;

		const readonlyAdvice = "Use spawn only for same-topic delegation. If the user explicitly requests /handoff, complete it and ensure the brief says the fresh context resumes in readonly mode.";
		if (topic) {
			return `${contextLead}
Active notebook topic: ${topic}.
${readonlyAdvice}
Save durable findings to the notebook before moving on.`;
		}
		return `${contextLead}
${readonlyAdvice}
Assign a short stable topic with notebook_topic_set to track the current frame.`;
	}

	// ── Not readonly — existing logic unchanged ──────────────────────
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
		// ── Enforcement counter: prevent infinite handoff nudges ──
		const requestedHandoff = state.pendingRequestedHandoff;
		if (requestedHandoff && !requestedHandoff.toolCalled) {
			requestedHandoff.enforcementAttempts += 1;
			if (requestedHandoff.enforcementAttempts >= MAX_HANDOFF_ATTEMPTS) {
				state.pendingRequestedHandoff = null;
				if (ctx.hasUI) {
					ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
					ctx.ui.notify(
						`User-requested /handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} turns without completion. Use /handoff <direction> again to retry.`,
						"warning",
					);
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
