/**
 * External pager integration for the /notebook TUI.
 *
 * Resolves a pager command (respecting $PI_PAGER, then $PAGER, falling back to
 * `less` on POSIX) and runs it with the page body fed via stdin. Exports a
 * mutable `pagerRuntime` seam so tests can swap resolvePager/spawnPager
 * without shelling out.
 */

import { execSync, spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

export interface ResolvedPager {
	cmd: string;
	args: string[];
}

function defaultCommandExists(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * $PI_PAGER takes precedence over $PAGER, as $GIT_PAGER does in git, so a
 * pager can be chosen for Pi alone. This matters for bat < 0.22, which uses
 * $PAGER as its own pager and recurses forever on PAGER=batcat. Unlike git,
 * a blank value counts as unset and falls through; it never disables paging.
 *
 * The pager value may carry args (e.g. "less -R"). Whitespace-split matches git's
 * historical behavior; no shell quoting, and no `sh -c` (which would be
 * Windows-hostile). Users needing complex pager invocations should wrap
 * them in a script and point $PI_PAGER or $PAGER at it.
 */
export function resolvePager(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	commandExists: (cmd: string) => boolean = defaultCommandExists,
): ResolvedPager | undefined {
	const raw = env.PI_PAGER?.trim() || env.PAGER?.trim();
	if (raw) {
		const [cmd, ...args] = raw.split(/\s+/);
		if (cmd) {
			const executable = platform === "win32" ? win32.basename(cmd).toLowerCase().replace(/\.exe$/, "") : posix.basename(cmd);
			// Injected args go last, but before any end-of-options marker.
			const endOfOptions = args.indexOf("--");
			const at = endOfOptions === -1 ? args.length : endOfOptions;
			if (executable === "less") {
				// Override -F and -X (including inherited LESS) so short pages stay
				// readable until dismissed and page text doesn't linger in the
				// terminal's scrollback.
				args.splice(at, 0, "-+F", "-+X");
			} else if (executable === "bat" || executable === "batcat") {
				// bat's default --paging=auto runs less with -F, so short pages
				// would vanish immediately. The last --paging wins in bat. An
				// inherited LESS=-F still applies to bat's less; not overridden.
				args.splice(at, 0, "--paging=always");
			}
			return { cmd, args };
		}
	}
	// Skip probing on Windows: `command -v` isn't standard and less is
	// rarely present. Respect $PI_PAGER/$PAGER above, otherwise fall through.
	if (platform === "win32") return undefined;
	if (commandExists("less")) return { cmd: "less", args: ["-R", "-+F", "-+X"] };
	return undefined;
}

/**
 * Async spawn. Prefer `openInPager` from callers inside the TUI — it owns the
 * suspend/restore + SIGINT dance that `spawnPager` requires to be safe.
 *
 * stdin MUST be piped, not inherited: otherwise the pager swallows Pi's
 * buffered raw-mode escapes and the next overlay opens broken. `less` reads
 * its own keystrokes from /dev/tty when stdin is not a TTY, so navigation
 * still works.
 *
 * ENOENT becomes a readable error. EPIPE/EOF on the stdin pipe is normal (the
 * pager quit before consuming all stdin) and stays silent. Nonzero exit
 * codes are intentionally ignored — a pager's exit code shouldn't break the
 * caller's UX. On Windows (shell: true) a missing binary is just a cmd.exe
 * exit code, so it is ignored too, matching Pi's external editor.
 */
export function spawnPager(body: string, pager: ResolvedPager): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(pager.cmd, pager.args, {
			stdio: ["pipe", "inherit", "inherit"],
			shell: process.platform === "win32",
		});
		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") reject(new Error(`${pager.cmd} not found`));
			else reject(err);
		});
		child.on("close", () => resolve());
		// Windows (libuv) reports a closed read end as EOF rather than EPIPE.
		child.stdin?.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPIPE" && code !== "EOF") reject(err);
		});
		child.stdin?.end(body);
	});
}

/**
 * Run a pager under Pi's TUI. Caller passes the already-resolved pager.
 *
 * Suspends the parent TUI (releases alt screen + raw-mode stdin) before
 * spawning so `less`'s alt-screen restore returns to Pi's screen, not the
 * primary buffer, and keystrokes don't race between Pi's input listener and
 * the child. Mirrors the stop/spawn/start pattern used by upstream Pi for
 * external editors.
 *
 * Guards SIGINT across the whole stop→spawn→start window: `less` keeps ISIG
 * on, so Ctrl+C in the pager fires SIGINT to the whole foreground process
 * group. Pi has no persistent SIGINT handler, so without this guard a Ctrl+C
 * in less kills Pi before the TUI restore runs.
 *
 * Returns the error if `spawnPager` rejected (caller decides how to surface
 * it); returns undefined on success.
 */
export async function openInPager(
	tui: TUI,
	body: string,
	pager: ResolvedPager,
): Promise<Error | undefined> {
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);
	try {
		tui.stop();
		await pagerRuntime.spawnPager(body, pager);
		return undefined;
	} catch (err) {
		return err as Error;
	} finally {
		process.removeListener("SIGINT", ignoreSigint);
		tui.start();
		tui.requestRender(true);
	}
}

interface PagerRuntime {
	resolvePager: typeof resolvePager;
	spawnPager: typeof spawnPager;
}

const defaultPagerRuntime: PagerRuntime = { resolvePager, spawnPager };

/** Test seam: index.ts and openInPager call pagerRuntime.* so tests can swap per-test. */
export let pagerRuntime: PagerRuntime = defaultPagerRuntime;

/** Test seam: swap one or more pagerRuntime methods; pass null to restore the originals. */
export function __setPagerRuntimeForTests(next: Partial<PagerRuntime> | null): void {
	pagerRuntime = next ? { ...defaultPagerRuntime, ...next } : defaultPagerRuntime;
}
