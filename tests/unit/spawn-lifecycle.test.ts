import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createState, resetState } from "../../state.js";
import { createSession, createSubscribableSession, createTestPI, createRenderContext, theme } from "./helpers.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { executeSpawn, getSpawnCleanupError, registerSpawnTool } from "../../spawn/index.js";
import { flushSpawnFrameScheduler } from "../../spawn/renderer.js";

let h: TestHarness;

function makeChildSpawnTool(state: any) {
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
});

afterEach(() => {
	h.teardown();
});

test("executeSpawn disposes a normally completed child exactly once", async () => {
	const state = createState();
	const pi = createTestPI();
	let disposeCalls = 0;
	const session = {
		...createSession([]),
		messages: [] as any[],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		},
		getSessionStats: () => undefined,
		dispose: () => { disposeCalls++; },
	};

	const result = await executeSpawn(
		"spawn-1", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work" }, undefined, undefined, "medium",
		async () => ({ session: session as any, extensionsResult: undefined as any }),
	);

	assert.equal(result.content[0]?.text, "done");
	assert.equal(disposeCalls, 1);
});

test("executeSpawn preserves a primary prompt failure when disposal also fails", async () => {
	const state = createState();
	const pi = createTestPI();
	const primary = new Error("prompt failed");
	const cleanup = new Error("dispose failed");
	let disposeCalls = 0;
	const session = {
		...createSession([]),
		prompt: async () => { throw primary; },
		getSessionStats: () => undefined,
		dispose: () => {
			disposeCalls++;
			throw cleanup;
		},
	};

	const execution = executeSpawn(
		"spawn-1", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work" }, undefined, undefined, "medium",
		async () => ({ session: session as any, extensionsResult: undefined as any }),
	);
	await assert.rejects(
		execution,
		(error: unknown) => error === primary && getSpawnCleanupError(error, execution) === cleanup,
	);
	assert.equal(disposeCalls, 1);
});

test("executeSpawn preserves a primitive primary failure and retains its cleanup failure", async () => {
	const state = createState();
	const pi = createTestPI();
	const primary = "primitive prompt failure";
	const cleanup = new Error("dispose failed");
	const session = {
		...createSession([]),
		prompt: async () => { throw primary; },
		getSessionStats: () => undefined,
		dispose: () => { throw cleanup; },
	};

	const execution = executeSpawn(
		"spawn-primitive", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work" }, undefined, undefined, "medium",
		async () => ({ session: session as any, extensionsResult: undefined as any }),
	);
	let caught: unknown;
	try {
		await execution;
	} catch (error) {
		caught = error;
	}

	assert.equal(caught, primary, "the primitive primary failure remains authoritative");
	assert.equal(getSpawnCleanupError(caught, execution), cleanup, "cleanup failure remains observable");
});

test("executeSpawn correlates concurrent identical primitive failures with their own cleanup", async () => {
	const state = createState();
	const pi = createTestPI();
	const primary = "shared primitive failure";
	const cleanupA = new Error("dispose A failed");
	const cleanupB = new Error("dispose B failed");
	let releaseA!: () => void;
	let releaseB!: () => void;
	const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
	const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
	const makeSession = (gate: Promise<void>, cleanup: Error) => ({
		...createSession([]),
		prompt: async () => {
			await gate;
			throw primary;
		},
		getSessionStats: () => undefined,
		dispose: () => { throw cleanup; },
	});

	const executionA = executeSpawn(
		"spawn-primitive-a", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work A" }, undefined, undefined, "medium",
		async () => ({ session: makeSession(gateA, cleanupA) as any, extensionsResult: undefined as any }),
	);
	const executionB = executeSpawn(
		"spawn-primitive-b", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work B" }, undefined, undefined, "medium",
		async () => ({ session: makeSession(gateB, cleanupB) as any, extensionsResult: undefined as any }),
	);
	const rejectionA = executionA.catch((error: unknown) => error);
	const rejectionB = executionB.catch((error: unknown) => error);

	releaseA();
	assert.equal(await rejectionA, primary);
	releaseB();
	assert.equal(await rejectionB, primary);

	assert.equal(getSpawnCleanupError(primary, executionB), cleanupB);
	assert.equal(getSpawnCleanupError(primary, executionA), cleanupA);
});

test("executeSpawn correlates concurrent identical object failures with their own cleanup", async () => {
	const state = createState();
	const pi = createTestPI();
	const primary = new Error("shared object failure");
	const cleanupA = new Error("dispose A failed");
	const cleanupB = new Error("dispose B failed");
	let releaseA!: () => void;
	let releaseB!: () => void;
	const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
	const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
	const makeSession = (gate: Promise<void>, cleanup: Error) => ({
		...createSession([]),
		prompt: async () => {
			await gate;
			throw primary;
		},
		getSessionStats: () => undefined,
		dispose: () => { throw cleanup; },
	});

	const executionA = executeSpawn(
		"spawn-object-a", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work A" }, undefined, undefined, "medium",
		async () => ({ session: makeSession(gateA, cleanupA) as any, extensionsResult: undefined as any }),
	);
	const executionB = executeSpawn(
		"spawn-object-b", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work B" }, undefined, undefined, "medium",
		async () => ({ session: makeSession(gateB, cleanupB) as any, extensionsResult: undefined as any }),
	);
	const rejectionA = executionA.catch((error: unknown) => error);
	const rejectionB = executionB.catch((error: unknown) => error);

	releaseA();
	assert.equal(await rejectionA, primary);
	releaseB();
	assert.equal(await rejectionB, primary);

	assert.equal(getSpawnCleanupError(primary, executionB), cleanupB);
	assert.equal(getSpawnCleanupError(primary, executionA), cleanupA);
});

test("executeSpawn surfaces a disposal-only failure", async () => {
	const state = createState();
	const pi = createTestPI();
	const cleanup = new Error("dispose failed");
	const session = {
		...createSession([]),
		messages: [] as any[],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		},
		getSessionStats: () => undefined,
		dispose: () => { throw cleanup; },
	};

	await assert.rejects(
		() => executeSpawn(
			"spawn-1", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
			state, { prompt: "work" }, undefined, undefined, "medium",
			async () => ({ session: session as any, extensionsResult: undefined as any }),
		),
		(error: unknown) => error === cleanup,
	);
});

test("executeSpawn disposes no-output and post-create aborted children", async () => {
	for (const mode of ["no-output", "aborted"] as const) {
		const state = createState();
		const pi = createTestPI();
		let disposeCalls = 0;
		const controller = new AbortController();
		if (mode === "aborted") controller.abort(new Error("stop"));
		const session = {
			...createSession([]),
			messages: [] as any[],
			prompt: async () => {},
			getSessionStats: () => undefined,
			dispose: () => { disposeCalls++; },
		};
		await assert.rejects(
			() => executeSpawn(
				`spawn-${mode}`, pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
				state, { prompt: "work" }, mode === "aborted" ? controller.signal : undefined, undefined, "medium",
				async () => ({ session: session as any, extensionsResult: undefined as any }),
			),
			mode === "aborted" ? /stop/ : /produced no output/,
		);
		assert.equal(disposeCalls, 1, mode);
	}
});

test("executeSpawn disposes a session that resolves after reset invalidates creation", async () => {
	const state = createState();
	const pi = createTestPI();
	let resolveFactory!: (value: any) => void;
	const factory = new Promise<any>((resolve) => { resolveFactory = resolve; });
	let disposeCalls = 0;
	const session = {
		...createSession([]),
		getSessionStats: () => undefined,
		dispose: () => { disposeCalls++; },
	};
	const execution = executeSpawn(
		"spawn-reset", pi as any, { model: { id: "model", provider: "provider" }, cwd: "/tmp" } as any,
		state, { prompt: "work" }, undefined, undefined, "medium", async () => factory,
	);
	resetState(state);
	resolveFactory({ session, extensionsResult: undefined as any });
	await assert.rejects(() => execution, /invalidated by reset/i);
	assert.equal(disposeCalls, 1);
});

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("resetState aborts a claimed child session after render ownership transfer", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	resetState(state);

	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("nested spawn drops events after resetState bumps child epoch", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	resetState(state);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "stale events should not request rerender after reset");
	assert.deepEqual(after, before, "stale events should not change rendered state after reset");
});

test("nested spawn drops events when session is replaced in live state", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	const replacementSession = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacementSession);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "replaced sessions should not request rerender");
	assert.deepEqual(after, before, "replaced sessions should not change rendered state");
});

test("nested spawn completed-session deletion stays stale even if the toolCallId is later reused", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const afterDeletion = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should immediately stale the old session");
	assert.deepEqual(afterDeletion, before, "completed-session deletion should freeze the rendered state before reuse");

	state.liveChildSessions.set("tool-call-1", createSubscribableSession([]).session);
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "should be dropped" }] } });
	const afterReuse = component.render(120);
	assert.equal(invalidateCalls, 0, "toolCallId reuse should not revive a completed stale session");
	assert.deepEqual(afterReuse, before, "toolCallId reuse should keep the old rendered state frozen");
	assert.ok(afterReuse.every((l: string) => !l.includes("should be dropped")), "toolCallId reuse should not admit stale text updates");
});

test("nested spawn drops late events after live registry deletion", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should stop rerenders from late events");
	assert.deepEqual(after, before, "completed-session deletion should freeze the rendered state");
});

test("nested spawn processes stale-state events without invalidating the parent", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	// Emit a message_start while the session is still fresh — triggers a render after flush
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "fresh-session event triggers invalidate");

	// Now mark the session stale
	state.liveChildSessions.delete("tool-call-1");

	// Subsequent events are dropped by handleEvent's isStaleSession check
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "stale-session events do not invalidate");

	// The optimistic event state was applied (message_start set thinking),
	// but stale-session updates are dropped — the component shows the last
	// known state before staleness, not a rolled-back version.
	const after = component.render(120);
	assert.ok(after.some((l: string) => l.includes("thinking")),
		"optimistic event state from when session was still fresh is visible");
	assert.ok(!after.some((l: string) => l.includes("stale")),
		"stale-session events are dropped");
});

test("nested spawn cancels a queued parent invalidate when the session becomes stale before flush", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	state.liveChildSessions.delete("tool-call-1");
	flushSpawnFrameScheduler();

	assert.equal(invalidateCalls, 0, "stale-before-flush sessions cancel queued parent invalidates");
	assert.deepEqual(component.render(120), before, "stale-before-flush sessions roll back optimistic event state");
});

test("nested spawn reattach resets render guard for the new session", async () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "first session event triggers invalidate after scheduler flush");

	// Reattach resets the render guard
	const second = createSubscribableSession([{ role: "assistant", content: [{ type: "text", text: "replacement" }] }]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component, invalidate: () => { invalidateCalls++; } }),
	) as any;

	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "replacement 2" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 2, "second session event triggers another invalidate after reattach");
	const lines = sameComponent.render(120);
	assert.ok(lines.some((l: string) => l.includes("replacement 2")));
});

test("nested spawn dispose then reattach streams new session events", async () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "first" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	component.dispose();

	// Attach a second session to the same toolCallId after dispose
	const second = createSubscribableSession([
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const reattached = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "second" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "session B output" }] } });
	flushSpawnFrameScheduler();

	const lines = reattached.render(120);
	assert.ok(lines.some((l: string) => l.includes("session B output")),
		"reattached component should render events from the new session");
	assert.equal(lines.some((l: string) => l.includes("first")), false,
		"reattached component should not show stale content from disposed session");
});