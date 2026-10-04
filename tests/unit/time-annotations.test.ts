import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { createTestHost, type TestPI } from "./test-host.js";
import { registerToolTimings } from "../../time/register.js";

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

/** Real loader and registration; only `now` is injected so spans are deterministic. */
class TimingScenario {
	pi!: TestPI;
	now = 0;

	static async create(): Promise<TimingScenario> {
		const scenario = new TimingScenario();
		scenario.pi = await createTestHost((pi) => {
			registerToolTimings(pi, () => scenario.now);
		});
		return scenario;
	}

	async emit(name: string, event: any = {}): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.pi.handlers.get(name) ?? []) {
			const result = await handler(event, {});
			if (result !== undefined) results.push(result);
		}
		return results;
	}

	async start(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
		await this.emit("tool_execution_start", toolEvent(id, overrides));
	}

	async result(id: string, overrides: Record<string, unknown> = {}): Promise<any> {
		return (await this.emit("tool_result", toolEvent(id, overrides)))[0];
	}
}

test("tool footer labels the tool and its measured step", async () => {
	const s = await TimingScenario.create();
	await s.start("t1");
	s.now = 3250;
	const result = await s.result("t1", { structuredContent: { rows: [1, 2] } });
	assert.deepEqual(result.content[0], { type: "text", text: "out" });
	assert.equal(lastFooterText(result), "[read +3.2s]");
	assert.deepEqual(result.structuredContent, { rows: [1, 2] });
});

test("error results display even a short measured step", async () => {
	const s = await TimingScenario.create();
	await s.start("error");
	s.now = 50;
	assert.equal(lastFooterText(await s.result("error", { isError: true })), "[read +0.1s]");
});

test("a result with no observed start omits the step", async () => {
	const s = await TimingScenario.create();
	s.now = 3000;
	assert.equal(lastFooterText(await s.result("ghost")), "[read]");
});

test("a repeated result for one call omits the step", async () => {
	const s = await TimingScenario.create();
	await s.start("t1");
	s.now = 1000;
	assert.equal(lastFooterText(await s.result("t1")), "[read +1.0s]");
	s.now = 5000;
	assert.equal(lastFooterText(await s.result("t1")), "[read]");
});

test("nested calls are neither recorded nor annotated", async () => {
	const s = await TimingScenario.create();
	await s.start("parent/child", { parentToolCallId: "parent" });
	assert.equal(await s.result("parent/child", { parentToolCallId: "parent" }), undefined);
	await s.emit("tool_execution_end", toolEvent("parent/child", { parentToolCallId: "parent" }));
});

test("parallel calls measure their own independent spans", async () => {
	const s = await TimingScenario.create();
	await s.start("first");
	await s.start("second");
	s.now = 1000;
	assert.equal(lastFooterText(await s.result("first")), "[read +1.0s]");
	s.now = 5000;
	assert.equal(lastFooterText(await s.result("second")), "[read +5.0s]");
});

test("execution end without a result fabricates no footer and does not leak into the next call", async () => {
	const s = await TimingScenario.create();
	await s.start("blocked");
	s.now = 1000;
	await s.emit("tool_execution_end", toolEvent("blocked", { isError: true }));
	// The end hook dropped the orphaned start: a late result gets no invented delta.
	assert.equal(lastFooterText(await s.result("blocked")), "[read]");
	await s.start("t1");
	s.now += 2000;
	assert.equal(lastFooterText(await s.result("t1")), "[read +2.0s]");
});

for (const content of [undefined, [], [{ type: "text", text: " " }]]) {
	test(`body-less content ${JSON.stringify(content)} has a non-footer separator`, async () => {
		const s = await TimingScenario.create();
		await s.start("empty");
		s.now = 1000;
		const result = await s.result("empty", { content });
		assert.deepEqual(result.content.at(-2), { type: "text", text: "read" });
		assert.equal(lastFooterText(result), "[read +1.0s]");
	});
}

test("image-only body needs no separator before its footer", async () => {
	const s = await TimingScenario.create();
	await s.start("img");
	const result = await s.result("img", {
		content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
	});
	assert.equal(result.content.length, 2, "an image is a body: footer follows it directly");
	assert.equal(result.content[0].type, "image");
	assert.equal(lastFooterText(result), "[read +0.1s]");
});

// ── Property: random event sequences preserve footer shape + invariants ──

type TimingsAction =
	| { type: "start"; id: string; nested: boolean }
	| { type: "result"; id: string; nested: boolean }
	| { type: "end"; id: string; nested: boolean };

const arbId = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const arbTimingsAction: fc.Arbitrary<TimingsAction> = fc.oneof(
	fc.record({ type: fc.constant("start" as const), id: arbId, nested: fc.boolean() }),
	fc.record({ type: fc.constant("result" as const), id: arbId, nested: fc.boolean() }),
	fc.record({ type: fc.constant("end" as const), id: arbId, nested: fc.boolean() }),
);

test("property: footers stay well-formed and structuredContent preserved across random event sequences", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.tuple(arbTimingsAction, fc.integer({ min: 0, max: 100_000 })), { maxLength: 80 }),
			async (steps) => {
				// Fresh state per run: a counterexample must be reproducible standalone.
				const s = await TimingScenario.create();
				for (const [action, now] of steps) {
					s.now = now;
					const event: Record<string, unknown> = {
						toolCallId: action.id,
						toolName: "read",
						parentToolCallId: action.nested ? "parent" : undefined,
						content: [{ type: "text", text: "out" }],
						structuredContent: { kept: true },
					};
					if (action.type === "start") {
						await s.emit("tool_execution_start", event);
					} else if (action.type === "result") {
						const [result] = await s.emit("tool_result", event);
						// Nested results never reach the transcript — no annotation returned.
						if (!action.nested && result) {
							assert.match(
								lastFooterText(result),
								/^\[read(\s\+\d[^\s]*)?\]$/,
								`footer well-formed for id=${action.id}`,
							);
							assert.deepEqual(result.structuredContent, { kept: true });
						}
					} else {
						await s.emit("tool_execution_end", event);
					}
				}
			},
		),
		{ numRuns: 200 },
	);
});

test("a backward now clamps to a zero step, never a negative duration", async () => {
	// An injected test clock can regress; the delta clamps to 0, and the zero floor
	// renders +0.1s rather than a misleading "+0s".
	const s = await TimingScenario.create();
	await s.start("t1");
	s.now = 1000;
	await s.start("t2");
	s.now = 500;
	assert.equal(lastFooterText(await s.result("t2")), "[read +0.1s]");
});

test("a repeated start re-arms the span; a consumed start never contaminates a later call", async () => {
	// start→start→result measures from the LATEST start (restart wins); a start
	// already consumed by a result must not leak a stale timestamp into a new span.
	const s = await TimingScenario.create();
	await s.start("x");
	s.now = 1000;
	await s.start("x"); // repeated start before any result: overwrite
	s.now = 1500;
	assert.equal(lastFooterText(await s.result("x")), "[read +0.5s]");
	// A start after the first was consumed begins a fresh span.
	await s.start("x");
	s.now = 5000;
	assert.equal(lastFooterText(await s.result("x")), "[read +3.5s]");
});

test("default now source measures a real, non-negative step without an injected clock", async () => {
	// registerToolTimings with no `now` override uses performance.now() — verify
	// the default path works and produces a positive step after real time elapses.
	const pi = await createTestHost((api) => {
		registerToolTimings(api);
	});

	const run = async (name: string, event: Record<string, unknown>): Promise<any[]> => {
		const results: any[] = [];
		for (const handler of pi.handlers.get(name) ?? []) {
			const result = await handler(event, {});
			if (result !== undefined) results.push(result);
		}
		return results;
	};

	await run("tool_execution_start", { toolCallId: "default-now", toolName: "read", args: {} });
	// Allow real monotonic time to advance (guarantees a positive delta).
	await new Promise((r) => setTimeout(r, 10));
	const [result] = await run("tool_result", {
		toolCallId: "default-now", toolName: "read", args: {},
		content: [{ type: "text", text: "out" }],
		structuredContent: { kept: true },
	});
	const footer = result.content.at(-1)?.text;
	assert.match(footer, /^\[read \+\d[^\s]*\]$/, "default now produces a valid positive step footer");
	assert.deepEqual(result.structuredContent, { kept: true });
});
