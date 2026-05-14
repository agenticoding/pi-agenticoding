/**
 * session_before_compact hook for deliberate handoff compactions.
 *
 * Replaces the active context with the queued handoff task and keeps no
 * pre-handoff messages in LLM context.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";

function getImpossibleKeptId(branchEntries: SessionEntry[]): string {
	const leaf = branchEntries[branchEntries.length - 1];
	return `${leaf?.id ?? "handoff"}-handoff-cut`;
}

export function registerHandoffCompaction(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.on("session_before_compact", async (event) => {
		const pending = state.pendingHandoff;
		if (!pending) {
			return;
		}

		state.pendingHandoff = null;
		state.pendingRequestedHandoff = null;

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
