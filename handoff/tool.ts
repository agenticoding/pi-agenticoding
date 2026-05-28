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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

/**
 * Build the enriched task that becomes the compaction summary.
 *
 * Shape: handoff primer + original task.
 */
function buildEnrichedTask(task: string): string {
	const parts: string[] = [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
		"- Notebook pages hold durable grounding knowledge; fetch them with `notebook_read`",
		"- This handoff brief holds the distilled next task and immediate situational context",
		"- Use `notebook_index` to scan available pages when needed",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on notebook grounding and this brief rather than reconstructing old context",
		"",
		"## Task",
		"",
		task,
	];

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
			"Replace the active context with a compact task brief at the end of " +
			"the current turn while keeping full history in the session file. Handoff clears the active notebook topic so the next clean context can assign a fresh one.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context past ~30% and the current job is no longer cleanly " +
			"represented near the front of attention.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current job is complete and a new distinct task starts.\n\n" +
			"Rule: one context, one job. When the job changes, call handoff.\n\n" +
			"BEFORE CALLING HANDOFF you MUST:\n" +
			"  1. Persist all reusable findings to the notebook — anything not in the " +
			"notebook or the brief is permanently lost from context.\n" +
			"  2. Write a brief focused on the NEXT job, not a session recap. " +
			"Summaries of completed work belong in the notebook.\n" +
			"  3. Verify the next context would have everything it needs. If not, " +
			"notebook it first.\n\n" +
			"AFTER HANDOFF the LLM sees:\n" +
			"  • System prompt + context primer\n" +
			"  • The handoff task — the distilled next work at the top of context\n" +
			"  • All notebook pages — durable grounding accessible via notebook_read / notebook_index",

		promptSnippet: "Pivot to a new job via deliberate handoff compaction",
		promptGuidelines: [
			"Before handoff, promote any missing durable grounding knowledge that the next context will need to the notebook. " +
				"Then draft a concise but sufficiently detailed brief with the distilled next task and immediate starting state for the next clean context. The active notebook topic will reset after handoff, so the next context should assign a fresh topic from the brief or user direction.",
			"The brief describes what to do NEXT — not a recap of what was done. " +
				"Findings, decisions, and analysis belong in the notebook. The brief is the " +
				"task description for the next agent context.",
		],

		executionMode: "sequential",

		parameters: Type.Object({
			task: Type.String({
				description:
					"What to do next. A concise but sufficiently detailed handoff brief. " +
					"This becomes the FIRST thing the LLM sees after handoff. Focus on the " +
					"next job: current state, unresolved questions, constraints, and next steps. " +
					"Do NOT recap completed work — persist findings to the notebook before calling " +
					"handoff. Anything not in the notebook or this brief is lost.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const enrichedTask = buildEnrichedTask(params.task);
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
					if (ctx.hasUI) {
						ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
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
