import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRootFromScript, runChecked, runNpm } from "./compat-process.mjs";
import { assertSynchronizedPackageVersions } from "./dependency-graph-assertions.mjs";

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const root = repoRootFromScript(import.meta.url);
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

  const typeboxResult = runNpm(copy, [
    "view", "@earendil-works/pi-coding-agent@latest", "dependencies.typebox", "--json",
  ], { capture: true });
  const currentPiTypebox = JSON.parse(typeboxResult.stdout);
  if (typeof currentPiTypebox !== "string" || currentPiTypebox.length === 0) {
    throw new Error("Current Pi coding-agent did not declare a TypeBox dependency");
  }

  runNpm(copy, ["install", "--ignore-scripts", "--save-dev", "--save-exact",
    "@earendil-works/pi-ai@latest",
    "@earendil-works/pi-coding-agent@latest",
    "@earendil-works/pi-tui@latest",
    `typebox@${currentPiTypebox}`,
  ]);
  const graphResult = runNpm(copy, ["ls", "--all", "--json"], { capture: true });
  const graph = JSON.parse(graphResult.stdout);
  const piVersion = assertSynchronizedPackageVersions(graph, PI_PACKAGES);
  assertSynchronizedPackageVersions(graph, ["typebox"]);

  runNpm(copy, ["run", "typecheck"]);
  runChecked(process.execPath, ["./scripts/run-node-test.mjs",
    "tests/unit/spawn-runtime-compatibility.test.ts",
    "tests/unit/spawn-lifecycle.test.ts",
    "tests/unit/spawn-event.test.ts",
    "tests/unit/spawn-render.test.ts",
    "tests/unit/dependency-graph-assertions.test.ts",
    "tests/unit/spawn.test.ts",
    "tests/unit/readonly-spawn.test.ts",
    "tests/unit/compat-process.test.ts",
  ], { cwd: copy });
  runNpm(copy, ["run", "test:e2e"]);
  process.stdout.write(`Current synchronized Pi compatibility passed at ${piVersion}.\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
