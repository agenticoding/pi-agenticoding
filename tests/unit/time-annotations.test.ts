import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestHost, type TestPI } from "./test-host.js";
import { createState } from "../../state.js";
import { createClock } from "../../time/clock.js";
import { registerTimeAwareness } from "../../time/register.js";
import { CLOCK_ENTRY_TYPE, reconstructClock, resolveCutAnchor } from "../../time/store.js";

function assistantMessage(content: any[] = [{ type: "text", text: "hello" }]): any {
	return { role: "assistant", content, stopReason: "stop", timestamp: 0 };
}

function toolEvent(toolCallId: string, overrides: Record<string, unknown> = {}): any {
	return {
		toolCallId, toolName: "read", args: {}, input: {},
		content: [{ type: "text", text: "out" }], isError: false,
		...overrides,
	};
}

function lastFooterText(result: any): string {
	const last = result.content.at(-1);
	assert.equal(last?.type, "text");
	return last.text;
}

/** Real loader and session entries; only host dispatch uses the existing test seam. */
class ClockScenario {
	pi!: TestPI;
	state = createState();
	session = SessionManager.inMemory(process.cwd());
	now = 0;
	copiedEntries = 0;

	static async create(): Promise<ClockScenario> {
		const scenario = new ClockScenario();
		scenario.state.clock = createClock(0);
		scenario.pi = await createTestHost((pi) => {
			registerTimeAwareness(pi, scenario.state, () => scenario.now);
		});
		return scenario;
	}

	async emit(name: string, event: any = {}, ctx: any = {}): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.pi.handlers.get(name) ?? []) {
			const result = await handler(event, { sessionManager: this.session, ...ctx });
			if (result !== undefined) results.push(result);
		}
		this.copyEntries();
		return results;
	}

	copyEntries(): void {
		for (const entry of this.pi.appendedEntries.slice(this.copiedEntries)) {
			this.session.appendCustomEntry(entry.customType, entry.data);
		}
		this.copiedEntries = this.pi.appendedEntries.length;
	}

	async start(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
		await this.emit("tool_execution_start", toolEvent(id, overrides));
	}

	async result(id: string, overrides: Record<string, unknown> = {}): Promise<any> {
		return (await this.emit("tool_result", toolEvent(id, overrides)))[0];
	}

	retainResult(id: string, result: any): string {
		return this.session.appendMessage({
			role: "toolResult", toolCallId: id, toolName: "read",
			content: result.content, isError: false, timestamp: this.now,
		});
	}

	restoreAt(id: string | null = this.session.getLeafId()): void {
		reconstructClock(this.state.clock, this.session.getBranch(id ?? undefined), this.now);
	}

	reading(): any {
		return this.pi.appendedEntries.at(-1)?.data;
	}
}

test("generation persists raw time, leaves assistant messages unannotated, and ignores users", async () => {
	const s = await ClockScenario.create();
	await s.emit("message_start", { message: assistantMessage() });
	s.now = 2500;
	assert.deepEqual(await s.emit("message_end", { message: assistantMessage() }), []);
	assert.deepEqual(s.reading(), { version: 1, l: 2500 });
	const count = s.pi.appendedEntries.length;
	assert.deepEqual(await s.emit("message_end", { message: { role: "user", content: "hi" } }), []);
	assert.equal(s.pi.appendedEntries.length, count);
});

test("tool footer preserves body and structuredContent and persists its call association", async () => {
	const s = await ClockScenario.create();
	await s.start("t1");
	s.now = 3000;
	const result = await s.result("t1", { structuredContent: { rows: [1, 2] } });
	assert.deepEqual(result.content[0], { type: "text", text: "out" });
	assert.equal(lastFooterText(result), "[read +3.0s | task 3.0s]");
	assert.deepEqual(result.structuredContent, { rows: [1, 2] });
	assert.deepEqual(s.reading(), { version: 1, l: 3000, toolCallId: "t1" });
	assert.equal(s.pi.appendedEntries.at(-1)?.customType, CLOCK_ENTRY_TYPE);
});

test("error results display even a short measured step", async () => {
	const s = await ClockScenario.create();
	await s.start("error");
	s.now = 50;
	assert.equal(lastFooterText(await s.result("error", { isError: true })), "[read +0.1s | task 0.1s]");
});

test("nested calls neither persist nor annotate", async () => {
	const s = await ClockScenario.create();
	await s.start("parent/child", { parentToolCallId: "parent" });
	assert.equal(await s.result("parent/child", { parentToolCallId: "parent" }), undefined);
	await s.emit("tool_execution_end", toolEvent("parent/child", { parentToolCallId: "parent" }));
	assert.equal(s.pi.appendedEntries.length, 0);
});

test("UI boundaries preserve independent readings and exclude waits from tool time", async () => {
	const s = await ClockScenario.create();
	await s.start("ui");
	s.now = 500;
	await s.emit("ui_prompt_start");
	assert.deepEqual(s.reading(), { version: 1, l: 500 });
	s.now += 30_000;
	await s.emit("ui_prompt_end");
	const uiEndId = s.session.getLeafId();
	s.now += 500;
	assert.equal(lastFooterText(await s.result("ui")), "[read +1.0s | task 1.0s]");
	s.restoreAt(uiEndId);
	assert.equal(s.state.clock.elapsedMs, 500);
});

test("repeated UI starts/ends do not corrupt the active measurement", async () => {
	const s = await ClockScenario.create();
	await s.start("ui");
	s.now = 1000;
	await s.emit("ui_prompt_start");
	s.now += 500;
	await s.emit("ui_prompt_start");
	s.now += 10_000;
	await s.emit("ui_prompt_end");
	s.now += 500;
	await s.emit("ui_prompt_end");
	s.now += 1000;
	assert.equal(lastFooterText(await s.result("ui")), "[read +2.5s | task 2.5s]");
});

test("fallback execution end remains a restorable boundary and excludes later idle time", async () => {
	const s = await ClockScenario.create();
	await s.start("blocked");
	s.now = 1000;
	await s.emit("tool_execution_end", toolEvent("blocked", { isError: true }));
	assert.deepEqual(s.reading(), { version: 1, l: 1000 });
	s.now += 100_000;
	s.restoreAt();
	await s.emit("message_start", { message: assistantMessage() });
	s.now += 500;
	await s.emit("message_end", { message: assistantMessage() });
	assert.deepEqual(s.reading(), { version: 1, l: 1500 });
});

test("execution end after a footer does not double-persist", async () => {
	const s = await ClockScenario.create();
	await s.start("done");
	s.now = 2000;
	await s.result("done");
	const count = s.pi.appendedEntries.length;
	await s.emit("tool_execution_end", toolEvent("done"));
	assert.equal(s.pi.appendedEntries.length, count);
});

test("execution end for a never-started call persists nothing and disturbs nothing", async () => {
	const s = await ClockScenario.create();
	await s.emit("tool_execution_end", toolEvent("ghost", { isError: true }));
	assert.equal(s.pi.appendedEntries.length, 0, "no observed start means no boundary to record");
	await s.start("t1");
	s.now = 2000;
	assert.equal(lastFooterText(await s.result("t1")), "[read +2.0s | task 2.0s]");
});

for (const content of [undefined, [], [{ type: "text", text: " " }]]) {
	test(`body-less content ${JSON.stringify(content)} has a non-footer separator`, async () => {
		const s = await ClockScenario.create();
		await s.start("empty");
		s.now = 1000;
		const result = await s.result("empty", { content });
		assert.deepEqual(result.content.at(-2), { type: "text", text: "read" });
		assert.equal(lastFooterText(result), "[read +1.0s | task 1.0s]");
	});
}

test("image-only body needs no separator before its footer", async () => {
	const s = await ClockScenario.create();
	await s.start("img");
	const result = await s.result("img", {
		content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
	});
	assert.equal(result.content.length, 2, "an image is a body: footer follows it directly");
	assert.equal(result.content[0].type, "image");
	assert.equal(lastFooterText(result), "[read +0.1s | task 0s]");
});

test("cut boundary persists the advanced active reading", async () => {
	const s = await ClockScenario.create();
	await s.start("cut");
	s.now = 3000;
	await s.emit("session_before_compact", { preparation: { tokensBefore: 1 }, branchEntries: [] });
	assert.deepEqual(s.reading(), { version: 1, l: 3000 });
});

async function nativeCut(s: ClockScenario, fromExtension: boolean): Promise<void> {
	await s.emit("session_compact", {
		compactionEntry: { id: "new-cut" }, fromExtension, reason: "manual", willRetry: false,
	});
}

test("extension cuts send no native anchor; first native cut sends one without covers", async () => {
	const s = await ClockScenario.create();
	await nativeCut(s, true);
	assert.equal(s.pi.sentMessages.length, 0);
	await nativeCut(s, false);
	assert.equal(s.pi.sentMessages.length, 1);
	assert.deepEqual(s.pi.sentMessages[0], {
		content: { customType: "pi-schematic-time-anchor", content: "[task elapsed 0s]", display: false },
		options: { triggerTurn: false },
	});
});

async function parallelBatch(firstFinished: string): Promise<ClockScenario> {
	const s = await ClockScenario.create();
	await s.start("first");
	await s.start("second");
	s.now = 1000;
	const early = await s.result(firstFinished);
	s.now = 5000;
	const other = firstFinished === "first" ? "second" : "first";
	const late = await s.result(other);
	// Host completes the entire batch before retaining results in call order.
	s.retainResult("first", firstFinished === "first" ? early : late);
	s.retainResult("second", firstFinished === "second" ? early : late);
	return s;
}

for (const firstFinished of ["first", "second"]) {
	test(`parallel rewind/resume follows retained results when ${firstFinished} completes first`, async () => {
		const s = await parallelBatch(firstFinished);
		const results = s.session.getBranch().filter((e) => e.type === "message");
		s.restoreAt(results[0].id);
		const firstElapsed = firstFinished === "first" ? 1000 : 5000;
		assert.equal(lastFooterText(await s.result("ghost")), `[read | task ${firstElapsed / 1000}.0s]`);
		s.restoreAt(results[1].id);
		assert.equal(s.state.clock.elapsedMs, firstFinished === "first" ? 5000 : 1000);
	});
}

test("rewind before all result messages does not retain unselected parallel completions", async () => {
	const s = await parallelBatch("first");
	const firstResult = s.session.getBranch().find((e) => e.type === "message")!;
	s.restoreAt(firstResult.parentId);
	assert.equal(lastFooterText(await s.result("ghost")), "[read | task 0s]");
});

test("restored position carries into subsequent work and the next cut's covers span", async () => {
	const s = await parallelBatch("first");
	const firstResult = s.session.getBranch().find((e) => e.type === "message")!;
	s.session.branch(firstResult.id);
	s.restoreAt();
	await s.emit("session_before_compact", {});
	s.session.appendCompaction("summary", firstResult.id, 1);
	await s.start("carried");
	s.now += 2000;
	const result = await s.result("carried");
	assert.equal(lastFooterText(result), "[read +2.0s | task 3.0s]");
	s.retainResult("carried", result);
	const anchor = resolveCutAnchor(s.state.clock, s.session.getBranch(), null, s.now);
	assert.equal(anchor.anchor, "[task elapsed 3.0s; covers 2.0s]");
	await nativeCut(s, false);
	assert.equal(s.pi.sentMessages[0].content.content, anchor.anchor);
});

// The default host loads the real registerSchematic from index.ts, so these
// footers prove the production session_start/session_tree reconstructClock
// wiring: a deleted call would render the footers from L=0 instead.
test("production session_start and session_tree reconstruct the clock from the branch", async () => {
	const pi = await createTestHost();
	const ctxFor = (l: number): any => ({
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => [
				{ id: `k${l}`, type: "custom", customType: CLOCK_ENTRY_TYPE, data: { version: 1, l } },
			],
		},
	});
	const footerTask = async (ctx: any): Promise<string> => {
		for (const handler of pi.handlers.get("tool_execution_start") ?? []) {
			await handler({ toolCallId: "w", toolName: "read", args: {} }, ctx);
		}
		let footer = "";
		for (const handler of pi.handlers.get("tool_result") ?? []) {
			const result = await handler({
				toolCallId: "w", toolName: "read", input: {},
				content: [{ type: "text", text: "out" }], isError: false,
			}, ctx);
			footer = result?.content?.at(-1)?.text ?? footer;
		}
		return footer;
	};

	const resumed = ctxFor(30_000);
	for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "resume" }, resumed);
	assert.match(await footerTask(resumed), /^\[read \+.+ \| task 30s\]$/, "resume restores the branch reading");

	const rewound = ctxFor(10_000);
	for (const handler of pi.handlers.get("session_tree") ?? []) await handler({}, rewound);
	assert.match(await footerTask(rewound), /^\[read \+.+ \| task 10s\]$/, "rewind re-reads the smaller branch reading");
});
