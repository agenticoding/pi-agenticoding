import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const REGISTER_LOADER = pathToFileURL(resolve(ROOT, "register-loader.mjs")).href;
const ENTRY = fileURLToPath(new URL("./fixtures/register-loader-entry.mjs", import.meta.url));

test("register-loader resolves test-loader relative to itself instead of cwd", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-agenticoding-loader-"));

	try {
		const result = spawnSync(
			process.execPath,
			["--import", REGISTER_LOADER, ENTRY],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /ok/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("register-loader errors when entry file does not exist", () => {
	const cwd = mkdtempSync(resolve(tmpdir(), "pi-agenticoding-loader-fail-"));
	try {
		const result = spawnSync(
			process.execPath,
			["--import", REGISTER_LOADER, "/nonexistent/entry.mjs"],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			},
		);

		assert.notEqual(result.status, 0, "should exit non-zero for missing entry");
		assert.ok(
			result.stderr.includes("nonexistent") || result.stderr.includes("ENOENT"),
			"stderr should reference the missing file, got: " + result.stderr,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
