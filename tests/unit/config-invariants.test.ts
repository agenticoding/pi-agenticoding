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
	engines: {
		node: string;
	};
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
const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22",
	"ubuntu-latest@24",
	"macos-latest@24",
	"windows-latest@24",
]);
const EXPECTED_ALLOWLIST_KEYS = new Set([
	"GHSA-96hv-2xvq-fx4p",
	"GHSA-f38q-mgvj-vph7",
	"GHSA-wcpc-wj8m-hjx6",
	"GHSA-vmh5-mc38-953g|@earendil-works/pi-coding-agent>undici",
	"GHSA-pr7r-676h-xcf6|@earendil-works/pi-coding-agent>undici",
	"GHSA-38rv-x7px-6hhq|@earendil-works/pi-coding-agent>undici",
	"GHSA-p88m-4jfj-68fv|@earendil-works/pi-coding-agent>undici",
	"GHSA-vxpw-j846-p89q|@earendil-works/pi-coding-agent>undici",
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

function minimumNodeVersion(value: string): number {
	const match = value.match(/^>=(?<major>\d+)$/);
	assert.ok(match?.groups?.major, `unsupported engines.node format: ${value}`);
	return Number.parseInt(match.groups.major, 10);
}

function runAuditCi(): void {
	const result = spawnSync(process.execPath, [AUDIT_CLI_PATH, "--config", "audit-ci.jsonc"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
}

test("audit-ci config keeps an expiry-tracked, path-scoped allowlist", () => {
	const config = parseAuditConfig();
	assert.equal(config.$schema, AUDIT_SCHEMA);
	assert.equal(config.moderate, true);

	const entries = allowlistEntries(config);
	assert.deepEqual(new Set(entries.map(([key]) => key)), EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		assert.match(key, /^GHSA-[a-z0-9-]+(\|.*)?$/);
		assert.equal(value.active, true);
		assert.match(value.expiry, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(parseIsoDate(value.expiry) >= today, `expired allowlist entry: ${key}`);
		assert.notEqual(value.notes.trim(), "");
	}
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
