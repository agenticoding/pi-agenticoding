/**
 * Ledger rehydration for the agenticoding extension.
 *
 * A session_start handler that scans the current branch newest-to-oldest for
 * persisted ledger-entry custom entries, rebuilds the in-memory state.ledger
 * Map (newest wins per name), and ensures ledger_get / ledger_list are active.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface LedgerEntryData {
	version: number;
	epoch: number;
	name: string;
	content: string;
}

interface LedgerCandidate {
	epoch: number;
	content: string;
}

// ── Registration ──────────────────────────────────────────────────────

export function registerLedgerRehydration(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();

		// Scan newest-to-oldest; first occurrence of each name wins (newest).
		const candidates = new Map<string, LedgerCandidate>();

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];

			if (
				entry.type !== "custom" ||
				(entry as Record<string, unknown>).customType !== "ledger-entry"
			) {
				continue;
			}

			const data = (entry as Record<string, unknown>).data as LedgerEntryData | undefined;
			if (!data?.name || typeof data.content !== "string") continue;

			// Skip if we already have a newer version of this name
			if (candidates.has(data.name)) continue;

			candidates.set(data.name, {
				epoch: data.epoch,
				content: data.content,
			});
		}

		if (candidates.size === 0) return;

		// Determine the current epoch from candidates.
		// If state.epoch is already set (e.g., from first add before rehydration),
		// filter to entries matching that epoch. Otherwise adopt the max epoch found.
		let currentEpoch = state.epoch;
		if (currentEpoch === 0) {
			for (const [, c] of candidates) {
				if (c.epoch > currentEpoch) currentEpoch = c.epoch;
			}
			state.epoch = currentEpoch;
		}

		// Rebuild state.ledger, filtering by epoch
		state.ledger.clear();
		for (const [name, candidate] of candidates) {
			if (candidate.epoch === currentEpoch) {
				state.ledger.set(name, candidate.content);
			}
		}

		// Ensure ledger_get and ledger_list are active so the LLM can fetch entries
		const active = pi.getActiveTools();
		let changed = false;
		if (!active.includes("ledger_get")) {
			active.push("ledger_get");
			changed = true;
		}
		if (!active.includes("ledger_list")) {
			active.push("ledger_list");
			changed = true;
		}
		if (changed) pi.setActiveTools(active);
	});
}
