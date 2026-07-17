import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertExactPackageVersions } from "./dependency-graph-assertions.mjs";

const expected = {
  "@earendil-works/pi-agent-core": "0.80.8",
  "@earendil-works/pi-ai": "0.80.8",
  "@earendil-works/pi-coding-agent": "0.80.8",
  "@earendil-works/pi-tui": "0.80.8",
  typebox: "1.1.38",
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (packageJson.engines?.node !== ">=22.19.0") throw new Error("Node floor must be >=22.19.0");
const graphResult = spawnSync("npm", ["ls", "--all", "--json"], { encoding: "utf8" });
if (graphResult.status !== 0) throw new Error(graphResult.stderr || graphResult.stdout);
assertExactPackageVersions(JSON.parse(graphResult.stdout), expected);

run("npm", ["run", "typecheck"]);
run(process.execPath, ["./scripts/run-node-test.mjs",
  "tests/unit/spawn-runtime-compatibility.test.ts",
  "tests/unit/spawn-lifecycle.test.ts",
  "tests/unit/spawn-event.test.ts",
  "tests/unit/dependency-graph-assertions.test.ts",
  "tests/unit/spawn-render.test.ts",
  "tests/unit/spawn.test.ts",
  "tests/unit/readonly-spawn.test.ts",
  "tests/unit/config-invariants.test.ts",
]);
run("npm", ["run", "test:e2e"]);
process.stdout.write("Exact Pi 0.80.8 compatibility floor passed.\n");
