/**
 * OS-level sandboxing for readonly-mode bash commands.
 *
 * Wraps bash commands to run inside an OS sandbox that denies filesystem
 * writes outside the OS temp dir. Uses platform-native sandbox mechanisms:
 *   macOS  → sandbox-exec with Seatbelt profile
 *   Linux  → bubblewrap (bwrap) if available
 *   Windows → not supported (returns command unchanged, classifyBashCommand applies)
 *
 * This replaces the best-effort command-pattern matching in classifyBashCommand
 * with actual kernel-enforced file-write blocking.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
	READONLY_SANDBOX_BLOCK_NOTICE,
	buildReadonlySandboxPathError,
} from "./readonly-copy.js";
import { TEMP_DIR } from "./temp-dir.js";
import { resolveRealPath } from "./resolve-path.js";

// ── Temp dir canonicalization ────────────────────────────────────

let _canonicalTempDir: string | undefined;

/** Get the canonical (symlink-resolved) temp dir path. */
function getCanonicalTempDir(): string {
	if (_canonicalTempDir === undefined) {
		_canonicalTempDir = resolveRealPath(TEMP_DIR);
	}
	return _canonicalTempDir;
}

// ── Platform detection ───────────────────────────────────────────

/**
 * Check whether we can use OS-level sandboxing on the current platform.
 * Returns true when sandbox-exec is available (macOS) or bwrap is installed (Linux).
 */
export function canUseOsSandbox(): boolean {
	const platform = process.platform;
	if (platform === "darwin") {
		return _hasSandboxExec();
	}
	if (platform === "linux") {
		return _hasBwrap();
	}

	return false;
}

let _bwrapResult: boolean | undefined;
let _sandboxExecResult: boolean | undefined;

function hasCommand(command: string): boolean {
	try {
		execSync(`command -v ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function _hasBwrap(): boolean {
	if (_bwrapResult === undefined) {
		if (hasCommand("bwrap")) {
			// Quick functional test: can bwrap actually create a namespace?
			try {
				execSync("bwrap --ro-bind / / true 2>/dev/null", { stdio: "ignore", timeout: 2000 });
				_bwrapResult = true;
			} catch (e) {
				_bwrapResult = false;
			}
		} else {
			_bwrapResult = false;
		}
	}
	return _bwrapResult;
}

function _hasSandboxExec(): boolean {
	if (_sandboxExecResult === undefined) {
		if (hasCommand("sandbox-exec")) {
			// Quick functional test: can sandbox-exec actually enforce a profile?
			try {
				execSync("echo true | sandbox-exec -p '(version 1)(allow default)' /bin/bash 2>/dev/null",
					{ stdio: "ignore", timeout: 2000 });
				_sandboxExecResult = true;
			} catch (e) {
				_sandboxExecResult = false;
			}
		} else {
			_sandboxExecResult = false;
		}
	}
	return _sandboxExecResult;
}

// ── macOS: sandbox-exec ──────────────────────────────────────────

/**
 * Build a Seatbelt sandbox profile string for readonly mode.
 *
 * Pattern: allow everything by default, but deny all file writes except
 * to the canonical temp dir and /dev/null.
 *
 * Using (allow default) + write denies (permissive pattern) because
 * (deny default) + explicit read allows is fragile — system library
 * reads, dyld, and process execution are complex to enumerate and
 * vary across macOS versions. The permissive pattern keeps standard
 * tooling (node, npm, git, python, etc.) working while correctly
 * blocking all file writes outside the temp dir.
 */
export function buildMacProfile(tempDir: string): string {
	const canon = resolveRealPath(tempDir);
	const original = path.resolve(os.tmpdir()); // may have symlinks (e.g., /var -> /private/var)

	// Collect unique paths — both canonical and unresolved (symlink) forms.
	// Seatbelt subpath does NOT resolve symlinks, so we must include both.
	// Also include /tmp and /private/tmp because bash (on macOS) creates
	// heredoc temp files in /tmp regardless of $TMPDIR.
	const writePaths = new Set<string>();
	writePaths.add(canon);
	if (original !== canon) writePaths.add(original);
	writePaths.add("/private/tmp");
	writePaths.add("/tmp");

	// Two distinct injection risks in the profile string:
	//  - Single quotes (') break out of the outer shell wrapper: sandbox-exec -p '${profile}'
	//  - Double quotes (") break Seatbelt (subpath "...") literal syntax
	for (const p of writePaths) {
		if (p.includes("'") || p.includes('"')) {
			throw new Error(buildReadonlySandboxPathError(p));
		}
	}

	const parts = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		'(allow file-write* (literal "/dev/null"))',
	];
	for (const p of writePaths) {
		parts.push(`(allow file-write* (subpath "${p}"))`);
	}
	return parts.join("");
}

/**
 * Generate a unique heredoc delimiter for wrapping commands.
 * Using a random suffix avoids accidental collision with command content.
 */
function generateDelimiter(): string {
	const suffix = crypto.randomBytes(4).toString("hex");
	return `PI_SANDBOX_INNER_${suffix}`;
}

/**
 * Wrap a bash command with sandbox-exec on macOS.
 *
 * Uses a heredoc to pipe the original command verbatim (with all newlines
 * and special characters preserved) to an inner bash running under
 * sandbox-exec:
 *
 *   sandbox-exec -p '<profile>' /bin/bash << 'DELIM'
 *   <original-command>
 *   DELIM
 *
 * The outer bash tool calls spawn(shell, ['-c', modifiedCommand]), so:
 *   /bin/bash -c "sandbox-exec -p '...' /bin/bash << 'DELIM'\n<cmd>\nDELIM"
 *
 * The heredoc preserves all original characters (multiline, quotes, pipes,
 * redirects) so the inner bash receives the exact original command.
 * All descendants inherit the sandbox restrictions.
 */
export function wrapWithSandboxExec(command: string): string {
	const profile = buildMacProfile(getCanonicalTempDir());
	const delim = generateDelimiter();
	return `sandbox-exec -p '${profile}' /bin/bash << '${delim}'
output=\$({
:
${command}
} 2>&1)
rc=\$?
if [ \$rc -ne 0 ]; then
  case "\$output" in
    *"Operation not permitted"*|*"Permission denied"*|*"denying file-write"*)
      echo ""
      echo "${READONLY_SANDBOX_BLOCK_NOTICE}"
      echo ""
      ;;
  esac
fi
[ -n "\$output" ] && echo "\$output"
exit \$rc
${delim}`;
}

// ── Linux: bubblewrap ────────────────────────────────────────────

/**
 * Wrap a bash command with bubblewrap on Linux.
 *
 * Uses the same heredoc approach as sandbox-exec for consistent behavior.
 *
 * --ro-bind / /  makes entire root read-only
 * --tmpfs /tmp   then mounts writable tmpfs at /tmp (overrides ro-bind)
 * --bind <tmp> <tmp> binds the real temp dir writable into /tmp
 * --proc /proc, --dev /dev for proper /proc and /dev
 * --unshare-all --share-net for isolation while allowing network
 * --die-with-parent --new-session for clean termination
 */
export function wrapWithBwrap(command: string): string {
	const canon = getCanonicalTempDir();
	const delim = generateDelimiter();
	const flags = [
		"--ro-bind / /",
		"--tmpfs /tmp",
		`--bind "${canon}" "${canon}"`,
		"--proc /proc",
		"--dev /dev",
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
	];
	return `bwrap ${flags.join(" ")} /bin/bash << '${delim}'
output=\$({
:
${command}
} 2>&1)
rc=\$?
if [ \$rc -ne 0 ]; then
  case "\$output" in
    *"Operation not permitted"*|*"Permission denied"*|*"denying file-write"*)
      echo ""
      echo "${READONLY_SANDBOX_BLOCK_NOTICE}"
      echo ""
      ;;
  esac
fi
[ -n "\$output" ] && echo "\$output"
exit \$rc
${delim}`;
}

// ── Unified dispatch ─────────────────────────────────────────────

/**
 * Wrap a bash command string to run inside an OS-level filesystem sandbox.
 *
 * On macOS: wraps with sandbox-exec (native, no deps).
 * On Linux: wraps with bubblewrap if available.
 * On other platforms / when unavailable: returns command unchanged.
 *
 * The returned command must be passed to /bin/bash -c (or equivalent) for
 * execution — the shell tool handles this automatically.
 */
export function wrapCommandWithOsSandbox(command: string): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return wrapWithSandboxExec(command);
	}
	if (platform === "linux" && _hasBwrap()) {
		return wrapWithBwrap(command);
	}
	// No OS sandbox available — command unchanged, classifyBashCommand
	// fallback will handle it at the call site.
	return command;
}
