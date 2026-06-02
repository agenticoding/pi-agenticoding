import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canUseOsSandbox, wrapCommandWithOsSandbox } from "./os-sandbox.js";
import { resolveRealPath } from "./resolve-path.js";

/**
 * Readonly bash guard.
 *
 * Contract: block filesystem writes/deletions outside the OS temp dir.
 * Non-mutating commands, unknown commands, and environment inheritance are
 * allowed. Process-level commands (kill, reboot, shutdown, systemctl, su)
 * are not filesystem mutations and are intentionally allowed.
 *
 * Package-manager mutations (npm install, pip install, etc.) are blocked
 * unconditionally regardless of target path — they write outside any single
 * directory (node_modules, site-packages, etc.) making temp-dir checking
 * meaningless.
 *
 * This is a best-effort command inspection layer, not a security sandbox.
 */

type Verdict =
	| { ok: true }
	| { ok: false; reason: string };

// Resolve TEMP_DIR via realpathSync so symlinked temp dirs match
// the resolved paths produced by isTempPath().
// TEMP_DIR is resolved at module import time; it won't reflect runtime OS
// reconfiguration (e.g., TMPDIR env var changes after process start).
//
// Ownership: readonly-bash owns TEMP_DIR (canonical source). os-sandbox imports
// it here and re-resolves via resolveRealPath for its own canonical temp dir
// cache. Both modules must agree on the same temp dir — do not create a second
// independent temp dir constant.
export const TEMP_DIR = (() => {
	const resolved = path.resolve(os.tmpdir());
	try { return fs.realpathSync(resolved); } catch { return resolved; }
})();

const GIT_IMMUTABLE = new Set([
	"diff", "log", "show", "status", "blame", "grep",
	"ls-files", "ls-tree", "merge-tree", "format-patch",
	"rev-parse", "rev-list", "cat-file", "for-each-ref",
	"merge-base", "fsck", "range-diff", "shortlog", "name-rev",
	"describe", "var", "version",
]);

const GIT_MUTABLE = new Set([
	"add", "am", "apply", "checkout", "cherry-pick", "clean",
	"clone", "commit", "fetch", "init", "merge", "mv", "pull", "push",
	"rebase", "reset", "restore", "revert", "rm", "switch",
]);

const GIT_MIXED: Record<string, (sub: string) => boolean> = {
	reflog: (sub) => sub === "" || sub === "show" || sub.startsWith("show "),
	branch: (sub) =>
		sub === "" || sub === "-l" || sub === "--show-current" ||
		/^--?[a-zA-Z-]*list(?:[=\s]|$)/.test(sub),
	tag: (sub) => sub === "-l" || /^--?[a-zA-Z-]*list(?:[=\s]|$)/.test(sub),
	remote: (sub) => sub === "" || sub === "-v" || sub === "show" || sub === "get-url",
	config: (sub) =>
		sub === "" || sub === "-l" || sub === "--list" ||
		sub === "--get" || sub.startsWith("--get ") || sub.startsWith("--get="),
	notes: (sub) => sub === "list" || sub === "show",
	stash: (sub) => sub === "list" || sub === "show",
	bisect: (sub) => sub === "log" || sub === "view" || sub === "",
	worktree: (sub) => sub === "list",
	submodule: (sub) => sub === "status",
};

// Interpreters whose inline-execution flag is recursively classified.
// node -c = syntax check only (non-executing); node -e executes code.
const INTERPRETER_EXEC_FLAGS: Record<string, string[]> = {
	node: ["-e"],
	bash: ["-c"], sh: ["-c"], zsh: ["-c"], dash: ["-c"], ksh: ["-c"],
	python3: ["-c"], python: ["-c"],
	perl: ["-e"],
	ruby: ["-e"],
};

const INTERPRETERS = new Set(Object.keys(INTERPRETER_EXEC_FLAGS));

// Package managers are blocked unconditionally — they mutate system state
// outside any single directory (npm install writes to node_modules, pip
// installs to site-packages, etc.). Temp-dir path checking is not meaningful.
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "pip", "apt", "apt-get", "brew", "cargo", "gem", "yum", "dnf", "pacman", "choco"]);


/**
 * Classify a bash command string for readonly mode.
 *
 * Splits the command into shell-operator-separated segments (&&, ||, ;, |, &, \n),
 * checks each segment for command substitutions ($(...), backticks), write redirects (>),
 * and filesystem mutations. Blocks if any target path resolves outside the OS temp dir.
 *
 * When OS-level sandboxing (canUseOsSandbox()) is available, this serves as a fallback —
 * the kernel-enforced sandbox enforces the same write-restriction policy.
 *
 * @param cmd - Raw bash command string (may contain multiple segments via &&, ;, |, etc.)
 * @param cwd - Working directory for relative path resolution (defaults to process.cwd())
 * @returns {ok: true} if allowed, or {ok: false, reason} with explanation
 */

export function classifyBashCommand(cmd: string, cwd: string = process.cwd(), depth: number = 0): Verdict {
	if (depth > 10) return { ok: false, reason: "recursion depth exceeded in command classification" };
	for (const rawSegment of splitUnquotedShellSegments(cmd)) {
		const segment = rawSegment.trim();
		if (!segment) continue;

		for (const subcommand of extractCommandSubstitutions(segment)) {
			const nested = classifyBashCommand(subcommand, cwd, depth + 1);
			if (!nested.ok) {
				return { ok: false, reason: `command substitution blocked: ${nested.reason}` };
			}
		}

		const redirectTarget = getUnsafeWriteRedirectTarget(segment, cwd);
		if (redirectTarget) {
			return { ok: false, reason: `write redirect blocked outside temp dir: ${redirectTarget}` };
		}

		const mutationReason = getFilesystemMutationReason(segment, cwd, depth);
		if (mutationReason) return { ok: false, reason: mutationReason };
	}

	return { ok: true };
}

/**
 * Classify a shell segment's filesystem mutation risk.
 *
 * Extracts the command and its targets, then blocks if any target
 * resolves outside the OS temp dir. Handles git, sudo, env, interpreter -c,
 * dd of=, sed -i, find -exec/-delete, perl/ruby -pi, and package managers.
 * Command names are compared case-insensitively (normalized via .toLowerCase()).
 * Unknown commands return null (allowed).
 */
function getFilesystemMutationReason(segment: string, cwd: string, depth: number = 0): string | null {
	const tokens = getCommandTokens(segment);
	const command = tokens[0]?.toLowerCase();
	if (!command) return null;

	// Strip subshell parens: (rm file) → rm file
	if (command.startsWith("(") && segment.endsWith(")")) {
		const inner = segment.slice(1, -1).trim();
		return inner ? getFilesystemMutationReason(inner, cwd, depth) : null;
	}

	// eval/exec: recursively classify the remaining argument string
	if (command === "eval" || command === "exec") {
		const inner = tokens.slice(1).map(stripMatchingQuotes).join(" ");
		const nested = classifyBashCommand(inner, cwd, depth + 1);
		return nested.ok ? null : nested.reason;
	}

	if (command === "sudo") {
		const nested = classifyBashCommand(tokens.slice(findSudoCommandIndex(tokens)).join(" "), cwd, depth + 1);
		return nested.ok ? null : nested.reason;
	}

	if (command === "env") {
		// Handle env prefix: recursively classify the inner command.
		// env -S "command" is common — getCommandTokens strips env flags
		// and assignments, but -S "string" and its value consume all
		// remaining tokens, leaving tokens.length === 1 (just ["env"]).
		// In that case, find the -S value in the raw segment and classify it.
		if (tokens.length > 1) {
			const nested = classifyBashCommand(tokens.slice(1).join(" "), cwd, depth + 1);
			return nested.ok ? null : nested.reason;
		}
		// env with only flags (e.g., env -S "cmd") — extract -S value
		const sMatch = segment.match(/\benv\b.*?-S\s+/);
		if (sMatch) {
			const afterS = segment.slice(sMatch.index! + sMatch[0].length).trim();
			const stripped = stripMatchingQuotes(afterS);
			const nested = classifyBashCommand(stripped, cwd, depth + 1);
			return nested.ok ? null : nested.reason;
		}
		return null;
	}

	if (command === "git") {
		return isSafeGitCommand(tokens.slice(1).join(" "))
			? null
			: "mutable git command blocked outside temp dir";
	}

	// Interpreters with inline-execution flags — check inline code, then fall through
	// so perl/ruby -pi, python3 script.py, etc. still reach getMutationTargets.
	if (INTERPRETERS.has(command)) {
		const args = tokens.slice(1);
		const execFlags = INTERPRETER_EXEC_FLAGS[command];
		for (const flag of execFlags) {
			const idx = args.indexOf(flag);
			if (idx !== -1 && idx + 1 < args.length) {
				const inlineScript = stripMatchingQuotes(args[idx + 1]);
				const nested = classifyBashCommand(inlineScript, cwd, depth + 1);
				if (!nested.ok) {
					return `${command} ${flag} blocked: ${nested.reason}`;
				}
			}
		}
	}

	const ddMatch = segment.match(/\bof=([^\s]+)/);
	if (ddMatch && !isTempPath(ddMatch[1], cwd)) {
		return `dd output blocked outside temp dir: ${stripMatchingQuotes(ddMatch[1])}`;
	}

	const packageManagerReason = getPackageManagerMutationReason(segment);
	if (packageManagerReason) return packageManagerReason;

	// xargs: classify the command xargs would run.
	// xargs feeds stdin as args, so any mutation command is blocked even
	// without explicit targets — the targets come from the pipe.
	if (command === "xargs") {
		const xArgs = tokens.slice(1);
		const XARGS_FLAGS_WITH_VALUE = new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s"]);
		let cmdStart = 0;
		while (cmdStart < xArgs.length) {
			if (XARGS_FLAGS_WITH_VALUE.has(xArgs[cmdStart])) { cmdStart += 2; continue; }
			if (xArgs[cmdStart].startsWith("-")) { cmdStart++; continue; }
			break;
		}
		if (cmdStart < xArgs.length) {
			const xTokens = xArgs.slice(cmdStart);
			const xCmd = xTokens[0]?.toLowerCase();
			if (xCmd && getMutationTargets(xCmd, xTokens) !== null) {
				return `xargs ${xCmd} blocked: mutation command via xargs`;
			}
		}
		return null;
	}

	const paths = getMutationTargets(command, tokens);
	if (!paths) return null;
	for (const target of paths) {
		if (!isTempPath(target, cwd)) {
			return `${command} blocked outside temp dir: ${stripMatchingQuotes(target)}`;
		}
	}
	return null;
}

function getPackageManagerMutationReason(cmd: string): string | null {
	for (const rawSegment of splitUnquotedShellSegments(cmd)) {
		const segment = rawSegment.trim();
		if (!segment) continue;
		const tokens = getCommandTokens(segment);
		const command = tokens[0]?.toLowerCase();
		if (command && PACKAGE_MANAGERS.has(command) && isPackageMutation(tokens.slice(1))) {
			const args = tokens.slice(1).join(" ");
			return `${command} ${args} is blocked in readonly mode`;
		}
	}
	return null;
}

function skipFlagValues(args: string[], flagsWithValues: Set<string>): string[] {
	const result: string[] = [];
	let i = 0;
	while (i < args.length) {
		if (flagsWithValues.has(args[i])) {
			i += 2; // skip flag + value
		} else {
			result.push(args[i]);
			i++;
		}
	}
	return result;
}

function getMutationTargets(command: string, tokens: string[]): string[] | null {
	switch (command) {
		case "rm":
		case "rmdir":
		case "unlink":
		case "mkdir":
		case "truncate":
		case "touch":
			return nonOptionArgs(skipFlagValues(tokens.slice(1), new Set(["-s", "-o", "--io-size", "--no-create", "-t", "-d", "-r"])));
		case "chmod":
		case "chown":
		case "chgrp": {
			const args = nonOptionArgs(tokens.slice(1));
			return args.slice(1);
		}
		case "cp":
		case "mv":
		case "install":
		case "ln": {
			const args = nonOptionArgs(tokens.slice(1));
			return args.length > 0 ? [args[args.length - 1]] : [];
		}
		case "tee":
			return nonOptionArgs(tokens.slice(1));
		case "sed":
			if (tokens.slice(1).some((arg) => arg === "-i" || arg.startsWith("-i"))) {
				const args = nonOptionArgs(tokens.slice(1));
				// -i may have a separate backup extension value (macOS: sed -i '' 's/.../.../' file).
				// When present, it becomes the first non-option arg before the sed expression.
				// Skip the extension (if present) then the expression, returning remaining as targets.
				if (args.length > 0 && (args[0] === "" || /^[a-zA-Z0-9._-]{1,10}$/.test(args[0]))) {
					return args.slice(2);
				}
				return args.slice(1);
			}
			return null;
		case "perl":
		case "ruby":
			if (tokens.slice(1).some((arg) => /^-p?i/.test(arg))) {
				const args = nonOptionArgs(tokens.slice(1));
				return args;
			}
			return null;
		case "find":
			return getFindMutationTargets(tokens.slice(1));
		case "wget": {
			const wArgs = tokens.slice(1);
			for (let i = 0; i < wArgs.length; i++) {
				if (wArgs[i] === "-O" && wArgs[i + 1]) return [wArgs[i + 1]];
				if (wArgs[i].startsWith("-O") && wArgs[i].length > 2) return [wArgs[i].slice(2)];
			}
			return null;
		}
		case "curl": {
			const cArgs = tokens.slice(1);
			for (let i = 0; i < cArgs.length; i++) {
				if ((cArgs[i] === "-o" || cArgs[i] === "--output") && cArgs[i + 1]) return [cArgs[i + 1]];
			}
			return null;
		}
		default:
			return null;
	}
}

function getFindMutationTargets(args: string[]): string[] | null {
	// Skip glob-pattern args (e.g., -name '*.txt') — these cannot be filesystem roots.
	const roots = args.filter((arg) => arg && !arg.startsWith("-") && !/[*?{}()\[\]~]/.test(arg));
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-delete") return roots.length > 0 ? roots : ["."];
		if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) return roots.length > 0 ? roots : ["."];
		if (["-fprintf", "-fprint", "-fprint0", "-fls"].includes(arg)) {
			const output = args[i + 1];
			return output ? [output] : ["."];
		}
	}
	return null;
}

function isPackageMutation(args: string[]): boolean {
	const joined = args.join(" ").toLowerCase();
	return /(install|uninstall|update|upgrade|ci|link|publish|add|remove|reinstall|tap|untap|download|build)/.test(joined);
}

function findSudoCommandIndex(tokens: string[]): number {
	const FLAGS_WITH_VALUE = new Set(["-u", "-g", "-p", "-C", "-T"]);
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "--") return i + 1;
		if (!token.startsWith("-")) return i;
		if (FLAGS_WITH_VALUE.has(token)) i += 2;
		else i += 1;
	}
	return tokens.length;
}

/**
 * Extract the command tokens from a shell segment, stripping env-prefixes,
 * env-var assignments, and the `command` builtin wrapper.
 *
 * The `env` prefix is handled specially: env flags with values (-u, --unset,
 * -S, -g) consume the next token as their value, and env-var assignments
 * (KEY=value) before the real command are stripped.
 */
function getCommandTokens(segment: string): string[] {
	const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	let i = 0;

	if (tokens[i] === "env") {
		i++;
		// env -u VAR and -S "string" take a value — consume as flag-value pairs
		const ENV_FLAGS_WITH_VALUE = new Set(["-u", "--unset", "-S", "--split-string", "-g", "--group"]);
		while (i < tokens.length && tokens[i].startsWith("-")) {
			if (ENV_FLAGS_WITH_VALUE.has(tokens[i])) {
				i += 2; // skip flag + its value
			} else {
				i++; // valueless flag
			}
		}
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
		// Skip -- separator between env assignments and the command
		if (i < tokens.length && tokens[i] === "--") i++;
		if (i >= tokens.length) return ["env"];
	}

	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	if (tokens[i] === "command") i++;
	return tokens.slice(i);
}

function nonOptionArgs(args: string[]): string[] {
	const result: string[] = [];
	let stopOptions = false;
	for (const arg of args) {
		if (!stopOptions && arg === "--") {
			stopOptions = true;
			continue;
		}
		if (!stopOptions && arg.startsWith("-") && arg !== "-") continue;
		result.push(arg);
	}
	return result;
}

function isSafeGitCommand(rest: string): boolean {
	const trimmed = rest.trim();
	if (!trimmed) return false;

	const tokens = trimmed.split(/\s+/);
	const FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
	let subcommand = "";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (FLAGS_WITH_VALUE.has(token)) { i++; continue; }
		if (token.startsWith("-")) continue;
		subcommand = token;
		break;
	}

	if (!subcommand) return false;
	if (GIT_IMMUTABLE.has(subcommand)) return true;
	if (GIT_MUTABLE.has(subcommand)) return false;
	const mixed = GIT_MIXED[subcommand];
	if (!mixed) return false;
	const afterSub = trimmed.slice(trimmed.indexOf(subcommand) + subcommand.length).trim();
	return mixed(afterSub);
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

/**
 * Resolve a path's real location, following symlinks.
 * If the path doesn't exist, walk up to the nearest existing ancestor
 * and resolve that, then append the remaining components.
 * This handles the common case where a new file is created inside a
 * symlinked temp dir (/tmp -> /private/tmp).
 */
function isTempPath(rawPath: string, cwd: string): boolean {
	const normalized = stripMatchingQuotes(rawPath);
	if (!normalized || normalized === "/dev/null" || /^&\d+$/.test(normalized)) return true;
	if (/[*?`{}()\[\]~]/.test(normalized)) return false;
	const absolute = path.resolve(cwd, normalized);
	// Resolve symlinks so /tmp/link -> /etc/passwd is correctly classified as non-temp.
	// Walking up to the nearest existing ancestor handles new files inside symlinked dirs.
	const real = resolveRealPath(absolute);
	const relative = path.relative(TEMP_DIR, real);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read the file redirect target starting at position `start`.
 *
 * Handles quoted targets (single/double quotes) and backslash escapes.
 * Scope: > (write), >> (append), >| (noclobber override). Heredoc redirects
 * (<<EOF) are stdin, not file writes, and are not checked by this function.
 */
function readRedirectTarget(
	cmd: string,
	start: number,
): { target: string; end: number } {
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

/**
 * Detect write redirects (>) to unsafe targets outside the temp dir.
 *
 * Scope: > (write), >> (append), >| (noclobber override), 2> (stderr), &> (combined).
 * Heredoc redirect targets (<<EOF) are stdin, not file writes, and are not checked.
 * This is a best-effort inspection layer, not a security sandbox.
 */
function getUnsafeWriteRedirectTarget(cmd: string, cwd: string): string | null {
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch !== ">") continue;

		const next = cmd[i + 1];
		// >&N = fd redirect (e.g., 2>&1) — not a file write, skip
		if (next === "&" && /^[\d-]$/.test(cmd[i + 2] ?? "")) continue;
		// >& = combined stdout+stderr redirect to a file, treat as 2-char operator
		const opLen = next === ">" || next === "|" || next === "&" ? 2 : 1;
		const { target, end } = readRedirectTarget(cmd, i + opLen);
		if (!isTempPath(target, cwd)) return stripMatchingQuotes(target) || "(unknown target)";
		i = Math.max(i, end - 1);
	}

	return null;
}

/**
 * Split a shell command string into segments separated by shell operators.
 *
 * Handles quoted strings (single/double quotes) and backslash escapes.
 * Shell operator handling:
 *   ;  — sequential (segment boundary)
 *   |  — pipe (segment boundary)
 *   &  — background (segment boundary, but >& and <& are redirects not separators)
 *   && — AND (segment boundary)
 *   || — OR (segment boundary)
 *   \n — newline (segment boundary)
 * The >| and >& operators are consumed as part of the preceding segment.
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

/**
 * Extract command substitution targets ($(...) and backticks) from a shell line.
 *
 * Uses simple depth-tracked matching. This is a best-effort guard — nested
 * nesting, backslash escapes, and quote-aware tracking are intentionally
 * skipped for simplicity since this is not a security boundary.
 */
function extractCommandSubstitutions(line: string): string[] {
	const commands: string[] = [];

	// Backtick substitutions: `` `cmd` ``
	const backtickRe = /`([^`]*)`/g;
	let match: RegExpExecArray | null;
	while ((match = backtickRe.exec(line)) !== null) {
		if (match[1].trim()) commands.push(match[1].trim());
	}

	// $() substitutions: handles arbitrary nesting via depth counter
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "$" || line[i + 1] !== "(") continue;
		let depth = 1;
		let cmd = "";
		let j = i + 2;
		for (; j < line.length && depth > 0; j++) {
			if (line[j] === "(" && line[j - 1] === "$") depth++;
			else if (line[j] === ")") depth--;
			if (depth > 0) cmd += line[j];
		}
		if (cmd.trim()) commands.push(cmd.trim());
		i = j;
	}

	return commands;
}

// ── Shared readonly bash guard (consumed by parent tool_call hook and child spawnHook) ──

export type ReadonlyBashGuardResult =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "sandbox"; sandboxedCommand: string };

/**
 * Apply the readonly bash guard to a command.
 *
 * L1: OS-level sandboxing — wraps command if available (sandbox-exec / bwrap).
 * L2: Command-pattern inspection — blocks if OS sandbox unavailable.
 *
 * @param cmd - Raw bash command string
 * @param cwd - Working directory for path resolution
 * @returns Structured result: allow, block (with reason), or sandbox (with wrapped command)
 */
export function applyReadonlyBashGuard(cmd: string, cwd: string): ReadonlyBashGuardResult {
	// L1: OS sandbox (primary enforcement when available)
	if (canUseOsSandbox()) {
		const verdict = classifyBashCommand(cmd, cwd);
		if (verdict.ok === false) {
			return { action: "block", reason: `Readonly mode: command blocked.\nReason: ${verdict.reason}\nCommand: ${cmd}` };
		}
		return { action: "sandbox", sandboxedCommand: wrapCommandWithOsSandbox(cmd) };
	}

	// L2: Pattern inspection fallback (no sandbox available)
	const verdict = classifyBashCommand(cmd, cwd);
	if (verdict.ok === false) {
		return { action: "block", reason: `Readonly mode: command blocked.\nReason: ${verdict.reason}\nCommand: ${cmd}` };
	}
	return { action: "allow" };
}
