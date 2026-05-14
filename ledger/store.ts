/**
 * Shared ledger storage helpers.
 *
 * Keeps parent and spawned-child ledger writes on the same persistence path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";

let writeLock: Promise<void> = Promise.resolve();

async function acquireWriteLock(): Promise<() => void> {
	let release: () => void;
	const prev = writeLock;
	writeLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await prev;
	return release!;
}

export function getEntryNames(state: AgenticodingState): string[] {
	return Array.from(state.ledger.keys()).sort();
}

export function formatEntryList(state: AgenticodingState): string {
	const names = getEntryNames(state);
	if (names.length === 0) return "(empty)";

	return names
		.map((name) => {
			const content = state.ledger.get(name)!;
			const firstLine = content.split("\n")[0] ?? "";
			const preview =
				firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
			return `  ${name}: ${preview}`;
		})
		.join("\n");
}

export async function saveLedgerEntry(
	pi: ExtensionAPI,
	state: AgenticodingState,
	name: string,
	content: string,
): Promise<string[]> {
	const release = await acquireWriteLock();
	try {
		const truncated = truncateHead(content, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		if (state.epoch === 0) {
			state.epoch = Date.now();
		}

		state.ledger.set(name, truncated.content);
		pi.appendEntry("ledger-entry", {
			version: 1,
			epoch: state.epoch,
			name,
			content: truncated.content,
		});

		return getEntryNames(state);
	} finally {
		release();
	}
}
