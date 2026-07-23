import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	__setModelGroupsFsForTests,
	createGroup,
	deleteGroup,
	loadModelGroups,
	modelGroupsPath,
	moveGroup,
	renameGroup,
	saveModelGroups,
	updateGroup,
	validateModelGroups,
} from "../../model-groups/store.js";
import { ModelGroupsPersistenceError, type ModelGroupScope, type ModelGroupsAccess } from "../../model-groups/types.js";
import { withTemp } from "./model-groups-helpers.js";

function access(cwd: string, policy: ModelGroupsAccess["policy"] = "global-project"): ModelGroupsAccess { return { cwd, policy }; }

function read(scope: ModelGroupScope, cwd: string): any {
	return JSON.parse(fs.readFileSync(modelGroupsPath(scope, cwd), "utf8"));
}

function registry(available = new Set(["openai:gpt-5", "anthropic:claude"])): any {
	const models = [
		{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "x" } },
		{ provider: "anthropic", id: "claude", reasoning: false },
	];
	return {
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.has(`${m.provider}:${m.id}`)),
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => available.has(`${model.provider}:${model.id}`),
	};
}

test("model groups store creates, round-trips, validates, renames, updates, deletes, and moves", () => withTemp(({ cwd }) => {
	assert.equal(Object.keys(loadModelGroups(access(cwd)).configs.project.groups).length, 0);
	createGroup("project", access(cwd), "review", { models: [] });
	assert.deepEqual(read("project", cwd).groups.review.models, []);
	assert.throws(() => createGroup("project", access(cwd), "review", { models: [] }), /already exists/);

	createGroup("project", access(cwd), "inherit-roundtrip", { models: [{ provider: "anthropic", modelId: "claude" }] });
	const inheritLoaded = loadModelGroups(access(cwd)).configs.project.groups["inherit-roundtrip"].models[0];
	assert.equal(inheritLoaded.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritLoaded, "thinkingLevel"), false);
	const inheritPersisted = read("project", cwd).groups["inherit-roundtrip"].models[0];
	assert.equal(inheritPersisted.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritPersisted, "thinkingLevel"), false);

	updateGroup("project", access(cwd), "review", { models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }] });
	renameGroup("project", access(cwd), "review", "reviewers");
	assert.equal(read("project", cwd).groups.review, undefined);
	assert.equal(read("project", cwd).groups.reviewers.models[0].thinkingLevel, "high");

	createGroup("project", access(cwd), "collision", { models: [] });
	assert.throws(() => renameGroup("project", access(cwd), "reviewers", "collision"), /already exists/);
	createGroup("global", access(cwd), "reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] });
	const loaded = loadModelGroups(access(cwd));
	const resolved = validateModelGroups(loaded, registry());
	const globalReviewers = resolved.find((g) => g.name === "reviewers" && g.scope === "global");
	assert.equal(globalReviewers?.validation.shadowedByProject, true);
	assert.deepEqual(globalReviewers?.validation.unavailableRefs, [{ provider: "missing", modelId: "nope" }]);
	assert.equal(globalReviewers?.validation.degraded, true);

	createGroup("global", access(cwd), "move-collision", { models: [] });
	createGroup("project", access(cwd), "move-collision", { models: [] });
	assert.throws(() => moveGroup(access(cwd), "move-collision", "project"), /already exists in project scope/);
	assert.ok(read("global", cwd).groups["move-collision"]);
	assert.ok(read("project", cwd).groups["move-collision"]);

	const deleted = deleteGroup("global", access(cwd), "reviewers");
	assert.equal(deleted.otherScopeHasOverride, true);
	moveGroup(access(cwd), "reviewers", "global");
	assert.ok(read("global", cwd).groups.reviewers);
	assert.equal(read("project", cwd).groups.reviewers, undefined);
}));

test("model groups load recovery handles malformed, schema-invalid, unsupported version, and backup failure", () => withTemp(({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{not json", "utf8");
	let loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues[0].kind, "corrupt-json");
	assert.ok(fs.existsSync(`${modelGroupsPath("global", cwd)}.bak`));

	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { bad: { models: [{ provider: 1 }] } } }), "utf8");
	loaded = loadModelGroups(access(cwd));
	const schemaIssue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(schemaIssue.kind, "schema-invalid");
	assert.equal(schemaIssue.scope, "project");
	assert.equal(schemaIssue.sourcePath, modelGroupsPath("project", cwd));
	assert.equal(schemaIssue.backupPath, `${modelGroupsPath("project", cwd)}.bak`);
	assert.match(schemaIssue.message, /provider/);
	assert.ok(fs.existsSync(schemaIssue.backupPath!));
	assert.equal(Object.keys(loaded.configs.project.groups).length, 0);

	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.kind, "unsupported-version");
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.version, 99);

	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("denied"); } });
	loaded = loadModelGroups(access(cwd));
	const issue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(issue.backupFailed, true);
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
	assert.throws(() => createGroup("project", access(cwd), "must-not-overwrite", { models: [] }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "load-recovery");
		return true;
	});
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
}));

test("model groups rename failure removes the generated temp file and preserves committed bytes", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	saveModelGroups("project", access(cwd), { version: 1, groups: { keep: { models: [] } } });
	const committedBytes = fs.readFileSync(sourcePath);
	const renameCause = new Error("rename denied");
	let generatedTempPath = "";

	__setModelGroupsFsForTests({
		renameSync: (from) => {
			generatedTempPath = String(from);
			assert.match(path.basename(generatedTempPath), /^model-groups\.json\.\d+\.\d+\.tmp$/);
			assert.ok(fs.readFileSync(generatedTempPath, "utf8").includes('"drop"'));
			throw renameCause;
		},
	});
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 1, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "rename");
		assert.equal(error.sourcePath, sourcePath);
		assert.equal(error.targetPath, generatedTempPath);
		assert.equal(error.cause, renameCause);
		return true;
	});

	assert.ok(generatedTempPath);
	assert.deepEqual(fs.readFileSync(sourcePath), committedBytes);
	assert.equal(fs.existsSync(generatedTempPath), false);
	assert.deepEqual(fs.readdirSync(path.dirname(sourcePath)).filter((name) => /^model-groups\.json\.\d+\.\d+\.tmp$/.test(name)), []);
}));

test("model groups rename cleanup failure remains supplemental to the original typed error", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	saveModelGroups("project", access(cwd), { version: 1, groups: { keep: { models: [] } } });
	const committedBytes = fs.readFileSync(sourcePath);
	const renameCause = new Error("rename denied");
	const cleanupCause = new Error("cleanup denied");
	let generatedTempPath = "";

	__setModelGroupsFsForTests({
		renameSync: (from) => {
			generatedTempPath = String(from);
			assert.ok(fs.existsSync(generatedTempPath));
			throw renameCause;
		},
		unlinkSync: (target) => {
			assert.equal(String(target), generatedTempPath);
			throw cleanupCause;
		},
	});
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 1, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "rename");
		assert.equal(error.sourcePath, sourcePath);
		assert.equal(error.targetPath, generatedTempPath);
		assert.equal(error.cause, renameCause);
		assert.match(error.message, /cleanup denied/);
		return true;
	});

	assert.ok(generatedTempPath);
	assert.deepEqual(fs.readFileSync(sourcePath), committedBytes);
	assert.equal(fs.existsSync(generatedTempPath), true);
}));

test("model groups persistence failures throw typed errors and preserve committed state", () => withTemp(({ cwd }) => {
	saveModelGroups("project", access(cwd), { version: 1, groups: { keep: { models: [] } } });
	__setModelGroupsFsForTests({ writeFileSync: () => { throw new Error("temp denied"); } });
	assert.throws(() => updateGroup("project", access(cwd), "keep", { models: [{ provider: "openai", modelId: "gpt-5" }] }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "temp-write");
		assert.equal(error.scope, "project");
		assert.equal(error.sourcePath, modelGroupsPath("project", cwd));
		assert.match(error.targetPath ?? "", /model-groups\.json\..+\.tmp$/);
		return true;
	});
	__setModelGroupsFsForTests(null);
	assert.ok(read("project", cwd).groups.keep);
	assert.equal(read("project", cwd).groups.keep.models.length, 0);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("rename denied"); } });
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 1, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.phase, "rename");
		return true;
	});
	__setModelGroupsFsForTests(null);
	assert.ok(read("project", cwd).groups.keep);
	assert.equal(read("project", cwd).groups.drop, undefined);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("delete denied"); } });
	assert.throws(() => deleteGroup("project", access(cwd), "keep"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "delete");
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-target-fails", { models: [] });
	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("target denied"); } });
	assert.throws(() => moveGroup(access(cwd), "move-target-fails", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "move");
		assert.equal(error.partialMove, undefined);
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-me", { models: [] });
	let writes = 0;
	__setModelGroupsFsForTests({ renameSync: (from, to) => { writes++; if (writes === 2) throw new Error("source denied"); fs.renameSync(from, to); } });
	assert.throws(() => moveGroup(access(cwd), "move-me", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.partialMove, "target-written-source-retained");
		assert.equal(error.phase, "source-remove");
		return true;
	});
}));

test("model groups strictly partitions schema and legacy version domains", () => withTemp(({ cwd }) => {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	const invalid: Array<[string, unknown, RegExp]> = [
		["root", [], /root/], ["version type", { version: "1", groups: {} }, /version/],
		["negative", { version: -1, groups: {} }, /version/], ["fraction low", { version: 0.5, groups: {} }, /version/],
		["fraction high", { version: 1.5, groups: {} }, /version/], ["groups", { version: 1, groups: [] }, /groups/],
		["group", { version: 1, groups: { bad: 1 } }, /group/],
		["provider missing", { version: 1, groups: { bad: { models: [{ modelId: "m" }] } } }, /provider/],
		["provider type", { version: 1, groups: { bad: { models: [{ provider: 1, modelId: "m" }] } } }, /provider/],
		["model missing", { version: 1, groups: { bad: { models: [{ provider: "p" }] } } }, /modelId/],
		["model type", { version: 1, groups: { bad: { models: [{ provider: "p", modelId: 1 }] } } }, /modelId/],
		["models", { version: 1, groups: { bad: { models: 1 } } }, /models/],
		["thinking", { version: 1, groups: { bad: { models: [{ provider: "p", modelId: "m", thinkingLevel: "turbo" }] } } }, /thinkingLevel/],
	];
	for (const [label, raw, message] of invalid) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project")!;
		assert.equal(issue.kind, "schema-invalid", label);
		assert.match(issue.message, message, label);
		assert.ok(fs.existsSync(`${projectPath}.bak`), label);
		assert.equal(Object.keys(loaded.configs.project.groups).length, 0, label);
	}
	for (const raw of [{ groups: { legacy: { models: [] } } }, { version: 0, groups: { legacy: { models: [] } } }]) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		assert.equal(loaded.issues.length, 0);
		assert.equal(loaded.configs.project.version, 1);
		updateGroup("project", access(cwd), "legacy", { models: [] });
		assert.equal(read("project", cwd).version, 1);
	}
}));

test("model groups use branded paths, global-only access, canonical own keys, and native max", () => withTemp(({ cwd }) => {
	assert.equal(modelGroupsPath("project", cwd, "branded-pi"), path.join(cwd, "branded-pi", "pi-agenticoding", "model-groups.json"));
	const raw = '{"version":1,"groups":{" __proto__ ":{"models":[{"provider":"p","modelId":"proto","thinkingLevel":"max"}]},"constructor":{"models":[]},"toString":{"models":[]}}}';
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), raw, "utf8");
	let loaded = loadModelGroups(access(cwd));
	for (const name of ["__proto__", "constructor", "toString"]) assert.ok(Object.hasOwn(loaded.configs.project.groups, name));
	assert.equal(loaded.configs.project.groups.__proto__.models[0].thinkingLevel, "max");
	saveModelGroups("project", access(cwd), loaded.configs.project);
	const persisted = read("project", cwd);
	assert.deepEqual(Object.keys(persisted.groups).sort(), ["__proto__", "constructor", "toString"].sort());
	assert.equal(Object.getPrototypeOf(loaded.configs.project.groups), null);

	for (const name of ["__proto__", "constructor", "toString"]) {
		deleteGroup("project", access(cwd), name);
		createGroup("global", access(cwd), ` ${name} `, { models: [] });
		updateGroup("global", access(cwd), name, { models: [{ provider: "p", modelId: name }] });
		moveGroup(access(cwd), name, "project");
		assert.ok(Object.hasOwn(read("project", cwd).groups, name));
		deleteGroup("project", access(cwd), name);
	}

	let projectProbe = false;
	__setModelGroupsFsForTests({ existsSync: (candidate) => {
		if (String(candidate).startsWith(cwd)) { projectProbe = true; throw new Error("project probed"); }
		return fs.existsSync(candidate);
	} });
	const untrusted = loadModelGroups(access(cwd, "global-only"));
	assert.equal(projectProbe, false);
	assert.equal(untrusted.merged.every((group) => group.scope === "global"), true);
	assert.throws(() => createGroup("project", access(cwd, "global-only"), "forbidden", { models: [] }), /global-only/);
	assert.equal(projectProbe, false);
}));

test("model groups direct save canonicalizes unique keys and rejects empty/colliding keys before write", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	saveModelGroups("project", a, { version: 1, groups: { committed: { models: [] } } });
	const unique: Record<string, any> = Object.create(null);
	Object.defineProperty(unique, " unique ", { value: { models: [] }, enumerable: true });
	saveModelGroups("project", a, { version: 1, groups: unique });
	assert.deepEqual(Object.keys(read("project", cwd).groups), ["unique"]);
	for (const keys of [["   "], ["same", " same "]]) {
		const groups: Record<string, any> = Object.create(null);
		for (const key of keys) Object.defineProperty(groups, key, { value: { models: [] }, enumerable: true });
		const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
		let writes = 0;
		__setModelGroupsFsForTests({ writeFileSync: (..._args: any[]) => { writes++; throw new Error("must not write"); } });
		assert.throws(() => saveModelGroups("project", a, { version: 1, groups }), (error) => {
			assert.ok(error instanceof ModelGroupsPersistenceError);
			assert.equal(error.operation, "save");
			assert.equal(error.phase, "config-validation");
			return true;
		});
		assert.equal(writes, 0);
		assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), before);
		__setModelGroupsFsForTests(null);
	}
}));
