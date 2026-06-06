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
import { resolveHandoffAutomaticAvailability } from "../settings.js";
import { preserveManualHandoffRequestAfterCompactionError } from "./cleanup.js";

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
			"Performs authorized context compaction with a supplied task brief. " +
			"Availability is enforced at execution time by extension state and settings.",

		executionMode: "sequential",

		parameters: Type.Object({
			task: Type.String({
				description:
					"Task brief to place at the start of the next compacted context when this handoff request is authorized.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const availability = await resolveHandoffAutomaticAvailability(ctx);
			const manualRequest = state.pendingRequestedHandoff;
			const awaitingManualRequest = manualRequest?.awaitingAgentTurn === true;
			const activeManualRequest = manualRequest?.awaitingAgentTurn === false ? manualRequest : null;
			if (awaitingManualRequest) {
				return {
					content: [{ type: "text", text: "A manual /handoff request is queued, but its generated user turn has not started yet. No compaction was started." }],
					details: { automaticEnabled: availability.automaticEnabled, manualRequest: "awaiting_agent_turn" },
				};
			}
			if (!availability.automaticEnabled && !activeManualRequest) {
				if (ctx.hasUI) {
					ctx.ui.notify("Automatic handoff is disabled by handoff.automaticEnabled=false; use the explicit /handoff <direction> command to request a manual handoff.", "warning");
				}
				return {
					content: [{ type: "text", text: "Automatic handoff is disabled, and there is no active manual /handoff request. No compaction was started." }],
					details: { automaticEnabled: false, manualRequest: false },
				};
			}

			const enrichedTask = buildEnrichedTask(params.task);
			const retryableManualRequest = activeManualRequest
				? { ...activeManualRequest, toolCalled: false, awaitingAgentTurn: false }
				: null;
			const retryableManualRequestPrompt = activeManualRequest ? state.pendingRequestedHandoffPrompt : null;
			const retryableManualRequestGeneration = activeManualRequest ? state.pendingRequestedHandoffGeneration : null;
			state.pendingHandoff = { task: enrichedTask, source: "tool", manualRequestGeneration: retryableManualRequestGeneration };
			if (activeManualRequest) {
				activeManualRequest.toolCalled = true;
			}
			try {
				ctx.compact({
					onComplete: () => {
						pi.sendUserMessage("Proceed.");
					},
					onError: () => {
						preserveManualHandoffRequestAfterCompactionError(state, ctx, retryableManualRequest, retryableManualRequestPrompt, retryableManualRequestGeneration);
					},
				});
			} catch (error) {
				preserveManualHandoffRequestAfterCompactionError(state, ctx, retryableManualRequest, retryableManualRequestPrompt, retryableManualRequestGeneration);
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
