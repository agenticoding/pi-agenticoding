import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, rm } from "node:fs/promises";
import { createState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { createTestPI } from "./helpers.js";

async function spawnWithCapture(
	readonlyEnabled: boolean,
	inspect: (config: any, prompt: string) => Promise<void> | void,
	activeTools?: string[],
) {
	const pi = createTestPI();
	const tools = activeTools ?? ["read", "bash", "write", "edit", "spawn", "handoff"];
	pi.setActiveTools(tools);
	pi.setAllTools(tools);
	const state = createState();
	state.readonlyEnabled = readonlyEnabled;

	const sessionFactory = async (config: any) => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				await inspect(config, prompt);
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, sessionFactory as any);
	await pi.tools.get("spawn").execute(
		"spawn-readonly",
		{ prompt: "test" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: process.cwd() },
	);
}

test("readonly spawn child prompt tells the child it inherits readonly authority", async () => {
	let prompt = "";

	await spawnWithCapture(true, (_config, childPrompt) => {
		prompt = childPrompt;
	});

	assert.match(prompt, /inherit readonly authority/i);
	assert.match(prompt, /\[readonly\] write\/edit blocked/i);
	assert.match(prompt, /bash writes\/deletions outside temp blocked/i);
});

test("non-readonly spawn child prompt keeps normal authority", async () => {
	let prompt = "";

	await spawnWithCapture(false, (_config, childPrompt) => {
		prompt = childPrompt;
	});

	assert.match(prompt, /same authority as the parent/i);
	assert.doesNotMatch(prompt, /\[readonly\] write\/edit blocked; bash writes\/deletions outside temp blocked\./i);
});

test("readonly spawn child bash tool rejects malformed commands", async () => {
	await spawnWithCapture(true, async (config) => {
		const bashTool = config.customTools.find((tool: any) => tool.name === "bash");
		assert.ok(bashTool, "readonly child should receive a bash tool");
		for (const command of [undefined, null, 42, { command: "ls" }]) {
			await assert.rejects(
				() => bashTool.execute("malformed", { command }),
				/bash command input must be a string/,
			);
		}
	});
});

test("readonly spawn child bash tool blocks non-temp writes and allows temp writes", async () => {
	const outsideTemp = path.join(os.homedir(), `readonly-child-test-${process.pid}-${Date.now()}`);
	const insideTemp = path.join(os.tmpdir(), `readonly-child-test-${Date.now()}`);
	await rm(outsideTemp, { force: true });

	try {
		await spawnWithCapture(true, async (config) => {
			const bashTool = config.customTools.find((tool: any) => tool.name === "bash");

			assert.ok(bashTool, "readonly child should receive a bash tool");
			await assert.rejects(
				() => bashTool.execute("bash-1", { command: `touch ${outsideTemp}` }),
				/Readonly mode:/,
			);
			await assert.rejects(() => access(outsideTemp), /ENOENT/);
			await assert.doesNotReject(
				() => bashTool.execute("bash-2", { command: `touch ${insideTemp} && rm ${insideTemp}` }),
			);
		});
	} finally {
		await rm(outsideTemp, { force: true });
	}
});
