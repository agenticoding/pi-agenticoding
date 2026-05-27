/**
 * Bash safety classifier for readonly mode.
 *
 * Pipeline: git strict allowlist → code editor detection (smart parser
 * to avoid false-positives from grep) → destructive-command blacklist.
 *
 * Git uses a strict allowlist — only known-immutable subcommands pass.
 */

// ── Destructive command blacklist ─────────────────────────────────────

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	// File mutation
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/,
	// Privilege / process mutation
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/,
	// Package mutation
	/\b(npm|yarn|pnpm)\s+(install|uninstall|update|ci|link|publish|add|remove)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\b(cargo|gem)\s+(install|uninstall|update|build|publish)\b/i,
	/\b(yum|dnf)\s+(install|remove|update|upgrade|groupinstall)\b/i,
	/\bpacman\s+(-[SRU]|--sync|--remove|--upgrade)\b/i,
	/\bchoco\s+(install|uninstall|update|upgrade)\b/i,
	// Service mutation
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	// Editors (interactive or IDE-launching)
	/\b(vim?|nano|emacs|subl)\b/i,
];

/**
 * Detect VS Code CLI invocation that would hang in headless readonly mode.
 *
 * `code` is handled separately because agents commonly grep for `\bcode\b`
 * as a token (e.g. rg \bcode\b), causing false-positives with a simple
 * word-boundary regex. Parse only unquoted shell separators so
 * "rg \bcode\b file" is safe while "code .", "echo hi | code .",
 * and newline-separated editor launches are blocked.
 *
 * Also catches code-insiders (VS Code Insiders variant). The optional
 * leading env-var prefix handles cases like FOO=bar code .
 */
function splitUnquotedShellSegments(cmd: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		const next = cmd[i + 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		const prev = current[current.length - 1];
		if (ch === "|" && prev === ">") {
			current += ch;
			continue;
		}
		if (ch === "&" && (prev === ">" || prev === "<" || next === ">")) {
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments;
}

function stripMatchingQuotes(token: string): string {
	if (
		(token.startsWith('"') && token.endsWith('"')) ||
		(token.startsWith("'") && token.endsWith("'"))
	) {
		return token.slice(1, -1);
	}
	return token;
}

function readRedirectTarget(cmd: string, start: number): { target: string; end: number } {
	let i = start;
	while (i < cmd.length && /\s/.test(cmd[i])) i++;
	if (i >= cmd.length) return { target: "", end: i };

	const first = cmd[i];
	if (first === '"' || first === "'") {
		const quote = first;
		let target = quote;
		i++;
		while (i < cmd.length) {
			const ch = cmd[i];
			target += ch;
			if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
				i++;
				target += cmd[i];
				continue;
			}
			if (ch === quote) {
				i++;
				break;
			}
			i++;
		}
		return { target, end: i };
	}

	let target = "";
	while (i < cmd.length) {
		const ch = cmd[i];
		if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "\n") break;
		if (ch === "&" && target !== "") break;
		target += ch;
		i++;
	}
	return { target, end: i };
}

function isSafeRedirectTarget(target: string): boolean {
	const normalized = stripMatchingQuotes(target);
	return normalized === "/dev/null" || /^&\d+$/.test(normalized);
}

function hasUnsafeWriteRedirect(cmd: string): boolean {
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;

		const next = cmd[i + 1];
		const opLen = next === ">" || next === "|" ? 2 : 1;
		const { target, end } = readRedirectTarget(cmd, i + opLen);
		if (!isSafeRedirectTarget(target)) return true;
		i = Math.max(i, end - 1);
	}

	return false;
}

function isCodeEditorInvocation(cmd: string): boolean {
	// Caller already split on shell operators.
	return /^(?:env\s+)?(?:\w+=(?:"[^"]*"|\u0027[^\u0027]*\u0027|\S+)\s+)*(?:command\s+)?(?:\S*\/)?code(?:-insiders)?(?:\s|$)/i.test(cmd.trim());
}
/**
 * Git subcommand policy — three-tier classification.
 *
 * GIT_IMMUTABLE: Always pass. Commands that never modify repo state.
 *   diff, log, show, status, blame, grep, ls-files, ls-tree, merge-tree,
 *   format-patch, rev-parse, rev-list, cat-file, for-each-ref, merge-base,
 *   fsck, range-diff, shortlog, name-rev, describe, var, version
 *
 * GIT_MUTABLE: Always block. Commands that modify repo state.
 *   add, commit, push, pull, merge, rebase, reset, revert, cherry-pick,
 *   clean, rm, mv, restore, switch, checkout, fetch, init, clone
 *
 * GIT_MIXED: Allow only read-oriented flags/subcommands. Each entry has a
 *   predicate function. Strategy: ALLOWLIST — only known-safe subcommands pass,
 *   everything else blocks (conservative).
 *   reflog:     bare or show...
 *   branch:     --list, -l, bare, or any non-flag arg (e.g. a branch name)
 *   tag:        --list, -l, bare, or any non-flag arg
 *   stash:      list, show
 *   remote:     -v, show, get-url, bare
 *   config:     --get, --list, -l, bare
 *   notes:      list, show, bare
 *   worktree:   list, bare
 *   submodule:  status, bare
 *   apply:      always blocked (mutable by default)
 *   bisect:     log, view, bare
 */
// ── Git command policy ────────────────────────────────────────────────

/** Always-immutable git subcommands — always pass. */
const GIT_IMMUTABLE = new Set([
	"diff", "log", "show", "status", "blame", "grep",
	"ls-files", "ls-tree", "merge-tree", "format-patch",
	"rev-parse", "rev-list", "cat-file", "for-each-ref",
	"merge-base", "fsck", "range-diff", "shortlog", "name-rev",
	"describe", "var", "version",
]);

/** Always-mutable git subcommands — always block. */
const GIT_MUTABLE = new Set([
	"add", "commit", "push", "pull", "merge", "rebase", "reset",
	"revert", "cherry-pick", "clean", "rm", "mv", "restore",
	"switch", "checkout", "fetch", "init", "clone",
]);

/** Mixed subcommands: allow only read-oriented flags/subcommands. */
const GIT_MIXED: Record<string, (sub: string) => boolean> = {
	reflog: (sub) => sub === "" || sub === "show" || sub.startsWith("show "),
	branch: (sub) => /^--?[a-zA-Z]*list/.test(sub) || sub === "-l" || sub === "" || !sub.startsWith("-"),
	tag: (sub) => /^--?[a-zA-Z]*list/.test(sub) || sub === "-l" || sub === "" || !sub.startsWith("-"),
	stash: (sub) => sub === "list" || sub === "show",
	remote: (sub) => sub === "-v" || sub === "show" || sub === "get-url" || sub === "",
	config: (sub) => sub === "--get" || sub.startsWith("--get=") || sub === "--list" || sub === "-l" || sub === "",
	notes: (sub) => sub === "list" || sub === "show" || sub === "",
	worktree: (sub) => sub === "list" || sub === "",
	submodule: (sub) => sub === "status" || sub === "",
	apply: () => false,
	bisect: (sub) => sub === "log" || sub === "view" || sub === "",
};

/**
 * Classify a git command as safe or unsafe for readonly mode.
 * Extracts the first subcommand and delegates to the policy tables.
 */
function isSafeGitCommand(cmd: string): boolean {
	// Extract everything after "git"
	const rest = cmd.replace(/^\s*git\s+/, "").trim();
	if (!rest) return false; // bare "git" — probably fine but conservative

	// Handle flags before subcommand: git --no-pager diff, git -C /path status
	// -C <path> and -c <name=value> consume the next token as their value.
	const tokens = rest.split(/\s+/);
	const FLAGS_WITH_VALUE = new Set(["-C", "-c"]);
	let subcommand = "";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (FLAGS_WITH_VALUE.has(token)) {
			i++; // skip the value argument
			continue;
		}
		if (token.startsWith("-")) continue; // skip flags without values
		subcommand = token;
		break;
	}

	if (!subcommand) return false;

	if (GIT_IMMUTABLE.has(subcommand)) return true;
	if (GIT_MUTABLE.has(subcommand)) return false;

	const mixedPolicy = GIT_MIXED[subcommand];
	if (mixedPolicy) {
		// Collect the part after the subcommand (lowercase, trimmed)
		const afterSub = rest.slice(rest.indexOf(subcommand) + subcommand.length).trim();
		return mixedPolicy(afterSub);
	}

	// Unknown git subcommand — conservative: block
	return false;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns true if the bash command is safe to execute in readonly mode.
 *
 * Policy: blacklist destructive commands, allow everything else.
 * Git is the exception — strict allowlist.
 *
 * Internally splits the command into shell-operator-separated segments
 * (handling `&&`, `||`, `;`, `|`, `&`, `\n`) and tests each segment
 * independently. A single unsafe segment blocks the entire command.
 */
export function isSafeReadonlyCommand(cmd: string): boolean {
	for (const segment of splitUnquotedShellSegments(cmd)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;

		if (/^\s*git\b/i.test(trimmed) && !isSafeGitCommand(trimmed)) return false;
		if (isCodeEditorInvocation(trimmed)) return false;
		if (hasUnsafeWriteRedirect(trimmed)) return false;

		// Blacklist: if any destructive pattern matches, block
		for (const pattern of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(trimmed)) return false;
		}
	}

	return true;
}
