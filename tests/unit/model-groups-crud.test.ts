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
import { ModelGroupsPersistenceError, type ModelGroupScope } from "../../model-groups/types.js";
import { withTemp } from "./model-groups-helpers.js";

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
	assert.deepEqual(loadModelGroups(cwd).configs.project.groups, {});
	createGroup("project", cwd, "review", { models: [] });
	assert.deepEqual(read("project", cwd).groups.review.models, []);
	assert.throws(() => createGroup("project", cwd, "review", { models: [] }), /already exists/);

	createGroup("project", cwd, "inherit-roundtrip", { models: [{ provider: "anthropic", modelId: "claude" }] });
	const inheritLoaded = loadModelGroups(cwd).configs.project.groups["inherit-roundtrip"].models[0];
	assert.equal(inheritLoaded.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritLoaded, "thinkingLevel"), false);
	const inheritPersisted = read("project", cwd).groups["inherit-roundtrip"].models[0];
	assert.equal(inheritPersisted.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritPersisted, "thinkingLevel"), false);

	updateGroup("project", cwd, "review", { models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }] });
	renameGroup("project", cwd, "review", "reviewers");
	assert.equal(read("project", cwd).groups.review, undefined);
	assert.equal(read("project", cwd).groups.reviewers.models[0].thinkingLevel, "high");

	createGroup("project", cwd, "collision", { models: [] });
	assert.throws(() => renameGroup("project", cwd, "reviewers", "collision"), /already exists/);
	createGroup("global", cwd, "reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] });
	const loaded = loadModelGroups(cwd);
	const resolved = validateModelGroups(loaded, registry());
	const globalReviewers = resolved.find((g) => g.name === "reviewers" && g.scope === "global");
	assert.equal(globalReviewers?.validation.shadowedByProject, true);
	assert.deepEqual(globalReviewers?.validation.unavailableRefs, [{ provider: "missing", modelId: "nope" }]);
	assert.equal(globalReviewers?.validation.degraded, true);

	createGroup("global", cwd, "move-collision", { models: [] });
	createGroup("project", cwd, "move-collision", { models: [] });
	assert.throws(() => moveGroup(cwd, "move-collision", "project"), /already exists in project scope/);
	assert.ok(read("global", cwd).groups["move-collision"]);
	assert.ok(read("project", cwd).groups["move-collision"]);

	const deleted = deleteGroup("global", cwd, "reviewers");
	assert.equal(deleted.otherScopeHasOverride, true);
	moveGroup(cwd, "reviewers", "global");
	assert.ok(read("global", cwd).groups.reviewers);
	assert.equal(read("project", cwd).groups.reviewers, undefined);
}));

test("model groups load recovery handles malformed, schema-invalid, unsupported version, and backup failure", () => withTemp(({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{not json", "utf8");
	let loaded = loadModelGroups(cwd);
	assert.equal(loaded.issues[0].kind, "corrupt-json");
	assert.ok(fs.existsSync(`${modelGroupsPath("global", cwd)}.bak`));

	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { bad: { models: [{ provider: 1 }] } } }), "utf8");
	loaded = loadModelGroups(cwd);
	const schemaIssue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(schemaIssue.kind, "schema-invalid");
	assert.equal(schemaIssue.scope, "project");
	assert.equal(schemaIssue.sourcePath, modelGroupsPath("project", cwd));
	assert.equal(schemaIssue.backupPath, `${modelGroupsPath("project", cwd)}.bak`);
	assert.match(schemaIssue.message, /invalid model entry/);
	assert.ok(fs.existsSync(schemaIssue.backupPath!));
	assert.deepEqual(loaded.configs.project.groups, {});

	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	loaded = loadModelGroups(cwd);
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.kind, "unsupported-version");
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.version, 99);

	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("denied"); } });
	loaded = loadModelGroups(cwd);
	const issue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(issue.backupFailed, true);
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
	assert.throws(() => createGroup("project", cwd, "must-not-overwrite", { models: [] }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "load-recovery");
		return true;
	});
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
}));

test("model groups persistence failures throw typed errors and preserve committed state", () => withTemp(({ cwd }) => {
	saveModelGroups("project", cwd, { version: 1, groups: { keep: { models: [] } } });
	__setModelGroupsFsForTests({ writeFileSync: () => { throw new Error("temp denied"); } });
	assert.throws(() => updateGroup("project", cwd, "keep", { models: [{ provider: "openai", modelId: "gpt-5" }] }), (error) => {
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
	assert.throws(() => saveModelGroups("project", cwd, { version: 1, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.phase, "rename");
		return true;
	});
	__setModelGroupsFsForTests(null);
	assert.ok(read("project", cwd).groups.keep);
	assert.equal(read("project", cwd).groups.drop, undefined);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("delete denied"); } });
	assert.throws(() => deleteGroup("project", cwd, "keep"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "delete");
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", cwd, "move-target-fails", { models: [] });
	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("target denied"); } });
	assert.throws(() => moveGroup(cwd, "move-target-fails", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "move");
		assert.equal(error.partialMove, undefined);
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", cwd, "move-me", { models: [] });
	let writes = 0;
	__setModelGroupsFsForTests({ renameSync: (from, to) => { writes++; if (writes === 2) throw new Error("source denied"); fs.renameSync(from, to); } });
	assert.throws(() => moveGroup(cwd, "move-me", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.partialMove, "target-written-source-retained");
		assert.equal(error.phase, "source-remove");
		return true;
	});
}));
