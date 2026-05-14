/**
 * Handoff tool for the agenticoding extension.
 *
 * Tools can trigger compaction directly, so handoff is implemented as a
 * deliberate compaction that replaces noisy context with a clean restart brief.
 *
 * The brief should complete the picture: preserve the important knowledge that
 * is still only present in the current context, while referenced ledger entry
 * bodies seed the post-handoff context immediately.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgenticodingState } from "../state.js";

const MAX_INLINE_ENTRIES = 3;
const MAX_INLINE_CHARS = 4000;

/**
 * Extract names of existing ledger entries referenced in the task text.
 * Returns up to MAX_INLINE_ENTRIES entries with their full bodies,
 * capped at MAX_INLINE_CHARS total.
 */
function extractReferencedLedgerEntries(
	task: string,
	state: AgenticodingState,
): { name: string; body: string }[] {
	const entryNames = Array.from(state.ledger.keys()).sort();
	const matched: { name: string; body: string }[] = [];
	const seen = new Set<string>();
	let totalChars = 0;

	for (const name of entryNames) {
		if (task.includes(name) && !seen.has(name)) {
			const body = state.ledger.get(name);
			if (body) {
				const chars = body.length;
				if (totalChars + chars <= MAX_INLINE_CHARS && matched.length < MAX_INLINE_ENTRIES) {
					matched.push({ name, body });
					seen.add(name);
					totalChars += chars;
				}
			}
		}
	}

	return matched;
}

/**
 * Build the enriched task that becomes the compaction summary.
 *
 * Shape: handoff primer + inlined ledger bodies + original task.
 */
function buildEnrichedTask(
	task: string,
	state: AgenticodingState,
): string {
	const refs = extractReferencedLedgerEntries(task, state);

	const parts: string[] = [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Available knowledge:",
		"- Use `ledger_get` to retrieve detailed entries by name on demand",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on ledger knowledge and the handoff brief rather than reconstructing old context",
		"- Treat the handoff brief as the missing picture that survived the cut",
	];

	if (refs.length > 0) {
		parts.push("", "### Inlined Ledger Context");
		for (const { name, body } of refs) {
			parts.push("", `Ledger: \`${name}\``, body, "---");
		}
	}

	parts.push("", "## Task", "", task);

	return parts.join("\n");
}

export function registerHandoffTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Replace the active context with a compact handoff task at the end of " +
			"the current turn while keeping full history in the session file.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context past ~30% and the current job is no longer cleanly " +
			"represented near the front of attention.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current job is complete and a new distinct task starts.\n\n" +
			"Rule: one context, one job. When the job changes, call handoff.\n\n" +
			"AFTER HANDOFF the LLM sees:\n" +
			"  • System prompt + context primer\n" +
			"  • The handoff task — as a compaction summary at the top of context\n" +
			"  • All ledger entries — accessible via ledger_get / ledger_list",

		promptSnippet: "Pivot to a new job via deliberate handoff compaction",
		promptGuidelines: [
			"Call handoff when the job changes, or when context is past ~30% and noisy. " +
				"Capture reusable state in the ledger if needed, then draft a concise but " +
				"sufficiently detailed brief that completes the picture for the next clean context.",
		],

		executionMode: "sequential",

		parameters: Type.Object({
			task: Type.String({
				description:
					"What to do next. A concise but sufficiently detailed handoff brief. " +
					"This becomes the FIRST thing the LLM sees after handoff. Complete the " +
					"picture by preserving the important knowledge still missing from the ledger, " +
					"then make the next work unambiguous using any structure you want.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const enrichedTask = buildEnrichedTask(params.task, state);
			state.pendingHandoff = { task: enrichedTask, source: "tool" };
			if (state.pendingRequestedHandoff) {
				state.pendingRequestedHandoff.toolCalled = true;
			}
			ctx.compact({
				onComplete: () => {
					pi.sendUserMessage("Proceed.");
				},
				onError: () => {
					state.pendingHandoff = null;
					// Safe: pendingRequestedHandoff may already be cleaned up by watchdog
					if (state.pendingRequestedHandoff) {
						state.pendingRequestedHandoff.toolCalled = false;
					}
				},
			});

			return {
				content: [{ type: "text", text: "Handoff started." }],
				details: {},
				terminate: true,
			};
		},

	});
}
