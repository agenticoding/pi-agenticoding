import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { getEffectiveModelGroups } from "./router.js";
import type { ModelGroupModel, ResolvedModelGroup } from "./types.js";

const registeredUis = new WeakSet<object>();

function isUnavailable(group: ResolvedModelGroup, entry: ModelGroupModel): boolean {
	return group.validation.unavailableRefs.some((ref) => ref.provider === entry.provider && ref.modelId === entry.modelId);
}

function formatModelGroupRouteDetails(group: ResolvedModelGroup): string {
	if (group.models.length === 0) return "No models configured";
	return group.models
		.map((entry) => {
			const thinking = entry.thinkingLevel ?? "inherit";
			const unavailable = isUnavailable(group, entry) ? " (unavailable)" : "";
			return `${entry.provider}/${entry.modelId} • ${thinking}${unavailable}`;
		})
		.join("; ");
}

export function createModelGroupAutocompleteProvider(state: AgenticodingState) {
	return (current: any) => ({
		async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: unknown) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[\t ])#([^\s#]*)$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const partial = (match[1] ?? "").toLowerCase();
			const groups = getEffectiveModelGroups(state.modelGroups.groups);
			const items = groups
				.filter((group) => group.name.toLowerCase().startsWith(partial))
				.map((group) => ({
					value: `#${group.name}`,
					label: `#${group.name}`,
					description: formatModelGroupRouteDetails(group),
				}));
			return { prefix: `#${match[1] ?? ""}`, items };
		},

		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: unknown, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	});
}

export function registerModelGroupAutocomplete(ctx: ExtensionContext, state: AgenticodingState): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as unknown as { addAutocompleteProvider?: (factory: ReturnType<typeof createModelGroupAutocompleteProvider>) => void };
	if (typeof ui.addAutocompleteProvider !== "function") return;
	const key = ui as object;
	if (registeredUis.has(key)) return;
	registeredUis.add(key);
	ui.addAutocompleteProvider(createModelGroupAutocompleteProvider(state));
}
