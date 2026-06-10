/**
 * Process-isolated E2E tests for the agenticoding extension.
 *
 * These tests spawn a fresh Node.js process per test case. Process isolation
 * means no shared singletons and no console races between test cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessHarness } from "./pty-harness.js";

/**
 * Create a fresh host, wait for READY, and return the harness.
 */
async function start(): Promise<ProcessHarness> {
  const h = new ProcessHarness();
  await h.waitForText("READY");
  return h;
}

async function withHarness(run: (h: ProcessHarness) => Promise<void>): Promise<void> {
  const h = await start();
  try {
    await run(h);
  } finally {
    try {
      h.write("exit");
    } catch {
      // already dead
    }
    h.close();
  }
}

describe("agenticoding E2E", () => {
  it("host starts and extension registers", async () => withHarness(async (h) => {
    h.write("tools");
    await h.waitForText("OK:");

    const snap = h.snapshot();
    assert.ok(snap.includes("notebook_write"), "notebook_write tool registered");
    assert.ok(snap.includes("notebook_read"), "notebook_read tool registered");
    assert.ok(snap.includes("notebook_index"), "notebook_index tool registered");
    assert.ok(snap.includes("notebook_topic_set"), "notebook_topic_set tool registered");
    assert.ok(snap.includes("handoff"), "handoff tool registered");
    assert.ok(snap.includes("spawn"), "spawn tool registered");
  }));

  it("notebook write/read round-trip", async () => withHarness(async (h) => {
    h.write('tool notebook_write {"name":"my-page","content":"Hello World"}');
    await h.waitForText("OK:Saved notebook page");

    h.write('tool notebook_read {"name":"my-page"}');
    await h.waitForText("OK:--- my-page ---");

    const snap = h.snapshot();
    assert.ok(snap.includes("Hello World"), "content persisted");
  }));

  it("notebook index reflects written pages", async () => withHarness(async (h) => {
    h.write('tool notebook_write {"name":"page-a","content":"Page A"}');
    await h.waitForText("OK:");

    h.write("tool notebook_index {}");
    await h.waitForText("page-a");

    // Second write should appear in index
    h.write('tool notebook_write {"name":"page-b","content":"Page B"}');
    await h.waitForText("OK:");

    h.write("tool notebook_index {}");
    await h.waitForText("page-b");

    const snap = h.snapshot();
    assert.ok(snap.includes("page-a"), "page-a in index");
    assert.ok(snap.includes("page-b"), "page-b in index");
  }));

  it("notebook_write overwrites existing page", async () => withHarness(async (h) => {
    h.write('tool notebook_write {"name":"page","content":"v1"}');
    await h.waitForText("OK:");

    // Clear accumulated output so we only check the second write/read
    h.clear();
    h.write('tool notebook_write {"name":"page","content":"v2"}');
    await h.waitForText("OK:");

    h.clear();
    h.write('tool notebook_read {"name":"page"}');
    await h.waitForText("OK:--- page ---");

    const snap = h.snapshot();
    assert.ok(snap.includes("v2"), "overwritten content present");
    assert.ok(!snap.includes("v1"), "old content absent from fresh output");
  }));

  it("notebook topic lifecycle: set via command, agent-set blocked", async () => withHarness(async (h) => {
    // Set topic via /notebook command (human-set)
    h.write("cmd notebook my-e2e-topic");
    await h.waitForText("OK");

    // Agent-set should be blocked (human is authoritative)
    h.write('tool notebook_topic_set {"topic":"agent-topic"}');
    await h.waitForText("ERR:");
    const snap = h.snapshot();
    assert.ok(
      snap.includes("authoritative"),
      "human-set topic blocks agent override",
    );
  }));

  it("agent-set topic works when unset", async () => withHarness(async (h) => {
    // No topic set yet -- agent can set
    h.write('tool notebook_topic_set {"topic":"fresh-agent-topic"}');
    await h.waitForText("OK:Active notebook topic:");
    const snap = h.snapshot();
    assert.ok(snap.includes("fresh-agent-topic"));
  }));

  it("handoff tool queues handoff state", async () => withHarness(async (h) => {
    h.write('tool handoff {"task":"test handoff task","direction":"next-phase"}');
    await h.waitForText("OK:Handoff started");
  }));

  it("commands are registered", async () => withHarness(async (h) => {
    h.write("cmds");
    await h.waitForText("OK:");

    const snap = h.snapshot();
    assert.ok(snap.includes("notebook"), "/notebook command registered");
    assert.ok(snap.includes("handoff"), "/handoff command registered");
  }));

  it("spawn tool errors gracefully without model infrastructure", async () => withHarness(async (h) => {
    // Without a real model/session manager, spawn should throw immediately.
    h.write('tool spawn {"prompt":"any task"}');
    await h.waitForText("ERR:");

    const snap = h.snapshot();
    assert.ok(snap.includes("No model") || snap.includes("ERR"), "spawn errors gracefully");
  }));

  it("handles errors gracefully", async () => withHarness(async (h) => {
    // Unknown tool
    h.write("tool nonexistent {}");
    await h.waitForText("ERR:unknown tool");

    // Invalid JSON
    h.write("tool notebook_write {bad json}");
    await h.waitForText("ERR:invalid json");

    // Unknown command
    h.write("cmd nonexistent");
    await h.waitForText("ERR:unknown command");
  }));
});
