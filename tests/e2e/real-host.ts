/**
 * real-host.ts — Harness that runs pi-schematic inside the real pi CLI in RPC
 * mode, driven through `RpcClient`, with the scripted probe provider from
 * `real-host-probe.ts`.
 *
 * Every helper that starts a run or navigates the tree returns only once the
 * session is idle with no message pending (see `/e2e-barrier`), so tests never
 * issue a non-command prompt while a run or compaction is active.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { RpcClient, SessionManager, type RpcClientOptions, type SessionEntry } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMATIC_ENTRY = resolve(HERE, "..", "..", "index.ts");
const PROBE_ENTRY = resolve(HERE, "real-host-probe.ts");
const CLI_PATH = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const REQUIRED_COMMANDS = ["handoff", "notebook", "readonly", "e2e-barrier"];

function readTimeout(): number {
	const raw = process.env.E2E_REAL_HOST_TIMEOUT_MS;
	if (raw === undefined) return 20_000;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`E2E_REAL_HOST_TIMEOUT_MS must be a positive integer, got: ${raw}`);
	}
	return value;
}

export const REAL_HOST_TIMEOUT_MS = readTimeout();

/** Same expressions as tests/unit/helpers.ts; this harness imports nothing from tests/unit/. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export type RpcEvent = { type: string; [key: string]: unknown };
export type ScriptedCall = { name: string; arguments: Record<string, unknown> };
export type ProbeRecord =
	| { kind: "request"; step: number; calls: ScriptedCall[] | null; texts: string[] }
	| { kind: "compact"; entryId: string }
	| { kind: "successor-send"; text: string; dropped: boolean }
	| { kind: "tools"; names: string[] };
export type Notification = { message: string; notifyType: string | undefined };
export type Status = { statusKey: string; statusText: string | undefined };
export type ToolResult = { isError: boolean; text: string };

export interface RealHostOptions {
	seedSession?: (session: SessionManager) => void;
}

function pathEnv(): Record<string, string> {
	const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
	if (!key) throw new Error("No PATH variable in the test environment");
	const current = process.env[key];
	return { [key]: current ? `${dirname(process.execPath)}${delimiter}${current}` : dirname(process.execPath) };
}

function requireString(event: RpcEvent, field: string): string {
	const value = event[field];
	if (typeof value !== "string") throw new Error(`${event.type} field ${field} is not a string: ${JSON.stringify(event)}`);
	return value;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run `body`; when it throws, run `cleanup` and rethrow the body's error. A cleanup
 * error never hides it: both are thrown together as an AggregateError.
 */
async function cleanupOnFailure<T>(body: () => Promise<T>, cleanup: () => unknown): Promise<T> {
	try {
		return await body();
	} catch (failure) {
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError(
				[failure, cleanupError],
				`${describeError(failure)}; cleanup also failed: ${describeError(cleanupError)}`,
			);
		}
		throw failure;
	}
}

/** Run `body`, then `cleanup` whether or not it threw; see `cleanupOnFailure`. */
async function withCleanup<T>(body: () => Promise<T>, cleanup: () => unknown): Promise<T> {
	const result = await cleanupOnFailure(body, cleanup);
	await cleanup();
	return result;
}

/** Project `extension_ui_request` setStatus events; a cleared status has `statusText` undefined. */
export function projectStatuses(events: RpcEvent[]): Status[] {
	return events
		.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus")
		.map((event) => ({
			statusKey: requireString(event, "statusKey"),
			statusText: event.statusText === undefined ? undefined : stripAnsi(requireString(event, "statusText")),
		}));
}

/** Text of a message's content: string content as is, text blocks joined by newlines. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new Error(`Unexpected message content: ${JSON.stringify(content)}`);
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Tool results named `name` in an `entries()` snapshot, in session order. */
export function toolResults(entries: SessionEntry[], name: string): ToolResult[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== name) return [];
		return [{ isError: entry.message.isError, text: messageText(entry.message.content) }];
	});
}

export class RealHost {
	client: RpcClient;
	events: RpcEvent[];
	readonly projectDir: string;
	private readonly root: string;
	private readonly logPath: string;
	private options: RpcClientOptions;
	private closing: Promise<void> | null = null;

	private constructor(root: string, logPath: string, options: RpcClientOptions, client: RpcClient, events: RpcEvent[]) {
		this.root = root;
		this.logPath = logPath;
		this.projectDir = join(root, "project");
		this.options = options;
		this.client = client;
		this.events = events;
	}

	static async start(options: RealHostOptions = {}): Promise<RealHost> {
		if (!existsSync(CLI_PATH)) throw new Error(`pi CLI not found at ${CLI_PATH}`);
		const root = mkdtempSync(join(os.tmpdir(), "pi-schematic-e2e-"));
		return cleanupOnFailure(async () => {
			const agentDir = join(root, "agent");
			const homeDir = join(root, "home");
			const projectDir = join(root, "project");
			const sessionsDir = join(root, "sessions");
			const logPath = join(root, "probe.jsonl");
			for (const dir of [agentDir, homeDir, projectDir, sessionsDir]) mkdirSync(dir);
			writeFileSync(logPath, "");
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
				compaction: { enabled: false, keepRecentTokens: 1 },
				retry: { enabled: false },
			}));
			const args = [
				"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
				"--no-context-files", "--no-approve", "--offline",
				"--session-dir", sessionsDir,
				"-e", SCHEMATIC_ENTRY,
				"-e", PROBE_ENTRY,
			];
			if (options.seedSession) {
				const session = SessionManager.create(projectDir, sessionsDir);
				options.seedSession(session);
				const sessionFile = session.getSessionFile();
				if (!sessionFile || !existsSync(sessionFile)) {
					throw new Error(`Seeded session file was not written (${sessionFile}); the seed must append a user or assistant message`);
				}
				args.push("--session", sessionFile);
			}
			const clientOptions: RpcClientOptions = {
				cliPath: CLI_PATH,
				cwd: projectDir,
				provider: "schematic-e2e",
				model: "schematic-e2e-model",
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					HOME: homeDir,
					USERPROFILE: homeDir,
					PI_SCHEMATIC_E2E_PROBE_LOG: logPath,
					FORCE_COLOR: "0",
					NODE_OPTIONS: "",
					...pathEnv(),
				},
				args,
			};
			const { client, events } = await startClient(clientOptions);
			return new RealHost(root, logPath, clientOptions, client, events);
		}, () => removeRoot(root));
	}

	get notifications(): Notification[] {
		return this.events
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => ({
				message: requireString(event, "message"),
				notifyType: event.notifyType === undefined ? undefined : requireString(event, "notifyType"),
			}));
	}

	get statuses(): Status[] {
		return projectStatuses(this.events);
	}

	/** Run an extension command; it must report "handled" without an extension_error, from the command or from any handler it triggers. */
	async command(text: string): Promise<void> {
		if (!text.startsWith("/")) throw new Error(`command() needs a slash command, got: ${text}`);
		const mark = this.events.length;
		const disposition = await this.client.prompt(text);
		if (disposition !== "handled") throw new Error(`${text} reported "${disposition}", expected "handled"`);
		const spaceIndex = text.indexOf(" ");
		const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		this.assertNoExtensionErrors(mark, text, `command:${name}`);
	}

	/** Submit a user prompt on an idle session and wait until its run and everything it left behind drained. */
	async say(text: string): Promise<void> {
		const mark = this.events.length;
		const disposition = await this.client.prompt(text);
		if (disposition !== "started") throw new Error(`"${text}" reported "${disposition}", expected "started"`);
		await this.runWait(mark, `"${text}"`);
	}

	/** Run a command whose handler starts a run on an idle session, then wait for that run to drain. */
	async turn(text: string): Promise<void> {
		const mark = this.events.length;
		await this.command(text);
		await this.runWait(mark, text);
	}

	async arm(calls: ScriptedCall[]): Promise<void> {
		await this.command("/e2e-script " + JSON.stringify(calls));
	}

	async script(calls: ScriptedCall[]): Promise<void> {
		await this.arm(calls);
		await this.say("go");
	}

	async settle(): Promise<void> {
		await this.command("/e2e-barrier");
	}

	async entries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		return this.client.getEntries();
	}

	probeLog(): ProbeRecord[] {
		return readFileSync(this.logPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as ProbeRecord);
	}

	successorSends(): Array<Extract<ProbeRecord, { kind: "successor-send" }>> {
		return this.probeLog().filter((record): record is Extract<ProbeRecord, { kind: "successor-send" }> => record.kind === "successor-send");
	}

	async navigate(entryId: string): Promise<void> {
		await this.command("/e2e-tree " + entryId);
		await this.settle();
	}

	/** Stop the CLI and start a new one on the same session file, temp root and probe log. */
	async restart(): Promise<void> {
		const { sessionFile } = await this.client.getState();
		if (!sessionFile || !existsSync(sessionFile)) {
			throw new Error(`restart() needs a session file on disk (${sessionFile}); pi writes it only after a user or assistant message`);
		}
		await this.client.stop();
		const args = [...(this.options.args ?? [])];
		const sessionIndex = args.indexOf("--session");
		if (sessionIndex !== -1) args.splice(sessionIndex, 2);
		args.push("--session", sessionFile);
		this.options = { ...this.options, args };
		// A timed-out test body keeps running after its after-hook closed the host; whatever the
		// new CLI wrote into the removed root, and the CLI itself when it started, is cleared here.
		const { client, events } = await cleanupOnFailure(() => startClient(this.options), () => {
			if (this.closing) removeRoot(this.root);
		});
		if (this.closing) {
			await withCleanup(() => client.stop(), () => removeRoot(this.root));
			throw new Error("restart() finished after close(); the new CLI was stopped");
		}
		this.client = client;
		this.events = events;
	}

	/** Stop the CLI and remove the temp root. Runs once: every call returns the first call's outcome. */
	close(): Promise<void> {
		this.closing ??= withCleanup(() => this.client.stop(), () => removeRoot(this.root));
		return this.closing;
	}

	/**
	 * Throw when any extension_error event, from a command or an event handler, arrived at or
	 * after `mark`. An error from extension path `commandPath` is reported as the command's own failure.
	 */
	private assertNoExtensionErrors(mark: number, action: string, commandPath?: string): void {
		const failures = this.events.slice(mark).filter((event) => event.type === "extension_error");
		const own = commandPath === undefined ? undefined : failures.find((event) => event.extensionPath === commandPath);
		if (own) throw new Error(`${action} failed: ${requireString(own, "error")}`);
		const failure = failures[0];
		if (!failure) return;
		throw new Error(
			`${action} raised an extension error in ${requireString(failure, "extensionPath")} ` +
			`(event ${requireString(failure, "event")}): ${requireString(failure, "error")}`,
		);
	}

	/** Wait for an agent_settled event at or after `mark`, drain with settle(), then require no extension_error since `mark`. */
	private async runWait(mark: number, action: string): Promise<void> {
		const events = this.events;
		const settled = () => events.slice(mark).some((event) => event.type === "agent_settled");
		if (!settled()) {
			await new Promise<void>((resolveWait, rejectWait) => {
				const timer = setTimeout(() => {
					unsubscribe();
					rejectWait(new Error(`Timed out after ${REAL_HOST_TIMEOUT_MS} ms waiting for agent_settled. Stderr: ${this.client.getStderr()}`));
				}, REAL_HOST_TIMEOUT_MS);
				const unsubscribe = this.client.onEvent(() => {
					if (!settled()) return;
					clearTimeout(timer);
					unsubscribe();
					resolveWait();
				});
			});
		}
		await this.settle();
		this.assertNoExtensionErrors(mark, action);
	}
}

async function startClient(options: RpcClientOptions): Promise<{ client: RpcClient; events: RpcEvent[] }> {
	const client = new RpcClient(options);
	const events: RpcEvent[] = [];
	client.onEvent((event) => {
		events.push(event as unknown as RpcEvent);
	});
	await cleanupOnFailure(async () => {
		await client.start();
		const commands = await client.getCommands();
		const names = new Set(commands.filter((command) => command.source === "extension").map((command) => command.name));
		const missing = REQUIRED_COMMANDS.filter((name) => !names.has(name));
		if (missing.length > 0) {
			throw new Error(`pi started without extension commands ${missing.join(", ")}. Stderr: ${client.getStderr()}`);
		}
	}, () => client.stop());
	return { client, events };
}

function removeRoot(root: string): void {
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function startRealHost(options?: RealHostOptions): Promise<RealHost> {
	return RealHost.start(options);
}

/**
 * Start a host and run `run` against it, then close it. The close also hangs off an after-hook
 * on `t`: node:test does not cancel a timed-out test body, so only a hook still runs then.
 * `close()` runs once however many of these paths reach it. The inline close keeps a cleanup
 * error visible next to a body failure; node:test ignores an after-hook error once the test
 * has failed (timeout included), so the hook also records it as a diagnostic.
 */
export async function withRealHost(t: TestContext, run: (host: RealHost) => Promise<void>, options?: RealHostOptions): Promise<void> {
	const host = await startRealHost(options);
	t.after(() => host.close().catch((error: unknown) => {
		t.diagnostic(`cleanup failed: ${describeError(error)}`);
		throw error;
	}));
	await withCleanup(() => run(host), () => host.close());
}
