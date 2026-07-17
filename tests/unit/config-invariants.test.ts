/**
 * Invariant tests for the audit-ci security audit configuration.
 *
 * Validates that allowlist entries have unexpired expiry dates, that the
 * CI workflow ordering (audit → unit → e2e) is preserved, and that the
 * allowlist matches the current lockfile's actual vulnerability state.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

type AuditRecord = {
	active: boolean;
	expiry: string;
	notes: string;
};

type AuditConfig = {
	$schema: string;
	moderate: boolean;
	allowlist: Array<Record<string, AuditRecord>>;
};

type PackageJson = {
	engines: { node: string };
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};

const AUDIT_SCHEMA = "https://github.com/IBM/audit-ci/raw/main/docs/schema.json";
const REPO_ROOT_URL = new URL("../../", import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const AUDIT_CLI_PATH = fileURLToPath(
	new URL("node_modules/audit-ci/dist/bin.js", REPO_ROOT_URL),
);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const WORKFLOW_PATH = new URL(".github/workflows/test.yml", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const SPAWN_SOURCE_PATH = new URL("spawn/index.ts", REPO_ROOT_URL);
const RENDERER_SOURCE_PATH = new URL("spawn/renderer.ts", REPO_ROOT_URL);
const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22.19.0",
	"ubuntu-latest@24",
	"macos-latest@24",
	"windows-latest@24",
]);
const EXPECTED_ALLOWLIST_KEYS = new Set([
	"GHSA-f38q-mgvj-vph7|protobufjs",
]);

function readText(url: URL): string {
	return readFileSync(url, "utf8");
}

function parseAuditConfig(): AuditConfig {
	const lines = readText(AUDIT_CONFIG_PATH)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"));
	return JSON.parse(lines.join("\n")) as AuditConfig;
}

function parsePackageJson(): PackageJson {
	return JSON.parse(readText(PACKAGE_JSON_PATH)) as PackageJson;
}

function parseMatrixEntries(workflow: string): Set<string> {
	const entries = workflow.matchAll(/- os: ([^\n]+)\n\s+node-version: "([^"]+)"/g);
	return new Set(Array.from(entries, ([, os, node]) => `${os.trim()}@${node}`));
}

function stepIndex(workflow: string, step: string): number {
	const index = workflow.indexOf(`- name: ${step}`);
	assert.notEqual(index, -1, `missing workflow step: ${step}`);
	return index;
}

function allowlistEntries(config: AuditConfig): Array<[string, AuditRecord]> {
	return config.allowlist.map((entry) => {
		const [key, value] = Object.entries(entry)[0] ?? [];
		assert.ok(key, "allowlist entry must define exactly one scoped advisory path");
		assert.ok(value, `missing metadata for allowlist entry: ${key}`);
		return [key, value];
	});
}

function parseIsoDate(value: string): number {
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	assert.notEqual(Number.isNaN(timestamp), true, `invalid ISO date: ${value}`);
	return timestamp;
}

function minimumNodeVersion(value: string): string {
	const match = value.match(/^>=(?<version>\d+\.\d+\.\d+)$/);
	assert.ok(match?.groups?.version, `unsupported engines.node format: ${value}`);
	return match.groups.version;
}

function runAuditCi(): void {
	const result = spawnSync(process.execPath, [AUDIT_CLI_PATH, "--config", "audit-ci.jsonc"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
}

function collectPackagePaths(graph: any, packageName: string): Array<{ path: string; version: string }> {
	const found: Array<{ path: string; version: string }> = [];
	const visit = (node: any, path: string) => {
		for (const [name, dependency] of Object.entries(node?.dependencies ?? {}) as Array<[string, any]>) {
			const dependencyPath = `${path} > ${name}`;
			if (name === packageName && typeof dependency.version === "string") {
				found.push({ path: dependencyPath, version: dependency.version });
			}
			visit(dependency, dependencyPath);
		}
	};
	visit(graph, graph?.name ?? "root");
	return found;
}

function isVulnerableProtobufVersion(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	assert.ok(match, `unexpected protobufjs version: ${version}`);
	const [, major, minor, patch] = match.map(Number);
	return major < 7 || (major === 7 && (minor < 6 || (minor === 6 && patch <= 2)));
}

test("Pi 0.80.8 compatibility metadata and source boundaries stay exact", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { packages: Record<string, { version?: string }> };
	assert.equal(packageJson.engines.node, ">=22.19.0");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(packageJson.peerDependencies[name], "*", `${name} peer must remain host-provided`);
	}
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(packageJson.devDependencies[name], "0.80.8");
		assert.equal(lock.packages[`node_modules/${name}`]?.version, "0.80.8");
	}
	assert.equal(packageJson.devDependencies.typebox, "1.1.38");
	assert.equal(lock.packages["node_modules/typebox"]?.version, "1.1.38");

	const spawnSource = readText(SPAWN_SOURCE_PATH);
	assert.doesNotMatch(spawnSource, /\bAuthStorage\b|\bModelRegistry\b/);
	assert.doesNotMatch(spawnSource, /\bauthStorage\s*:|\bmodelRegistry\s*:/);
	assert.match(spawnSource, /model:\s*childModel/);
	assert.match(spawnSource, /session\.dispose\(\)/);
	const rendererSource = readText(RENDERER_SOURCE_PATH);
	assert.doesNotMatch(rendererSource, /console\.(?:debug|warn|error|log)\s*\(/);
	assert.doesNotMatch(rendererSource, /process\.(?:stdout|stderr)\.write\s*\(/);
});

test("audit-ci config keeps an expiry-tracked advisory-module path allowlist", () => {
	const config = parseAuditConfig();
	assert.equal(config.$schema, AUDIT_SCHEMA);
	assert.equal(config.moderate, true);

	const entries = allowlistEntries(config);
	assert.deepEqual(new Set(entries.map(([key]) => key)), EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		assert.match(key, /^GHSA-[a-z0-9-]+\|[^|>]+(?:>[^|>]+)*$/);
		assert.equal(value.active, true);
		assert.match(value.expiry, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(parseIsoDate(value.expiry) >= today, `expired allowlist entry: ${key}`);
		assert.notEqual(value.notes.trim(), "");
	}
});

test("the allowlisted vulnerable protobufjs path is reachable only through the exact Pi floor graph", () => {
	const result = spawnSync("npm", ["ls", "protobufjs", "--all", "--json"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const vulnerablePaths = collectPackagePaths(JSON.parse(result.stdout), "protobufjs")
		.filter(({ version }) => isVulnerableProtobufVersion(version));
	assert.deepEqual(vulnerablePaths, [{
		path: "pi-agenticoding > @earendil-works/pi-ai > @google/genai > protobufjs",
		version: "7.6.1",
	}]);
});

test("workflow keeps the expected matrix and audit/test order", () => {
	const workflow = readText(WORKFLOW_PATH);
	const packageJson = parsePackageJson();
	assert.match(workflow, /fail-fast:\s+false/);
	assert.deepEqual(parseMatrixEntries(workflow), EXPECTED_MATRIX);
	assert.ok(stepIndex(workflow, "Security audit") < stepIndex(workflow, "Unit tests"));
	assert.ok(stepIndex(workflow, "Unit tests") < stepIndex(workflow, "E2E tests"));
	assert.match(workflow, /run: npx audit-ci --config audit-ci\.jsonc/);
	assert.ok(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(packageJson.engines.node)}`));
});


test("audit-ci config matches the current lockfile vulnerabilities", () => {
	runAuditCi();
});
