import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

export function emitHandoffDiagnostic(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "warning",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify?.(message, level);
	}
}

export function clearPendingHandoffCompaction(state: AgenticodingState, ctx: ExtensionContext): void {
	state.pendingHandoff = null;
	state.pendingRequestedHandoff = null;
	state.pendingRequestedHandoffPrompt = null;
	if (ctx.hasUI) {
		ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
	}
}

export async function clearStaleRequestedHandoff(
	_pi: ExtensionAPI,
	state: AgenticodingState,
	ctx: ExtensionContext,
): Promise<void> {
	const requested = state.pendingRequestedHandoff;
	if (!requested) {
		return;
	}
	state.pendingRequestedHandoff = null;
	state.pendingRequestedHandoffPrompt = null;
	if (ctx.hasUI) {
		ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
	}
}
