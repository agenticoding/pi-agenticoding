import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_PRIMER } from "../../system-prompt.js";
import registerAgenticoding from "../../index.js";
import { createTestPI, makeTUICtx } from "./helpers.js";

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
	assert.match(notebookSection, /future contexts/i);
	assert.match(topicSection, /semantic frame/i);
	assert.match(topicSection, /prefer spawn/i);
	assert.match(topicSection, /prefer handoff/i);
	assert.match(handoffSection, /handoff/i);
	assert.match(handoffSection, /notebook/i);
	assert.match(rulesSection, /one subject, thread, or subsystem/i);
});

test("before_agent_start injects notebook contracts plus live topic and page data", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	await pi.commands.get("notebook")!.handler("oauth", { hasUI: false, getContextUsage: () => null });
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "first line\nsecond line" }, undefined, undefined, makeTUICtx());

	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const result = await handler({ systemPrompt: "Base system prompt." }, ctx);

	assert.match(result.systemPrompt, /Base system prompt\./);
	assert.match(result.systemPrompt, /## Context management/);
	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /Current topic: `oauth`/);
	assert.match(result.systemPrompt, /## Active Notebook Pages/);
	assert.match(result.systemPrompt, /notebook_read/);
	assert.match(result.systemPrompt, /Reference pages by name/i);
	assert.match(result.systemPrompt, /alpha: first line/);
});

test("before_agent_start injects no-topic guidance when the topic is unset", async () => {
	const pi = createTestPI();
	registerAgenticoding(pi as any);
	const [handler] = pi.handlers.get("before_agent_start")!;
	const ctx = { ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false };
	const result = await handler({ systemPrompt: "Base system prompt." }, ctx);

	assert.match(result.systemPrompt, /## Active Notebook Topic/);
	assert.match(result.systemPrompt, /No active notebook topic is set\./);
	assert.match(result.systemPrompt, /notebook_topic_set/);
});
