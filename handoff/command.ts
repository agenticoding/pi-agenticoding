/**
 * /handoff command for the agenticoding extension.
 *
 * Collects a user direction, asks the LLM to complete the picture in a
 * handoff brief, and lets the handoff tool perform the actual compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

export function registerHandoffCommand(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.registerCommand("handoff", {
		description:
			"Ask the LLM to draft a handoff brief that completes the picture from " +
			"your direction, then perform the handoff automatically.",

		handler: async (args, ctx) => {
			const direction = args.trim();
			if (!direction) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /handoff <direction>", "error");
				return;
			}
			if (state.readonlyEnabled) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Readonly mode blocks /handoff. Use spawn only for same-topic delegation, or disable readonly with /readonly before a real handoff.",
						"warning",
					);
				}
				return;
			}

			state.pendingRequestedHandoff = {
				direction,
				enforcementAttempts: 0,
				toolCalled: false,
			};

			// Show live progress indicator in footer
			if (ctx.hasUI && ctx.ui.theme) {
				ctx.ui.setStatus(
					STATUS_KEY_HANDOFF,
					ctx.ui.theme.fg("accent", "\uD83E\uDD1D Handoff in progress"),
				);
			}

			pi.sendUserMessage(
				`Handoff direction: ${direction}\n\nPrepare a handoff in the current session. First, save any durable reusable knowledge to the notebook: findings worth keeping, constraints discovered, decisions made, or other grounding future contexts will need. Then draft a concise but sufficiently detailed handoff brief capturing only the remaining situational context: current state, blockers, unresolved questions, failed paths worth avoiding, and next steps. The next context will read the notebook on demand, so do not duplicate notebook content in the brief. Use any structure that makes the next work unambiguous. Reference notebook pages by name when relevant.`,
				ctx.isIdle() ? undefined : { deliverAs: "followUp" },
			);
		},
	});
}
