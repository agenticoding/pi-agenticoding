/**
 * Handoff tool for the agenticoding extension.
 *
 * Tools can trigger compaction directly, so handoff is implemented as a
 * deliberate compaction that replaces noisy context with a clean restart brief.
 *
 * The brief should complete the picture: preserve the important situational
 * context that is still only present in the current turn, while notebook pages
 * remain durable grounding fetched on demand in the next context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearActiveNotebookTopic } from "../notebook/topic.js";
import {
	HANDOFF_IN_PROGRESS_STATUS,
	HANDOFF_REQUESTED_STATUS,
	HANDOFF_REQUIRED_STATUS,
} from "./copy.js";
import { buildEnrichedTask } from "./format.js";
import {
	MIN_HANDOFF_TOKENS,
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	isHandoffEligible,
	normalizeContextPercent,
} from "./eligibility.js";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

function validateHandoffTask(task: string, ctx: ExtensionContext): void {
	const trimmed = task.trim();
	if (!trimmed) {
		const pct = normalizeContextPercent(ctx.getContextUsage()?.percent);
		throw new Error(
			`Context at ${pct === null ? "?" : Math.round(pct) + "%"}. Empty handoff rejected. Save findings to notebook, then draft a substantive brief.`,
		);
	}

	const usage = ctx.getContextUsage();
	const approximateTokens = estimateHandoffContextTokens(usage);
	if (approximateTokens === null) {
		throw new Error(
			"Context usage unavailable. Handoff requires an estimated session size of at least 30K tokens before compaction can work, so this handoff is rejected until context usage can be measured. Continue working in the current context.",
		);
	}
	if (approximateTokens < MIN_HANDOFF_TOKENS) {
		const tokenLabel = formatHandoffContextUsage(usage);
		const percent = normalizeContextPercent(usage?.percent);
		const pctLabel = percent === null ? "?" : `~${Math.round(percent)}%`;
		throw new Error(
			`Context at ${pctLabel} (${tokenLabel}). Session is too small for handoff — this extension requires at least 30K tokens before compaction can work. Continue working in the current context.`,
		);
	}
}

function completeHandoff(pi: ExtensionAPI, state: AgenticodingState, ctx: ExtensionContext): void {
	// Finalize the two-phase clear: pendingHandoff was already cleared by compact.ts;
	// this is the sole path that clears pendingRequestedHandoff after successful compaction.
	state.pendingHandoff = null;
	clearActiveNotebookTopic(state);
	state.pendingRequestedHandoff = null;
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
		ctx.ui.notify("Handoff complete. Fresh context will resume with the queued brief.", "info");
	}
	pi.sendUserMessage("Proceed.");
}

function notifyHandoffFailure(ctx: ExtensionContext, error: Error, pendingRequest: AgenticodingState["pendingRequestedHandoff"]): void {
	if (!ctx.hasUI) return;
	if (pendingRequest && ctx.ui.theme) {
		const status = isHandoffEligible(ctx.getContextUsage())
			? HANDOFF_REQUIRED_STATUS
			: HANDOFF_REQUESTED_STATUS;
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", status));
	} else {
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
	}
	ctx.ui.notify(`Handoff compaction failed: ${error.message}. The handoff can be retried.`, "error");
}

function sendHandoffFailure(pi: ExtensionAPI, error: Error, pendingRequest: AgenticodingState["pendingRequestedHandoff"]): void {
	const nextStep = pendingRequest
		? "The required handoff remains pending; retry when context usage is eligible. "
		: "No required handoff remains pending; retry when ready. ";
	pi.sendUserMessage(`Handoff failed — ${error.message}. ${nextStep}Continue working in the current context.`);
}

function failHandoff(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
	rawError: unknown,
): void {
	const error = rawError instanceof Error ? rawError : new Error(String(rawError));
	state.pendingHandoff = null;
	const pendingRequest = state.pendingRequestedHandoff;
	if (pendingRequest) pendingRequest.toolCalled = false;
	notifyHandoffFailure(ctx, error, pendingRequest);
	sendHandoffFailure(pi, error, pendingRequest);
}

function createHandoffCallbacks(
	pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
	generation: number,
): { onComplete: () => void; onError: (error: unknown) => void } {
	let settled = false;
	const clearInFlight = () => {
		// Pair generation with handoffCompactionGeneration: only clear this
		// reservation if it is still the active one. A newer handoff will have
		// bumped handoffGeneration and set its own reservation.
		if (state.handoffCompactionGeneration !== generation) return;
		state.handoffCompactionGeneration = null;
		if (state.pendingHandoff?.generation === generation) state.pendingHandoff = null;
	};
	const isCurrent = () => state.handoffGeneration === generation;
	return {
		onComplete: () => {
			if (settled) return;
			settled = true;
			clearInFlight();
			if (isCurrent()) completeHandoff(pi, state, ctx);
		},
		onError: (error) => {
			if (settled) return;
			settled = true;
			clearInFlight();
			if (isCurrent()) failHandoff(pi, state, ctx, error);
		},
	};
}

export function registerHandoffTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Replace the active context with a compact task brief at the end of " +
			"the current turn while keeping full history in the session file. Handoff clears the active notebook topic so the next clean context can assign a fresh one.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context is eligible (measurable and at least 30K tokens) and the current job is no longer cleanly " +
			"represented near the front of attention.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current job is complete and a new distinct task starts.\n" +
			"  4. This extension's handoff guard requires at least 30K tokens before compaction can work, and rejects handoff when that size cannot be estimated. " +
			"That is roughly the mid-teens percent range in common context windows, " +
			"so treat any percentage wording here as approximate.\n\n" +
			"Rule: one context, one job. When the job changes, call handoff only when eligible; otherwise continue inline or use spawn.\n\n" +
			"AFTER HANDOFF the LLM sees:\n" +
			"  • System prompt + context primer\n" +
			"  • The handoff task — the distilled next work at the top of context\n" +
			"  • All notebook pages — durable grounding accessible via notebook_read / notebook_index",

		promptSnippet: "Pivot to a new job via deliberate handoff compaction",
		promptGuidelines: [
			"Before handoff, promote any missing durable grounding knowledge that the next context will need to the notebook. " +
				"Then draft a concise but sufficiently detailed brief with the distilled next task and immediate starting state for the next clean context. The active notebook topic will reset after handoff, so the next context should assign a fresh topic from the brief or user direction.",
			"Do not call handoff when the session is below this extension's ~30K-token minimum threshold or when context usage cannot be estimated yet. " +
				"In common context windows that is only an approximate mid-teens percentage, so prefer the token rule when known. " +
				"Use spawn for subtasks or continue inline until the context grows.",
		],

		executionMode: "sequential",

		parameters: Type.Object({
			task: Type.String({
				description:
					"What to do next. A concise but sufficiently detailed handoff brief. " +
					"This becomes the FIRST thing the LLM sees after handoff. Capture the distilled next task, " +
					"immediate starting state, blockers, failed paths worth avoiding, and relevant notebook page names. " +
					"The notebook is the long-term grounding store; this brief should carry only the remaining situational context.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.handoffCompactionGeneration !== null) {
				throw new Error("Handoff compaction already in progress; retry after it completes.");
			}
			// validateHandoffTask throws with a user-facing reason. Before the throw
			// reaches Pi (which will render a generic tool-error), send the richer
			// sendHandoffFailure message so the LLM gets actionable guidance. The
			// throw after this ensures Pi's tool-call lifecycle sees the rejection.
			try {
				validateHandoffTask(params.task, ctx);
			} catch (error) {
				sendHandoffFailure(pi, error instanceof Error ? error : new Error(String(error)), state.pendingRequestedHandoff);
				throw error;
			}
			const requestedHandoff = state.pendingRequestedHandoff;
			const generation = ++state.handoffGeneration;
			state.pendingHandoff = {
				task: params.task,
				source: "tool",
				generation,
			};
			state.handoffCompactionGeneration = generation;
			if (requestedHandoff) requestedHandoff.toolCalled = true;
			if (ctx.hasUI && ctx.ui.theme) {
				ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", HANDOFF_IN_PROGRESS_STATUS));
			}

			const callbacks = createHandoffCallbacks(pi, state, ctx, generation);
			try {
				ctx.compact(callbacks);
			} catch (error) {
				callbacks.onError(error);
				throw error;
			}

			return {
				content: [{ type: "text", text: "Handoff started." }],
				details: {},
				terminate: true,
			};
		},

	});
}
