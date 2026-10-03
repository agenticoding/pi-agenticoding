/**
 * Branch-scoped persistence for the active-time clock.
 *
 * WHY branch-scoped custom entries (not in-memory only): L must survive
 * reloads, rewinds, and forks. Each boundary appends a reading; rewind
 * (session_tree) reconstructs from the newly active branch, so an older
 * branch naturally yields a smaller L (rewind-correct, per design rule 3).
 *
 * WHY result-position association: parallel completion entries precede the
 * batch's result messages. A tool reading applies only at its own retained
 * result, not at another tool's completion. Other boundaries apply directly.
 * Invalid entries are skipped; a branch with no reading restores to zero.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { advance, read, restore, snapshot, type Clock } from "./clock.js";
import { formatCutAnchor } from "./format.js";

export const CLOCK_ENTRY_TYPE = "pi-schematic-clock";

interface ClockEntryData {
	version: number;
	l: number;
	toolCallId?: string;
}

/** Reject corrupt readings and associations rather than treating them as boundaries. */
function readValidClockData(entry: SessionEntry): ClockEntryData | null {
	if (entry?.type !== "custom" || entry.customType !== CLOCK_ENTRY_TYPE) return null;
	const data = entry.data as ClockEntryData | undefined;
	if (data?.version !== 1) return null;
	if (!Number.isSafeInteger(data.l) || data.l < 0) return null;
	if (data.toolCallId !== undefined &&
		(typeof data.toolCallId !== "string" || data.toolCallId.length === 0)) return null;
	return data;
}

/** Record the current reading at an activity boundary. Branch-scoped, model-invisible. */
export function persistClock(pi: ExtensionAPI, clock: Clock, toolCallId?: string): void {
	const data: ClockEntryData = { version: 1, l: snapshot(clock) };
	if (toolCallId !== undefined) data.toolCallId = toolCallId;
	pi.appendEntry(CLOCK_ENTRY_TYPE, data);
}

/** Raw data is the source of truth; never recover elapsed time from rendered footers. */
function readBranchElapsed(branch: readonly SessionEntry[]): number | null {
	const toolReadings = new Map<string, number>();
	let elapsed: number | null = null;
	for (const entry of branch) {
		const data = readValidClockData(entry);
		if (data?.toolCallId !== undefined) toolReadings.set(data.toolCallId, data.l);
		else if (data !== null) elapsed = data.l;
		if (entry.type === "message" && entry.message?.role === "toolResult") {
			elapsed = toolReadings.get(entry.message.toolCallId) ?? elapsed;
		}
	}
	return elapsed;
}

/**
 * Rebuild `clock` at the last retained boundary or associated tool result.
 * A miss restores to 0 so rewinding to the root or a branch before any clock
 * entry clears the abandoned branch's reading (design rule 1 & boundaries).
 */
export function reconstructClock(
	clock: Clock,
	branch: readonly SessionEntry[],
	now: number,
): void {
	restore(clock, readBranchElapsed(branch) ?? 0, now);
}

/** Rebuild the clock from the host's active branch; tolerates hosts without a session manager (tests). */
export function reconstructClockFromContext(
	clock: Clock,
	ctx: ExtensionContext,
	now: number,
): void {
	reconstructClock(clock, ctx.sessionManager?.getBranch?.() ?? [], now);
}

/** Find the newest compaction strictly before beforeEntryId (or branch end if null/unfound). */
function findPriorCompactionIndex(
	branch: readonly SessionEntry[],
	beforeEntryId: string | null,
): number {
	const limit = beforeEntryId !== null
		? branch.findIndex((entry) => entry?.id === beforeEntryId)
		: -1;
	const scanLimit = limit >= 0 ? limit : branch.length;
	for (let i = scanLimit - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") return i;
	}
	return -1;
}

/**
 * Return the clock reading at/before the previous compaction cut, or null.
 *
 * WHY strictly-before `beforeEntryId`: `session_compact` passes the
 * just-created compaction entry's id. Including it would return the current
 * cut's reading instead of the previous cut's, making `covers` always ~0.
 * Excluding it yields the previous cut's reading, so `covers = now - previous`
 * spans the compacted-away work. A null or unfound id scans the whole branch.
 */
export function readPreviousCutElapsed(
	branch: readonly SessionEntry[],
	beforeEntryId: string | null,
): number | null {
	const cutIndex = findPriorCompactionIndex(branch, beforeEntryId);
	if (cutIndex < 0) return null;
	return readBranchElapsed(branch.slice(0, cutIndex + 1));
}

/**
 * Compute the cut anchor reading and covered span for a compaction event.
 * Reusable by both deliberate handoff compactions and native Pi compactions.
 */
export function resolveCutAnchor(
	clock: Clock,
	branch: readonly SessionEntry[],
	beforeEntryId: string | null,
	now: number,
): { elapsed: number; covered: number | null; anchor: string } {
	advance(clock, now);
	const elapsed = read(clock);
	const base = readPreviousCutElapsed(branch, beforeEntryId);
	const covered = base === null ? null : Math.max(0, elapsed - base);
	const anchor = formatCutAnchor(elapsed, covered);
	return { elapsed, covered, anchor };
}
