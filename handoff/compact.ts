/**
 * session_before_compact hook for deliberate handoff compactions.
 *
 * Replaces the active context with the queued handoff task and keeps no
 * pre-handoff messages in LLM context.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildEnrichedTask } from "./format.js";
import type { AgenticodingState } from "../state.js";

function getImpossibleKeptId(branchEntries: SessionEntry[]): string {
	const leaf = branchEntries[branchEntries.length - 1];
	return `${leaf?.id ?? "handoff"}-handoff-cut`;
}

export function registerHandoffCompaction(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.on("session_before_compact", async (event, _ctx: ExtensionContext) => {
		const pending = state.pendingHandoff;
		if (!pending || pending.generation !== state.handoffGeneration) {
			return;
		}

		state.pendingHandoff = null;
		// Two-phase clear contract:
		//   pendingHandoff — cleared here (the compaction hook consumed the queued task)
		//   pendingRequestedHandoff — kept; cleared later by completeHandoff in tool.ts
		//                              (on success) or preserved for retry (on error).
		// Read readonlyEnabled at the cut so the brief reflects a toggle made after
		// the handoff tool was called but before Pi consumes the queued task.
		const task = buildEnrichedTask(pending.task, {
			resumeReadonlyAfterHandoff: state.readonlyEnabled,
		});

		return {
			compaction: {
				summary: task,
				firstKeptEntryId: getImpossibleKeptId(event.branchEntries),
				tokensBefore: event.preparation.tokensBefore,
				details: { handoff: true, task },
			},
		};
	});
}
