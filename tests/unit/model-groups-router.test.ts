import test from "node:test";
import assert from "node:assert/strict";
import { getEffectiveModelGroupNames, resolveSpawnModelRoute, SpawnRouteError } from "../../model-groups/router.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";

function model(provider: string, id: string, overrides: Record<string, unknown> = {}): any {
	return { provider, id, reasoning: true, ...overrides };
}

function group(name: string, scope: "project" | "global", models: any[], shadowedByProject = false): ResolvedModelGroup {
	return {
		name,
		scope,
		sourcePath: `<${scope}>`,
		models,
		validation: { unavailableRefs: [], shadowedByProject, degraded: false },
	};
}

function registry(models: any[], authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`))): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
}

test("effective model group names use project-over-global names", () => {
	const groups = [
		group("review", "global", [], true),
		group("review", "project", []),
		group("research", "global", []),
	];
	assert.deepEqual(getEffectiveModelGroupNames(groups), ["research", "review"]);
});

test("omitted and unknown groups inherit parent route with fallback metadata", () => {
	const parent = model("openai", "gpt-parent");
	const reg = registry([parent]);
	assert.deepEqual(resolveSpawnModelRoute({ groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg }).status, "inherited");
	const route = resolveSpawnModelRoute({ requestedGroup: "typo", groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg });
	assert.equal(route.status, "unknown-fallback");
	assert.equal(route.requestedGroup, "typo");
	assert.equal(route.model, parent);
	assert.equal(route.thinking, "medium");
});

test("known empty and all-unusable groups fail clearly", () => {
	const parent = model("openai", "parent");
	assert.throws(
		() => resolveSpawnModelRoute({ requestedGroup: "empty", groups: [group("empty", "project", [])], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }),
		(error: unknown) => error instanceof SpawnRouteError && error.group === "empty" && error.reason === "empty" && /empty/.test(error.message),
	);
	assert.throws(
		() => resolveSpawnModelRoute({ requestedGroup: "bad", groups: [group("bad", "project", [{ provider: "openai", modelId: "missing" }])], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }),
		(error: unknown) => error instanceof SpawnRouteError && error.group === "bad" && error.reason === "no-usable-models" && /configured\/authenticated/.test(error.message),
	);
});

test("known usable groups filter registry/auth, draw with rng seam, and clamp thinking", () => {
	const parent = model("openai", "parent");
	const usableA = model("openai", "a", { thinkingLevelMap: { xhigh: "x" } });
	const usableB = model("anthropic", "b", { thinkingLevelMap: { xhigh: null } });
	const unauth = model("openai", "unauth");
	const groups = [group("review", "project", [
		{ provider: "openai", modelId: "missing" },
		{ provider: "openai", modelId: "unauth" },
		{ provider: "openai", modelId: "a" },
		{ provider: "anthropic", modelId: "b", thinkingLevel: "xhigh" },
	])];
	const reg = registry([parent, usableA, usableB, unauth], new Set(["openai:parent", "openai:a", "anthropic:b"]));
	const first = resolveSpawnModelRoute({ requestedGroup: "review", groups, parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0 });
	assert.equal(first.status, "routed");
	assert.equal(first.model, usableA);
	assert.equal(first.thinking, "low", "entry without thinking inherits parent");
	const second = resolveSpawnModelRoute({ requestedGroup: "review", groups, parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0.99 });
	assert.equal(second.model, usableB);
	assert.equal(second.thinking, "high", "xhigh clamps when selected model does not support it");
});
