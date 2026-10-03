import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { createClock } from "../../time/clock.js";
import { CLOCK_ENTRY_TYPE, reconstructClock, resolveCutAnchor } from "../../time/store.js";
import { registerTimeAwareness } from "../../time/register.js";
import { createDeferred } from "./helpers.js";

const usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The offline provider and tools drive the installed agent loop, never dispatch events. */
class TimeHost {
	now = 0;
	state = createState();
	session!: AgentSession;
	manager!: SessionManager;
	started = createDeferred();
	earlyResult = createDeferred();
	starts = 0;
	requests = 0;
	completions: string[] = [];
	errors: unknown[] = [];
	settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	readonly root: string;
	readonly early: string;

	constructor(root: string, early: string) {
		this.root = root;
		this.early = early;
		this.state.clock = createClock(0);
	}

	async open(manager = SessionManager.create(this.root, join(this.root, "sessions"))): Promise<void> {
		this.manager = manager;
		const resourceLoader = await this.loader();
		const { session } = await createAgentSession({
			cwd: this.root, agentDir: join(this.root, "agent"), resourceLoader,
			settingsManager: this.settings, sessionManager: manager, model: this.model(),
			tools: ["time_probe"], thinkingLevel: "off",
		});
		this.session = session;
		await session.bindExtensions({ onError: (error) => { this.errors.push(error); } });
	}

	async loader(): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd: this.root, agentDir: join(this.root, "agent"), settingsManager: this.settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Run the deterministic time tools.", extensionFactories: [(pi) => this.register(pi)],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		return loader;
	}

	model() {
		return {
			id: "time-host", name: "Offline time host", api: "time-host-api", provider: "time-host",
			baseUrl: "http://localhost.invalid", reasoning: false, input: ["text" as const],
			cost: usage.cost, contextWindow: 128000, maxTokens: 1024,
		};
	}

	register(pi: ExtensionAPI): void {
		registerTimeAwareness(pi, this.state, () => this.now);
		pi.on("session_start", (_event, ctx) => {
			reconstructClock(this.state.clock, ctx.sessionManager.getBranch(), this.now);
		});
		pi.on("message_start", (event) => {
			if (event.message.role === "assistant" && this.requests === 2) this.now = 6000;
		});
		pi.on("tool_result", (event) => {
			this.completions.push(event.toolCallId);
			if (event.toolCallId === this.early) this.earlyResult.resolve();
		});
		this.registerOperations(pi);
	}

	registerOperations(pi: ExtensionAPI): void {
		this.registerProvider(pi);
		pi.registerTool({
			name: "time_probe", label: "Time probe", description: "Complete at an injected clock boundary.",
			parameters: Type.Object({}), execute: (id) => this.execute(id),
		});
	}

	registerProvider(pi: ExtensionAPI): void {
		pi.registerProvider("time-host", {
			api: "time-host-api", apiKey: "offline-test", baseUrl: "http://localhost.invalid",
			models: [this.model()], streamSimple: (model) => {
				const stream = createAssistantMessageEventStream();
				const message = this.response(model);
				queueMicrotask(() => {
					stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
					stream.end();
				});
				return stream;
			},
		});
	}

	response(model: { api: string; provider: string; id: string }): AssistantMessage {
		this.requests++;
		const ids = this.requests === 1 ? ["first", "second"] : this.requests === 3 ? ["carry"] : [];
		return {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			usage, timestamp: this.now, stopReason: ids.length ? "toolUse" : "stop",
			content: ids.length ? ids.map((id) => ({ type: "toolCall", id, name: "time_probe", arguments: {} }))
				: [{ type: "text", text: "done" }],
		};
	}

	async execute(id: string) {
		if (id === "carry") this.now += 2000;
		else {
			if (++this.starts === 2) this.started.resolve();
			await this.started.promise;
			if (id !== this.early) await this.earlyResult.promise;
			this.now = id === this.early ? 1000 : 5000;
		}
		return { content: [{ type: "text" as const, text: id }], details: undefined };
	}

	reopen(): Promise<void> {
		const file = this.manager.getSessionFile();
		assert.ok(file);
		const leaf = this.manager.getLeafId();
		assert.ok(leaf);
		this.session.dispose();
		const reopened = SessionManager.open(file);
		// Session files store the tree; callers select the desired branch on reload.
		reopened.branch(leaf);
		return this.open(reopened);
	}
}

function results(entries: SessionEntry[]) {
	return entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
}

function footer(entry: SessionEntry): string {
	assert.equal(entry.type, "message");
	if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected tool result");
	const block = entry.message.content.at(-1);
	assert.equal(block?.type, "text");
	if (block?.type !== "text") throw new Error("Expected footer text");
	return block.text;
}

function assertRestored(host: TimeHost, expected: number): void {
	assert.equal(host.state.clock.elapsedMs, expected);
	assert.equal(resolveCutAnchor(host.state.clock, host.manager.getBranch(), null, host.now).elapsed, expected);
}

function assertBatch(host: TimeHost): void {
	const branch = host.manager.getBranch();
	const retained = results(branch);
	assert.equal(retained.length, 2);
	assert.deepEqual(host.completions, [host.early, host.early === "first" ? "second" : "first"]);
	for (const [index, id] of ["first", "second"].entries()) {
		const elapsed = id === host.early ? 1000 : 5000;
		assert.equal(footer(retained[index]), `[time_probe +${elapsed / 1000}.0s | task ${elapsed / 1000}.0s]`);
		const reading = branch.find((entry) => entry.type === "custom" && entry.customType === CLOCK_ENTRY_TYPE
			&& (entry.data as { toolCallId?: string }).toolCallId === id);
		assert.ok(reading && branch.indexOf(reading) < branch.indexOf(retained[0]));
		assert.deepEqual(reading.type === "custom" && reading.data, { version: 1, l: elapsed, toolCallId: id });
	}
}

function assertFinalBoundary(manager: SessionManager): void {
	const clocks = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CLOCK_ENTRY_TYPE);
	const final = clocks.at(-1);
	assert.ok(final?.type === "custom");
	assert.deepEqual(final.data, { version: 1, l: 6000 });
	const assistant = manager.buildSessionProjection().messages.at(-1);
	assert.equal(assistant?.role, "assistant");
	assert.deepEqual(assistant?.content, [{ type: "text", text: "done" }]);
}

async function assertFirstRetained(host: TimeHost): Promise<void> {
	const first = results(host.manager.getBranch())[0];
	host.manager.branch(first.id);
	await host.reopen();
	const expected = host.early === "first" ? 1000 : 5000;
	assertRestored(host, expected);
	assert.equal(results(host.manager.getBranch()).length, 1);
	assertProjection(host.manager, first);
}

function assertProjection(manager: SessionManager, first: SessionEntry): void {
	const projected = manager.buildSessionProjection();
	assert.equal(projected.messages.filter((message) => message.role === "toolResult").length, 1);
	const source = projected.entries.find((entry) => entry.sourceEntry.id === first.id);
	assert.ok(source);
	assert.equal(footer(source.sourceEntry), footer(first));
	assert.equal(source.sourceEntry.type, "message");
	if (source.sourceEntry.type !== "message") throw new Error("Expected persisted result source");
	assert.deepEqual(source.messages, [source.sourceEntry.message]);
}

async function assertFullCarry(host: TimeHost, leaf: string): Promise<void> {
	host.manager.branch(leaf);
	await host.reopen();
	assertRestored(host, 6000);
	assert.equal(resolveCutAnchor(host.state.clock, host.manager.getBranch(), null, host.now).anchor, "[task elapsed 6.0s]");
	await host.session.prompt("Continue with carried time");
	assert.equal(footer(results(host.manager.getBranch()).at(-1)!), "[time_probe +2.0s | task 8.0s]");
	await host.reopen();
	assertRestored(host, 8000);
	assert.deepEqual(host.errors, []);
}

async function withOfflineHost(early: string, run: (host: TimeHost) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-time-host-"));
	const host = new TimeHost(root, early);
	const offline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	try {
		await host.open();
		await run(host);
	} finally {
		host.session?.dispose();
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
		await rm(root, { recursive: true, force: true });
	}
}

for (const early of ["first", "second"]) {
	test(`installed offline host restores parallel result position when ${early} finishes first`, { timeout: 10_000 }, async () => {
		await withOfflineHost(early, async (host) => {
			await host.session.prompt("Run the parallel batch");
			assertBatch(host);
			assertFinalBoundary(host.manager);
			const leaf = host.manager.getLeafId();
			assert.ok(leaf);
			await assertFirstRetained(host);
			await assertFullCarry(host, leaf);
		});
	});
}
