import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
	buildMacProfile,
	canUseOsSandbox,
	quoteShellArgument,
	wrapCommandWithOsSandbox,
	wrapWithBwrap,
} from "../../os-sandbox.js";
import { resolveRealPath } from "../../resolve-path.js";

function hasPosixShell(): boolean {
	if (process.platform === "win32") return false;
	try {
		execFileSync("/bin/sh", ["-c", "true"], { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

test("wrapped command blocks non-temp writes and allows temp writes", () => {
	if (!canUseOsSandbox()) return;

	const outsidePath = path.join(process.cwd(), `.pi-readonly-outside-${Date.now()}`);
	const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-sandbox-"));
	const insidePath = path.join(insideDir, "inside.txt");
	try {
		assert.throws(
			() => execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`echo blocked > "${outsidePath}"`)], { encoding: "utf8", timeout: 5000 }),
			/(Operation not permitted|Permission denied|readonly mode)/,
			"sandbox should block writes outside temp",
		);
		assert.equal(fs.existsSync(outsidePath), false, "outside temp file should not be created");

		execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`echo allowed > "${insidePath}"`)], { encoding: "utf8", timeout: 5000 });
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "allowed", "sandbox should allow temp writes");
	} finally {
		try { fs.rmSync(outsidePath, { force: true }); } catch { /* best-effort cleanup */ }
		try { fs.rmSync(insideDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

// ── buildMacProfile invariants ──────────────────────────────────

test("buildMacProfile rejects paths containing quotes", () => {
	assert.throws(() => buildMacProfile("/tmp/evil'"), /contain.*quote/);
	assert.throws(() => buildMacProfile('/tmp/evil"'), /contain.*quote/);
});

test("quotes dynamic Linux sandbox paths for the outer shell", () => {
	const tempPath = "/tmp/readonly' ; echo injected; #";
	const canonicalPath = resolveRealPath(tempPath);
	const quotedPath = quoteShellArgument(canonicalPath);
	const wrapped = wrapWithBwrap("true", tempPath);

	assert.equal(quoteShellArgument("a'b"), `'a'"'"'b'`);
	assert.ok(wrapped.includes(`--bind ${quotedPath} ${quotedPath}`));
	assert.equal(wrapped.includes(`--bind "${canonicalPath}" "${canonicalPath}"`), false);
});

test("bwrap executes a quoted bind path without shell injection", () => {
	if (process.platform !== "linux" || !canUseOsSandbox()) return;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-quote'-"));
	const target = path.join(dir, "result.txt");
	try {
		execFileSync(
			"/bin/bash",
			["-c", wrapWithBwrap(`printf wrapped > ${quoteShellArgument(target)}`, dir)],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(fs.readFileSync(target, "utf8"), "wrapped");
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

test("quoteShellArgument emits POSIX single-quoted arguments", () => {
	// POSIX shell single-quote invariant: input is wrapped in single quotes.
	// Embedded single quotes close, quote, and reopen the outer argument.
	assert.equal(quoteShellArgument(""), "''");
	assert.equal(quoteShellArgument("normal"), "'normal'");
	assert.equal(quoteShellArgument("'"), `''"'"''`);
});

test("quoteShellArgument round-trips through a POSIX shell", () => {
	if (!hasPosixShell()) return;

	for (const raw of ["normal", "spaces", "dollar$ign", "backtick`", "line1\nline2", "'mixed' quotes", "'"]) {
		const quoted = quoteShellArgument(raw);
		const result = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8", timeout: 2000 });
		assert.equal(result, raw, `quoteShellArgument(${JSON.stringify(raw)}) should round-trip`);
	}
});

// ── Behavioral contract: observable sandbox effects ──────────────

test("sandbox allows writes to /dev/null", () => {
	if (!canUseOsSandbox()) return;

	// CONTRACT: /dev/null redirects are always allowed (not a real write)
	execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox('echo discard > /dev/null')], { encoding: "utf8", timeout: 5000 });
});

test("sandbox allows writes through a symlinked temp path", () => {
	if (!canUseOsSandbox()) return;

	const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-real-"));
	const linkDir = path.join(os.tmpdir(), `pi-readonly-link-${Date.now()}`);
	try {
		// Create symlink to mimic /tmp → /private/tmp on macOS
		fs.symlinkSync(realDir, linkDir);
		const insidePath = path.join(linkDir, "via-symlink.txt");

		execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`echo symlink-works > "${insidePath}"`)], { encoding: "utf8", timeout: 5000 });
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "symlink-works", "sandbox should allow writes through symlinks to temp");
	} finally {
		try { fs.rmSync(linkDir, { force: true }); } catch { /* best-effort cleanup */ }
		try { fs.rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

