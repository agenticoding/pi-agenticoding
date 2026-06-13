/**
 * test-host.ts — Minimal pi host for process-isolated E2E tests.
 *
 * Spawned as a child process. Loads the extension, then runs a
 * line-oriented REPL on stdin/stdout.
 *
 * Protocol:
 *   → cmd <name> [arg]      — call a registered command
 *   → tool <name> <json>    — call a registered tool with JSON params
 *   → tools                 — list registered tool names
 *   → cmds                  — list registered command names
 *   → exit                  — graceful shutdown
 *
 *   ← READY\n               — sent after extension registration
 *   ← OK[:payload]\n        — success
 *   ← ERR:message\n         — failure
 *
 * No TUI. All UI-dependent paths are skipped (hasUI=false).
 */

import { createInterface } from "node:readline";
import registerAgenticoding from "../../index.js";
import { createTestPI } from "../unit/helpers.js";

// ── Mock ExtensionAPI ─────────────────────────────────────────────
// Uses createTestPI() from the shared test utilities — a minimal object
// that satisfies what index.ts needs at registration time.
// No TUI dependencies — tools and commands access the state through
// the pi object directly.

const pi = createTestPI();
const commands = pi.commands;
const tools = pi.tools;

// Register the extension — this populates pi.commands and pi.tools
registerAgenticoding(pi);

// ── Mock ExtensionContext for tool/command execution ──────────────

const mockCtx = {
	hasUI: false,
	mode: "non-interactive",
	cwd: process.cwd(),
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		theme: { fg: () => "" },
		select: () => Promise.resolve(undefined),
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(""),
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.resolve(undefined),
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: () => Promise.resolve(""),
		addAutocompleteProvider: () => {},
		themes: [],
		getTheme: () => undefined,
		setTheme: () => ({ ok: true }),
	},
	getContextUsage: () => null,
	sessionManager: null,
	modelRegistry: null,
	// Required by spawn tool which checks ctx.model existence before using it
	model: undefined,
	isIdle: () => true,
	signal: new AbortController().signal,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => process.exit(0),
	compact: () => {},
	getSystemPrompt: () => "",
} as any; // Type assertion needed: mock intentionally omits some interface fields

// ── REPL loop ────────────────────────────────────────────────────

process.stdout.write("READY\n");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;

	if (trimmed === "exit") {
		process.exit(0);
	} else if (trimmed === "tools") {
		const names = Array.from(tools.keys()).sort().join(",");
		process.stdout.write("OK:" + names + "\n");
	} else if (trimmed === "cmds") {
		const names = Array.from(commands.keys()).sort().join(",");
		process.stdout.write("OK:" + names + "\n");
	} else if (trimmed.startsWith("tool ")) {
		const rest = trimmed.slice(5).trim();
		const spaceIdx = rest.indexOf(" ");
		if (spaceIdx === -1) {
			process.stdout.write("ERR:usage tool <name> <json-args>\n");
			continue;
		}
		const toolName = rest.slice(0, spaceIdx);
		const jsonArgs = rest.slice(spaceIdx + 1);
		const toolDef = tools.get(toolName);
		if (!toolDef) {
			process.stdout.write("ERR:unknown tool " + toolName + "\n");
			continue;
		}
		let params;
		try { params = JSON.parse(jsonArgs); }
		catch (e: unknown) {
			process.stdout.write("ERR:invalid json: " + (e instanceof Error ? e.message : String(e)) + "\n");
			continue;
		}
		try {
			const result = await toolDef.execute("e2e-" + toolName, params, undefined, undefined, mockCtx);
			const text = result.content?.map((c: any) => c.text).filter(Boolean).join("\n") || "";
			process.stdout.write("OK:" + text + "\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else if (trimmed.startsWith("cmd ")) {
		const rest = trimmed.slice(4).trim();
		const spaceIdx = rest.indexOf(" ");
		const cmdName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const cmdArg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
		const cmdDef = commands.get(cmdName);
		if (!cmdDef) {
			process.stdout.write("ERR:unknown command " + cmdName + "\n");
			continue;
		}
		try {
			await cmdDef.handler(cmdArg, mockCtx);
			process.stdout.write("OK\n");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			process.stdout.write("ERR:" + msg + "\n");
		}
	} else {
		process.stdout.write("ERR:unknown input\n");
	}
}
