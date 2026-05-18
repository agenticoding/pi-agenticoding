# pi-agenticoding

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![npm version](https://img.shields.io/badge/npm-0.1.0-blue)
![Status](https://img.shields.io/badge/status-active-green)

**Context management for the pi coding agent.** Three primitives — spawn, ledger, handoff — that keep your agent focused, prevent context rot, and make complex multi-step tasks actually finish.

---

## Stop treating context like infinite RAM.

Every coding agent degrades as the conversation grows. The model "forgets" the beginning, hallucinates stale assumptions, and burns tokens re-deriving context it already knew. By the time you hit the token limit, performance has been degrading for a while — long before the error.

*pi-agenticoding* is the antidote. It gives your agent three concrete primitives for managing context deliberately, so it stays sharp across long sessions, survives session restarts, and can pivot between tasks without carrying dead weight.

> **What if your agent could hand off knowledge between sessions, isolate messy exploration to child contexts, and restart fresh without losing what it learned?**

That's what this does.

*This README was written by an agent, using the same primitives this extension teaches: spawn research subtasks, cache findings in a ledger, handoff to the next phase.*

---

## Table of Contents

- [Quick Start](#quick-start)
- [The Three Primitives](#the-three-primitives)
  - [Spawn — isolate noise](#spawn--isolate-noise)
  - [Ledger — continuity across cuts](#ledger--continuity-across-cuts)
  - [Handoff — deliberate compaction](#handoff--deliberate-compaction)
- [What You Get](#what-you-get)
- [Under the Hood](#under-the-hood)
- [Why This Exists](#why-this-exists)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

**1. Install**

```bash
pi install npm:pi-agenticoding
```

**2. You're done.**

Your agent now has access to `spawn`, `ledger_add`, `ledger_get`, `ledger_list`, and `handoff` tools. The status bar will show context usage and ledger entry count.

**Try it in 30 seconds:**

```bash
# Tell your agent:
# "Use spawn to research what the current primacy-zone heuristic says
#  about context degradation, then ledger_add a summary."
```

The agent spawns a child with its own clean context, researches, and caches the result. You can now reference that knowledge across turns without re-deriving it.

---

## The Three Primitives

### Spawn — isolate noise

Delegate messy, exploratory work to an isolated child agent. The child has its own clean context, inherits your model and active tools except `handoff`, and only gets `spawn` when depth allows it. The parent stays focused.

```typescript
// The agent calls spawn — you never see the child's messy exploration
spawn({
  prompt: "Research best error-handling patterns for async TypeScript.
           Summarize top 3 with code snippets.",
})
// Returns: a concise summary. All intermediate noise stays in the child.
```

- Max depth: 1 (parent → child only)
- Real-time TUI rendering of the child session
- Token cost and usage stats reported back
- Ledger writes from children are visible to parent (same shared state)

### Ledger — continuity across cuts

A sparse key-value cache that survives context resets, handoffs, and session restarts. The agent saves compact reusable knowledge — facts, decisions, constraints, discoveries — and fetches it on demand.

```typescript
// Save
ledger_add({
  name: "architecture-decision",
  content: "- We chose SQLite for local-first sync\n- Reason: offline-first requirement\n- Constraint: max 5 concurrent writers",
})

// Retrieve
ledger_get({ name: "architecture-decision" })
// → restores full body

// List
ledger_list()
// → architecture-decision: We chose SQLite for local-first sync
```

- Entries persist in the session file — survive restarts
- Newest write wins on rehydration
- Children share the same ledger (one truth across contexts)
- Capped at 50KB / 2000 lines per entry

### Handoff — deliberate compaction

When context gets noisy or the job changes, handoff replaces the active context with a clean restart brief. The agent captures what matters, inlines referenced ledger entries, and starts fresh.

```bash
# User triggers a handoff:
/handoff Implement auth module

# The agent:
#   1. Saves reusable state to the ledger
#   2. Drafts a concise brief that completes the picture
#   3. Calls handoff() — context compacts, brief becomes the new top
#   4. Continues in a clean context with all knowledge preserved
```

- `/handoff <direction>` command for user-triggered pivots
- `handoff()` tool for agent-initiated compaction
- Inlines referenced ledger entries (up to 3, 4000 chars) into the brief
- Full history preserved in session file — nothing lost

---

## What You Get

| Feature | What it looks like |
|---------|-------------------|
| **Context usage %** | `ctx 65%` in status bar — green < 30%, yellow < 50%, orange < 70%, red ≥ 70% |
| **Ledger count** | 📒 `3` when entries exist, hidden when empty |
| **`/handoff` command** | Instant pivot — agent drafts brief, compacts context, resumes |
| **`/ledger` command** | Overlay showing all entries with previews |
| **Auto-rehydration** | Ledger entries survive session restarts — determined by epoch |
| **Spawn transparency** | Watch child agents work in real time in the TUI |
| **Token cost visibility** | Each spawn reports input/output tokens, cache hits, and cost |
| **No polling** | writes are serialized via a process-local lock — no race conditions |

---

## Under the Hood

<details>
<summary><strong>Architecture overview</strong> — how the three primitives wire together</summary>

The extension hooks into pi's lifecycle at key points:

| Hook | What it does |
|------|-------------|
| `before_agent_start` | Injects context management primer + live ledger listing into system prompt |
| `context` | Injects advisory watchdog reminders when context > 30% |
| `session_start` | Rehydrates ledger from persisted entries; resets on `/new` |
| `turn_end` | Updates TUI indicators (context %, ledger count) |
| `agent_end` | Records last context usage percent |
| `session_before_compact` | Consumes pending handoff task and sets it as compaction summary |

All state lives in a single `AgenticodingState` instance:

```typescript
interface AgenticodingState {
  ledger: Map<string, string>          // keyed by kebab-case name
  epoch: number                        // set on first ledger_add, for rehydration
  lastContextPercent: number | null    // last reading from getContextUsage()
  pendingHandoff: { task, source } | null
  pendingRequestedHandoff: { direction, ... } | null
  childSessions: Map<string, AgentSession>  // render handoff queue keyed by toolCallId
  liveChildSessions: Map<string, AgentSession>  // live registry, including claimed sessions
  childSessionEpoch: number             // increments on /new to invalidate stale child updates
}
```

</details>

<details>
<summary><strong>The primacy-zone heuristic</strong> — why 30% matters</summary>

LLMs use context unevenly. Performance degrades as context grows — even far from the token limit. The **first ~30%** is a practical heuristic for keeping the current job in active focus. Past that, the agent is nudged to consider handoff.

The watchdog never force-disengages — it's advisory only. Three tiers:

- **30–50%**: "Consider handoff if the phase is done or context is noisy"
- **50–70%**: "Well past the heuristic — consider a deliberate handoff"
- **≥70%**: "Deep in the degraded zone. Save state, draft a brief, call handoff"

</details>

<details>
<summary><strong>Architecture deep dive</strong> → <code>ARCHITECTURE.md</code></summary>

See [ARCHITECTURE.md](ARCHITECTURE.md) for:
- Full module breakdown (handoff/, ledger/, spawn/, state.ts, system-prompt.ts, watchdog.ts)
- Tool definitions and parameter schemas
- Lifecycle hook wiring details
- Spawn depth tracking and child session lifecycle
- Ledger rehydration algorithm and epoch mechanics

</details>

---

## Why This Exists

LLM context management is underspecified. Most developers discover it the hard way — their agent starts forgetting, hallucinating, or grinding to a halt mid-task. There's no built-in vocabulary for "save this discovery" or "start fresh with what I've learned."

pi-agenticoding provides that vocabulary, embedded directly into the agent's toolset. The agent learns to manage its own context because the system teaches it how.

The three primitives aren't arbitrary — they correspond to the three fundamental operations in any context management system:

| Operation | Primitive | What it prevents |
|-----------|-----------|-----------------|
| Isolate | **Spawn** | Context pollution from noisy subtasks |
| Persist | **Ledger** | Knowledge loss across resets and pivots |
| Compact | **Handoff** | Degradation from overstuffed context |

---

## Contributing

Contributions are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](LICENSE).
