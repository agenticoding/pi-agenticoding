/**
 * Notebook rehydration for the agenticoding extension.
 *
 * A session_start handler that scans the current branch newest-to-oldest for
 * persisted notebook-entry (and legacy ledger-entry) custom entries, rebuilds
 * the in-memory state.notebookPages Map (newest wins per name), and ensures
 * notebook_read / notebook_index are active.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface NotebookEntryData {
	version: number;
	epoch: number;
	name: string;
	content: string;
}

interface NotebookCandidate {
	epoch: number;
	content: string;
}

// ── Rehydration entry types ───────────────────────────────────────────

const ENTRY_TYPES = new Set(["notebook-entry", "ledger-entry"]);

// ── Registration ──────────────────────────────────────────────────────

export function registerNotebookRehydration(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();

		// Scan newest-to-oldest; first occurrence of each name wins (newest).
		const candidates = new Map<string, NotebookCandidate>();

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];

			if (
				entry.type !== "custom" ||
				!ENTRY_TYPES.has((entry as Record<string, unknown>).customType as string)
			) {
				continue;
			}

			const data = (entry as Record<string, unknown>).data as NotebookEntryData | undefined;
			if (!data?.name || typeof data.content !== "string") continue;

			// Skip if we already have a newer version of this name
			if (candidates.has(data.name)) continue;

			candidates.set(data.name, {
				epoch: data.epoch ?? 0,
				content: data.content,
			});
		}

		// Rehydrate from persisted history: branch entries are the durable
		// notebook source of truth. Pick the latest persisted epoch across the
		// surviving names, then rebuild the in-memory view from that generation.
		let currentEpoch = 0;
		for (const candidate of candidates.values()) {
			if (candidate.epoch > currentEpoch) {
				currentEpoch = candidate.epoch;
			}
		}
		state.epoch = currentEpoch;

		// Rebuild state.notebookPages, filtering by epoch
		state.notebookPages.clear();
		for (const [name, candidate] of candidates) {
			if (candidate.epoch === currentEpoch) {
				state.notebookPages.set(name, candidate.content);
			}
		}

		// Ensure notebook_read and notebook_index are active so the LLM can fetch pages
		const active = pi.getActiveTools();
		let changed = false;
		if (!active.includes("notebook_read")) {
			active.push("notebook_read");
			changed = true;
		}
		if (!active.includes("notebook_index")) {
			active.push("notebook_index");
			changed = true;
		}
		if (changed) pi.setActiveTools(active);
	});
}
