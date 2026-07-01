/**
 * Readonly cache tests.
 *
 * Exercises populateFromSkills, populatePromptCacheFromResolvedCommandsAndDirs,
 * and cache lookups using real temp files with frontmatter — no mocks, same
 * pattern as readonly-bash-classifier.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir, withTempHome } from "./helpers.js";
import {
	cacheLookupCommand,
	cacheLookupCommandIssue,
	cacheLookupPrompt,
	cacheLookupSkill,
	cacheLookupSkillIssue,
	populateFromSkills,
	populatePromptCacheFromResolvedCommandsAndDirs,
} from "../../readonly-cache.js";
import { createState } from "../../state.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

async function writeMd(dir: string, name: string, frontmatter: Record<string, unknown>): Promise<string> {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\n${fm}\n---\n\nBody content.\n`);
	return filePath;
}

function makeSkill(name: string, filePath: string): Skill {
	return {
		name,
		description: `Test skill ${name}`,
		filePath,
		baseDir: "",
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: false,
	};
}

// ── Tests ─────────────────────────────────────────────────────────

test("cache lookups return null for unknown names", () => {
	const state = createState();
	assert.equal(cacheLookupSkill(state, "nonexistent-skill"), null);
	assert.equal(cacheLookupCommand(state, "nonexistent-command"), null);
});

test("populateFromSkills caches a skill with readonly: true", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "my-skill", { readonly: true, description: "Test" });
		populateFromSkills(state, [makeSkill("my-skill", filePath)]);

		assert.equal(cacheLookupSkill(state, "my-skill"), true);
		assert.equal(cacheLookupCommand(state, "my-skill"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills caches a skill with readonly: false", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "safe-skill", { readonly: false, description: "Test" });
		populateFromSkills(state, [makeSkill("safe-skill", filePath)]);

		assert.equal(cacheLookupSkill(state, "safe-skill"), false);
		assert.equal(cacheLookupCommand(state, "safe-skill"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills returns null for skill without readonly frontmatter", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "no-readonly", { description: "Test" });
		populateFromSkills(state, [makeSkill("no-readonly", filePath)]);

		assert.equal(cacheLookupSkill(state, "no-readonly"), null);
		assert.equal(cacheLookupCommand(state, "no-readonly"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills silently skips missing file", () => {
	const state = createState();
	populateFromSkills(state, [makeSkill("missing", "/nonexistent/path/skill.md")]);
	assert.equal(cacheLookupSkill(state, "missing"), null);
	assert.equal(cacheLookupCommand(state, "missing"), null);
});

test("populateFromSkills caches multiple skills", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const fp1 = await writeMd(dir, "alpha", { readonly: true, description: "A" });
		const fp2 = await writeMd(dir, "beta", { readonly: false, description: "B" });
		const fp3 = await writeMd(dir, "gamma", { description: "C" });
		populateFromSkills(state, [
			makeSkill("alpha", fp1),
			makeSkill("beta", fp2),
			makeSkill("gamma", fp3),
		]);

		assert.equal(cacheLookupSkill(state, "alpha"), true);
		assert.equal(cacheLookupSkill(state, "beta"), false);
		assert.equal(cacheLookupSkill(state, "gamma"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills returns null for non-boolean readonly frontmatter", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const fp1 = await writeMd(dir, "string-ro", { readonly: "yes" });
		const fp2 = await writeMd(dir, "number-ro", { readonly: 1 });
		const fp3 = await writeMd(dir, "array-ro", { readonly: [true] });
		populateFromSkills(state, [
			makeSkill("string-ro", fp1),
			makeSkill("number-ro", fp2),
			makeSkill("array-ro", fp3),
		]);

		assert.equal(cacheLookupSkill(state, "string-ro"), null);
		assert.equal(cacheLookupSkillIssue(state, "string-ro")?.kind, "invalid-readonly-value");
		assert.equal(cacheLookupSkill(state, "number-ro"), null);
		assert.equal(cacheLookupSkillIssue(state, "number-ro")?.kind, "invalid-readonly-value");
		assert.equal(cacheLookupSkill(state, "array-ro"), null);
		assert.equal(cacheLookupSkillIssue(state, "array-ro")?.kind, "invalid-readonly-value");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cacheLookupCommand falls back to prompts when no skill is loaded", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "prompt-only", { readonly: true });

		populateFromSkills(state, []);
		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

		assert.equal(cacheLookupSkill(state, "prompt-only"), null);
		assert.equal(cacheLookupCommand(state, "prompt-only"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/name prompt lookup stays distinct from /skill:name lookup for the same name", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const skillPath = await writeMd(dir, "shared-name", { readonly: false });
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "shared-name", { readonly: true });

		populateFromSkills(state, [makeSkill("shared-name", skillPath)]);
		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

		assert.equal(cacheLookupSkill(state, "shared-name"), false);
		assert.equal(cacheLookupPrompt(state, "shared-name"), true);
		assert.equal(cacheLookupCommand(state, "shared-name"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs caches prompt commands", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "command-prompt", { readonly: false });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "command-prompt",
			source: "prompt",
			description: "Command prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		}], dir, false);

		assert.equal(cacheLookupCommand(state, "command-prompt"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs caches resolved prompt template file paths", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "resolved-prompt", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "resolved-prompt",
			source: "prompt",
			description: "Resolved prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		}], dir, false);

		assert.equal(cacheLookupPrompt(state, "resolved-prompt"), true);
		assert.equal(cacheLookupCommand(state, "resolved-prompt"), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs caches .md files from project dir", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "proj-prompt", { readonly: false });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

		assert.equal(cacheLookupCommand(state, "proj-prompt"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs skips non-.md files", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(projectDir, "readme.txt"), "not markdown");
		await writeMd(projectDir, "real-prompt", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

		assert.equal(cacheLookupCommand(state, "real-prompt"), true);
		assert.equal(cacheLookupCommand(state, "readme"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs skips nonexistent dir silently", () => {
	const state = createState();
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", true);
	assert.equal(cacheLookupCommand(state, "anything"), null);
});

test("project prompt overrides global prompt for the same name", async () => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const workspace = await tmpDir();
		try {
			const globalDir = join(homeDir, ".pi", "agent", "prompts");
			const projectDir = join(workspace, ".pi", "prompts");
			await mkdir(globalDir, { recursive: true });
			await mkdir(projectDir, { recursive: true });
			await writeMd(globalDir, "shared", { readonly: false });
			await writeMd(projectDir, "shared", { readonly: true });

			populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, true);
			assert.equal(cacheLookupCommand(state, "shared"), true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});


test("resolved prompt command stays authoritative over directory fallback", async () => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const workspace = await tmpDir();
		try {
			const globalDir = join(homeDir, ".pi", "agent", "prompts");
			const projectDir = join(workspace, ".pi", "prompts");
			await mkdir(globalDir, { recursive: true });
			await mkdir(projectDir, { recursive: true });
			const resolvedPath = await writeMd(workspace, "shared-resolved", { readonly: false });
			await writeMd(globalDir, "shared-resolved", { readonly: true });
			await writeMd(projectDir, "shared-resolved", { readonly: true });

			populatePromptCacheFromResolvedCommandsAndDirs(state, [{
				name: "shared-resolved",
				source: "prompt",
				description: "Resolved command",
				sourceInfo: { path: resolvedPath, source: "test", scope: "temporary", origin: "top-level" },
			}], workspace, true);
			assert.equal(cacheLookupCommand(state, "shared-resolved"), false);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("resolved non-prompt command blocks prompt-dir fallback for the same name", async () => {
	const state = createState();
	const workspace = await tmpDir();
	try {
		const projectDir = join(workspace, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		const promptPath = await writeMd(projectDir, "shared-owned", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "shared-owned",
			source: "builtin" as any,
			description: "Builtin command",
			sourceInfo: { path: promptPath, source: "test", scope: "temporary", origin: "top-level" },
		}], workspace, true);
		assert.equal(cacheLookupCommand(state, "shared-owned"), null);
		assert.equal(cacheLookupCommandIssue(state, "shared-owned"), null);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("resolved prompt command rebinding to a different file refreshes the cache", async () => {
	const state = createState();
	const workspace = await tmpDir();
	try {
		const pathA = await writeMd(workspace, "shared-a", { readonly: true });
		const pathB = await writeMd(workspace, "shared-b", { readonly: false });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "shared-rebound",
			source: "prompt",
			description: "Resolved command A",
			sourceInfo: { path: pathA, source: "test", scope: "temporary", origin: "top-level" },
		}], workspace, false);
		assert.equal(cacheLookupCommand(state, "shared-rebound"), true);

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "shared-rebound",
			source: "prompt",
			description: "Resolved command B",
			sourceInfo: { path: pathB, source: "test", scope: "temporary", origin: "top-level" },
		}], workspace, false);
		assert.equal(cacheLookupCommand(state, "shared-rebound"), false);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs does not scan project dir when projectTrusted is false", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "proj-only", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, false);

		assert.equal(cacheLookupCommand(state, "proj-only"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs evicts deleted prompt entries on rebuild", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		const filePath = await writeMd(projectDir, "deleted-prompt", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
		assert.equal(cacheLookupCommand(state, "deleted-prompt"), true);

		await rm(filePath, { force: true });
		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
		assert.equal(cacheLookupCommand(state, "deleted-prompt"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs records invalid readonly value issues", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "broken-prompt", { readonly: "yes" });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
		assert.equal(cacheLookupCommand(state, "broken-prompt"), null);
		assert.equal(cacheLookupCommandIssue(state, "broken-prompt")?.kind, "invalid-readonly-value");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs records unreadable prompt issues", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await mkdir(join(projectDir, "dir-prompt.md"), { recursive: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
		assert.equal(cacheLookupCommand(state, "dir-prompt"), null);
		assert.equal(cacheLookupCommandIssue(state, "dir-prompt")?.kind, "unreadable-file");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs evicts untrusted project prompt entries on rebuild", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const projectDir = join(dir, ".pi", "prompts");
		await mkdir(projectDir, { recursive: true });
		await writeMd(projectDir, "trusted-only", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
		assert.equal(cacheLookupCommand(state, "trusted-only"), true);

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, false);
		assert.equal(cacheLookupCommand(state, "trusted-only"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("project/global precedence rebinding refreshes the cache for the same prompt name", async () => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const workspace = await tmpDir();
		try {
			const globalDir = join(homeDir, ".pi", "agent", "prompts");
			const projectDir = join(workspace, ".pi", "prompts");
			await mkdir(globalDir, { recursive: true });
			await mkdir(projectDir, { recursive: true });
			await writeMd(globalDir, "shared-priority", { readonly: false });
			await writeMd(projectDir, "shared-priority", { readonly: true });

			populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, true);
			assert.equal(cacheLookupCommand(state, "shared-priority"), true);

			populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, false);
			assert.equal(cacheLookupCommand(state, "shared-priority"), false);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("populateFromSkills reuses the cached entry while mtime is unchanged", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "stable-skill", { readonly: true });
		populateFromSkills(state, [makeSkill("stable-skill", filePath)]);
		const firstEntry = state.readonlySkillCache.get("stable-skill");
		assert.equal(firstEntry?.readonly, true);

		populateFromSkills(state, [makeSkill("stable-skill", filePath)]);
		const secondEntry = state.readonlySkillCache.get("stable-skill");
		assert.equal(secondEntry, firstEntry);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills records malformed frontmatter issues", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-skill.md");
		await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
		populateFromSkills(state, [makeSkill("broken-skill", filePath)]);

		assert.equal(cacheLookupSkill(state, "broken-skill"), null);
		assert.equal(cacheLookupSkillIssue(state, "broken-skill")?.kind, "malformed-frontmatter");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills refreshes changed frontmatter when mtime changes", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "mutable-skill", { readonly: true });
		populateFromSkills(state, [makeSkill("mutable-skill", filePath)]);
		assert.equal(cacheLookupSkill(state, "mutable-skill"), true);

		await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populateFromSkills(state, [makeSkill("mutable-skill", filePath)]);
		assert.equal(cacheLookupSkill(state, "mutable-skill"), false);
		assert.equal(cacheLookupCommand(state, "mutable-skill"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills clears an invalid issue after the skill is fixed", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "recover-skill", { readonly: "yes" });
		populateFromSkills(state, [makeSkill("recover-skill", filePath)]);
		assert.equal(cacheLookupSkillIssue(state, "recover-skill")?.kind, "invalid-readonly-value");

		await writeFile(filePath, `---\nreadonly: true\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populateFromSkills(state, [makeSkill("recover-skill", filePath)]);
		assert.equal(cacheLookupSkill(state, "recover-skill"), true);
		assert.equal(cacheLookupSkillIssue(state, "recover-skill"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populateFromSkills clears an unreadable issue after the skill becomes readable", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "recover-readable-skill.md");
		await mkdir(filePath, { recursive: true });
		populateFromSkills(state, [makeSkill("recover-readable-skill", filePath)]);
		assert.equal(cacheLookupSkillIssue(state, "recover-readable-skill")?.kind, "unreadable-file");

		await rm(filePath, { recursive: true, force: true });
		await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populateFromSkills(state, [makeSkill("recover-readable-skill", filePath)]);
		assert.equal(cacheLookupSkill(state, "recover-readable-skill"), false);
		assert.equal(cacheLookupSkillIssue(state, "recover-readable-skill"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs refreshes a prompt when the same path changes", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "mutable-prompt", { readonly: true });
		const commands = [{
			name: "mutable-prompt",
			source: "prompt" as const,
			description: "Mutable prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		}];

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommand(state, "mutable-prompt"), true);

		await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommand(state, "mutable-prompt"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs clears an invalid issue after the prompt is fixed", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = await writeMd(dir, "recover-prompt", { readonly: "yes" });
		const commands = [{
			name: "recover-prompt",
			source: "prompt" as const,
			description: "Recover prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		}];

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommandIssue(state, "recover-prompt")?.kind, "invalid-readonly-value");

		await writeFile(filePath, `---\nreadonly: true\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommand(state, "recover-prompt"), true);
		assert.equal(cacheLookupCommandIssue(state, "recover-prompt"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs records malformed frontmatter issues", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-yaml.md");
		await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
		const commands = [{
			name: "broken-yaml",
			source: "prompt" as const,
			description: "Broken yaml prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		}];

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommand(state, "broken-yaml"), null);
		assert.equal(cacheLookupCommandIssue(state, "broken-yaml")?.kind, "malformed-frontmatter");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("populatePromptCacheFromResolvedCommandsAndDirs clears an unreadable issue after the prompt becomes readable", async () => {
	const state = createState();
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "recover-readable.md");
		await mkdir(filePath, { recursive: true });
		const commands = [{
			name: "recover-readable",
			source: "prompt" as const,
			description: "Recover readable prompt",
			sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		}];

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommandIssue(state, "recover-readable")?.kind, "unreadable-file");

		await rm(filePath, { recursive: true, force: true });
		await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
		const future = new Date(Date.now() + 2_000);
		await utimes(filePath, future, future);

		populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
		assert.equal(cacheLookupCommand(state, "recover-readable"), false);
		assert.equal(cacheLookupCommandIssue(state, "recover-readable"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
