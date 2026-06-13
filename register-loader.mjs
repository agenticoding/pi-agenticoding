// Bootstrap module for `--import` that registers the custom module loader.
// Replaces the deprecated `--experimental-loader` flag.
// Phase 1: uses module.register() — available on Node >=22.
// Phase 2: migrate to module.registerHooks() when targeting Node >=25.
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolve(HERE, "test-loader.mjs")), pathToFileURL(HERE + "/"));
