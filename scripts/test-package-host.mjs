import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cwd, command, args, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "pi-agenticoding-host-"));
let tarball;
try {
  const packJson = JSON.parse(run(root, "npm", ["pack", "--json", "--ignore-scripts"], true));
  tarball = join(root, packJson[0].filename);
  const host = join(temp, "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, "package.json"), `${JSON.stringify({
    name: "pi-agenticoding-package-host",
    private: true,
    type: "module",
    dependencies: {
      "@earendil-works/pi-ai": "0.80.8",
      "@earendil-works/pi-coding-agent": "0.80.8",
      "@earendil-works/pi-tui": "0.80.8",
      typebox: "1.1.38",
      "pi-agenticoding": `file:${tarball}`,
    },
  }, null, 2)}\n`);
  run(host, "npm", ["install", "--ignore-scripts"]);
  const graph = JSON.parse(run(host, "npm", ["ls", "--json", "pi-agenticoding",
    "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"], true));
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
  run(host, process.execPath, ["smoke.mjs"]);
  process.stdout.write("Packed Pi 0.80.8 host smoke passed with host-provided peers.\n");
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
