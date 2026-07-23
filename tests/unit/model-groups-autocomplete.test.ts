import test from "node:test";
import assert from "node:assert/strict";
import { createModelGroupAutocompleteProvider, registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { group } from "./model-groups-helpers.js";

test("#group autocomplete suggests effective live group names and delegates elsewhere", async () => {
	const state = createState();
	state.modelGroups.groups = [
		group("review", { models: [
			{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
			{ provider: "anthropic", modelId: "claude-sonnet-4" },
		]}),
		group("research", { models: [{ provider: "google", modelId: "gemini-2.5-pro", thinkingLevel: "xhigh" }] }),
	];
	let delegated = 0;
	const current = {
		getSuggestions: async () => { delegated++; return { prefix: "", items: [{ value: "delegated" }] }; },
		applyCompletion: () => "applied",
		shouldTriggerFileCompletion: () => false,
	};
	const provider = createModelGroupAutocompleteProvider(state)(current as any);

	const suggestions = await provider.getSuggestions(["spawn #re"], 0, "spawn #re".length, {});
	assert.equal(suggestions.prefix, "#re");
	assert.deepEqual(suggestions.items.map((item: any) => item.value), ["#research", "#review"]);
	assert.deepEqual(suggestions.items.map((item: any) => item.description), [
		"google/gemini-2.5-pro • xhigh",
		"openai/gpt-5 • high; anthropic/claude-sonnet-4 • inherit",
	]);
	assert.equal(delegated, 0);

	state.modelGroups.groups = [group("reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }], unavailableRefs: [{ provider: "openai", modelId: "gpt-5" }] })];
	const fresh = await provider.getSuggestions(["#rev"], 0, 4, {});
	assert.deepEqual(fresh.items.map((item: any) => item.value), ["#reviewers"]);
	assert.equal(fresh.items[0].description, "openai/gpt-5 • inherit (unavailable)");

	const other = await provider.getSuggestions(["no hash"], 0, 7, {});
	assert.equal(delegated, 1);
	assert.deepEqual(other.items.map((item: any) => item.value), ["delegated"]);
	assert.equal(provider.applyCompletion([], 0, 0, {}, "#re"), "applied");
	assert.equal(provider.shouldTriggerFileCompletion([], 0, 0), false);
});

test("registerModelGroupAutocomplete uses ctx.ui.addAutocompleteProvider once", () => {
	const state = createState();
	const providers: any[] = [];
	const ctx = { hasUI: true, ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } };
	registerModelGroupAutocomplete(ctx as any, state);
	registerModelGroupAutocomplete(ctx as any, state);
	assert.equal(providers.length, 1);
});
