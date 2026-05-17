/**
 * Ledger tool definitions for the agenticoding extension.
 *
 * Three tools: ledger_add (sequential, serialized write), ledger_get, ledger_list.
 * All read from the in-memory state.ledger Map and always return the current
 * list of entry names in both result text and details.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgenticodingState } from "../state.js";
import { formatEntryList, getEntryNames, saveLedgerEntry } from "./store.js";

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Creates ledger tool definitions (ledger_add, ledger_get, ledger_list).
 *
 * Shared by parent registration (withPromptHints=true) and child spawn
 * sessions (withPromptHints=false). The prompt hints (snippet, guidelines)
 * are only included for the parent — child agents don't need them.
 */
export function createLedgerToolDefinitions(
	pi: ExtensionAPI,
	state: AgenticodingState,
	options?: { withPromptHints?: boolean; isStale?: () => boolean },
): ToolDefinition[] {
	const withHints = options?.withPromptHints ?? false;
	const assertFresh = () => {
		if (options?.isStale?.()) {
			throw new Error("Spawn invalidated by reset.");
		}
	};

	const ledgerAdd: ToolDefinition = {
		name: "ledger_add",
		label: "Ledger Add",
		description:
			"Save or refine a compact continuity entry. " +
			"Same name overwrites the previous entry (refinement). " +
			"Writes are serialized via a process-local lock; same-name writes overwrite in completion order. " +
			"Always returns the current list of up to date entries.",
		...(withHints
			? {
					promptSnippet: "Save or refine a compact continuity entry",
					promptGuidelines: [
						"Continuously maintain the ledger while you work. After meaningful reads, research, analysis, decisions, or milestones, either refine an existing entry, create a compact reusable entry, or consciously skip because nothing reusable was learned.",
						"Prefer refining existing entries over creating many tiny ones. Do not try to make the ledger complete.",
					],
				}
			: {}),
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Kebab-case entry identifier. Using an existing name overwrites that entry (refinement).",
			}),
			content: Type.String({
				description:
					"Compact markdown. Capture only reusable facts, decisions, " +
					"constraints, progress, and expensive discoveries. " +
					"Truncated at 50KB / 2000 lines.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			assertFresh();
			const names = await saveLedgerEntry(pi, state, params.name, params.content, assertFresh);
			return {
				content: [
					{
						type: "text",
						text: `Saved ledger entry "${params.name}".` +
							`\n\nEntries:\n${formatEntryList(state) || "(empty)"}`,
					},
				],
				details: { entries: names },
			};
		},
	};

	const ledgerGet: ToolDefinition = {
		name: "ledger_get",
		label: "Ledger Get",
		description:
			"Retrieve a ledger entry's full body by name. " +
			"Always returns the current list of entry names.",
		...(withHints
			? { promptSnippet: "Fetch a ledger entry by name" }
			: {}),
		parameters: Type.Object({
			name: Type.String({
				description: "Entry name to retrieve.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			assertFresh();
			const content = state.ledger.get(params.name);
			const names = getEntryNames(state);

			if (content === undefined) {
				return {
					content: [
						{
							type: "text",
							text:
								`Entry "${params.name}" not found.` +
								`\n\nEntries:\n${formatEntryList(state) || "(empty)"}`,
						},
					],
					details: { entries: names, found: false },
				};
			}

			return {
				content: [
					{
						type: "text",
						text:
							`--- ${params.name} ---\n${content}\n` +
							`---\nEntries:\n${formatEntryList(state) || "(empty)"}`,
					},
				],
				details: { entries: names, found: true },
			};
		},
	};

	const ledgerList: ToolDefinition = {
		name: "ledger_list",
		label: "Ledger List",
		description:
			"List all ledger entries as name + first-line preview. " +
			"Always returns the current list of entry names.",
		...(withHints
			? { promptSnippet: "List all ledger entries" }
			: {}),
		parameters: Type.Object({}),
		async execute() {
			assertFresh();
			const names = getEntryNames(state);
			return {
				content: [
					{
						type: "text",
						text: `Entries:\n${formatEntryList(state) || "(empty)"}`,
					},
				],
				details: { entries: names },
			};
		},
	};

	return [ledgerAdd, ledgerGet, ledgerList];
}

// ── Registration ──────────────────────────────────────────────────────

export function registerLedgerTools(
	pi: ExtensionAPI,
	state: AgenticodingState,
): void {
	const tools = createLedgerToolDefinitions(pi, state, { withPromptHints: true });
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
