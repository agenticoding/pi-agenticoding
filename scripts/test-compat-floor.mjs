import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRootFromScript, runChecked, runNpm } from "./compat-process.mjs";
import { assertExactPackageVersions } from "./dependency-graph-assertions.mjs";

const expected = {
  "@earendil-works/pi-agent-core": "0.81.0",
  "@earendil-works/pi-ai": "0.81.0",
  "@earendil-works/pi-coding-agent": "0.81.0",
  "@earendil-works/pi-tui": "0.81.0",
  typebox: "1.1.38",
};

const root = repoRootFromScript(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.engines?.node !== ">=22.19.0") throw new Error("Node floor must be >=22.19.0");
const graphResult = runNpm(root, ["ls", "--all", "--json"], { capture: true });
assertExactPackageVersions(JSON.parse(graphResult.stdout), expected);

runNpm(root, ["run", "typecheck"]);
runChecked(process.execPath, [join(root, "scripts", "run-node-test.mjs"),
  "tests/unit/spawn-runtime-compatibility.test.ts",
  "tests/unit/spawn-lifecycle.test.ts",
  "tests/unit/spawn-event.test.ts",
  "tests/unit/dependency-graph-assertions.test.ts",
  "tests/unit/spawn-render.test.ts",
  "tests/unit/spawn.test.ts",
  "tests/unit/readonly-spawn.test.ts",
  "tests/unit/config-invariants.test.ts",
  "tests/unit/compat-process.test.ts",
], { cwd: root });
runNpm(root, ["run", "test:e2e"]);
process.stdout.write("Exact Pi 0.81.0 compatibility floor passed.\n");
