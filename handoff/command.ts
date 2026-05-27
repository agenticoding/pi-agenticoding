/**
 * /handoff command for the agenticoding extension.
 *
 * Collects a user direction, asks the LLM to complete the picture in a
 * handoff brief, and lets the handoff tool perform the actual compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";
import { temporarilyActivateHandoffTool, updateHandoffToolAvailability } from "./availability.js";
import { emitHandoffDiagnostic } from "./cleanup.js";

export function registerHandoffCommand(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.registerCommand("handoff", {
		description:
			"Ask the LLM to draft a handoff brief that completes the picture from " +
			"your direction, then perform the handoff manually.",

		handler: async (args, ctx) => {
			const direction = args.trim();
			if (!direction) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /handoff <direction>", "error");
				return;
			}

			let isIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
			if (!isIdle) {
				if (ctx.hasUI && ctx.ui.theme) {
					ctx.ui.setStatus?.(
						STATUS_KEY_HANDOFF,
						ctx.ui.theme.fg("accent", "\uD83E\uDD1D Handoff pending"),
					);
				}
				if (typeof ctx.waitForIdle === "function") {
					await ctx.waitForIdle();
				}
				isIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
			}

			if (!isIdle) {
				if (ctx.hasUI) {
					ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
					ctx.ui.notify?.("Manual /handoff is waiting for the assistant to become idle before starting a fresh handoff turn.", "warning");
				}
				return;
			}

			const prompt = `Handoff direction: ${direction}\n\nPrepare a handoff in the current session. First, save any durable reusable knowledge to the notebook: findings worth keeping, constraints discovered, decisions made, or other grounding future contexts will need. Then draft a concise but sufficiently detailed handoff brief capturing only the remaining situational context: current state, blockers, unresolved questions, failed paths worth avoiding, and next steps. The next context will read the notebook on demand, so do not duplicate notebook content in the brief. Use any structure that makes the next work unambiguous. Reference notebook pages by name when relevant. After drafting the brief, you must call the \`handoff\` tool with the brief as its task so the session actually compacts. Do not answer with only prose; if the \`handoff\` tool is unavailable, say that manual handoff cannot compact because the handoff tool is unavailable.`;
			state.pendingRequestedHandoff = {
				direction,
				enforcementAttempts: 0,
				toolCalled: false,
				awaitingAgentTurn: true,
			};
			state.pendingRequestedHandoffPrompt = prompt;
			const activated = temporarilyActivateHandoffTool(pi);
			if (!activated) {
				state.pendingRequestedHandoff = null;
				state.pendingRequestedHandoffPrompt = null;
				const message = "Manual /handoff cannot compact because the handoff tool could not be activated for the next agent turn.";
				emitHandoffDiagnostic(pi, ctx, message, "error");
				return;
			}

			// Show live progress indicator in footer
			if (ctx.hasUI && ctx.ui.theme) {
				ctx.ui.setStatus(
					STATUS_KEY_HANDOFF,
					ctx.ui.theme.fg("accent", "\uD83E\uDD1D Handoff in progress"),
				);
			}

			void Promise.resolve(pi.sendUserMessage(prompt)).catch(async (error) => {
				state.pendingRequestedHandoff = null;
				state.pendingRequestedHandoffPrompt = null;
				if (ctx.hasUI) {
					ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
					ctx.ui.notify?.(
						`Manual /handoff could not start: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				await updateHandoffToolAvailability(pi, state, ctx);
			});
		},
	});
}
