import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const {
	npmInvocation,
	repoRootFromScript,
	runChecked,
	runNpm,
} = await import(new URL("../../scripts/compat-process.mjs", import.meta.url).href);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readScript(name: string): string {
	return readFileSync(join(REPO_ROOT, "scripts", name), "utf8");
}

test("repoRootFromScript decodes native paths containing spaces", () => {
	const expectedRoot = resolve(tmpdir(), "compat repo with spaces");
	const scriptUrl = pathToFileURL(join(expectedRoot, "scripts", "check.mjs")).href;
	assert.equal(repoRootFromScript(scriptUrl), expectedRoot);
});

test("npmInvocation uses npm_execpath through the active Node executable", () => {
	assert.deepEqual(
		npmInvocation(["ls", "--json"], {
			env: { npm_execpath: "/npm install/npm-cli.js" },
			platform: "win32",
			execPath: "/node install/node.exe",
		}),
		{
			command: "/node install/node.exe",
			args: ["/npm install/npm-cli.js", "ls", "--json"],
		},
	);
});

test("runNpm launches npm portably", () => {
	const result = runNpm(REPO_ROOT, ["--version"], { capture: true });
	assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test("runChecked reports process launch failures", () => {
	assert.throws(
		() => runChecked("pi-agenticoding-command-that-does-not-exist", [], { cwd: REPO_ROOT, capture: true }),
		(error: unknown) => {
			assert.match(String(error), /error\.stack:/);
			assert.match(String(error), /status: null/);
			return true;
		},
	);
});

test("runChecked reports nonzero status and captured output", () => {
	assert.throws(
		() => runChecked(process.execPath, [
			"-e",
			"process.stdout.write('stdout sentinel'); process.stderr.write('stderr sentinel'); process.exit(7)",
		], { cwd: REPO_ROOT, capture: true }),
		(error: unknown) => {
			assert.match(String(error), /status: 7/);
			assert.match(String(error), /stdout sentinel/);
			assert.match(String(error), /stderr sentinel/);
			return true;
		},
	);
});

test("compatibility scripts use native roots and the shared npm runner", () => {
	for (const name of ["test-compat-current.mjs", "test-compat-floor.mjs", "test-package-host.mjs"]) {
		const source = readScript(name);
		assert.doesNotMatch(source, /\.pathname\b/);
		assert.doesNotMatch(source, /spawnSync\(["']npm["']/);
		assert.match(source, /runNpm\(/);
		assert.match(source, /repoRootFromScript\(import\.meta\.url\)/);
	}
});
