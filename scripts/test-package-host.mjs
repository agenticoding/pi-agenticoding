import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRootFromScript, runChecked, runNpm } from "./compat-process.mjs";

const root = repoRootFromScript(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "pi-agenticoding-host-"));
let tarball;
try {
  const packJson = JSON.parse(runNpm(root, ["pack", "--json", "--ignore-scripts"], { capture: true }).stdout);
  tarball = join(root, packJson[0].filename);
  const host = join(temp, "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, "package.json"), `${JSON.stringify({
    name: "pi-agenticoding-package-host",
    private: true,
    type: "module",
    dependencies: {
      "@earendil-works/pi-ai": "0.81.0",
      "@earendil-works/pi-coding-agent": "0.81.0",
      "@earendil-works/pi-tui": "0.81.0",
      typebox: "1.1.38",
      "pi-agenticoding": `file:${tarball}`,
    },
  }, null, 2)}\n`);
  runNpm(host, ["install", "--ignore-scripts"]);
  const graph = JSON.parse(runNpm(host, ["ls", "--json", "pi-agenticoding",
    "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"], { capture: true }).stdout);
  const extension = graph.dependencies?.["pi-agenticoding"];
  if (!extension) throw new Error("Packed extension is missing from host graph");
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    const nested = join(host, "node_modules", "pi-agenticoding", "node_modules", ...name.split("/"), "package.json");
    if (existsSync(nested)) throw new Error(`Packed extension owns nested peer ${name}`);
  }

  writeFileSync(join(host, "smoke.mjs"), `
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
const extensionPath = join(process.cwd(), "node_modules", "pi-agenticoding", "index.ts");
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: join(process.cwd(), "agent"),
  additionalExtensionPaths: [extensionPath],
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
if (loaded.extensions.length !== 1) throw new Error("packed extension did not load");
`);
  runChecked(process.execPath, ["smoke.mjs"], { cwd: host });
  process.stdout.write("Packed Pi 0.81.0 host smoke passed with host-provided peers.\n");
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
