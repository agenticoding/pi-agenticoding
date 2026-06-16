import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ResolvedModelGroup } from "./types.js";

export type SpawnRouteStatus = "inherited" | "routed" | "unknown-fallback";

export interface SpawnModelRoute {
	status: SpawnRouteStatus;
	requestedGroup?: string;
	groupName?: string;
	model: Model<Api>;
	provider: string;
	modelId: string;
	thinking: ModelThinkingLevel;
}

export type SpawnRouteErrorReason = "empty" | "no-usable-models";

export class SpawnRouteError extends Error {
	readonly kind = "unusable-group" as const;
	readonly group: string;
	readonly reason: SpawnRouteErrorReason;

	constructor(group: string, reason: SpawnRouteErrorReason) {
		const detail = reason === "empty"
			? "has no model entries"
			: "has no configured/authenticated usable models";
		super(`Model Group '${group}' ${detail}.`);
		this.name = "SpawnRouteError";
		this.group = group;
		this.reason = reason;
	}
}

function parentProvider(model: Model<Api>): string {
	return typeof model.provider === "string" ? model.provider : "";
}

function effectiveGroupMap(groups: ResolvedModelGroup[]): Map<string, ResolvedModelGroup> {
	const byName = new Map<string, ResolvedModelGroup>();
	for (const group of groups) {
		if (group.validation?.shadowedByProject) continue;
		const existing = byName.get(group.name);
		if (!existing || group.scope === "project") byName.set(group.name, group);
	}
	return byName;
}

export function getEffectiveModelGroups(groups: ResolvedModelGroup[]): ResolvedModelGroup[] {
	return [...effectiveGroupMap(groups).values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getEffectiveModelGroupNames(groups: ResolvedModelGroup[]): string[] {
	return getEffectiveModelGroups(groups).map((group) => group.name);
}

export function resolveSpawnModelRoute(options: {
	requestedGroup?: string;
	groups: ResolvedModelGroup[];
	parentModel: Model<Api>;
	parentThinking: ModelThinkingLevel;
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
	rng?: () => number;
}): SpawnModelRoute {
	const requestedGroup = options.requestedGroup?.trim();
	const inherited = (status: "inherited" | "unknown-fallback"): SpawnModelRoute => ({
		status,
		...(status === "unknown-fallback" && requestedGroup ? { requestedGroup } : {}),
		model: options.parentModel,
		provider: parentProvider(options.parentModel),
		modelId: options.parentModel.id,
		thinking: options.parentThinking,
	});

	if (!requestedGroup) return inherited("inherited");

	const group = effectiveGroupMap(options.groups).get(requestedGroup);
	if (!group) return inherited("unknown-fallback");
	if (group.models.length === 0) throw new SpawnRouteError(group.name, "empty");

	const usable = group.models
		.map((entry) => {
			const model = options.modelRegistry.find(entry.provider, entry.modelId) as Model<Api> | undefined;
			return model && options.modelRegistry.hasConfiguredAuth(model)
				? { entry, model }
				: undefined;
		})
		.filter((entry): entry is { entry: typeof group.models[number]; model: Model<Api> } => Boolean(entry));

	if (usable.length === 0) throw new SpawnRouteError(group.name, "no-usable-models");

	const rng = options.rng ?? Math.random;
	const index = Math.min(usable.length - 1, Math.max(0, Math.floor(rng() * usable.length)));
	const selected = usable[index];
	const requestedThinking = selected.entry.thinkingLevel ?? options.parentThinking;
	const thinking = clampThinkingLevel(selected.model, requestedThinking);
	return {
		status: "routed",
		requestedGroup,
		groupName: group.name,
		model: selected.model,
		provider: selected.entry.provider,
		modelId: selected.entry.modelId,
		thinking,
	};
}
