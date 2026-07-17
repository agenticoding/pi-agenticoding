import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const {
	assertExactPackageVersions,
	assertSynchronizedPackageVersions,
} = await import(new URL("../../scripts/dependency-graph-assertions.mjs", import.meta.url).href);

const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

test("floor and current compatibility lanes include installed pi-agent-core", () => {
	for (const script of ["test-compat-floor.mjs", "test-compat-current.mjs"]) {
		const source = readFileSync(new URL(`../../scripts/${script}`, import.meta.url), "utf8");
		assert.match(source, /["']@earendil-works\/pi-agent-core["']/i, `${script} must guard pi-agent-core`);
	}
});

function dependency(version: string, dependencies = {}): object {
	return { version, dependencies };
}

function graph(piVersion = "0.80.8", typeboxVersion = "1.1.38"): object {
	return {
		name: "synthetic-install",
		version: "1.0.0",
		dependencies: {
			"@earendil-works/pi-ai": dependency(piVersion, {
				typebox: dependency(typeboxVersion),
			}),
			"@earendil-works/pi-coding-agent": dependency(piVersion, {
				"@earendil-works/pi-agent-core": dependency(piVersion),
				"@earendil-works/pi-ai": dependency(piVersion, {
					typebox: dependency(typeboxVersion),
				}),
				"@earendil-works/pi-tui": dependency(piVersion),
			}),
			"@earendil-works/pi-tui": dependency(piVersion),
			typebox: dependency(typeboxVersion),
		},
	};
}

test("exact floor accepts a coherent recursive dependency graph", () => {
	assert.doesNotThrow(() => assertExactPackageVersions(graph(), {
		"@earendil-works/pi-agent-core": "0.80.8",
		"@earendil-works/pi-ai": "0.80.8",
		"@earendil-works/pi-coding-agent": "0.80.8",
		"@earendil-works/pi-tui": "0.80.8",
		typebox: "1.1.38",
	}));
});

test("exact floor rejects mixed nested Pi and TypeBox versions", () => {
	const mixedCore = graph() as any;
	mixedCore.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-agent-core"].version = "0.81.0";
	assert.throws(
		() => assertExactPackageVersions(mixedCore, { "@earendil-works/pi-agent-core": "0.80.8" }),
		/@earendil-works\/pi-agent-core@0\.80\.8.*0\.81\.0/,
	);

	const mixedPi = graph() as any;
	mixedPi.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-ai"].version = "0.81.0";
	assert.throws(
		() => assertExactPackageVersions(mixedPi, { "@earendil-works/pi-ai": "0.80.8" }),
		/@earendil-works\/pi-ai@0\.80\.8.*0\.81\.0/,
	);

	const mixedTypebox = graph() as any;
	mixedTypebox.dependencies["@earendil-works/pi-ai"].dependencies.typebox.version = "1.2.0";
	assert.throws(
		() => assertExactPackageVersions(mixedTypebox, { typebox: "1.1.38" }),
		/typebox@1\.1\.38.*1\.2\.0/,
	);
});

test("current assertions accept recursively synchronized Pi and TypeBox versions", () => {
	const current = graph("0.99.0", "2.0.0");
	assert.equal(assertSynchronizedPackageVersions(current, PI_PACKAGES), "0.99.0");
	assert.equal(assertSynchronizedPackageVersions(current, ["typebox"]), "2.0.0");
});

test("current assertions reject mixed nested Pi and TypeBox versions", () => {
	const mixedCore = graph("0.99.0", "2.0.0") as any;
	mixedCore.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-agent-core"].version = "0.98.0";
	assert.throws(
		() => assertSynchronizedPackageVersions(mixedCore, PI_PACKAGES),
		/synchronized.*0\.98\.0.*0\.99\.0/i,
	);

	const mixedPi = graph("0.99.0", "2.0.0") as any;
	mixedPi.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-tui"].version = "0.98.0";
	assert.throws(
		() => assertSynchronizedPackageVersions(mixedPi, PI_PACKAGES),
		/synchronized.*0\.98\.0.*0\.99\.0/i,
	);

	const mixedTypebox = graph("0.99.0", "2.0.0") as any;
	mixedTypebox.dependencies["@earendil-works/pi-ai"].dependencies.typebox.version = "1.9.0";
	assert.throws(
		() => assertSynchronizedPackageVersions(mixedTypebox, ["typebox"]),
		/synchronized.*1\.9\.0.*2\.0\.0/i,
	);
});
