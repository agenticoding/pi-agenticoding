import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Walk up from a start directory to find node_modules/<name>.
 * Works regardless of how the package was installed (local vs global).
 */
function findPackageRoot(name, startDir, maxDepth = 50) {
	let dir = startDir;
	let depth = 0;
	while (true) {
		if (depth > maxDepth) return null;
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		depth++;
	}
}

const PACKAGE_ROOT = findPackageRoot(
	"@earendil-works/pi-coding-agent",
	path.dirname(fileURLToPath(import.meta.url)),
);
if (!PACKAGE_ROOT) throw new Error("Cannot find @earendil-works/pi-coding-agent package root");
const PACKAGE_ALIASES = {
	"@earendil-works/pi-coding-agent": `${PACKAGE_ROOT}/dist/index.js`,
	"@earendil-works/pi-ai": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"@earendil-works/pi-tui": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-agent-core": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
	typebox: `${PACKAGE_ROOT}/node_modules/typebox/build/index.mjs`,
};

export async function resolve(specifier, context, defaultResolve) {
	const packagePath = PACKAGE_ALIASES[specifier];
	if (packagePath) {
		return defaultResolve(pathToFileURL(packagePath).href, context, defaultResolve);
	}

	if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
		const parentPath = fileURLToPath(context.parentURL);
		const tsPath = path.resolve(path.dirname(parentPath), specifier.slice(0, -3) + ".ts");
		try {
			await access(tsPath);
			return defaultResolve(pathToFileURL(tsPath).href, context, defaultResolve);
		} catch {
			// fall through
		}
	}

	return defaultResolve(specifier, context, defaultResolve);
}
