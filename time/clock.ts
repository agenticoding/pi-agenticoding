/**
 * Active-time clock for the time-awareness feature.
 *
 * WHY pure + injectable `now`: the clock must be deterministic and testable —
 * no project imports, no Date.now(). All events are driven by explicit
 * timestamps so idle gaps, UI waits, and overlaps behave identically in
 * tests and production.
 *
 * WHY depth counter: assistant generation and tool execution overlap
 * (nested/parallel); wall time is advanced only when depth > 0, so each
 * active span counts once (union, not sum).
 *
 * WHY uiBlocked: human UI-prompt waits inside an active interval must NOT
 * count as active time; the frozen window is skipped by rewinding lastMarkMs
 * on resume instead of accumulating and subtracting.
 */

/** Process-local measurement only; persisted readings never contain this origin. */
export function monotonicNow(): number {
	return performance.now();
}

export interface Clock {
	elapsedMs: number;
	lastMarkMs: number;
	depth: number;
	uiBlocked: boolean;
	generationStartElapsedMs: number | null;
	toolStarts: Map<string, number>;
}

export function createClock(now: number): Clock {
	return {
		elapsedMs: 0,
		lastMarkMs: now,
		depth: 0,
		uiBlocked: false,
		generationStartElapsedMs: null,
		toolStarts: new Map(),
	};
}

/** Add wall time to elapsedMs only while active and not UI-blocked; lastMarkMs always moves. */
export function advance(clock: Clock, now: number): void {
	if (clock.depth > 0 && !clock.uiBlocked && now > clock.lastMarkMs) {
		clock.elapsedMs += now - clock.lastMarkMs;
	}
	clock.lastMarkMs = now;
}

export function startGeneration(clock: Clock, now: number): void {
	// A generation is singular in pi's agent loop: a mid-stream throw is followed
	// by a synthetic failure-path message_start. Ignore a repeated start so depth
	// cannot double-increment (which would leak and inflate every later reading).
	if (clock.generationStartElapsedMs !== null) return;
	advance(clock, now);
	clock.generationStartElapsedMs = clock.elapsedMs;
	clock.depth++;
}

export function endGeneration(
	clock: Clock,
	now: number,
): { elapsed: number; delta: number } {
	advance(clock, now);
	const start = clock.generationStartElapsedMs;
	clock.generationStartElapsedMs = null;
	// Only the generation that incremented depth may decrement it; an orphan end
	// must not consume a concurrently running span's slot.
	if (start === null) return { elapsed: clock.elapsedMs, delta: 0 };
	if (clock.depth > 0) clock.depth--;
	return { elapsed: clock.elapsedMs, delta: clock.elapsedMs - start };
}

export function startTool(clock: Clock, id: string, now: number): void {
	if (clock.toolStarts.has(id)) return;
	advance(clock, now);
	clock.toolStarts.set(id, clock.elapsedMs);
	clock.depth++;
}

export function endTool(
	clock: Clock,
	id: string,
	now: number,
): { elapsed: number; delta: number | null } {
	// Advance BEFORE removing the start so the ending tool's time is captured while depth still counts it.
	advance(clock, now);
	const started = clock.toolStarts.get(id);
	const delta = started === undefined ? null : Math.max(0, clock.elapsedMs - started);
	clock.toolStarts.delete(id);
	// Only the tool that incremented depth may decrement it; an unknown id never
	// owned a slot, so decrementing would unbalance a concurrently running tool.
	if (started !== undefined && clock.depth > 0) clock.depth--;
	return { elapsed: clock.elapsedMs, delta };
}

export function startUiPrompt(clock: Clock, now: number): void {
	if (clock.uiBlocked) return;
	// Freeze accumulated time up to the prompt moment.
	advance(clock, now);
	clock.uiBlocked = true;
}

export function endUiPrompt(clock: Clock, now: number): void {
	if (!clock.uiBlocked) return;
	clock.uiBlocked = false;
	// The blocked wall-clock window is never added; resume marking from now.
	clock.lastMarkMs = now;
}

export function read(clock: Clock): number {
	return clock.elapsedMs;
}

/** Reinitialize after session reload: drops all in-flight spans, keeps elapsed reading. */
export function restore(
	clock: Clock,
	elapsedMs: number,
	now: number,
): void {
	clock.elapsedMs = elapsedMs;
	clock.lastMarkMs = now;
	clock.depth = 0;
	clock.uiBlocked = false;
	clock.generationStartElapsedMs = null;
	clock.toolStarts.clear();
}

export function snapshot(clock: Clock): number {
	return Math.round(clock.elapsedMs);
}
