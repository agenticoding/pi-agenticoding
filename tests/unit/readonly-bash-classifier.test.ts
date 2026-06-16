import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { registerReadonlyPI, makeReadonlyUICtx } from "./helpers.js";
import type { ToolCall } from "./helpers.js";

// ── Helpers ───────────────────────────────────────────────────────

async function enableReadonly(pi: ReturnType<typeof import("./helpers.js").createTestPI>) {
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
}

async function assertBlocked(toolCall: ToolCall, command: string, cwd = "/workspace") {
	const result = await toolCall({ toolName: "bash", input: { command } }, { cwd });
	assert.equal(result.block, true, `expected block: ${command}`);
}

async function assertAllowed(toolCall: ToolCall, command: string, cwd = "/workspace") {
	assert.equal(await toolCall({ toolName: "bash", input: { command } }, { cwd }), undefined, `expected allow: ${command}`);
}

// ── Behavioral contract tests (via tool_call hook — real code path) ──

test("blocks bash writes outside temp dir", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

	// Representative mutation commands targeting a concrete non-temp path.
	// Tests the CONTRACT: writes outside temp dir are blocked.
	await assertBlocked(toolCall, `touch ${outsideTemp}`);
	await assertBlocked(toolCall, `rm -f ${outsideTemp}`);
	await assertBlocked(toolCall, `echo "test" > ${outsideTemp}`);
});

test("allows bash reads and non-mutating commands", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: reads are allowed (catches over-blocking).
	await assertAllowed(toolCall, "ls -la");
	await assertAllowed(toolCall, "echo hello");
	await assertAllowed(toolCall, "git status");
	await assertAllowed(toolCall, "git log --oneline");
	await assertAllowed(toolCall, "git stash list");
});

test("allows bash writes to temp dir", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();

	// CONTRACT: temp dir writes are allowed.
	await assertAllowed(toolCall, `echo ok > ${tmp}/readonly-test.txt`);
	await assertAllowed(toolCall, `rm ${tmp}/readonly-test.txt`);
});

test("blocks command substitutions that write outside temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

	// CONTRACT: evasion via command substitution is caught.
	await assertBlocked(toolCall, `touch $(echo ${outsideTemp})`);
});

test("blocks write redirects outside temp dir", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

	// CONTRACT: write redirects to non-temp paths are blocked.
	await assertBlocked(toolCall, `echo hello > ${outsideTemp}`);
});

test("blocks package managers unconditionally", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: package managers blocked regardless of target path.
	await assertBlocked(toolCall, "npm install lodash");
	await assertBlocked(toolCall, "pip install requests");
	await assertBlocked(toolCall, "yarn add lodash");
});

test("classifies git commands correctly", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: immutable git commands allowed, mutable blocked.
	await assertAllowed(toolCall, "git status");
	await assertAllowed(toolCall, "git log --oneline");
	await assertBlocked(toolCall, "git add .");
	await assertBlocked(toolCall, "git commit -m 'msg'");
});

test("blocks cwd-relative downloads outside temp but allows inside temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();

	// CONTRACT: cwd-relative downloads follow temp-dir rules.
	await assertBlocked(toolCall, "curl -O https://example.com/file.txt", "/workspace");
	await assertAllowed(toolCall, "curl -O https://example.com/file.txt", tmp);
	await assertBlocked(toolCall, "wget https://example.com/file.txt", "/workspace");
});

test("allows readonly-safe git inspection subcommands", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "git reflog");
	await assertAllowed(toolCall, "git branch -l");
	await assertAllowed(toolCall, "git config -l");
});

test("allows piped read commands", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "cat /etc/hosts | grep localhost");
	await assertAllowed(toolCall, "ls -la | head -5");
	await assertAllowed(toolCall, "git log | grep commit");
});

test("blocks chained commands that write outside temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const outside = path.join(os.homedir(), "readonly-test-file");

	await assertBlocked(toolCall, `echo a && touch ${outside}`);
	await assertBlocked(toolCall, `ls; rm -f ${outside}`);
	await assertBlocked(toolCall, `echo ok || touch ${outside}`);
});

test("allows chained commands that only read or write to temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();

	await assertAllowed(toolCall, "echo a && ls");
	await assertAllowed(toolCall, `echo a > ${tmp}/x && cat ${tmp}/x`);
});

test("blocks heredoc redirects outside temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const outside = path.join(os.homedir(), "readonly-test-file");

	await assertBlocked(toolCall, `cat <<'EOF' > ${outside}\nhello\nEOF`);
});

test("blocks dd of= outside temp and allows it in temp", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();
	const outside = path.join(os.homedir(), "readonly-test-file");

	await assertBlocked(toolCall, `dd if=/dev/zero of=${outside} bs=1 count=1`);
	await assertAllowed(toolCall, `dd if=/dev/zero of=${tmp}/dd-test bs=1 count=1`);
});
