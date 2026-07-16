import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel, type Api } from "@earendil-works/pi-ai";
import { Container, Input, Key, matchesKey, SelectList, truncateToWidth, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import {
	createGroup,
	deleteGroup,
	listResolvedModelGroups,
	moveGroup,
	renameGroup,
	summarizeBootValidation,
	updateGroup,
} from "./store.js";
import { ModelGroupsPersistenceError, type ModelGroupDef, type ModelGroupScope, type ModelGroupsAccess, type ModelGroupsBootValidation, type ResolvedModelGroup } from "./types.js";
import { canonicalizeModelGroupName } from "./names.js";
import { decodeDisplayLabel, escapeDisplayLabel } from "./display.js";

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
function isDeleteChord(data: string): boolean { return data === "D" || matchesKey(data, Key.delete); }

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
	return `${escapeDisplayLabel(model.provider)}/${escapeDisplayLabel(model.id)}`;
}

function toPersistenceMessage(error: unknown): string {
	if (error instanceof ModelGroupsPersistenceError) {
		const scope = error.scope ? ` for ${error.scope} scope` : "";
		const paths = [error.sourcePath ? `source: ${escapeDisplayLabel(error.sourcePath)}` : "", error.targetPath ? `target: ${escapeDisplayLabel(error.targetPath)}` : ""].filter(Boolean).join("; ");
		const pathDetails = paths ? ` (${paths})` : "";
		const cause = error.cause === undefined ? "" : `; cause: ${escapeDisplayLabel(error.cause instanceof Error ? error.cause.message : String(error.cause))}`;
		const partial = error.partialMove ? `; ${error.partialMove}` : "";
		return `${error.operation} failed at ${error.phase}${scope}${pathDetails}: ${escapeDisplayLabel(error.message)}${cause}${partial}`;
	}
	return escapeDisplayLabel(error instanceof Error ? error.message : String(error));
}

export function createModelGroupsComponent(
	tui: TUI,
	theme: Theme,
	modelRegistry: ModelRegistry,
	access: ModelGroupsAccess,
	done: (result: void) => void,
	options: ModelGroupsComponentOptions = {},
): Component & Focusable {
	const store = { ...defaultStore, ...options.store };
	const notify = options.notify ?? (() => {});
	const state = {
		screen: "LIST" as ModelGroupsScreen,
		row: 0,
		groups: [] as ResolvedModelGroup[],
		loadIssues: [] as ModelGroupsBootValidation["loadIssues"],
		editKey: null as string | null,
		editName: "",
		editScope: (access.policy === "global-project" ? "project" : "global") as ModelGroupScope,
		editDraft: null as ModelGroupDef | null,
		activeTextInput: null as null | "group-name",
		modelEditIndex: 0,
		wizardProvider: "",
		wizardModelId: "",
		wizardThinking: undefined as ModelThinkingLevel | undefined,
		deleteKey: null as string | null,
		finished: false,
	};
	const groupNameInput = new Input();
	let rootFocused = false;
	let activeSelect: SelectList | null = null;
	const nameRow = () => access.policy === "global-project" ? 2 : 1;
	const modelStartRow = () => nameRow() + 1;
	function syncInputFocus(): void {
		groupNameInput.focused = rootFocused && state.screen === "EDITOR" && state.row === nameRow() && state.activeTextInput === "group-name";
	}
	function setGroupNameInputValue(value: string): void {
		groupNameInput.setValue(value);
		groupNameInput.handleInput("\u001b[F");
	}

	function refresh(): void {
		const boot = store.listResolvedModelGroups(access, modelRegistry);
		state.groups = boot.groups;
		state.loadIssues = boot.loadIssues;
		options.onRefresh?.(boot);
		for (const issue of boot.loadIssues) {
			const backupPath = issue.backupPath ? escapeDisplayLabel(issue.backupPath) : "";
			const backup = issue.backupFailed ? `; backup failed${backupPath ? ` (${backupPath})` : ""}, original file left untouched` : "";
			notify(`Model Groups config ${issue.kind} in ${issue.scope} scope (${escapeDisplayLabel(issue.sourcePath)}); using empty config for that scope${backup}; ${escapeDisplayLabel(issue.message)}`, "warning");
		}
	}

	if (options.initialValidation) {
		state.groups = options.initialValidation.groups
			.filter((group) => access.policy === "global-project" || group.scope === "global")
			.map((group) => access.policy === "global-project" ? group : { ...group, validation: { ...group.validation, shadowedByProject: false } });
		state.loadIssues = options.initialValidation.loadIssues.filter((issue) => access.policy === "global-project" || issue.scope === "global");
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
		state.editName = escapeDisplayLabel(group.name);
		setGroupNameInputValue(state.editName);
		state.editScope = group.scope;
		state.editDraft = cloneDef(group);
		state.activeTextInput = null;
		syncInputFocus();
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
		state.editName = groupNameInput.getValue();
		const decoded = decodeDisplayLabel(state.editName);
		if (!decoded.ok) {
			notify(escapeDisplayLabel(decoded.message), "error");
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return false;
		}
		const nextName = canonicalizeModelGroupName(decoded.value);
		if (!nextName) {
			notify("Model group name is required", "error");
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return false;
		}
		if (nextName === group.name) {
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return true;
		}
		try {
			store.renameGroup(group.scope, access, group.name, nextName);
			refresh();
			const renamed = state.groups.find((candidate) => candidate.name === nextName && candidate.scope === group.scope);
			if (renamed) openEditor(renamed);
			return true;
		} catch (error) {
			notifyError(error);
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			state.activeTextInput = null;
			syncInputFocus();
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
			store.moveGroup(access, confirmed.name, newScope);
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
			store.updateGroup(group.scope, access, group.name, def);
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
			case "EDITOR": return modelStartRow() + (state.editDraft?.models.length ?? 0);
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
						const scope = access.policy === "global-project" ? "project" : "global";
						store.createGroup(scope, access, name, { models: [] });
						refresh();
						const created = state.groups.find((group) => group.name === name && group.scope === scope);
						if (created) openEditor(created);
					} catch (error) { notifyError(error); }
					return;
				}
				const group = selectedGroup();
				if (group) openEditor(group);
				return;
			}
			case "EDITOR": {
				if (access.policy === "global-project" && state.row === 0) { switchScope("project"); return; }
				if ((access.policy === "global-project" && state.row === 1) || (access.policy === "global-only" && state.row === 0)) { switchScope("global"); return; }
				if (state.row === nameRow()) { state.activeTextInput = "group-name"; syncInputFocus(); return; }
				if (!commitName()) return;
				const modelIndex = state.row - modelStartRow();
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
					store.deleteGroup(group.scope, access, group.name);
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

	function textLine(value: string): Component {
		return { render: () => [value], invalidate: () => {} };
	}

	const selectTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("dim", text),
	};

	function buildSelect(items: SelectItem[]): SelectList {
		const select = new SelectList(items, Math.max(1, items.length), selectTheme);
		select.setSelectedIndex(Math.min(state.row, Math.max(0, items.length - 1)));
		select.onSelectionChange = (item) => { state.row = Number(item.value); syncInputFocus(); };
		select.onSelect = (item) => { state.row = Number(item.value); activate(); syncInputFocus(); };
		select.onCancel = () => { goBack(); syncInputFocus(); };
		activeSelect = select;
		return select;
	}

	function renderListComponent(): Component {
		const summary = summarizeBootValidation(state.groups);
		const container = new Container();
		container.addChild(textLine(theme.fg("accent", "Model Groups")));
		container.addChild(textLine(theme.fg("dim", `Boot validation: ${summary.unavailableCount} unavailable model references · ${summary.overrideCount} project overrides`)));
		const items: SelectItem[] = state.groups.map((group, index) => {
			const tags: string[] = [];
			if (group.validation.degraded) tags.push("⚠ degraded");
			if (group.validation.unavailableRefs.length > 0) tags.push("✗ unavailable");
			if (group.validation.shadowedByProject) tags.push("project override");
			const models = group.models.map((model) => thinkingLabel(model.thinkingLevel)).join(", ") || "empty";
			return { value: String(index), label: escapeDisplayLabel(group.name), description: `[${group.scope}] ${group.models.length} models ${models}${tags.length ? ` — ${tags.join(" · ")}` : ""}` };
		});
		items.push({ value: String(state.groups.length), label: "+ Add group" });
		container.addChild(buildSelect(items));
		container.addChild(textLine(theme.fg("dim", "↑↓ navigate • Enter open/add • D delete • Esc close")));
		return container;
	}

	function renderEditorComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const current = currentEditGroup();
		container.addChild(textLine(theme.fg("accent", `Model Group: ${escapeDisplayLabel(current?.name ?? "")}`)));
		if (access.policy === "global-project") container.addChild(textLine(selectableLine(state.row === 0, "Location: project", state.editScope === "project" ? " ✓" : "")));
		container.addChild(textLine(selectableLine(state.row === (access.policy === "global-project" ? 1 : 0), "Location: global", state.editScope === "global" ? " ✓" : "")));
		container.addChild(textLine(selectableLine(state.row === nameRow(), "Name:")));
		container.addChild(groupNameInput);
		state.editDraft?.models.forEach((model, index) => {
			const available = modelAvailable(modelRegistry, model.provider, model.modelId) ? "available" : "unavailable";
			container.addChild(textLine(selectableLine(state.row === index + modelStartRow(), `${escapeDisplayLabel(model.provider)}/${escapeDisplayLabel(model.modelId)}`, ` (${available}, thinking ${thinkingLabel(model.thinkingLevel)})`)));
		});
		const addRow = modelStartRow() + (state.editDraft?.models.length ?? 0);
		container.addChild(textLine(selectableLine(state.row === addRow, "+ Add model…")));
		return container;
	}

	function renderModelEditComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const model = state.editDraft?.models[state.modelEditIndex];
		if (!model) { container.addChild(textLine("Model not found")); return container; }
		const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
		container.addChild(textLine(theme.fg("accent", "Edit model")));
		container.addChild(textLine(`Provider: ${escapeDisplayLabel(model.provider)}`));
		container.addChild(textLine(`Model ID: ${escapeDisplayLabel(model.modelId)}`));
		container.addChild(textLine(`Status: ${found && modelRegistry.hasConfiguredAuth(found) ? "available" : "unavailable"}`));
		thinkingOptionsFor(found).forEach((level, index) => container.addChild(textLine(selectableLine(state.row === index, `Thinking: ${thinkingLabel(level)}`))));
		container.addChild(textLine(selectableLine(state.row === thinkingOptionsFor(found).length, "Remove model")));
		return container;
	}

	function renderWizardComponent(): Component {
		const container = new Container();
		let title: string;
		let items: SelectItem[];
		if (state.screen === "WIZARD_PROVIDER") {
			title = "Add model — Step 1/3 Provider";
			items = allProviders().map((provider, index) => ({ value: String(index), label: escapeDisplayLabel(provider) }));
		} else if (state.screen === "WIZARD_MODEL") {
			title = "Add model — Step 2/3 Model";
			items = modelsForProvider(state.wizardProvider).map((model, index) => ({ value: String(index), label: modelDisplay(model) }));
		} else {
			title = "Add model — Step 3/3 Thinking";
			items = thinkingOptionsFor(currentWizardModel()).map((level, index) => ({ value: String(index), label: thinkingLabel(level) }));
		}
		container.addChild(textLine(theme.fg("accent", title)));
		container.addChild(buildSelect(items));
		return container;
	}

	function renderDeleteComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const group = state.groups.find((candidate) => groupKey(candidate) === state.deleteKey);
		const otherScope = group ? state.groups.some((candidate) => candidate.name === group.name && candidate.scope !== group.scope) : false;
		container.addChild(textLine(theme.fg("warning", "Delete Model Group?")));
		container.addChild(textLine(group ? `${escapeDisplayLabel(group.name)} [${group.scope}] with ${group.models.length} models` : "Missing group"));
		if (otherScope) container.addChild(textLine("Same-name group in the other scope remains unaffected."));
		container.addChild(textLine(selectableLine(state.row === 0, "Keep group")));
		container.addChild(textLine(selectableLine(state.row === 1, "Delete group")));
		return container;
	}

	function activeComponent(): Component {
		if (state.screen === "LIST") return renderListComponent();
		if (state.screen === "EDITOR") return renderEditorComponent();
		if (state.screen === "MODEL_EDIT") return renderModelEditComponent();
		if (state.screen === "DELETE_CONFIRM") return renderDeleteComponent();
		return renderWizardComponent();
	}

	return {
		get focused() { return rootFocused; },
		set focused(value: boolean) { rootFocused = value; syncInputFocus(); },
		render: (width: number) => {
			syncInputFocus();
			return activeComponent().render(width).map((line) => truncateToWidth(line, width));
		},
		invalidate: () => groupNameInput.invalidate(),
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
				} else if (isEnter(data) || isEsc(data)) {
					commitName();
					state.activeTextInput = null;
				} else {
					groupNameInput.handleInput(data);
					state.editName = groupNameInput.getValue();
				}
				syncInputFocus();
				tui.requestRender();
				return;
			}
			if (isDeleteChord(data) && (state.screen === "LIST" || state.screen === "MODEL_EDIT")) deleteAction();
			else if (activeSelect && (state.screen === "LIST" || state.screen.startsWith("WIZARD_")) && (isUp(data) || isDown(data))) {
				const previousRow = state.row;
				activeSelect.handleInput(data);
				state.row = previousRow + (isDown(data) ? 1 : -1);
				clampRow();
				activeSelect.setSelectedIndex(state.row);
			}
			else if (activeSelect && (state.screen === "LIST" || state.screen.startsWith("WIZARD_")) && isEnter(data)) activate();
			else if (isUp(data)) { state.row--; clampRow(); }
			else if (isDown(data)) { state.row++; clampRow(); }
			else if (isLeft(data) || isEsc(data)) goBack();
			else if (isEnter(data)) activate();
			syncInputFocus();
			tui.requestRender();
		},
	};
}
