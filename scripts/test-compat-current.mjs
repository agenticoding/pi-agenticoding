import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSynchronizedPackageVersions } from "./dependency-graph-assertions.mjs";

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

function run(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "pi-agenticoding-current-"));
const copy = join(temp, "source");
try {
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => ![".git", "node_modules", "openspec"].includes(source.split(/[\\/]/).at(-1)),
  });
  rmSync(join(copy, "package-lock.json"), { force: true });
  const packagePath = join(copy, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.scripts.prepare = "";
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const typeboxResult = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent@latest", "dependencies.typebox", "--json"], {
    cwd: copy,
    encoding: "utf8",
  });
  if (typeboxResult.status !== 0) throw new Error(typeboxResult.stderr || typeboxResult.stdout);
  const currentPiTypebox = JSON.parse(typeboxResult.stdout);
  if (typeof currentPiTypebox !== "string" || currentPiTypebox.length === 0) {
    throw new Error("Current Pi coding-agent did not declare a TypeBox dependency");
  }

  run(copy, "npm", ["install", "--ignore-scripts", "--save-dev", "--save-exact",
    "@earendil-works/pi-ai@latest",
    "@earendil-works/pi-coding-agent@latest",
    "@earendil-works/pi-tui@latest",
    `typebox@${currentPiTypebox}`,
  ]);
  const graphResult = spawnSync("npm", ["ls", "--all", "--json"], { cwd: copy, encoding: "utf8" });
  if (graphResult.status !== 0) throw new Error(graphResult.stderr || graphResult.stdout);
  const graph = JSON.parse(graphResult.stdout);
  const piVersion = assertSynchronizedPackageVersions(graph, PI_PACKAGES);
  assertSynchronizedPackageVersions(graph, ["typebox"]);

  run(copy, "npm", ["run", "typecheck"]);
  run(copy, process.execPath, ["./scripts/run-node-test.mjs",
    "tests/unit/spawn-runtime-compatibility.test.ts",
    "tests/unit/spawn-lifecycle.test.ts",
    "tests/unit/spawn-event.test.ts",
    "tests/unit/dependency-graph-assertions.test.ts",
    "tests/unit/spawn.test.ts",
    "tests/unit/readonly-spawn.test.ts",
  ]);
  run(copy, "npm", ["run", "test:e2e"]);
  process.stdout.write(`Current synchronized Pi compatibility passed at ${piVersion}.\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
