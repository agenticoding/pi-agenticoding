import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerAgenticoding from "../../index.js";
import { registerModelGroupsCommand } from "../../model-groups/command.js";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { createState } from "../../state.js";
import { createTestPI, theme } from "./helpers.js";

function registry(available = new Set(["openai:gpt-5"])): any {
	const models = [{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "x" } }];
	return {
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.has(`${m.provider}:${m.id}`)),
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => available.has(`${model.provider}:${model.id}`),
	};
}

async function withTemp(fn: (cwd: string) => Promise<void> | void): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-groups-int-"));
	const oldHome = process.env.HOME;
	process.env.HOME = path.join(root, "home");
	try { await fn(path.join(root, "project")); }
	finally { process.env.HOME = oldHome; __setModelGroupsFsForTests(null); fs.rmSync(root, { recursive: true, force: true }); }
}

test("/model-groups command registers and opens ctx.ui.custom with live registry/cwd", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { "cwd-sentinel-group": { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = createTestPI();
	const state = createState();
	const findCalls: string[] = [];
	const registrySentinel = {
		...registry(),
		find: (provider: string, id: string) => {
			findCalls.push(`${provider}:${id}`);
			return { provider, id, reasoning: true, thinkingLevelMap: { xhigh: "x" } };
		},
		hasConfiguredAuth: () => true,
	};
	registerModelGroupsCommand(pi as any, state);
	assert.ok(pi.commands.has("model-groups"));
	let customCalled = 0;
	let rendered = "";
	await pi.commands.get("model-groups")!.handler("", {
		hasUI: true,
		cwd,
		modelRegistry: registrySentinel,
		ui: {
			notify: () => {},
			custom: async (factory: any) => {
				customCalled++;
				const component = factory({ requestRender: () => {} }, theme, {}, () => {});
				rendered = component.render(80).join("\n");
			},
		},
	});
	assert.equal(customCalled, 1);
	assert.match(rendered, /Model Groups/);
	assert.match(rendered, /cwd-sentinel-group/);
	assert.deepEqual(findCalls, ["openai:gpt-5"]);
}));

test("index session_start stores model group validation and notifies load and validation issues", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), JSON.stringify({ version: 1, groups: { bad: { models: [{ provider: "missing", modelId: "nope" }] }, shadow: { models: [] } } }), "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { shadow: { models: [] } } }), "utf8");
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: {
			theme,
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	assert.ok(notifications.some((m) => /1 unavailable model references · 1 project overrides/.test(m)));
}));

test("index session_start notifies corrupt/schema/unsupported load issues", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{bad", "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	assert.ok(notifications.some((m) => /corrupt-json/.test(m)));
	assert.ok(notifications.some((m) => /unsupported-version/.test(m)));
}));

test("index session_start notifies schema-invalid load issues", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { broken: { models: [{ provider: 1 }] } } }), "utf8");
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	assert.ok(notifications.some((m) => /schema-invalid/.test(m)));
	assert.ok(notifications.some((m) => /project scope/.test(m)));
	assert.ok(notifications.some((m) => m.includes(modelGroupsPath("project", cwd))));
}));

test("index session_start includes backup-failure detail in load issue notifications", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("backup denied"); } });
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	assert.ok(notifications.some((m) => /corrupt-json/.test(m) && /backup failed, original file left untouched/.test(m) && m.includes(modelGroupsPath("project", cwd))));
}));

test("before_agent_start injects fresh names-only Model Groups guidance", async () => withTemp(async (cwd) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const handler = pi.handlers.get("before_agent_start")!.at(-1)!;
	const result = await handler({ systemPrompt: "Base." }, { hasUI: false, cwd, modelRegistry: registry(), getContextUsage: () => null });
	assert.match(result.systemPrompt, /## Model Groups for spawn/);
	assert.match(result.systemPrompt, /Available Model Groups: review/);
	assert.match(result.systemPrompt, /exact group name/);
	assert.match(result.systemPrompt, /known and confident/);
	assert.match(result.systemPrompt, /omit group and inherit/);
	assert.doesNotMatch(result.systemPrompt, /gpt-5/);
	assert.doesNotMatch(result.systemPrompt, /model-groups\.json/);
}));

test("session_start registers Model Groups autocomplete provider when UI supports it", async () => withTemp(async (cwd) => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const providers: any[] = [];
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: () => {}, setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: (factory: any) => providers.push(factory) },
	});
	assert.equal(providers.length, 1);
}));

test("index session_start does not notify when load and validation issues are absent", async () => withTemp(async (cwd) => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	assert.deepEqual(notifications, []);
}));
