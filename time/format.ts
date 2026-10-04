/**
 * Duration formatting — the single source of truth for the tool-run delta
 * rendered in a tool-result footer.
 *
 * WHY pure (no project imports): the formatting rules are a stable contract;
 * isolating them keeps the math unit-testable and lets the rule set evolve
 * without touching event glue.
 *
 * WHY floor (not round): a tool run is observed execution, never rounded human
 * idle. Floored tenths avoid crediting a pause or a sub-100ms abort as work,
 * and the 0.1s floor for tiny non-zero deltas keeps an aborted block honest as
 * non-zero instead of a misleading "+0s".
 */

// Seconds-with-one-decimal max (excludes 10_000, which becomes integer seconds).
const ONE_DECIMAL_MAX_MS = 10_000;
const INTEGER_SECONDS_MAX_MS = 60_000;
const MINUTES_MAX_MS = 3_600_000;

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** 0, negative, or non-finite -> "0s"; nonzero <100ms -> "0.1s" (floor-up, never "0.0s"); then floored 1dp / integer / mm:ss / hh:mm. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 100) return "0.1s"; // nonzero sub-100ms floors up so an abort never reads "0s"
	if (ms < ONE_DECIMAL_MAX_MS) {
		// One decimal, floored: Math.floor(ms/100) is the tenths count. Splitting it
		// into digits avoids float formatting and never rounds 9999ms up to "10.0s".
		const tenths = Math.floor(ms / 100);
		return `${Math.floor(tenths / 10)}.${tenths % 10}s`;
	}
	if (ms < INTEGER_SECONDS_MAX_MS) return `${Math.floor(ms / 1000)}s`;
	if (ms < MINUTES_MAX_MS) {
		return `${Math.floor(ms / 60_000)}m${pad2(Math.floor((ms % 60_000) / 1000))}s`;
	}
	return `${Math.floor(ms / 3_600_000)}h${pad2(Math.floor((ms % 3_600_000) / 60_000))}m`;
}

/**
 * `[<tool> +<step>]` — the tool-result footer. The single model-visible time surface.
 *
 * WHY the kind label: a bare `[+3.2s]` names nothing; one result's footer can sit
 * directly above the next result's, so an unlabeled pair is unassignable.
 *
 * WHY the step delta is always rendered: a uniform shape makes every footer read
 * the same way. A sub-500ms step is not omitted — its absence would be
 * indistinguishable from a measurement that was never taken.
 *
 * `kind` is the tool's name. `deltaMs` is null when the span was never recorded
 * (for example a blocked call), rendering `[<tool>]` rather than an invented value.
 */
export function formatBlockFooter(kind: string, deltaMs: number | null): string {
	if (deltaMs === null) return `[${kind}]`;
	// A zero step floors to "0.1s" so an aborted instant block never reads "+0s".
	const step = deltaMs === 0 ? "0.1s" : formatDuration(deltaMs);
	return `[${kind} +${step}]`;
}

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
] as const;

/** Local month + year: matches the user's wall calendar. It carries no clock reading, so it is deliberately not timezone-invariant. */
export function formatCurrentPeriod(date: Date): string {
	return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}
