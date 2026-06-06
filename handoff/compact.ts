/**
 * session_before_compact hook for deliberate handoff compactions.
 *
 * Replaces the active context with the queued handoff task and keeps no
 * pre-handoff messages in LLM context.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { clearActiveNotebookTopic } from "../notebook/topic.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

function getImpossibleKeptId(branchEntries: SessionEntry[]): string {
	const leaf = branchEntries[branchEntries.length - 1];
	return `${leaf?.id ?? "handoff"}-handoff-cut`;
}

export function registerHandoffCompaction(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.on("session_before_compact", async (event, ctx: ExtensionContext) => {
		const pending = state.pendingHandoff;
		if (!pending) {
			return;
		}

		state.pendingHandoff = null;
		const manualRequestGeneration = pending.manualRequestGeneration ?? null;
		const manualRequestId = pending.manualRequestId ?? null;
		const ownsPendingManualRequest = state.pendingRequestedHandoff !== null &&
			manualRequestGeneration !== null &&
			manualRequestGeneration === state.pendingRequestedHandoffGeneration &&
			manualRequestId !== null &&
			manualRequestId === state.pendingRequestedHandoff.requestId;
		const legacyToolCalledRequest = state.pendingRequestedHandoff !== null &&
			manualRequestGeneration === null &&
			manualRequestId === null &&
			state.pendingRequestedHandoff.toolCalled &&
			!state.pendingRequestedHandoff.awaitingAgentTurn;
		const shouldClearManualState = state.pendingRequestedHandoff === null || ownsPendingManualRequest || legacyToolCalledRequest;
		if (shouldClearManualState) {
			state.pendingRequestedHandoff = null;
			state.pendingRequestedHandoffPrompt = null;
			state.pendingRequestedHandoffRetryProtected = false;
		}
		clearActiveNotebookTopic(state);

		// Clear the handoff progress indicator only when this compaction owns the
		// visible manual request state; newer queued requests keep their status.
		if (shouldClearManualState && ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
		}

		return {
			compaction: {
				summary: pending.task,
				firstKeptEntryId: getImpossibleKeptId(event.branchEntries),
				tokensBefore: event.preparation.tokensBefore,
				details: { handoff: true, task: pending.task },
			},
		};
	});
}
