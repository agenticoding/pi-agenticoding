import test from "node:test";
import assert from "node:assert/strict";
import { createModelGroupsComponent } from "../../model-groups/tui.js";
import { ModelGroupsPersistenceError, type ModelGroupsBootValidation, type ResolvedModelGroup } from "../../model-groups/types.js";
import { theme } from "./helpers.js";
import { group } from "./model-groups-helpers.js";

function registry(): any {
	const models = [
		{ provider: "anthropic", id: "claude", reasoning: false },
		{ provider: "google", id: "gemini-no-auth", reasoning: true, configuredAuth: false },
		{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "x" } },
		{ provider: "openai", id: "gpt-no-auth", reasoning: true, configuredAuth: false },
	];
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => model.provider !== "missing" && model.configuredAuth !== false,
	};
}

function boot(groups: ResolvedModelGroup[]): ModelGroupsBootValidation { return { groups, loadIssues: [] }; }

function component(args: { groups?: ResolvedModelGroup[]; store?: any; notify?: (m: string, t?: any) => void; renderTheme?: any } = {}) {
	let renders = 0;
	const c = createModelGroupsComponent(
		{ requestRender: () => { renders++; } } as any,
		args.renderTheme ?? theme,
		registry(),
		"/tmp/project",
		() => {},
		{ initialValidation: boot(args.groups ?? []), store: args.store, notify: args.notify },
	);
	return { c, get renders() { return renders; } };
}

const ENTER = "\r";
const ESC = "\u001b";
const ESC_KITTY = "\u001b[27u";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const LEFT_SS3 = "\u001bOD";

function press(c: { handleInput?: (data: string) => void }, ...inputs: string[]): void {
	for (const input of inputs) c.handleInput?.(input);
}

function rendered(c: { render: (width: number) => string[] }): string {
	return c.render(100).join("\n");
}

test("model groups TUI list renders validation summary, health tags, add row, no Validate row, and confirmed D delete", () => {
	const override = group("review", { scope: "global" });
	override.validation.shadowedByProject = true;
	const degraded = group("mixed", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] });
	degraded.validation.degraded = true;
	degraded.validation.unavailableRefs = [{ provider: "missing", modelId: "nope" }];
	let groups = [override, group("review", { scope: "project" }), degraded];
	const deleteCalls: string[] = [];
	const store = {
		deleteGroup: (scope: string, _cwd: string, name: string) => { deleteCalls.push(`${scope}:${name}`); groups = groups.filter((candidate) => !(candidate.scope === scope && candidate.name === name)); return { otherScopeHasOverride: true }; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	let lines = c.render(100).join("\n");
	assert.match(lines, /Boot validation: 1 unavailable model references · 1 project overrides/);
	assert.match(lines, /project override/);
	assert.match(lines, /⚠ degraded/);
	assert.match(lines, /✗ unavailable/);
	assert.match(lines, /\+ Add group/);
	assert.doesNotMatch(lines, /Validate/);
	c.handleInput?.("D");
	lines = c.render(100).join("\n");
	assert.match(lines, /Delete Model Group/);
	assert.match(lines, /Same-name group in the other scope remains unaffected/);
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r");
	assert.deepEqual(deleteCalls, ["global:review"]);
	assert.doesNotMatch(c.render(100).join("\n"), /Delete Model Group/);
});

test("model groups TUI computes unique new-group names and opens editor after create", () => {
	let groups = [group("new-group", { scope: "project" })];
	const calls: string[] = [];
	const store = {
		createGroup: (scope: string, _cwd: string, name: string, def: any) => {
			calls.push(`${scope}:${name}:${def.models.length}`);
			groups = [...groups, group(name, { scope: "project" })];
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.handleInput?.("\u001b[B"); // + Add group
	c.handleInput?.("\r");
	assert.deepEqual(calls, ["project:new-group-2:0"]);
	assert.match(c.render(100).join("\n"), /Model Group: new-group-2/);
});

test("model groups TUI wizard renders provider/model/thinking steps and preserves state on add failure", () => {
	const messages: string[] = [];
	let updateCalls = 0;
	const groups = [group("review", { scope: "project" })];
	const store = {
		updateGroup: () => {
			updateCalls++;
			throw new ModelGroupsPersistenceError({
				operation: "save",
				scope: "project",
				sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
				phase: "rename",
				message: "add failed",
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	assert.match(text, /Add model — Step 1\/3 Provider/);
	assert.match(text, /anthropic/);
	assert.match(text, /openai/);
	assert.doesNotMatch(text, /google/);
	assert.doesNotMatch(text, /Step 4/);

	press(c, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Add model — Step 2\/3 Model/);
	assert.match(text, /openai\/gpt-5/);
	assert.doesNotMatch(text, /openai\/gpt-no-auth/);
	assert.doesNotMatch(text, /anthropic\/claude/);
	assert.doesNotMatch(text, /Step 4/);

	press(c, ENTER);
	text = rendered(c);
	assert.match(text, /Add model — Step 3\/3 Thinking/);
	for (const option of ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.match(text, new RegExp(`\\b${option}\\b`));
	}
	assert.doesNotMatch(text, /Step 4/);

	press(c, ENTER);
	assert.equal(updateCalls, 1);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /save failed at rename for project scope/);
	assert.match(messages[0], /add failed/);
	text = rendered(c);
	assert.match(text, /Add model — Step 3\/3 Thinking/);
	assert.doesNotMatch(text, /Model Group: review/);
});

test("model groups TUI Esc and left-arrow share wizard back-step behavior", () => {
	function atProvider() {
		const { c } = component({ groups: [group("review", { scope: "project" })] });
		press(c, ENTER, DOWN, DOWN, DOWN, ENTER);
		return c;
	}
	function atModel() {
		const c = atProvider();
		press(c, DOWN, ENTER);
		return c;
	}
	function atThinking() {
		const c = atModel();
		press(c, ENTER);
		return c;
	}

	const providerEsc = atProvider();
	const providerEscKitty = atProvider();
	const providerLeft = atProvider();
	press(providerEsc, ESC);
	press(providerEscKitty, ESC_KITTY);
	press(providerLeft, LEFT);
	assert.equal(rendered(providerEsc), rendered(providerLeft));
	assert.equal(rendered(providerEscKitty), rendered(providerLeft));
	assert.match(rendered(providerEsc), /Model Group: review/);

	const modelEsc = atModel();
	const modelLeft = atModel();
	press(modelEsc, ESC);
	press(modelLeft, LEFT);
	assert.equal(rendered(modelEsc), rendered(modelLeft));
	assert.match(rendered(modelEsc), /Add model — Step 1\/3 Provider/);

	const thinkingEsc = atThinking();
	const thinkingLeft = atThinking();
	const thinkingLeftSs3 = atThinking();
	press(thinkingEsc, ESC);
	press(thinkingLeft, LEFT);
	press(thinkingLeftSs3, LEFT_SS3);
	assert.equal(rendered(thinkingEsc), rendered(thinkingLeft));
	assert.equal(rendered(thinkingLeftSs3), rendered(thinkingLeft));
	assert.match(rendered(thinkingEsc), /Add model — Step 2\/3 Model/);
});

test("model groups TUI selected markers and primary labels use accent token", () => {
	const accentTheme = {
		fg: (name: string, text: string) => name === "accent" ? `<accent>${text}</accent>` : text,
		bold: (text: string) => text,
	};
	const list = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;

	let text = rendered(list);
	assert.match(text, /<accent>→<\/accent> <accent>review<\/accent> \[project\]/);
	press(list, DOWN);
	assert.match(rendered(list), /<accent>→<\/accent> <accent>\+ Add group<\/accent>/);

	const editor = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(editor, ENTER);
	text = rendered(editor);
	assert.match(text, /<accent>→<\/accent> <accent>Location: project<\/accent> ✓/);
	press(editor, DOWN, DOWN, DOWN);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>openai\/gpt-5<\/accent> \(available/);
	press(editor, DOWN);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>\+ Add model…<\/accent>/);

	press(editor, ENTER);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>anthropic<\/accent>/);
	press(editor, DOWN, ENTER);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>openai\/gpt-5<\/accent>/);
	press(editor, ENTER);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>inherit<\/accent>/);

	const modelEdit = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(modelEdit, ENTER, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(modelEdit), /<accent>→<\/accent> <accent>Thinking: inherit<\/accent>/);

	const deleteConfirm = component({ groups: [group("review", { scope: "project" })], renderTheme: accentTheme }).c;
	press(deleteConfirm, "D");
	assert.match(rendered(deleteConfirm), /<accent>→<\/accent> <accent>Keep group<\/accent>/);
	press(deleteConfirm, DOWN);
	assert.match(rendered(deleteConfirm), /<accent>→<\/accent> <accent>Delete group<\/accent>/);
});

test("model groups TUI model edit renders identity/status and filters thinking options", () => {
	const groups = [group("review", { scope: "project", models: [
		{ provider: "anthropic", modelId: "claude" },
		{ provider: "openai", modelId: "gpt-5" },
		{ provider: "missing", modelId: "nope" },
	] })];
	const { c } = component({ groups });

	press(c, ENTER, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	assert.match(text, /Provider: anthropic/);
	assert.match(text, /Model ID: claude/);
	assert.match(text, /Status: available/);
	assert.match(text, /Thinking: inherit/);
	assert.equal(text.match(/Thinking:/g)?.length, 1);
	assert.doesNotMatch(text, /Thinking: off/);
	assert.doesNotMatch(text, /Thinking: (minimal|low|medium|high|xhigh)/);

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Model ID: gpt-5/);
	assert.match(text, /Status: available/);
	for (const option of ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.match(text, new RegExp(`Thinking: ${option}`));
	}

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Provider: missing/);
	assert.match(text, /Model ID: nope/);
	assert.match(text, /Status: unavailable/);
	assert.match(text, /Thinking: inherit/);
	assert.equal(text.match(/Thinking:/g)?.length, 1);
});

test("model groups TUI notifies and preserves location on move collision", () => {
	const messages: string[] = [];
	const groups = [group("review", { scope: "project" })];
	const store = {
		moveGroup: () => { throw new Error("target scope already contains review"); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, ENTER);
	assert.deepEqual(messages, ["target scope already contains review"]);
	const text = rendered(c);
	assert.match(text, /Model Group: review/);
	assert.match(text, /Location: project ✓/);
	assert.doesNotMatch(text, /Location: global ✓/);
});

test("model groups TUI notifies and preserves model edit state when updateGroup fails", () => {
	const messages: string[] = [];
	const attemptedModels: string[][] = [];
	const groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => {
			attemptedModels.push(def.models.map((model: any) => `${model.provider}/${model.modelId}/${model.thinkingLevel ?? "inherit"}`));
			throw new ModelGroupsPersistenceError({
				operation: "save",
				scope: "project",
				sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
				phase: "temp-write",
				message: `update failed ${attemptedModels.length}`,
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, ENTER, DOWN, ENTER);
	assert.deepEqual(attemptedModels[0], ["openai/gpt-5/off"]);
	assert.match(messages[0], /update failed 1/);
	let text = rendered(c);
	assert.match(text, /Edit model/);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Model ID: gpt-5/);
	assert.doesNotMatch(text, /Model Group: review/);

	press(c, "D");
	assert.deepEqual(attemptedModels[1], []);
	assert.match(messages[1], /update failed 2/);
	text = rendered(c);
	assert.match(text, /Edit model/);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Remove model/);
});

test("model groups TUI name edit commits through renameGroup on row-change and D in text input types literally", () => {
	let groups = [group("abc", { scope: "project" })];
	const calls: string[] = [];
	const store = {
		renameGroup: (_scope: string, _cwd: string, oldName: string, newName: string) => { calls.push(`${oldName}->${newName}`); groups = [group(newName, { scope: "project" })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.handleInput?.("\r"); // open editor
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // name row
	c.handleInput?.("\r"); // focus name
	c.handleInput?.("d");
	assert.match(c.render(100).join("\n"), /Name: abcd_/);
	c.handleInput?.("\u001b[B"); // row-change flushes the pending rename before moving to + Add model
	assert.deepEqual(calls, ["abc->abcd"]);
	const rendered = c.render(100).join("\n");
	assert.match(rendered, /Model Group: abcd/);
	assert.match(rendered, /→ \+ Add model/);
	assert.doesNotMatch(rendered, /Name: abcd_/);
	assert.doesNotMatch(rendered, /Delete Model Group/);
});

test("model groups TUI move, wizard add, model thinking, and remove persist through store calls", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })];
	const calls: string[] = [];
	const store = {
		moveGroup: (_cwd: string, name: string, scope: string) => { calls.push(`move:${name}:${scope}`); groups = [group(name, { scope: "global", models: groups[0].models })]; },
		updateGroup: (scope: string, _cwd: string, name: string, def: any) => { calls.push(`update:${scope}:${name}:${def.models.map((m: any) => `${m.provider}/${m.modelId}/${m.thinkingLevel ?? "inherit"}`).join(",")}`); groups = [group(name, { scope: scope as "project" | "global", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.handleInput?.("\r"); // editor
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r"); // switch global
	assert.equal(calls[0], "move:review:global");

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row
	c.handleInput?.("\r"); // model edit
	c.handleInput?.("\u001b[B"); // off
	c.handleInput?.("\r");
	assert.match(calls.at(-1)!, /update:global:review:openai\/gpt-5\/off/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // + add model
	c.handleInput?.("\r"); // provider step
	c.handleInput?.("\r"); // anthropic provider (sorted first)
	c.handleInput?.("\r"); // claude model
	c.handleInput?.("\r"); // inherit thinking
	assert.match(calls.at(-1)!, /anthropic\/claude\/inherit/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row after refresh
	c.handleInput?.("\r");
	c.handleInput?.("D");
	assert.ok(calls.at(-1)!.startsWith("update:global:review:"));
});

test("model groups TUI notifies and keeps visible state on persistence errors", () => {
	const messages: string[] = [];
	const { c } = component({
		groups: [group("review", { scope: "project" })],
		notify: (message) => messages.push(message),
		store: {
			renameGroup: () => {
				throw new ModelGroupsPersistenceError({
					operation: "save",
					scope: "project",
					sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
					targetPath: "/tmp/project/.pi/pi-agenticoding/model-groups.json.123.tmp",
					phase: "temp-write",
					message: "collision",
				});
			},
			listResolvedModelGroups: () => boot([group("review", { scope: "project" })]),
		},
	});
	c.handleInput?.("\r");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r");
	c.handleInput?.("2");
	c.handleInput?.("\r");
	assert.equal(messages.length, 1);
	assert.match(messages[0], /save failed at temp-write for project scope/);
	assert.match(messages[0], /source: \/tmp\/project\/\.pi\/pi-agenticoding\/model-groups\.json/);
	assert.match(messages[0], /target: \/tmp\/project\/\.pi\/pi-agenticoding\/model-groups\.json\.123\.tmp/);
	assert.match(messages[0], /collision/);
	assert.match(c.render(100).join("\n"), /Model Group: review/);
});
