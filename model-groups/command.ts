import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { createModelGroupsComponent } from "./tui.js";

export function registerModelGroupsCommand(pi: ExtensionAPI, state: AgenticodingState): void {
	pi.registerCommand("model-groups", {
		description: "Manage Model Groups",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.cwd || !ctx.modelRegistry) {
				ctx.ui.notify("Cannot manage model groups: missing working directory or model registry", "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createModelGroupsComponent(tui, theme, ctx.modelRegistry, ctx.cwd, done, {
					initialValidation: state.modelGroups.validation,
					notify: (message, type) => ctx.ui.notify(message, type),
					onRefresh: (validation) => {
						state.modelGroups.groups = validation.groups;
						state.modelGroups.validation = validation;
					},
				}),
			);
		},
	});
}
