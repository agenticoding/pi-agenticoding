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
				`Handoff direction: ${direction}\n\nPrepare a real handoff in the current session and current context. Before calling the handoff tool, capture any reusable state in the ledger that aligns with the direction above. Then complete the picture in a concise but sufficiently detailed handoff brief and call the handoff tool in this turn. Preserve the important knowledge that is still only present in the current context so the next clean context can start well without re-deriving it. Use any structure that makes the next work unambiguous. Include findings, current state, unresolved questions, failed paths worth avoiding, next steps, refs, constraints, and spawn ideas when useful. Reference ledger entries by name when relevant.`,
				ctx.isIdle() ? undefined : { deliverAs: "followUp" },
			);
		},
	});
}
