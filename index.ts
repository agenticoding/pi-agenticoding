/**
 * Agenticoding v2 — Extension factory.
 *
 * Wires together the three primitives:
 *   spawn     — delegate isolated work to child contexts
 *   notebook   — durable cross-context grounding
 *   handoff   — deliberate task pivot via compaction
 *
 * Also registers:
 *   - watchdog (advisory primacy-zone reminder after each turn)
 *   - system prompt injection (CONTEXT_PRIMER, nudge, notebook listing)
 *   - state reset on /new
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { createState, resetState, type AgenticodingState } from "./state.js";
import { CONTEXT_PRIMER } from "./system-prompt.js";
import { buildNudge, registerWatchdog } from "./watchdog.js";
import { registerNotebookTools } from "./notebook/tools.js";
import { registerNotebookRehydration } from "./notebook/rehydration.js";
import { registerNotebookTopicTool } from "./notebook/topic-tool.js";
import { setActiveNotebookTopic } from "./notebook/topic.js";
import { registerHandoffTool } from "./handoff/tool.js";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import { registerSpawnTool } from "./spawn/index.js";
import {
	STATUS_KEY_HANDOFF,
	STATUS_KEY_READONLY,
	STATUS_KEY_TOPIC,
	WIDGET_KEY_WARNING,
	updateIndicators,
} from "./tui.js";
import { isSafeReadonlyCommand } from "./readonly-bash.js";
import { formatPagePreview } from "./notebook/store.js";

export default function (pi: ExtensionAPI): void {
	const state: AgenticodingState = createState();

	// ── Register all tools ──────────────────────────────────────────
	registerNotebookTools(pi, state);
	registerNotebookTopicTool(pi, state);
	registerHandoffTool(pi, state);
	registerSpawnTool(pi, state);

	// ── Register event handlers ─────────────────────────────────────
	registerWatchdog(pi, state);
	registerNotebookRehydration(pi, state);
	registerHandoffCompaction(pi, state);

	// ── Register commands ───────────────────────────────────────────
	registerHandoffCommand(pi, state);

	// ── Readonly mode ───────────────────────────────────────────────

	pi.registerFlag("readonly", {
		description: "Start in readonly mode",
		type: "boolean",
		default: false,
	});

	function toggleReadonly(ctx: ExtensionContext): void {
		state.readonlyEnabled = !state.readonlyEnabled;
		state.readonlyNudgePending = true;
		pi.appendEntry("agenticoding-readonly", { enabled: state.readonlyEnabled });
		updateIndicators(ctx, state);
		ctx.ui.notify(
			state.readonlyEnabled
				? "Readonly mode enabled \u2014 write/edit/handoff/destructive-bash blocked"
				: "Readonly mode disabled \u2014 write/edit/handoff/bash unblocked",
			"info",
		);
	}

	pi.registerCommand("readonly", {
		description: "Toggle readonly mode (blocks write/edit/handoff/destructive-bash)",
		handler: async (_args, ctx) => toggleReadonly(ctx),
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Toggle readonly mode",
		handler: async (ctx) => {
			if (ctx.isIdle()) toggleReadonly(ctx);
		},
	});

	function rehydrateReadonlyState(ctx: ExtensionContext): void {
		const wasEnabled = state.readonlyEnabled;
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		state.readonlyEnabled = false;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as Record<string, unknown>;
			if (
				entry.type === "custom" &&
				entry.customType === "agenticoding-readonly"
			) {
				state.readonlyEnabled = (entry.data as Record<string, unknown>)?.enabled === true;
				break;
			}
		}
		// CLI flag sets initial default, but branch state takes precedence after any toggle.
		if (pi.getFlag("readonly") === true) {
			const hasBranchEntry = branch.some(
				(e) => (e as Record<string, unknown>).customType === "agenticoding-readonly"
			);
			if (!hasBranchEntry) {
				state.readonlyEnabled = true;
			}
		}
		// Nudge if readonly was activated by rehydration (CLI flag, branch restore, or undo)
		if (state.readonlyEnabled && !wasEnabled) {
			state.readonlyNudgePending = true;
		}
	}

	// ── Readonly: tool_call blocking ────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (!state.readonlyEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "handoff") {
			return {
				block: true as const,
				reason:
					"Readonly mode: write/edit/handoff disabled. " +
					"Use spawn for same-topic delegation, or disable readonly with /readonly before handoff.",
			};
		}

		if (event.toolName === "bash") {
			const cmd = (event.input as Record<string, unknown>).command as string;
			if (!isSafeReadonlyCommand(cmd)) {
				return {
					block: true as const,
					reason:
						"Readonly mode: dangerous command blocked.\n" +
						`Command: ${cmd}`,
				};
			}
		}
	});

	// ── /notebook command — interactive page selector ────────────────
	pi.registerCommand("notebook", {
		description: "Select a notebook page to preview, or set the active notebook topic with /notebook <topic>",
		handler: async (args, ctx) => {
			const topicArg = args.trim();
			if (topicArg) {
				const result = setActiveNotebookTopic(state, topicArg, "human");
				if (ctx.hasUI) {
					const message = result.boundaryHint
						? `Active notebook topic changed: ${result.boundaryHint.from} → ${result.boundaryHint.to}. This is a likely task boundary; handoff is recommended before continuing.`
						: `Active notebook topic: ${result.current}`;
					ctx.ui.notify(message, result.boundaryHint ? "warning" : "info");
				}
				updateIndicators(ctx, state);
				return;
			}
			if (!ctx.hasUI) {
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);
				container.addChild(
					new Text(theme.fg("accent", theme.bold(` Notebook (${state.notebookPages.size} pages) `)), 1, 0),
				);

				const entries = Array.from(state.notebookPages.entries()).sort(([a], [b]) => a.localeCompare(b));
				let selectList: SelectList | undefined;
				let finished = false;

				if (entries.length === 0) {
					container.addChild(
						new Text(theme.fg("dim", " (empty) — use notebook_write to create pages"), 1, 0),
					);
				} else {
					const items: SelectItem[] = entries.map(([name, content]) => ({
						value: name,
						label: name,
						description: formatPagePreview(content),
					}));

					selectList = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});
					selectList.onSelect = ({ value }) => {
						// Guard: selectList is set to undefined below, so this handler
						// cannot fire twice — no re-entrancy guard needed here.
						const body = state.notebookPages.get(value);
						if (!body) { done(); return; }
						// Switch to body view: show the selected entry body inline
						container.clear();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold(` ${value} `)), 1, 0));
						const truncated = body.length > 500 ? body.slice(0, 500) + "\n..." : body;
						container.addChild(new Text(theme.fg("toolOutput", truncated), 1, 0));
						container.addChild(new Text(theme.fg("dim", " press any key to close "), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						selectList = undefined;
						tui.requestRender();
					};
					selectList.onCancel = () => {
						if (finished) return;
						finished = true;
						done();
					};
					container.addChild(selectList);
				}

				container.addChild(
					new Text(theme.fg("dim", entries.length === 0
						? " esc close "
						: " \u2191\u2195 navigate \u2022 enter select \u2022 esc close "), 1, 0),
				);
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						if (finished) return;
						if (!selectList) { finished = true; done(); return; }
						selectList.handleInput?.(data);
						// Conservative: always repaint after key input.
						// SelectList.handleInput returns void in the current API,
						// so we can't conditionally skip — the cost is negligible.
						tui.requestRender();
					},
				};
			});
		},
	});

	// ── before_agent_start: inject context primer + notebook ───────
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		// Update TUI indicators before each user-prompt agent run
		updateIndicators(ctx, state);

		const parts: string[] = [event.systemPrompt];

		// Inject context management primer at the end of the system prompt
		parts.push("\n" + CONTEXT_PRIMER);

		if (state.activeNotebookTopic) {
			parts.push(
				`\n## Active Notebook Topic\n` +
				`Current topic: \`${state.activeNotebookTopic}\` (${state.activeNotebookTopicSource ?? "unknown"}-set).\n` +
				`Treat this as the current semantic frame. If new work fits it, prefer spawn for isolated noisy subtasks. If it does not fit it, prefer handoff over dragging stale context forward.`,
			);
		} else {
			parts.push(
				`\n## Active Notebook Topic\n` +
				`No active notebook topic is set. Early in the next substantive task, assign a short stable topic with \`notebook_topic_set\`. Human-set topics are authoritative.`,
			);
		}

		// Inject notebook listing so the LLM always knows what's available
		const entryNames = Array.from(state.notebookPages.keys()).sort();
		if (entryNames.length > 0) {
			const listing = entryNames
				.map((name) => {
					const content = state.notebookPages.get(name)!;
					const firstLine = (content.split("\n")[0] ?? "").slice(0, 80);
					return `  ${name}: ${firstLine}`;
				})
				.join("\n");
			parts.push(
				`\n## Active Notebook Pages\n` +
					`The following pages are available via notebook_read by name:\n${listing}\n` +
					`Reference pages by name — never paste bodies into prompts.`,
			);
		}

		return { systemPrompt: parts.join("\n\n") };
	});

	// ── context: inject primacy-zone nudge + readonly ON/OFF nudges ──────
	// ON: nudge once on toggle. OFF: checks --readonly CLI flag and prior
	// branch entries to detect session-level un-toggle before nudging.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const percent = usage?.percent ?? null;
		if (usage && usage.percent !== null) {
			state.lastContextPercent = usage.percent;
		}

		// Readonly ON/OFF nudge (one-shot, merged into the same context hook)
		if (state.readonlyNudgePending) {
			state.readonlyNudgePending = false;

			if (state.readonlyEnabled) {
				// ON nudge
				return {
					messages: [
						...event.messages,
						{
							role: "custom" as const,
							customType: "agenticoding-readonly-nudge",
							content:
								"Readonly mode is active. Do not call write or edit. " +
								"Destructive bash operations will be blocked.",
							display: false,
							timestamp: Date.now(),
						},
					],
				};
			} else {
				// OFF nudge — only if there was a prior ON entry on this branch
				const branch = ctx.sessionManager?.getBranch?.() ?? [];
				const hasPriorOn = branch.some(
					(e) =>
						(e as Record<string, unknown>).customType === "agenticoding-readonly" &&
						((e as Record<string, unknown>).data as Record<string, unknown>)?.enabled === true,
				);
				if (hasPriorOn) {
					return {
						messages: [
							...event.messages,
							{
								role: "custom" as const,
								customType: "agenticoding-readonly-nudge",
								content: "Readonly mode has been turned off. You may now use write, edit, and bash freely.",
								display: false,
								timestamp: Date.now(),
							},
						],
					};
				}
			}
		}

		if (!state.pendingTopicBoundaryHint && (percent === null || percent < 30)) {
			return;
		}

		const nudge = buildNudge(state, percent);
		state.pendingTopicBoundaryHint = null;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "agenticoding-watchdog",
					content: nudge,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	// ── session_start: reset state + readonly rehydration + indicators ──
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		if (event.reason === "new") {
			resetState(state);
			// Clear any stale TUI indicators from the previous session
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
				ctx.ui.setStatus(STATUS_KEY_TOPIC, undefined);
				ctx.ui.setStatus(STATUS_KEY_READONLY, undefined);
				ctx.ui.setWidget(WIDGET_KEY_WARNING, undefined);
			}
		}
		rehydrateReadonlyState(ctx);
		updateIndicators(ctx, state);
	});

	// ── session_tree: rehydrate readonly state on tree changes ─────
	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		rehydrateReadonlyState(ctx);
		updateIndicators(ctx, state);
	});

	// ── update TUI indicators after each turn ───────────────────────
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		// Fallback: clear handoff indicator if the LLM completed a turn
		// without calling the handoff tool (ignored the direction)
		if (state.pendingRequestedHandoff && !state.pendingRequestedHandoff.toolCalled) {
			state.pendingRequestedHandoff = null;
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
			}
		}
		updateIndicators(ctx, state);
	});
}
