/**
 * session_before_compact hook for deliberate handoff compactions.
 *
 * Replaces the active context with the constant continuation frame plus its one
 * session-specific line (the logical cut anchor), keeping no pre-handoff messages in
 * LLM context. The instruction and situational context are NOT summarized here —
 * tool.ts delivers them as one real user message afterwards.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildHandoffCompactionSummary } from "./format.js";
import type { SchematicState } from "../state.js";
import { resolveCutAnchor } from "../time/store.js";
import { monotonicNow } from "../time/clock.js";

function getImpossibleKeptId(branchEntries: SessionEntry[]): string {
	const leaf = branchEntries[branchEntries.length - 1];
	return `${leaf?.id ?? "handoff"}-handoff-cut`;
}

export function registerHandoffCompaction(pi: ExtensionAPI, state: SchematicState): void {
	pi.on("session_before_compact", async (event, _ctx: ExtensionContext) => {
		const pending = state.pendingHandoff;
		const delivery = state.pendingHandoffDelivery;
		if (!pending || !delivery || pending.generation !== state.handoffGeneration || delivery.generation !== pending.generation) {
			return;
		}

		state.pendingHandoff = null;
		// Two-phase clear contract:
		//   pendingHandoff — cleared here (the compaction hook consumed the queued request)
		//   pendingRequestedHandoff — kept; cleared later by completeHandoff in tool.ts
		//                              (on success) or preserved for retry (on error).
		// Readonly is deliberately NOT read at the cut: the frame is fixed and the live
		// `context` hook re-emits the current readonly state after the handoff. Pi finds
		// `session_compact.compactionEntry` by summary, so the invisible cut marker keeps
		// that host event attached to this cut without adding mutable model guidance.
		// The cut anchor is the one session-specific line added to the constant frame:
		// logical elapsed time, recorded once here, at the cut.
		// Null beforeEntryId: this cut's compaction entry is not on the branch yet, so the
		// newest compaction found is the PREVIOUS cut's, if any.
		const { anchor } = resolveCutAnchor(state.clock, event.branchEntries, null, monotonicNow());
		return {
			compaction: {
				summary: buildHandoffCompactionSummary(delivery.recoveryKey, anchor),
				firstKeptEntryId: getImpossibleKeptId(event.branchEntries),
				tokensBefore: event.preparation.tokensBefore,
				details: { handoff: true, payload: delivery.payload, recoveryKey: delivery.recoveryKey },
			},
		};
	});
}
