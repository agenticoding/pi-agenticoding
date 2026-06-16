import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel, type Api } from "@earendil-works/pi-ai";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	createGroup,
	deleteGroup,
	listResolvedModelGroups,
	moveGroup,
	renameGroup,
	summarizeBootValidation,
	updateGroup,
} from "./store.js";
import { ModelGroupsPersistenceError, type ModelGroupDef, type ModelGroupScope, type ModelGroupsBootValidation, type ResolvedModelGroup } from "./types.js";

export type ModelGroupsScreen = "LIST" | "EDITOR" | "MODEL_EDIT" | "WIZARD_PROVIDER" | "WIZARD_MODEL" | "WIZARD_THINKING" | "DELETE_CONFIRM";

export interface ModelGroupsStoreOps {
	listResolvedModelGroups: typeof listResolvedModelGroups;
	createGroup: typeof createGroup;
	updateGroup: typeof updateGroup;
	renameGroup: typeof renameGroup;
	deleteGroup: typeof deleteGroup;
	moveGroup: typeof moveGroup;
}

export interface ModelGroupsComponentOptions {
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	initialValidation?: ModelGroupsBootValidation | null;
	onRefresh?: (validation: ModelGroupsBootValidation) => void;
	store?: Partial<ModelGroupsStoreOps>;
}

const defaultStore: ModelGroupsStoreOps = { listResolvedModelGroups, createGroup, updateGroup, renameGroup, deleteGroup, moveGroup };

function isEnter(data: string): boolean { return matchesKey(data, Key.enter) || data === "\n"; }
function isEsc(data: string): boolean { return matchesKey(data, Key.escape); }
function isUp(data: string): boolean { return matchesKey(data, Key.up); }
function isDown(data: string): boolean { return matchesKey(data, Key.down); }
function isLeft(data: string): boolean { return matchesKey(data, Key.left); }
function isBackspace(data: string): boolean { return matchesKey(data, Key.backspace); }
function isDeleteChord(data: string): boolean { return data === "D" || matchesKey(data, Key.delete); }
function isPrintable(data: string): boolean { return data.length === 1 && data >= " " && data !== "\u007f"; }

function cloneDef(def: ModelGroupDef): ModelGroupDef {
	return { models: def.models.map((model) => ({ ...model })) };
}

function groupKey(group: Pick<ResolvedModelGroup, "scope" | "name">): string {
	return `${group.scope}:${group.name}`;
}

function thinkingLabel(level: ModelThinkingLevel | undefined): string {
	return level ?? "inherit";
}

function modelAvailable(registry: ModelRegistry, provider: string, modelId: string): boolean {
	const model = registry.find(provider, modelId);
	return Boolean(model && registry.hasConfiguredAuth(model));
}

function modelDisplay(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function toPersistenceMessage(error: unknown): string {
	if (error instanceof ModelGroupsPersistenceError) {
		const scope = error.scope ? ` for ${error.scope} scope` : "";
		const paths = [error.sourcePath ? `source: ${error.sourcePath}` : "", error.targetPath ? `target: ${error.targetPath}` : ""].filter(Boolean).join("; ");
		const pathDetails = paths ? ` (${paths})` : "";
		return `${error.operation} failed at ${error.phase}${scope}${pathDetails}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

export function createModelGroupsComponent(
	tui: TUI,
	theme: Theme,
	modelRegistry: ModelRegistry,
	cwd: string,
	done: (result: void) => void,
	options: ModelGroupsComponentOptions = {},
): Component {
	const store = { ...defaultStore, ...options.store };
	const notify = options.notify ?? (() => {});
	const state = {
		screen: "LIST" as ModelGroupsScreen,
		row: 0,
		groups: [] as ResolvedModelGroup[],
		loadIssues: [] as ModelGroupsBootValidation["loadIssues"],
		editKey: null as string | null,
		editName: "",
		editScope: "project" as ModelGroupScope,
		editDraft: null as ModelGroupDef | null,
		activeTextInput: null as null | "group-name" | "wizard-filter",
		modelEditIndex: 0,
		wizardProvider: "",
		wizardModelId: "",
		wizardThinking: undefined as ModelThinkingLevel | undefined,
		deleteKey: null as string | null,
		finished: false,
	};

	function refresh(): void {
		const boot = store.listResolvedModelGroups(cwd, modelRegistry);
		state.groups = boot.groups;
		state.loadIssues = boot.loadIssues;
		options.onRefresh?.(boot);
		for (const issue of boot.loadIssues) {
			const backup = issue.backupFailed ? "; backup failed, original file left untouched" : "";
			notify(`Model Groups config ${issue.kind} in ${issue.scope} scope (${issue.sourcePath}); using empty config for that scope${backup}`, "warning");
		}
	}

	if (options.initialValidation) {
		state.groups = options.initialValidation.groups;
		state.loadIssues = options.initialValidation.loadIssues;
	} else {
		refresh();
	}

	function selectedGroup(): ResolvedModelGroup | undefined {
		return state.groups[state.row];
	}

	function openEditor(group: ResolvedModelGroup): void {
		state.screen = "EDITOR";
		state.row = 0;
		state.editKey = groupKey(group);
		state.editName = group.name;
		state.editScope = group.scope;
		state.editDraft = cloneDef(group);
		state.activeTextInput = null;
	}

	function currentEditGroup(): ResolvedModelGroup | undefined {
		return state.groups.find((group) => groupKey(group) === state.editKey) ?? state.groups.find((group) => group.name === state.editName && group.scope === state.editScope);
	}

	function uniqueNewGroupName(): string {
		const existing = new Set(state.groups.map((group) => group.name));
		if (!existing.has("new-group")) return "new-group";
		let index = 2;
		while (existing.has(`new-group-${index}`)) index++;
		return `new-group-${index}`;
	}

	function notifyError(error: unknown): void {
		notify(toPersistenceMessage(error), "error");
	}

	function commitName(): boolean {
		const group = currentEditGroup();
		if (!group) return false;
		const nextName = state.editName.trim();
		if (!nextName || nextName === group.name) {
			state.editName = group.name;
			return true;
		}
		try {
			store.renameGroup(group.scope, cwd, group.name, nextName);
			refresh();
			const renamed = state.groups.find((candidate) => candidate.name === nextName && candidate.scope === group.scope);
			if (renamed) openEditor(renamed);
			return true;
		} catch (error) {
			notifyError(error);
			state.editName = group.name;
			state.activeTextInput = null;
			return false;
		}
	}

	function switchScope(newScope: ModelGroupScope): void {
		const group = currentEditGroup();
		if (!group || newScope === group.scope) return;
		if (!commitName()) return;
		const confirmed = currentEditGroup();
		if (!confirmed) return;
		try {
			store.moveGroup(cwd, confirmed.name, newScope);
			refresh();
			const moved = state.groups.find((candidate) => candidate.name === confirmed.name && candidate.scope === newScope);
			if (moved) openEditor(moved);
		} catch (error) {
			notifyError(error);
		}
	}

	function updateDraft(def: ModelGroupDef, afterSuccess: () => void): void {
		const group = currentEditGroup();
		if (!group) return;
		try {
			store.updateGroup(group.scope, cwd, group.name, def);
			refresh();
			const updated = state.groups.find((candidate) => candidate.name === group.name && candidate.scope === group.scope);
			if (updated) openEditor(updated);
			afterSuccess();
		} catch (error) {
			notifyError(error);
		}
	}

	function availableModels(): Model<Api>[] {
		return modelRegistry.getAvailable()
			.filter((model) => modelRegistry.hasConfiguredAuth(model));
	}

	function allProviders(): string[] {
		return [...new Set(availableModels().map((model) => model.provider))].sort();
	}

	function modelsForProvider(provider: string): Model<Api>[] {
		return availableModels()
			.filter((model) => model.provider === provider)
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	function currentWizardModel(): Model<Api> | undefined {
		return modelRegistry.find(state.wizardProvider, state.wizardModelId) as Model<Api> | undefined;
	}

	function thinkingOptionsFor(model: Model<Api> | undefined): Array<ModelThinkingLevel | undefined> {
		if (!model) return [undefined];
		const supported = getSupportedThinkingLevels(model).filter((level) => model.reasoning || level !== "off");
		return [undefined, ...supported];
	}

	function maxRow(): number {
		switch (state.screen) {
			case "LIST": return state.groups.length;
			case "EDITOR": return 3 + (state.editDraft?.models.length ?? 0);
			case "MODEL_EDIT": return thinkingOptionsFor(modelRegistry.find(state.editDraft?.models[state.modelEditIndex]?.provider ?? "", state.editDraft?.models[state.modelEditIndex]?.modelId ?? "") as Model<Api> | undefined).length;
			case "WIZARD_PROVIDER": return Math.max(0, allProviders().length - 1);
			case "WIZARD_MODEL": return Math.max(0, modelsForProvider(state.wizardProvider).length - 1);
			case "WIZARD_THINKING": return Math.max(0, thinkingOptionsFor(currentWizardModel()).length - 1);
			case "DELETE_CONFIRM": return 1;
		}
	}

	function clampRow(): void {
		state.row = Math.max(0, Math.min(state.row, maxRow()));
	}

	function activate(): void {
		switch (state.screen) {
			case "LIST": {
				if (state.row === state.groups.length) {
					const name = uniqueNewGroupName();
					try {
						store.createGroup("project", cwd, name, { models: [] });
						refresh();
						const created = state.groups.find((group) => group.name === name && group.scope === "project");
						if (created) openEditor(created);
					} catch (error) { notifyError(error); }
					return;
				}
				const group = selectedGroup();
				if (group) openEditor(group);
				return;
			}
			case "EDITOR": {
				if (state.row === 0) { switchScope("project"); return; }
				if (state.row === 1) { switchScope("global"); return; }
				if (state.row === 2) { state.activeTextInput = "group-name"; return; }
				if (!commitName()) return;
				const modelIndex = state.row - 3;
				if (state.editDraft && modelIndex < state.editDraft.models.length) {
					state.modelEditIndex = modelIndex;
					state.screen = "MODEL_EDIT";
					state.row = 0;
				} else {
					state.screen = "WIZARD_PROVIDER";
					state.row = 0;
				}
				return;
			}
			case "MODEL_EDIT": {
				const model = state.editDraft?.models[state.modelEditIndex];
				if (!state.editDraft || !model) return;
				const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
				const options = thinkingOptionsFor(found);
				if (state.row >= options.length) {
					const next = cloneDef(state.editDraft);
					next.models.splice(state.modelEditIndex, 1);
					updateDraft(next, () => { state.screen = "EDITOR"; state.row = 0; });
					return;
				}
				const next = cloneDef(state.editDraft);
				const level = options[state.row];
				if (level === undefined) delete next.models[state.modelEditIndex].thinkingLevel;
				else next.models[state.modelEditIndex].thinkingLevel = level;
				updateDraft(next, () => { state.screen = "EDITOR"; state.row = 0; });
				return;
			}
			case "WIZARD_PROVIDER": {
				const provider = allProviders()[state.row];
				if (!provider) return;
				state.wizardProvider = provider;
				state.screen = "WIZARD_MODEL";
				state.row = 0;
				return;
			}
			case "WIZARD_MODEL": {
				const model = modelsForProvider(state.wizardProvider)[state.row];
				if (!model) return;
				state.wizardModelId = model.id;
				state.screen = "WIZARD_THINKING";
				state.row = 0;
				return;
			}
			case "WIZARD_THINKING": {
				if (!state.editDraft) return;
				const level = thinkingOptionsFor(currentWizardModel())[state.row];
				const next = cloneDef(state.editDraft);
				const entry = { provider: state.wizardProvider, modelId: state.wizardModelId } as { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel };
				if (level !== undefined) entry.thinkingLevel = level;
				next.models.push(entry);
				updateDraft(next, () => { state.screen = "EDITOR"; state.row = 0; });
				return;
			}
			case "DELETE_CONFIRM": {
				if (state.row === 0) { state.screen = "LIST"; state.row = 0; return; }
				const group = state.groups.find((candidate) => groupKey(candidate) === state.deleteKey);
				if (!group) { state.screen = "LIST"; return; }
				try {
					store.deleteGroup(group.scope, cwd, group.name);
					refresh();
					state.screen = "LIST";
					state.row = 0;
				} catch (error) { notifyError(error); }
				return;
			}
		}
	}

	function goBack(): void {
		if (state.activeTextInput === "group-name") { commitName(); state.activeTextInput = null; return; }
		switch (state.screen) {
			case "LIST": state.finished = true; done(); return;
			case "EDITOR": commitName(); state.screen = "LIST"; state.row = 0; return;
			case "MODEL_EDIT": state.screen = "EDITOR"; state.row = 0; return;
			case "WIZARD_PROVIDER": state.screen = "EDITOR"; state.row = 0; return;
			case "WIZARD_MODEL": state.screen = "WIZARD_PROVIDER"; state.row = 0; return;
			case "WIZARD_THINKING": state.screen = "WIZARD_MODEL"; state.row = 0; return;
			case "DELETE_CONFIRM": state.screen = "LIST"; state.row = 0; return;
		}
	}

	function deleteAction(): void {
		if (state.screen === "LIST") {
			const group = selectedGroup();
			if (!group) return;
			state.deleteKey = groupKey(group);
			state.screen = "DELETE_CONFIRM";
			state.row = 0;
		} else if (state.screen === "MODEL_EDIT") {
			state.row = maxRow();
			activate();
		}
	}

	function selectableLine(selected: boolean, primary: string, suffix = ""): string {
		if (!selected) return `  ${primary}${suffix}`;
		return `${theme.fg("accent", "→")} ${theme.fg("accent", primary)}${suffix}`;
	}

	function renderList(): string[] {
		const summary = summarizeBootValidation(state.groups);
		const lines = [theme.fg("accent", "Model Groups"), theme.fg("dim", `Boot validation: ${summary.unavailableCount} unavailable model references · ${summary.overrideCount} project overrides`)];
		state.groups.forEach((group, index) => {
			const tags: string[] = [];
			if (group.validation.degraded) tags.push("⚠ degraded");
			if (group.validation.unavailableRefs.length > 0) tags.push("✗ unavailable");
			if (group.validation.shadowedByProject) tags.push("project override");
			const models = group.models.map((model) => thinkingLabel(model.thinkingLevel)).join(", ") || "empty";
			lines.push(selectableLine(index === state.row, group.name, ` [${group.scope}] ${group.models.length} models ${models}${tags.length ? ` — ${tags.join(" · ")}` : ""}`));
		});
		lines.push(selectableLine(state.row === state.groups.length, "+ Add group"));
		lines.push(theme.fg("dim", "↑↓ navigate • Enter open/add • D delete • Esc close"));
		return lines;
	}

	function renderEditor(): string[] {
		const lines = [theme.fg("accent", `Model Group: ${state.editName}`)];
		lines.push(selectableLine(state.row === 0, "Location: project", state.editScope === "project" ? " ✓" : ""));
		lines.push(selectableLine(state.row === 1, "Location: global", state.editScope === "global" ? " ✓" : ""));
		lines.push(selectableLine(state.row === 2, `Name: ${state.editName}${state.activeTextInput === "group-name" ? "_" : ""}`));
		state.editDraft?.models.forEach((model, index) => {
			const available = modelAvailable(modelRegistry, model.provider, model.modelId) ? "available" : "unavailable";
			lines.push(selectableLine(state.row === index + 3, `${model.provider}/${model.modelId}`, ` (${available}, thinking ${thinkingLabel(model.thinkingLevel)})`));
		});
		const addRow = 3 + (state.editDraft?.models.length ?? 0);
		lines.push(selectableLine(state.row === addRow, "+ Add model…"));
		return lines;
	}

	function renderModelEdit(): string[] {
		const model = state.editDraft?.models[state.modelEditIndex];
		if (!model) return ["Model not found"];
		const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
		const lines = [theme.fg("accent", "Edit model"), `Provider: ${model.provider}`, `Model ID: ${model.modelId}`, `Status: ${found && modelRegistry.hasConfiguredAuth(found) ? "available" : "unavailable"}`];
		thinkingOptionsFor(found).forEach((level, index) => lines.push(selectableLine(state.row === index, `Thinking: ${thinkingLabel(level)}`)));
		lines.push(selectableLine(state.row === thinkingOptionsFor(found).length, "Remove model"));
		return lines;
	}

	function renderWizard(): string[] {
		if (state.screen === "WIZARD_PROVIDER") return [theme.fg("accent", "Add model — Step 1/3 Provider"), ...allProviders().map((provider, index) => selectableLine(state.row === index, provider))];
		if (state.screen === "WIZARD_MODEL") return [theme.fg("accent", "Add model — Step 2/3 Model"), ...modelsForProvider(state.wizardProvider).map((model, index) => selectableLine(state.row === index, modelDisplay(model)))];
		return [theme.fg("accent", "Add model — Step 3/3 Thinking"), ...thinkingOptionsFor(currentWizardModel()).map((level, index) => selectableLine(state.row === index, thinkingLabel(level)))];
	}

	function renderDelete(): string[] {
		const group = state.groups.find((candidate) => groupKey(candidate) === state.deleteKey);
		const otherScope = group ? state.groups.some((candidate) => candidate.name === group.name && candidate.scope !== group.scope) : false;
		return [theme.fg("warning", "Delete Model Group?"), group ? `${group.name} [${group.scope}] with ${group.models.length} models` : "Missing group", otherScope ? "Same-name group in the other scope remains unaffected." : "", selectableLine(state.row === 0, "Keep group"), selectableLine(state.row === 1, "Delete group")].filter(Boolean);
	}

	return {
		render: (_width: number) => {
			if (state.screen === "LIST") return renderList();
			if (state.screen === "EDITOR") return renderEditor();
			if (state.screen === "MODEL_EDIT") return renderModelEdit();
			if (state.screen === "DELETE_CONFIRM") return renderDelete();
			return renderWizard();
		},
		invalidate: () => {},
		handleInput: (data: string) => {
			if (state.finished) return;
			if (state.activeTextInput === "group-name") {
				if (isUp(data) || isDown(data)) {
					const previousRow = state.row;
					if (commitName()) {
						state.activeTextInput = null;
						state.row = previousRow + (isDown(data) ? 1 : -1);
						clampRow();
					}
				} else if (isEnter(data) || isEsc(data)) { commitName(); state.activeTextInput = null; }
				else if (isBackspace(data)) state.editName = state.editName.slice(0, -1);
				else if (isPrintable(data)) state.editName += data;
				tui.requestRender();
				return;
			}
			if (isDeleteChord(data) && (state.screen === "LIST" || state.screen === "MODEL_EDIT")) deleteAction();
			else if (isUp(data)) { state.row--; clampRow(); }
			else if (isDown(data)) { state.row++; clampRow(); }
			else if (isLeft(data) || isEsc(data)) goBack();
			else if (isEnter(data)) activate();
			tui.requestRender();
		},
	};
}
