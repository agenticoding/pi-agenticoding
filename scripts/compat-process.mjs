import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the repository root from a script under ./scripts. */
export function repoRootFromScript(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

function formatInvocation(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(" ");
}

/** Run a subprocess and fail with launch/status/signal and captured-output context. */
export function runChecked(command, args, options = {}) {
  const { cwd, capture = false, env = process.env } = options;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.signal || result.status !== 0) {
    const diagnostics = [
      `invocation: ${formatInvocation(command, args)}`,
      `cwd: ${cwd ?? process.cwd()}`,
      `error.stack: ${result.error?.stack ?? "none"}`,
      `status: ${String(result.status)}`,
      `signal: ${String(result.signal)}`,
      `stdout:\n${result.stdout ?? ""}`,
      `stderr:\n${result.stderr ?? ""}`,
    ].join("\n");
    throw new Error(diagnostics);
  }
  return result;
}

/** Build a shell-free npm invocation, including Windows' npm.cmd installations. */
export function npmInvocation(args, options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    execPath = process.execPath,
  } = options;
  if (env.npm_execpath) {
    return { command: execPath, args: [env.npm_execpath, ...args] };
  }
  if (platform !== "win32") {
    return { command: "npm", args };
  }

  const npmCli = resolve(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCli)) {
    return { command: execPath, args: [npmCli, ...args] };
  }
  throw new Error(
    `Unable to locate npm CLI beside ${execPath}; invoke this compatibility check through its npm script.`,
  );
}

export function runNpm(cwd, args, options = {}) {
  const invocation = npmInvocation(args, options);
  return runChecked(invocation.command, invocation.args, { cwd, ...options });
}
