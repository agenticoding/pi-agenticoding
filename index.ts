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

import type { ExtensionAPI, ExtensionContext, Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { createState, invalidateHandoffState, resetState, type AgenticodingState } from "./state.js";
import { CONTEXT_PRIMER } from "./system-prompt.js";
import { buildNudge, registerWatchdog } from "./watchdog.js";
import { registerNotebookTools } from "./notebook/tools.js";
import { registerNotebookRehydration } from "./notebook/rehydration.js";
import { registerNotebookTopicTool } from "./notebook/topic-tool.js";
import { setActiveNotebookTopic } from "./notebook/topic.js";
import { formatPagePreview } from "./notebook/store.js";
import { registerHandoffTool } from "./handoff/tool.js";
import {
	canPromoteBoundary,
	discardNonHumanBoundary,
	markBoundaryAdvisory,
	promoteBoundary,
} from "./readonly-boundary.js";
import { isHandoffEligible, normalizeContextPercent } from "./handoff/eligibility.js";
import { getReadonlyFromBranch } from "./readonly-rehydration.js";
import { HANDOFF_REQUIRED_STATUS } from "./handoff/copy.js";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffCompaction } from "./handoff/compact.js";
import {
	READONLY_ACTIVE_SUMMARY,
	READONLY_COMMAND_DESCRIPTION,
	READONLY_DISABLED_NOTIFICATION,
	READONLY_DISABLED_SUMMARY,
	READONLY_ENABLED_STATUS,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION,
	READONLY_WRITE_EDIT_BLOCK_REASON,
	buildReadonlyDisabledContextSuffix,
	buildReadonlyFrontmatterNotification,
	buildReadonlyTopicBoundaryNotification,
} from "./readonly-copy.js";
import { registerSpawnTool } from "./spawn/index.js";
import {
	cacheLookupCommand,
	cacheLookupCommandIssue,
	cacheLookupSkill,
	cacheLookupSkillIssue,
	formatReadonlyFrontmatterIssue,
	populateFromSkills,
	populatePromptCacheFromResolvedCommandsAndDirs,
	type ReadonlyCacheIssue,
} from "./readonly-cache.js";
import {
	STATUS_KEY_HANDOFF,
	STATUS_KEY_READONLY,
	STATUS_KEY_TOPIC,
	WIDGET_KEY_WARNING,
	updateIndicators,
} from "./tui.js";
import { applyReadonlyBashGuard } from "./readonly-bash.js";
// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Populate the readonly frontmatter cache from loaded skills and prompt
 * commands/directories. Always called before toggle resolution so the cache
 * is fresh for the current input.
 */
function populateReadonlyCache(
	state: AgenticodingState,
	event: { systemPromptOptions?: { skills?: Skill[] } },
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	populateFromSkills(state, event.systemPromptOptions?.skills ?? []);
	populatePromptCacheFromResolvedCommandsAndDirs(state, pi.getCommands(), ctx.cwd, ctx.isProjectTrusted());
}

function isPromptCommand(commands: SlashCommandInfo[], name: string): boolean {
	return commands.some((command) => command.name === name && command.source === "prompt");
}

const READONLY_BYPASS_COMMANDS = new Set(["readonly", "notebook", "handoff"]);

function isBuiltinReadonlyBypassCommand(name: string): boolean {
	return READONLY_BYPASS_COMMANDS.has(name);
}

function alignPendingReadonlyHandoff(state: AgenticodingState, readonly: boolean): void {
	if (!state.pendingRequestedHandoff) return;
	// pendingRequestedHandoff represents a required future handoff, not just a
	// momentary bypass. Keep both fields aligned with the latest readonly intent:
	// readonly ON => allow exactly one handoff path now and resume readonly after it;
	// readonly OFF => remove the bypass flag because handoff is no longer blocked.
	state.pendingRequestedHandoff.resumeReadonlyAfterHandoff = readonly;
}

function formatReadonlyCommandRef(command: { type: "skill" | "command"; name: string }): string {
	return command.type === "skill" ? `/skill:${command.name}` : `/${command.name}`;
}

function recordReadonlyFrontmatterIssue(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	command: { type: "skill" | "command"; name: string },
	issue: ReadonlyCacheIssue,
): void {
	pi.appendEntry("agenticoding-readonly-frontmatter-issue", { name: command.name, type: command.type, issue });
	if (ctx.hasUI) {
		ctx.ui.notify(formatReadonlyFrontmatterIssue(formatReadonlyCommandRef(command), issue), "warning");
	}
}

/**
 * Consume any deferred readonly toggle recorded by the `input` handler.
 * Must be called after `populateReadonlyCache` so the cache is populated.
 */
function consumePendingReadonlyToggle(
	state: AgenticodingState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	const commands = pi.getCommands();
	// Readonly is a TUI-only feature. Headless/RPC sessions must not inherit a
	// queued slash-command toggle from some earlier interactive input source, so
	// drop any deferred intents here instead of letting them mutate headless runs.
	if (!ctx.hasUI) {
		state.pendingReadonlyCommands.length = 0;
		return;
	}

	// Consume unknown/malformed queue entries until the first real readonly
	// decision so a stale no-op slash command cannot delay the next valid toggle.
	// Prompt commands may exist only on disk in Pi's standard prompt dirs, so
	// command lookups trust the populated prompt cache instead of re-gating on
	// the live registry here. Known non-prompt commands stay blocked because the
	// cache builder marks their names as shadowed and never loads fallback files.
	while (state.pendingReadonlyCommands.length > 0) {
		const pendingCommand = state.pendingReadonlyCommands.shift();
		if (!pendingCommand) return;

		const readonly = pendingCommand.type === "skill"
			? cacheLookupSkill(state, pendingCommand.name)
			: cacheLookupCommand(state, pendingCommand.name);
		if (readonly === null) {
			const issue = pendingCommand.type === "skill"
				? cacheLookupSkillIssue(state, pendingCommand.name)
				: cacheLookupCommandIssue(state, pendingCommand.name);
			if (issue) recordReadonlyFrontmatterIssue(ctx, pi, pendingCommand, issue);
			continue;
		}

		// Keep a queued required handoff aligned with the latest resolved readonly
		// intent even when the frontmatter decision is a no-op for current mode.
		// Otherwise the eventual handoff brief could resume with stale readonly
		// semantics despite the slash command itself producing no visible toggle.
		alignPendingReadonlyHandoff(state, readonly);
		if (state.readonlyEnabled === readonly) {
			return;
		}

		state.readonlyEnabled = readonly;
		state.readonlyNudgePending = true;
		pi.appendEntry("agenticoding-readonly", { enabled: readonly });

		if (ctx.hasUI) {
			const commandRef = formatReadonlyCommandRef(pendingCommand);
			ctx.ui.notify(buildReadonlyFrontmatterNotification(readonly, commandRef), "info");
		}
		return;
	}
}

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
		if (!ctx.hasUI) return; // Toggle is a UI-only command, no-op in headless.
		state.readonlyEnabled = !state.readonlyEnabled;
		// A pendingRequestedHandoff is a promise to perform a real handoff later.
		// If the user flips readonly before that happens, update the stored
		// post-handoff readonly contract immediately so the eventual compacted task
		// reflects the newest intent instead of the mode at /handoff time.
		if (state.pendingRequestedHandoff) {
			alignPendingReadonlyHandoff(state, state.readonlyEnabled);
			if (state.readonlyEnabled) {
				ctx.ui.notify(READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION, "info");
			} else {
				ctx.ui.notify(READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION, "info");
			}
		}
		state.readonlyNudgePending = true;
		pi.appendEntry("agenticoding-readonly", { enabled: state.readonlyEnabled });
		updateIndicators(ctx, state);
		ctx.ui.notify(
			state.readonlyEnabled
				? READONLY_ENABLED_STATUS
				: READONLY_DISABLED_NOTIFICATION,
			"info",
		);
	}

	pi.registerCommand("readonly", {
		description: READONLY_COMMAND_DESCRIPTION,
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
		state.readonlyEnabled = getReadonlyFromBranch(branch, pi);
		// Nudge on any rehydrated readonly authority change.
		if (state.readonlyEnabled !== wasEnabled) {
			state.readonlyNudgePending = true;
		}
	}

	// ── Readonly: tool_call blocking ────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		// ── Readonly mode ───────────────────────────────────────────
		// Guardrail for a coding agent (not a security boundary):
		// write/edit stay in the tool list but are blocked at call time.
		// handoff is also blocked unless pendingRequestedHandoff has activated a
		// narrow temporary bypass for this session's required pivot. That sticky
		// state is created by explicit /handoff or by an eligible readonly human
		// topic boundary. Keeping tools advertised
		// avoids context-cache invalidation from tools disappearing mid-session.
		// Children use the opposite approach (remove from tool list entirely)
		// because they start with a fresh context — see spawn/index.ts.
		if (!state.readonlyEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true as const,
				reason: READONLY_WRITE_EDIT_BLOCK_REASON,
			};
		}

		if (event.toolName === "handoff" && !state.pendingRequestedHandoff) {
			return {
				block: true as const,
				reason: READONLY_HANDOFF_BLOCK_REASON,
			};
		}

		if (isToolCallEventType("bash", event)) {
			const result = applyReadonlyBashGuard(event.input.command, ctx.cwd);
			if (result.action === "block") {
				return { block: true as const, reason: result.reason };
			}
			if (result.action === "sandbox") {
				// Mutate input.command in-place — SDK has no transform return type.
				// Other tool_call hooks will see the sandbox-wrapped command.
				event.input.command = result.sandboxedCommand;
			}
		}
	});

	// ── Readonly: record slash-command intent for deferred toggle ─
	// Input interception runs earlier than the point where Pi has resolved the
	// authoritative skill/prompt-command metadata for this turn. Record only the
	// slash-command token here, then resolve readonly frontmatter later in
	// before_agent_start once the cache and registry view are current.
	pi.on("input", async (event, ctx) => {
		// Only TUI sessions should enqueue a readonly toggle. Headless/RPC runs
		// preserve the existing contract: readonly is a UI-only feature.
		// Extension-sourced steer/followUp text must not mutate readonly state.
		// Only interactive slash commands have authority to enqueue a toggle.
		if (!ctx.hasUI || event.source === "extension") return { action: "continue" };

		const text = event.text;
		// Capture the full first slash-command token and defer authority to the
		// resolved registry in before_agent_start. This avoids drifting from Pi's
		// naming rules when prompt/skill names include dots or suffixed segments.
		const skillName = text.match(/^\/skill:([^\s/]+)/)?.[1];
		if (skillName) {
			state.pendingReadonlyCommands.push({ type: "skill", name: skillName });
			return { action: "continue" };
		}

		const commandName = text.match(/^\/([^\s/]+)/)?.[1];
		if (!commandName) return { action: "continue" };

		// Prefer the live command registry when it's already available, but don't
		// rely on it as the sole authority at input time: some runtimes surface
		// prompt commands only later in before_agent_start. If the command is
		// unknown here, defer it optimistically unless it's one of the builtin
		// commands that must never create a stale no-op queue entry.
		const commands = pi.getCommands();
		if (isBuiltinReadonlyBypassCommand(commandName)) return { action: "continue" };
		if (isPromptCommand(commands, commandName)) {
			state.pendingReadonlyCommands.push({ type: "command", name: commandName });
			return { action: "continue" };
		}
		if (commands.some((command) => command.name === commandName)) {
			return { action: "continue" };
		}

		state.pendingReadonlyCommands.push({ type: "command", name: commandName });
		return { action: "continue" };
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
						? state.readonlyEnabled
							? buildReadonlyTopicBoundaryNotification(result.boundaryHint.from, result.boundaryHint.to)
							: `Active notebook topic changed: ${result.boundaryHint.from} → ${result.boundaryHint.to}. This is a likely task boundary; handoff is recommended before continuing.`
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

	// ── before_agent_start: populate readonly cache, consume the deferred
	//    queue until the first real readonly decision, then inject context
	//    primer + notebook ─────────────────────────────────────────────
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		if (state.pendingReadonlyCommands.length > 0) {
			populateReadonlyCache(state, event, ctx, pi);
		}
		consumePendingReadonlyToggle(state, ctx, pi);

		// Update TUI indicators before each user-prompt agent run
		updateIndicators(ctx, state);

		const parts: string[] = [event.systemPrompt];

		// Inject context management primer at the end of the system prompt
		parts.push("\n" + CONTEXT_PRIMER);

		if (state.activeNotebookTopic) {
			parts.push(
				`\n## Active Notebook Topic\n` +
				`Current topic: \`${state.activeNotebookTopic}\` (${state.activeNotebookTopicSource ?? "unknown"}-set).\n` +
				`Treat this as the current semantic frame. If new work fits it, prefer spawn for isolated noisy subtasks. If it does not fit it, prefer handoff.`,
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

	// ── context: inject toggle-on/toggle-off readonly state + watchdog nudge ──
	// Readonly visibility comes from two channels:
	//   1. toggle-nudge: injected once on mode change (context hook)
	//   2. tool-call blocking errors (tool_call handler)
	// The watchdog nudge is suppressed while readonly is active unless a
	// handoff is pending. pendingRequestedHandoff is created by explicit
	// /handoff or by an eligible human topic boundary. Ineligible boundaries
	// remain advisory, so the guardrail never mandates an impossible handoff.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const percent = normalizeContextPercent(usage?.percent);
		state.lastContextPercent = percent;

		// Build the readonly toggle-nudge (one-shot on mode change)
		let readonlyNudgeMsg: { role: string; customType: string; content: string; display: boolean; timestamp: number } | null = null;
		if (state.readonlyNudgePending) {
			state.readonlyNudgePending = false;
			readonlyNudgeMsg = {
				role: "custom" as const,
				customType: "agenticoding-readonly-nudge",
				content: state.readonlyEnabled
					? (state.pendingRequestedHandoff ||
						(state.pendingTopicBoundaryHint?.source === "human" && isHandoffEligible(usage)))
						? READONLY_HANDOFF_EXCEPTION_SUMMARY
						: READONLY_ACTIVE_SUMMARY
					: READONLY_DISABLED_SUMMARY +
					  (percent !== null && percent >= 30
						? buildReadonlyDisabledContextSuffix(percent)
						: ""),
				display: false,
				timestamp: Date.now(),
			};
		}
		const appendReadonlyNudge = () => readonlyNudgeMsg
			? { messages: [...event.messages, readonlyNudgeMsg as any] }
			: undefined;

		// In readonly mode, an eligible human topic boundary is equivalent to /handoff:
		// create the same sticky bypass contract only when compaction can proceed.
		// Without an eligible boundary or pending handoff, suppress the watchdog entirely
		// — readonly visibility comes from the toggle-nudge and tool-call blocking
		// errors, not from repeated advisory watchdog text.
		let retainIneligibleHumanBoundary = false;
		if (state.readonlyEnabled && !state.pendingRequestedHandoff) {
			if (discardNonHumanBoundary(state)) {
				state.lastWatchdogBand = null;
				return appendReadonlyNudge();
			}
			if (state.pendingTopicBoundaryHint) {
				if (canPromoteBoundary(state, usage)) {
					promoteBoundary(state, ctx);
				} else if (markBoundaryAdvisory(state)) {
					retainIneligibleHumanBoundary = true;
				} else {
					// Already advised; boundary guidance stays advisory until eligible.
					return appendReadonlyNudge();
				}
			} else {
				// Readonly active, no boundary hint, no pending handoff — suppress watchdog.
				state.lastWatchdogBand = null;
				return appendReadonlyNudge();
			}
		}

		const mustEnforceRequestedHandoff = state.pendingRequestedHandoff !== null;
		if (
			state.pendingRequestedHandoff &&
			!state.pendingRequestedHandoff.toolCalled &&
			isHandoffEligible(usage) &&
			ctx.hasUI &&
			ctx.ui.theme
		) {
			ctx.ui.setStatus(
				STATUS_KEY_HANDOFF,
				ctx.ui.theme.fg("accent", HANDOFF_REQUIRED_STATUS),
			);
		}

		// Below primacy-zone threshold (~30%), skip watchdog unless a boundary
		// hint or a sticky user-requested handoff is pending — context is still
		// fresh enough that ordinary nudges add noise.
		// HACK: `as any` required because readonlyNudgeMsg has customType field not in AgentMessage.
		// Proper fix: augment CustomAgentMessages via module augmentation on @earendil-works/pi-agent-core.
		if (!mustEnforceRequestedHandoff && !state.pendingTopicBoundaryHint && (percent === null || percent < 30)) {
			state.lastWatchdogBand = null;
			return appendReadonlyNudge();
		}

		// Throttle: only nudge when crossing into a higher context-percentage band.
		// Bands: null (<30), 0 (30-49), 1 (50-69), 2 (70+). This prevents nudging
		// every turn once past 30%.
		if (!mustEnforceRequestedHandoff && !state.pendingTopicBoundaryHint) {
			const band = percent! < 50 ? 0 : percent! < 70 ? 1 : 2;
			if (state.lastWatchdogBand !== null && band <= state.lastWatchdogBand) {
				return appendReadonlyNudge();
			}
			state.lastWatchdogBand = band;
		}

		const nudge = buildNudge(state, percent, isHandoffEligible(usage));
		if (!retainIneligibleHumanBoundary) state.pendingTopicBoundaryHint = null;
		return {
			messages: [
				...event.messages,
				...(readonlyNudgeMsg ? [readonlyNudgeMsg as any] : []),
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

	// ── session_tree: invalidate branch-local handoff work, then rehydrate readonly ──
	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		invalidateHandoffState(state);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
		rehydrateReadonlyState(ctx);
		updateIndicators(ctx, state);
	});

	// ── update TUI indicators after each turn ───────────────────────
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		updateIndicators(ctx, state);
	});
}
