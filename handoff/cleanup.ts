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

function clearHandoffStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) {
		ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
	}
}

export function clearPendingHandoffCompaction(state: AgenticodingState, ctx: ExtensionContext): void {
	state.pendingHandoff = null;
	state.pendingRequestedHandoff = null;
	state.pendingRequestedHandoffPrompt = null;
	state.pendingRequestedHandoffRetryProtected = false;
	clearHandoffStatus(ctx);
}

export function preserveManualHandoffRequestAfterCompactionError(
	state: AgenticodingState,
	ctx: ExtensionContext,
	request: NonNullable<AgenticodingState["pendingRequestedHandoff"]> | null,
	prompt: string | null,
	requestGeneration: number | null = null,
): void {
	const pendingGeneration = state.pendingHandoff?.manualRequestGeneration ?? null;
	if (pendingGeneration === requestGeneration) {
		state.pendingHandoff = null;
	}

	if (request) {
		if (requestGeneration !== state.pendingRequestedHandoffGeneration) {
			clearHandoffStatus(ctx);
			return;
		}
		if (state.pendingRequestedHandoff !== null && state.pendingRequestedHandoff.direction !== request.direction) {
			clearHandoffStatus(ctx);
			return;
		}
		state.pendingRequestedHandoff = {
			...request,
			toolCalled: false,
			awaitingAgentTurn: false,
		};
		state.pendingRequestedHandoffPrompt = prompt;
		state.pendingRequestedHandoffRetryProtected = true;
	} else if (state.pendingRequestedHandoff === null) {
		state.pendingRequestedHandoffPrompt = null;
		state.pendingRequestedHandoffRetryProtected = false;
	}
	clearHandoffStatus(ctx);
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
	state.pendingRequestedHandoffRetryProtected = false;
	if (ctx.hasUI) {
		ctx.ui.setStatus?.(STATUS_KEY_HANDOFF, undefined);
	}
}
