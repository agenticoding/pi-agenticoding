import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
	formatCurrentDate,
	formatCurrentDatePrompt,
	formatZoneOffset,
	hostZone,
	TEMPORAL_DIRECTIVE,
} from "../../time/format.js";

// Instants are built with Date.UTC throughout, so a run in any host zone
// exercises the same instants — the tests never inherit the runner's wall clock.
const MINUTE = 60_000;

/** An absolute instant, so tests never depend on the host zone. */
function utc(year: number, month: number, day = 1, hour = 0, minute = 0, second = 0): Date {
	return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/** Start of `instant`'s calendar day in `zone`, as epoch milliseconds. */
function localMidnight(instant: Date, zone: string = hostZone()): number {
	const offset = localTimeOfDayMillis(instant, zone);
	const midnight = Math.floor((instant.getTime() + offset) / 86_400_000) * 86_400_000;
	return midnight - offset;
}

// Milliseconds past local midnight. Equivalent to the zone's offset modulo a day,
// which is all the day-boundary arithmetic above needs — west of UTC included.
function localTimeOfDayMillis(instant: Date, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
	const field = (type: string) => Number(parts.find((candidate) => candidate.type === type)!.value);
	return ((field("hour") * 60 + field("minute")) * 60 + field("second")) * 1000;
}

/** The Intl `longOffset` for `date` in `zone`, normalised to `UTC±HH:MM`. */
function intlOffset(date: Date, zone: string): string {
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
	const gmt = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")!.value;
	return gmt === "GMT" ? "UTC+00:00" : gmt.replace("GMT", "UTC");
}

// ── formatZoneOffset ──────────────────────────────────────────────────

test("formatZoneOffset renders Intl offsets for named zones", () => {
	assert.equal(formatZoneOffset(utc(2026, 6, 1), "UTC"), "UTC+00:00");
	assert.equal(formatZoneOffset(utc(2026, 6, 1), "America/New_York"), "UTC-04:00"); // EDT
	assert.equal(formatZoneOffset(utc(2026, 11, 21), "America/New_York"), "UTC-05:00"); // EST
	assert.equal(formatZoneOffset(utc(2026, 6, 1), "Asia/Kolkata"), "UTC+05:30"); // half-hour
	assert.equal(formatZoneOffset(utc(2026, 6, 1), "Asia/Kathmandu"), "UTC+05:45"); // quarter-hour
	assert.equal(formatZoneOffset(utc(2026, 6, 1), "Pacific/Kiritimati"), "UTC+14:00"); // extreme east
});

// Property across the whole valid offset range (UTC±14:00) in 15-minute steps,
// the resolution real zones actually use. The oracle is Intl fed an offset-string
// zone (Node >=22), independent of the arithmetic under test.
test("formatZoneOffset property: minutes east of UTC match Intl", () => {
	const pad = (n: number) => String(n).padStart(2, "0");
	fc.assert(
		fc.property(fc.integer({ min: -840, max: 840 }).map((m) => m - (m % 15)), (minutesEast) => {
			const abs = Math.abs(minutesEast);
			const zone = `${minutesEast < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
			assert.equal(formatZoneOffset(utc(2026, 0, 1), zone), intlOffset(utc(2026, 0, 1), zone));
		}),
		{ numRuns: 200 },
	);
});

// ── hostZone ──────────────────────────────────────────────────────────

// A bogus, empty, or unusable zone must degrade to the fallback: the old failure
// modes were the literal text "undefined" in the prompt, then a RangeError that
// killed before_agent_start. Driven through the public entry point so the branch
// is covered on every runner, whatever the host reports.
test("formatCurrentDate degrades an unusable zone to the fallback", () => {
	for (const zone of ["", "Invalid/Zone", "Etc/Unknown"]) {
		const line = formatCurrentDate(utc(2025, 0, 1, 12), zone);
		assert.doesNotMatch(line, /undefined|Invalid|Unknown/, `${JSON.stringify(zone)} leaked into the prompt`);
		assert.equal(line, "2025-01-01 (Wednesday), UTC (UTC+00:00)", `${JSON.stringify(zone)} must fall back to UTC`);
	}
});

// The host zone is what the prompt renders by default, so it must be renderable
// too — never the text "undefined", never a throw.
test("hostZone drives a renderable default anchor", () => {
	const zone = hostZone();
	assert.notEqual(zone, "", "host zone must not be empty");
	assert.doesNotThrow(() => formatCurrentDatePrompt(new Date(), zone));
	assert.doesNotMatch(formatCurrentDate(utc(2025, 0, 1, 12), zone), /undefined/);
});

// ── formatCurrentDate ─────────────────────────────────────────────────

// Every field must come from the rendered zone, so an instant that is still the
// previous day in that zone renders the previous day.
test("formatCurrentDate renders the calendar day of the zone, not the host", () => {
	assert.equal(
		formatCurrentDate(utc(2026, 9, 5, 4, 0), "America/New_York"),
		"2026-10-05 (Monday), America/New_York (UTC-04:00)",
	);
	assert.equal(
		formatCurrentDate(utc(2026, 9, 5, 2, 0), "America/New_York"),
		"2026-10-04 (Sunday), America/New_York (UTC-04:00)",
	);
	assert.equal(
		formatCurrentDate(utc(2026, 9, 5, 2, 0), "Asia/Jerusalem"),
		"2026-10-05 (Monday), Asia/Jerusalem (UTC+03:00)",
	);
});

test("formatCurrentDate zero-pads month and day", () => {
	assert.match(formatCurrentDate(utc(2025, 0, 1), "UTC"), /^2025-01-01 /);
	assert.match(formatCurrentDate(utc(2025, 8, 9), "UTC"), /^2025-09-09 /);
});

// The host zone is interpolated into the prompt, so a host that reports no
// usable zone must render the fallback rather than the literal text "undefined".
test("formatCurrentDate never renders an unknown zone as text", () => {
	const line = formatCurrentDate(utc(2025, 0, 1, 12));
	assert.doesNotMatch(line, /undefined/);
	assert.match(line, /^\d{4}-\d{2}-\d{2} \(\w+\), \S+ \(UTC[+-]\d{2}:\d{2}\)$/);
});

test("formatCurrentDate carries no clock reading", () => {
	const out = formatCurrentDate(utc(2026, 9, 5, 14, 30, 45), "UTC");
	assert.doesNotMatch(out, /\d{2}:\d{2}:\d{2}/, "no hh:mm:ss");
	assert.doesNotMatch(out, /\dT\d|\dZ/, "no ISO time separator or Z suffix");
});

// ── the caching contract the docs promise ─────────────────────────────

// docs/architecture.md "Date anchor": the block is byte-stable within a calendar
// day. Sweep every minute of a zone's day so no time-of-day reading can leak in.
test("formatCurrentDatePrompt is byte-stable across a whole calendar day", () => {
	const start = utc(2026, 9, 5, 4).getTime(); // 2026-10-05 00:00 in America/New_York
	const baseline = formatCurrentDatePrompt(new Date(start), "America/New_York");
	assert.match(baseline, /^## Current date\n2026-10-05 \(Monday\), America\/New_York \(UTC-04:00\)/);
	for (let minute = 0; minute < 1440; minute++) {
		const instant = new Date(start + minute * MINUTE);
		assert.equal(formatCurrentDatePrompt(instant, "America/New_York"), baseline, `minute ${minute} drifted`);
	}
});

// Same claim for the host zone. The sweep starts at local midnight and runs 22
// hours — shorter than a 23-hour DST day — so it cannot leave that day.
test("formatCurrentDatePrompt is byte-stable across the host day", () => {
	const start = localMidnight(utc(2026, 9, 5, 0));
	const baseline = formatCurrentDatePrompt(new Date(start));
	for (let minute = 0; minute <= 1320; minute++) {
		assert.equal(formatCurrentDatePrompt(new Date(start + minute * MINUTE)), baseline, `minute ${minute} drifted`);
	}
});

// On a DST transition day the anchor may change at most once — the offset flips
// while the date holds — so the cached prefix changes at most twice that day.
test("formatCurrentDatePrompt holds one date change and one offset flip across a DST transition", () => {
	const start = utc(2026, 2, 8, 6).getTime(); // 2026-03-08 01:00 in America/New_York
	const dates = new Set<string>();
	const offsets = new Set<string>();
	for (let minute = 0; minute <= 1320; minute += 15) {
		const line = formatCurrentDate(new Date(start + minute * MINUTE), "America/New_York");
		assert.match(line, /^\d{4}-\d{2}-\d{2} \(\w+\), America\/New_York \(UTC[+-]\d{2}:\d{2}\)$/);
		dates.add(line.slice(0, 10));
		offsets.add(line.slice(line.indexOf("(UTC")));
	}
	assert.ok(dates.size <= 2, `date changed more than once: ${[...dates].join(", ")}`);
	assert.equal(offsets.size, 2, `offset changed more than once: ${[...offsets].join(", ")}`);
	assert.ok(offsets.has("(UTC-05:00)") && offsets.has("(UTC-04:00)"), "spring-forward must flip -05:00 to -04:00");
});

// The offset must be instant-correct against Intl, so a DST flip can never
// render an offset that belongs to the other side of the transition.
test("formatCurrentDate offset matches Intl longOffset authority incl. DST", () => {
	const instants = [utc(2026, 2, 8, 6), utc(2026, 2, 8, 9), utc(2026, 10, 1, 6), utc(2026, 10, 1, 9)];
	for (const instant of instants) {
		assert.equal(formatZoneOffset(instant, "America/New_York"), intlOffset(instant, "America/New_York"));
	}
	assert.equal(formatZoneOffset(utc(2026, 2, 8, 6), "America/New_York"), "UTC-05:00");
	assert.equal(formatZoneOffset(utc(2026, 2, 8, 9), "America/New_York"), "UTC-04:00");
});

// ── formatCurrentDatePrompt ───────────────────────────────────────────

test("formatCurrentDatePrompt anchors the date and instructs resolution", () => {
	const block = formatCurrentDatePrompt(utc(2026, 9, 5), "UTC");
	assert.match(block, /^## Current date\n2026-10-05 \(Monday\), /);
	// Directive text lives only in time/format.ts — assert it verbatim.
	assert.ok(block.endsWith(TEMPORAL_DIRECTIVE));
});

test("formatCurrentDatePrompt renders exactly one ISO date", () => {
	const block = formatCurrentDatePrompt(utc(2026, 9, 5), "UTC");
	assert.equal(block.match(/\d{4}-\d{2}-\d{2}/g)?.length, 1, "exactly one anchor date, no yesterday/tomorrow lines");
});
