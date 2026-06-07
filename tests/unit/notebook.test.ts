import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Text } from "@earendil-works/pi-tui";
import { createState, resetState } from "../../state.js";
import { registerNotebookRehydration } from "../../notebook/rehydration.js";
import { saveNotebookPage, resetNotebookWriteLock } from "../../notebook/store.js";
import { createNotebookToolDefinitions } from "../../notebook/tools.js";
import { __setSingletons, createWriteLock, getSingletons } from "../../runtime-singletons.js";
import registerAgenticoding from "../../index.js";
import { STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { createTestPI, makeTUICtx, createDeferred, theme, stripAnsi } from "./helpers.js";

// ── Notebook rehydration tests ────────────────────────────────────────

test("notebook rehydration rebuilds the latest epoch and enables notebook tools", async () => {
	const pi = createTestPI();
	const state = createState();
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "old", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "new" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "newer" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 2);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["keep", "newer"]]);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});


test("notebook rehydration rebuilds from the latest persisted epoch and avoids duplicate active tools", async () => {
	const pi = createTestPI();
	pi.activeTools = ["read", "notebook_read", "notebook_index"];
	const state = createState();
	state.epoch = 7;
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 7, name: "keep", content: "fresh" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "future", content: "latest" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 8);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["future", "latest"]]);
	assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
});


test("notebook rehydration clears stale in-memory notebook state when persisted history is empty", async () => {
	const pi = createTestPI();
	const state = createState();
	state.epoch = 7;
	state.notebookPages.set("stale", "stale body");
	registerNotebookRehydration(pi as any, state);
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [],
			},
		},
	);

	assert.equal(state.epoch, 0);
	assert.deepEqual(Array.from(state.notebookPages.entries()), []);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});


test("session_start rehydrates the latest persisted notebook state through the full hook chain", async () => {
	const pi = createTestPI();
	pi.activeTools = ["read", "notebook_read"];
	registerAgenticoding(pi as any);

	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute(
		"seed",
		{ name: "stale-page", content: "stale body" },
		undefined,
		undefined,
		makeTUICtx({ hasUI: false }),
	);

	const sessionStartHandlers = pi.handlers.get("session_start")!;
	const ctx = {
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
				{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "fresh" } },
				{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "newer" } },
			],
		},
	};
	for (const sessionStart of sessionStartHandlers) {
		await sessionStart({ reason: "resume" }, ctx as any);
	}

	const notebookIndex = pi.tools.get("notebook_index");
	const notebookRead = pi.tools.get("notebook_read");
	const indexResult = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["keep"]);

	const readResult = await notebookRead.execute("2", { name: "keep" }, undefined, undefined, {} as any);
	assert.equal(readResult.details.found, true);
	assert.equal(readResult.details.body, "newer");
	assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
});

// ── Notebook tool contract tests ──────────────────────────────────────

test("notebook tools add/get/list return stable contract details", async () => {
	const pi = createTestPI();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addResult = await notebookWrite.execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, undefined, {} as any);
	assert.deepEqual(addResult.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(state.notebookPages.get("entry-a"), "first line\nsecond line");
	assert.equal(pi.appendedEntries.length, 1);
	assert.equal(pi.appendedEntries[0].customType, "notebook-entry");
	assert.equal(pi.appendedEntries[0].data.name, "entry-a");

	const getResult = await notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any);
	assert.equal(getResult.details.found, true);
	assert.deepEqual(getResult.details.entries, ["entry-a"]);
	assert.match(getResult.content[0].text, /--- entry-a ---/);
	assert.match(getResult.content[0].text, /second line/);

	const listResult = await notebookIndex.execute("3", {}, undefined, undefined, {} as any);
	assert.deepEqual(listResult.details, { entries: ["entry-a"] });
	assert.match(listResult.content[0].text, /entry-a: first line/);
});

test("child notebook tools reject stale access after reset", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	let stale = false;
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state, { isStale: () => stale });

	stale = true;
	await assert.rejects(
		() => notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookIndex.execute("3", {}, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 0);
});

test("child notebook_write succeeds while child session is fresh", async () => {
	const pi = createTestPI();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state, { isStale: () => false });

	const result = await notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "alpha" });
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 1);
});

test("notebook_read reports not found with current page names", async () => {
	const pi = createTestPI();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	state.notebookPages.set("entry-b", "beta");
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	const result = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a", "entry-b"], found: false });
	assert.match(result.content[0].text, /Notebook page "missing" not found\./);
	assert.match(result.content[0].text, /Notebook Pages:\n/);
	assert.match(result.content[0].text, /entry-a: alpha/);
	assert.match(result.content[0].text, /entry-b: beta/);
});

test("notebook tools show empty-state placeholders", async () => {
	const pi = createTestPI();
	const state = createState();
	const [, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const missing = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(missing.details, { entries: [], found: false });
	assert.match(missing.content[0].text, /Notebook Pages:\n\(empty\)/);

	const list = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(list.details, { entries: [] });
	assert.match(list.content[0].text, /Notebook Pages:\n\(empty\)/);
});

test("notebook_write pushes onUpdate and refreshes UI indicators", async () => {
	const pi = createTestPI();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute(
		"1",
		{ name: "entry-a", content: "first line\nsecond line" },
		undefined,
		(payload: any) => { update = payload; },
		makeTUICtx({ percent: 42, record }),
	);

	assert.equal(update.content[0].text, 'Saved "entry-a": first line');
	assert.deepEqual(update.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(record.statuses.get("agenticoding-notebook"), "📒 1");
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "first line" });
});

test("notebook tool renderers expose stable call/result summaries", async () => {
	const pi = createTestPI();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addCall = notebookWrite.renderCall!({ name: "entry-a", content: "first line\nsecond line" }, theme, {} as any) as Text;
	assert.match(stripAnsi(addCall.render(120).join("\n")), /notebook_write "entry-a": first line/);

	const addResult = notebookWrite.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a", content: "first line\nsecond line" } } as any,
	) as Text;
	assert.match(stripAnsi(addResult.render(120).join("\n")), /Saved "entry-a": first line/);
	assert.match(stripAnsi(addResult.render(120).join("\n")), /entry-a/);

	const getResult = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResult.render(120).join("\n")), /"entry-a"/);
	assert.match(stripAnsi(getResult.render(120).join("\n")), /body/);

	const getResultWithDelimiters = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2" } },
		{ expanded: true },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 1/);
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 2/);

	const listResult = notebookIndex.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"] } },
		{ expanded: true },
		theme,
		{} as any,
	) as Text;
	assert.match(stripAnsi(listResult.render(120).join("\n")), /2 pages/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-a/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-b/);
});

// ── Notebook command / overlay tests ──────────────────────────────────

test("/notebook exits cleanly when headless", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);

	await assert.doesNotReject(() => pi.commands.get("notebook")!.handler("", { hasUI: false }));
});


test("/notebook <topic> notifies with info on first set and warning on boundary change", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 20 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: (key: string, status: string | undefined) => { statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { widgets.set(key, content); },
		},
	};

	await pi.commands.get("notebook")!.handler("oauth", ctx as any);
	await pi.commands.get("notebook")!.handler("billing", ctx as any);

	assert.deepEqual(notifications[0], { message: "Active notebook topic: oauth", level: "info" });
	assert.match(notifications[1].message, /Active notebook topic changed: oauth → billing/);
	assert.equal(notifications[1].level, "warning");
	assert.equal(statuses.get(STATUS_KEY_TOPIC), "🧭 billing");
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

test("/notebook empty overlay renders empty state and closes on input", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(lines, /Notebook \(0 pages\)/);
	assert.match(lines, /\(empty\) — use notebook_write to create pages/);
	overlay.handleInput("x");
	assert.equal(doneCalls, 1);
});

test("/notebook selection previews the chosen entry", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notifications: string[] = [];
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body line\nsecond line" }, undefined, undefined, makeTUICtx());
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
			notify: (message: string) => { notifications.push(message); },
		},
	});

	// First Enter selects the entry — shows body inline, done() not yet called
	overlay.handleInput("\r");
	assert.equal(doneCalls, 0, "body shown inline, overlay stays open");
	const bodyLines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(bodyLines, /body line/);
	assert.match(bodyLines, /alpha/);

	// Second keypress closes the overlay
	overlay.handleInput("\r");
	assert.equal(doneCalls, 1);
});

test("/notebook overlay sorts entries consistently", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "zeta", content: "last" }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "alpha", content: "first" }, undefined, undefined, makeTUICtx());
	let overlay: any;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => {});
			},
			notify: () => {},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.ok(lines.indexOf("alpha") < lines.indexOf("zeta"), lines);
});

// ── saveNotebookPage tests ────────────────────────────────────────────

test("saveNotebookPage serializes concurrent writes and preserves completion order", async () => {
	const pi = createTestPI();
	const state = createState();
	const firstGate = createDeferred();
	const order: string[] = [];

	const first = saveNotebookPage(pi as any, state, "entry-a", "first", async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = saveNotebookPage(pi as any, state, "entry-a", "second", async () => {
		order.push("second:start");
	});

	await Promise.resolve();
	assert.deepEqual(order, ["first:start"]);
	firstGate.resolve();
	await Promise.all([first, second]);

	assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
	assert.equal(state.notebookPages.get("entry-a"), "second");
	assert.deepEqual(pi.appendedEntries.map((entry) => entry.data.content), ["first", "second"]);
});

test("saveNotebookPage keeps write order across runtime singleton swaps", async () => {
	const pi = createTestPI();
	const state = createState();
	const previousSingletons = getSingletons();
	const firstGate = createDeferred();
	const order: string[] = [];

	try {
		const first = saveNotebookPage(pi as any, state, "entry-a", "first", async () => {
			order.push("first:start");
			await firstGate.promise;
			order.push("first:end");
		});
		await Promise.resolve();

		__setSingletons({
			writeLock: createWriteLock(),
			writeContext: new AsyncLocalStorage<true>(),
			frameScheduler: getSingletons().frameScheduler,
		});
		const second = saveNotebookPage(pi as any, state, "entry-a", "second", async () => {
			order.push("second:start");
		});

		await Promise.resolve();
		assert.deepEqual(order, ["first:start"]);
		firstGate.resolve();
		await Promise.all([first, second]);

		assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
		assert.equal(state.notebookPages.get("entry-a"), "second");
	} finally {
		firstGate.resolve();
		resetNotebookWriteLock();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage rejects true reentrancy explicitly", async () => {
	const pi = createTestPI();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "outer", "outer", async () => {
			await saveNotebookPage(pi as any, state, "inner", "inner");
		}),
		/not reentrant/i,
	);
	assert.equal(state.notebookPages.size, 0);
});

test("saveNotebookPage releases the lock when assertWritable throws", async () => {
	const pi = createTestPI();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "broken", "value", async () => {
			throw new Error("blocked");
		}),
		/blocked/,
	);
	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
});

test("resetNotebookWriteLock clears abandoned lock state for later writes", async () => {
	const pi = createTestPI();
	const state = createState();
	const gate = createDeferred();
	void saveNotebookPage(pi as any, state, "stuck", "value", async () => {
		await gate.promise;
	});
	await Promise.resolve();
	resetNotebookWriteLock();

	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
	gate.resolve();
});


test("saveNotebookPage truncates oversized content before persisting", async () => {
	const pi = createTestPI();
	const state = createState();
	const content = "first line\n" + "detail\n".repeat(3000);

	const result = await saveNotebookPage(pi as any, state, "large-page", content);
	const persisted = pi.appendedEntries[0].data.content;

	assert.ok(persisted.length < content.length, "oversized notebook content should be truncated");
	assert.equal(state.notebookPages.get("large-page"), persisted);
	assert.equal(result.preview, "first line");
	assert.match(persisted, /^first line/m);
});


test("resetState clears epoch and the next notebook write starts a fresh generation", async () => {
	const pi = createTestPI();
	const state = createState();
	const originalNow = Date.now;

	try {
		Date.now = () => 1000;
		await saveNotebookPage(pi as any, state, "entry-a", "first");
		await saveNotebookPage(pi as any, state, "entry-b", "second");
		assert.equal(state.epoch, 1000);
		assert.equal(pi.appendedEntries[0].data.epoch, 1000);
		assert.equal(pi.appendedEntries[1].data.epoch, 1000);

		resetState(state);
		assert.equal(state.epoch, 0);

		Date.now = () => 2000;
		await saveNotebookPage(pi as any, state, "entry-c", "third");
		assert.equal(state.epoch, 2000);
		assert.equal(pi.appendedEntries[2].data.epoch, 2000);
	} finally {
		Date.now = originalNow;
	}
});

// ── Notebook tool definition metadata tests ───────────────────────────

test("notebook tool definitions include prompt hints when withPromptHints is true", () => {
	const pi = createTestPI();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state, { withPromptHints: true });

	for (const tool of tools) {
		assert.ok(typeof tool.promptSnippet === "string", `${tool.name} should have promptSnippet when withPromptHints=true`);
		assert.ok(Array.isArray(tool.promptGuidelines), `${tool.name} should have promptGuidelines when withPromptHints=true`);
	}
	const notebookWrite = tools.find(t => t.name === "notebook_write")!;
	const notebookRead = tools.find(t => t.name === "notebook_read")!;
	const notebookIndex = tools.find(t => t.name === "notebook_index")!;

	// Structural invariants: all guidelines exist and are non-trivial
	for (const tool of tools) {
		assert.ok(tool.promptGuidelines!.length >= 2, `${tool.name} should have at least 2 promptGuidelines`);
		assert.ok(tool.promptGuidelines!.every((g: string) => g.length > 10), `${tool.name} each guideline should be non-trivial`);
	}

	// Conceptual: notebook_write is future-context oriented
	const writeGuidelines = notebookWrite.promptGuidelines!.join(" ");
	assert.match(writeGuidelines, /subject-oriented pages/i);
	assert.match(writeGuidelines, /fresh context/i);
	assert.match(writeGuidelines, /belongs in handoff/i);

	// Conceptual: descriptions mention the notebook-page metaphor
	assert.match(notebookWrite.description, /page|future contexts/i);
	assert.match(notebookRead.description, /notebook page|page/i);
	assert.match(notebookIndex.description, /notebook index|index/i);
});

test("notebook tool definitions omit prompt hints by default", () => {
	const pi = createTestPI();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state);

	for (const tool of tools) {
		assert.equal(tool.promptSnippet, undefined, `${tool.name} should not have promptSnippet by default`);
		assert.equal(tool.promptGuidelines, undefined, `${tool.name} should not have promptGuidelines by default`);
	}
});
