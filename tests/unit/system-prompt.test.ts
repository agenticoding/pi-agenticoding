import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_PRIMER } from "../../system-prompt.js";
import { createTestHost } from "./test-host.js";
import { makeTUICtx } from "./helpers.js";

test("CONTEXT_PRIMER states the notebook, topic, and handoff contracts", () => {
	assert.doesNotMatch(CONTEXT_PRIMER, /ledger/i,
		"CONTEXT_PRIMER should contain zero stale ledger references after the rename");

	const notebookParts = CONTEXT_PRIMER.split("### Notebook");
	const topicParts = CONTEXT_PRIMER.split("### Active notebook topic");
	const handoffParts = CONTEXT_PRIMER.split("### Handoff");
	const rulesParts = CONTEXT_PRIMER.split("### Rules");
	assert.equal(notebookParts.length, 2);
	assert.equal(topicParts.length, 2);
	assert.equal(handoffParts.length, 2);
	assert.equal(rulesParts.length, 2);

	const notebookSection = notebookParts[1].split("### Active notebook topic")[0];
	const topicSection = topicParts[1].split("### Handoff")[0];
	const handoffSection = handoffParts[1].split("### Rules")[0];
	const rulesSection = rulesParts[1];

	assert.match(notebookSection, /notebook_index/);
	assert.match(notebookSection, /notebook_read/);
	assert.match(notebookSection, /fresh context/i);
	assert.match(notebookSection, /two-tier cache/i);
	assert.match(notebookSection, /shared memory/i);
	assert.doesNotMatch(notebookSection, /durable cross-context grounding/i);
	assert.match(topicSection, /semantic frame/i);
	assert.match(topicSection, /prefer spawn/i);
	assert.match(topicSection, /prefer handoff/i);
	assert.match(handoffSection, /next instruction/i);
	assert.match(handoffSection, /verbatim/i);
	assert.match(handoffSection, /Hand off BEFORE executing/i);
	assert.match(handoffSection, /nextInstruction/i);
	assert.doesNotMatch(handoffSection, /draft a handoff prompt/i);
	assert.match(handoffSection, /notebook/i);
	assert.doesNotMatch(handoffSection, /\bbrief\b/i);
	assert.match(CONTEXT_PRIMER, /When the ask no longer matches the topic, call the handoff tool\./i);
	assert.match(rulesSection, /one subject, thread, or subsystem/i);
	assert.match(handoffSection, /situational context/i);
	assert.match(rulesSection, /non-recoverable knowledge/i,
		"rules must specify what the notebook must hold before handoff");
	assert.match(rulesSection, /current state, blockers, and next steps/i,
		"rules must explicitly list what the prompt carries");
	assert.doesNotMatch(rulesSection, /remaining situational context/i,
		"replaced with explicit list of what the prompt carries");
	assert.match(rulesSection, /Keep pages compact/i);
	assert.match(rulesSection, /handoff.*verify all important findings are persisted/i,
		"rules must require verifying all important findings are persisted before handoff");
	assert.match(rulesSection, /chaining handoffs/i);
	assert.match(rulesSection, /discard pages holding only recoverable code facts/i,
		"rules must explain when notebook pages may be deleted during handoff");
	assert.match(CONTEXT_PRIMER, /overlong child output is truncated/i);
});

test("before_agent_start injects notebook contracts plus live topic and page data", async () => {
	const pi = await createTestHost();
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "first line\nsecond line" }, undefined, undefined, makeTUICtx());

	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const result = await handler({ systemPrompt: "Base system prompt." }, ctx);

	assert.match(result.systemPrompt, /Base system prompt\./);
	assert.match(result.systemPrompt, /## Context management/);
	assert.match(result.systemPrompt, /## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/);
	assert.match(result.systemPrompt, /Resolve every relative or ambiguous time reference/);
	// Cached-prefix invariant: the anchor sits after the static primer and
	// before every dynamic section, exactly once. Count only up to the first
	// dynamic section — notebook page text lands after the anchor and may
	// legitimately contain a heading of the same name.
	const beforeDynamic = result.systemPrompt.slice(0, result.systemPrompt.indexOf("## Active Notebook Topic"));
	assert.equal(beforeDynamic.match(/## Current date/g)?.length, 1);
	const order = ["## Context management", "## Current date", "## Active Notebook Topic"]
		.map((marker) => result.systemPrompt.indexOf(marker));
	for (const [index, marker] of ["primer", "date anchor", "dynamic sections"].entries()) {
		assert.ok(order[index] >= 0, `${marker} marker must be present`);
	}
	assert.ok(order[0] < order[1], "date anchor must sit after the primer");
	assert.ok(order[1] < order[2], "date anchor must sit before the dynamic sections");
	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /Current topic: `oauth`/);
	assert.match(result.systemPrompt, /## Active Notebook Pages/);
	assert.match(result.systemPrompt, /notebook_read/);
	assert.match(result.systemPrompt, /Reference pages by name/i);
	assert.match(result.systemPrompt, /alpha: first line/);
});

// Caching contract: the anchor is rebuilt once per agent run, so two runs on
// the same host render byte-identical anchor blocks.
test("before_agent_start rebuilds the same date anchor on every run", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const first = await handler({ systemPrompt: "Base system prompt." }, ctx);
	const second = await handler({ systemPrompt: "Base system prompt." }, ctx);

	const anchor = dateAnchorOf(first.systemPrompt);
	// Guard: without this the comparison passes on two empty extracts.
	assert.match(anchor, /^## Current date\n\d{4}-\d{2}-\d{2} \(\w+\)/);
	assert.equal(dateAnchorOf(second.systemPrompt), anchor);
});

// Everything from the anchor heading up to the next injected section, so the
// comparison covers the whole block and nothing after it.
function dateAnchorOf(systemPrompt: string): string {
	const fromAnchor = systemPrompt.slice(systemPrompt.indexOf("## Current date"));
	return fromAnchor.split(/\n## (?!Current date)/)[0];
}

test("before_agent_start injects no-topic guidance when the topic is unset", async () => {
	const pi = await createTestHost();
	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const result = await handler({ systemPrompt: "Base system prompt." }, ctx);

	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /No active notebook topic is set\./);
	assert.match(result.systemPrompt, /notebook_topic_set/);
});
