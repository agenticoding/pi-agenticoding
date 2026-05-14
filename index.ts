/**
 * Agenticoding v2 — Extension factory.
 *
 * Wires together the three primitives:
 *   spawn     — delegate isolated work to child contexts
 *   ledger    — sparse continuity cache
 *   handoff   — deliberate task pivot via compaction
 *
 * Also registers:
 *   - watchdog (advisory primacy-zone reminder after each turn)
 *   - system prompt injection (CONTEXT_PRIMER, nudge, ledger listing)
 *   - state reset on /new
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createState, resetState, type AgenticodingState } from "./state.js";
import { CONTEXT_PRIMER } from "./system-prompt.js";
import { buildNudge, registerWatchdog } from "./watchdog.js";
import { registerLedgerTools } from "./ledger/tools.js";
import { registerLedgerRehydration } from "./ledger/rehydration.js";
import { registerHandoffTool } from "./handoff/tool.js";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import { registerSpawnTool } from "./spawn/index.js";

/** Build a status bar preview from ledger entries. */
function formatLedgerPreview(state: AgenticodingState): string {
	const names = Array.from(state.ledger.keys()).sort();
	if (names.length === 0) return "(empty)";
	return names
		.map((name) => {
			const content = state.ledger.get(name)!;
			const firstLine = (content.split("\n")[0] ?? "").slice(0, 60);
			return `${name}: ${firstLine}`;
		})
		.join("\n");
}

/** Update TUI indicators: context usage + ledger count. */
function updateIndicators(ctx: ExtensionContext, state: AgenticodingState): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;

	// Context usage
	const usage = ctx.getContextUsage();
	if (usage && usage.percent !== null) {
		const pct = Math.round(usage.percent);
		const tone = pct >= 70 ? "error" : pct >= 50 ? "warning" : pct >= 30 ? "accent" : "dim";
		ctx.ui.setStatus("agenticoding-ctx", theme.fg("dim", "ctx ") + theme.fg(tone, `${pct}%`));
	} else {
		ctx.ui.setStatus("agenticoding-ctx", theme.fg("dim", "ctx --%"));
	}

	// Ledger count
	const count = state.ledger.size;
	ctx.ui.setStatus("agenticoding-ledger", count > 0 ? `\u{1F4D2} ${count}` : "");
}

export default function (pi: ExtensionAPI): void {
	const state: AgenticodingState = createState();

	// ── Register all tools ──────────────────────────────────────────
	registerLedgerTools(pi, state);
	registerHandoffTool(pi, state);
	registerSpawnTool(pi, state);

	// ── Register event handlers ─────────────────────────────────────
	registerWatchdog(pi, state);
	registerLedgerRehydration(pi, state);
	registerHandoffCompaction(pi, state);

	// ── Register commands ───────────────────────────────────────────
	registerHandoffCommand(pi, state);

	// ── /ledger command — show entries in overlay ───────────────────
	pi.registerCommand("ledger", {
		description: "Show ledger entries with name, line count, and first-line preview",
		handler: async (_args, ctx) => {
			const preview = formatLedgerPreview(state);
			ctx.ui.notify(`Ledger (${state.ledger.size} entries):\n${preview}`, "info");
		},
	});

	// ── before_agent_start: inject context primer + ledger ─────────
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		// Update TUI indicators before each user-prompt agent run
		updateIndicators(ctx, state);

		const parts: string[] = [event.systemPrompt];

		// Inject context management primer at the end of the system prompt
		parts.push("\n" + CONTEXT_PRIMER);

		// Inject ledger listing so the LLM always knows what's available
		const entryNames = Array.from(state.ledger.keys()).sort();
		if (entryNames.length > 0) {
			const listing = entryNames
				.map((name) => {
					const content = state.ledger.get(name)!;
					const firstLine = (content.split("\n")[0] ?? "").slice(0, 80);
					return `  ${name}: ${firstLine}`;
				})
				.join("\n");
			parts.push(
				`\n## Active Ledger Entries\n` +
					`The following entries are available via ledger_get by name:\n${listing}\n` +
					`Reference entries by name — never paste bodies into prompts.`,
			);
		}

		return { systemPrompt: parts.join("\n\n") };
	});

	// ── context: inject primacy-zone nudge before each LLM call ────
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.percent < 30) {
			return;
		}

		state.lastContextPercent = usage.percent;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "agenticoding-watchdog",
					content: buildNudge(usage.percent),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	// ── session_start: reset state + update indicators ─────────────
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		if (event.reason === "new") {
			resetState(state);
		}
		updateIndicators(ctx, state);
	});

	// ── update TUI indicators after each turn ───────────────────────
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		updateIndicators(ctx, state);
	});
}
