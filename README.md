# pi-agenticoding

[![pi.dev package](https://img.shields.io/badge/pi.dev-package-purple)](https://pi.dev/packages/pi-agenticoding)
[![npm version](https://img.shields.io/badge/npm-0.4.0-blue)](https://www.npmjs.com/package/pi-agenticoding)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)

**A Pi extension that gives the LLM tools to manage its own context.** `spawn`, `notebook`, and `handoff` let the agent actively isolate work, persist reusable knowledge, and restart clean — without platform compaction or manual copy-paste. Readonly mode adds a research posture when you want exploration without mutating the tree.

---

## Table of Contents

- [Install](#install)
- [What You Get](#what-you-get)
- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Core Primitives](#core-primitives)
- [The Primacy-Zone Heuristic](#the-primacy-zone-heuristic)
- [Why This Exists](#why-this-exists)
- [Comparison](#comparison)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Install

```bash
pi install npm:pi-agenticoding
```

Then disable pi's built-in compaction so handoff stays in control:

```json
// ~/.pi/agent/settings.json
{
  "compaction": { "enabled": false }
}
```

That's it. Your agent now has `spawn`, `notebook_write`, `notebook_read`, `notebook_index`, `notebook_topic_set`, and `handoff`. The status bar shows context usage, notebook count, active topic, and readonly when enabled.

---

## What You Get

| Feature | What it looks like |
|---------|-------------------|
| **Context usage %** | `ctx 65%` in status bar — green < 30%, yellow < 50%, orange < 70%, red ≥ 70%; `ctx --%` when usage is unknown |
| **Notebook count** | 📒 `3` when pages exist, dim `📒 0` when empty |
| **Active notebook topic** | 🧭 topic name — current semantic frame; human-set topics win over the agent |
| **Readonly mode** | 🔒 in status bar; `/readonly`, Ctrl+Shift+R, or `--readonly` — blocks write/edit, guards bash (classifier + OS sandbox when available); spawn inherits the posture |
| **`/handoff` command** | Instant pivot — agent drafts brief, compacts context, resumes |
| **`/notebook` command** | Bare `/notebook` opens the page overlay; `/notebook <topic>` sets the active topic |
| **Context warning widget** | At ≥70%, a TUI warning with spawn-vs-handoff guidance (topic- and readonly-aware) |
| **Auto-rehydration** | Notebook pages and readonly state survive session restarts |
| **Spawn transparency** | Watch child agents work in real time in the TUI |
| **Token cost visibility** | Each spawn reports input/output tokens, cache hits, and cost |
| **No polling** | Writes serialized via a process-local lock — no race conditions |

---

## The Problem

Every coding agent degrades as its context grows. The industry manages context *around* the LLM — and every approach falls short:

| Approach | How It Works | Where It Fails |
|----------|-------------|----------------|
| **Platform auto-compaction** | Runtime summarizes and trims the conversation | The platform doesn't know what's important — blunt summarization buries critical details |
| **User-triggered compaction** | User runs `/compact` when the session feels slow | The user doesn't know the agent's internal working state — it's guesswork |
| **Manual session reset** | User runs `/clear` and copies over relevant context | Lossy, tedious, error-prone — the user has to remember what mattered across dozens of turns |

All three share the same assumption: **context is something to be managed *for* the LLM.** The agent is a passive recipient that silently degrades when its context grows beyond what it can effectively use.

**pi-agenticoding flips this.** It gives the LLM tools to manage its own context actively and deliberately. The agent decides what's worth keeping, when to isolate noise, and when to restart clean.

---

## How It Works

The agent uses these primitives as part of its normal workflow — not triggered by the user, not forced by the platform:

```
You: "Add OAuth to the backend"

  notebook_topic_set("oauth")
  spawn("research OAuth best practices")
  spawn("audit current auth code")
         │
         ▼
  notebook_write("oauth-decisions", "Flow: PKCE. Scope: read+write.")
         │
         ├── spawn("implement token endpoint")
         └── spawn("write tests")
         │
         ▼
  handoff("Wire OAuth routes into the middleware stack.
           Notebook page 'oauth-decisions' holds the constraints.")
```

The agent set a topic, spawned research children, saved reusable findings to the notebook, delegated implementation subtasks, and handed off when context got noisy. **You said one sentence.**

---

## Core Primitives

### Spawn — Isolate Noise

Delegate messy work to an isolated child agent with clean context. The child inherits the parent's model, thinking level, cwd, and active registered tools executable in the child session, including MCP/extension tools such as ChunkHound when they are active and registered. Child-local notebook tools remain available, but children cannot spawn grandchildren or handoff. Under readonly, children inherit the posture: no write/edit, and bash stays guarded. Siblings run in parallel; the parent stays focused on orchestration.

### Notebook — Continuity Across Cuts

A sparse pocket notebook the agent curates while working. After discovering something reusable — a fact, constraint, decision, or expensive finding — it writes a named, subject-oriented page. Later contexts use `notebook_index` and `notebook_read` on demand instead of re-deriving the work. The notebook persists across handoffs, context resets, and session restarts. Starting a new session with `/new` resets all notebook pages.

**Active topic** names the current semantic frame via `notebook_topic_set` or `/notebook <topic>` (🧭 in the status bar). Same topic → prefer spawn for noisy subtasks; different topic → prefer handoff. Topics clear after handoff so the next context assigns a fresh one. Human-set topics are authoritative — the agent cannot override them.

### Handoff — Deliberate Compaction

When context degrades or the job changes, the agent saves reusable state to the notebook, writes a focused brief for what's still missing, and restarts clean. The brief is task-only plus primer — notebook bodies are not inlined; the next context fetches pages by name. Handoff requires a real brief and a meaningful context load (rejects empty briefs, sessions under ~30k tokens, or missing usage). The active topic clears on success so the next context sets a fresh one.

Under readonly, handoff is blocked unless you run `/handoff` or cross an eligible human topic boundary; readonly resumes after compaction.

**Rule of thumb:** The notebook holds reusable learned knowledge. Handoff carries the remaining situational context.

### Readonly — Explore Without Mutating

A session-persisted research posture for when you want the agent to investigate without changing the tree. Toggle with `/readonly` or Ctrl+Shift+R, or start with `--readonly`. Skills and prompts can declare `readonly: true` in frontmatter to defer-enable the posture when invoked.

While on: write/edit are blocked; bash is classified (allowlist / temp-only writes) and sandboxed on macOS (`sandbox-exec`) and Linux (`bwrap`) when available; spawn inherits the posture. This is a coding-agent guardrail, not a hardened security boundary. Toggle is UI-oriented (no-op when no UI is attached); state rehydrates across session resume.

---

## The Primacy-Zone Heuristic

Research shows LLMs don't use context evenly — performance degrades **far from the token limit** as relevant information drifts into the "lost in the middle" zone. The first ~30% of the context window is a practical heuristic for where the model pays attention.

pi-agenticoding injects band-throttled advisory watchdog reminders when context passes 30%, 50%, and 70%. Copy is topic- and readonly-aware. At ≥70%, a TUI warning widget reinforces spawn-vs-handoff guidance. These don't force action — they give the agent awareness to decide: "Am I mid-task and clear, or has my context become noise?"

No other tool or platform provides this. They treat context as one undifferentiated block. pi-agenticoding gives the agent the visibility to act on what it knows about its own working memory.

---

## Why This Exists

The "lost in the middle" problem is well-documented academically (Liu et al., 2023). But the industry's response has been to manage context *around* the LLM — platform compaction, `/compact` commands, static injection files. None of these work well because none of them let the agent act on what it knows about its own state.

pi-agenticoding is context engineering for [Pi](https://pi.dev): tools so the agent keeps the active working set **small and in the primacy zone**, instead of growing a single noisy transcript until quality collapses. It pairs with the open reference [Agentic Coding](https://agenticoding.ai) (and is listed there as a companion extension) without re-teaching the book’s full operating methodology here.

**Readonly** is the active guardrail for common non-mutating work — reviewing, planning, debugging, exploring — so those sessions don’t accidentally edit the tree while the agent researches and reasons.

Keeping context lean is also a **cost** control. Provider prompt caches are typically short-lived (commonly on the order of **~5 minutes** of idle time, with longer options on some models). When the cache expires, the next turn reprocesses the prefix — and **miss cost scales with how large that prefix is**. A session held near the primacy heuristic (ideally under ~30% of the window) makes those misses far cheaper than a bloated multi-hundred-k context that falls out of cache the same way. Smaller context also means less billed input on every turn, hit or miss.

A single summary blob mixes durable knowledge with transient situational context. pi-agenticoding separates them:

| Operation | Primitive | What It Prevents |
|-----------|-----------|-----------------|
| **Isolate** | Spawn | Context pollution from noisy subtasks |
| **Persist** | Notebook | Knowledge loss across resets and pivots |
| **Compact** | Handoff | Degradation from overstuffed context |
| **Guard** | Readonly | Unwanted mutations during research and exploration |

---

## Comparison

| | Platform auto-compaction | User-triggered compaction | Manual `/clear` or `/new` | **pi-agenticoding** |
|---|---|---|---|---|
| **Compaction** | Runtime decides | User decides | Manual wipe + copy-paste | **Agent decides** |
| **Subagents** | Pre-defined or manual trigger | None | None | **Agent spawns dynamically** |
| **Persistent memory** | Background-generated (if at all) | None | None — gone on reset | **Notebook — agent-curated reusable continuity** |
| **Context awareness** | Token count only | Token count only | None | **Primacy-zone heuristic (~30%)** |
| **Cross-session continuity** | Rare (opt-in, background) | Manual copy-paste | Manual copy-paste | **Notebook persists across restarts** |
| **Structured handoff** | No | No | No | **Yes — resets context while carrying forward non-notebook state explicitly** |

---

## Architecture

<details>
<summary><strong>How the primitives wire together</strong></summary>

The extension hooks into pi's lifecycle:

| Hook | What it does |
|------|-------------|
| `before_agent_start` | Injects context management primer + live notebook index; resolves deferred `readonly:` frontmatter |
| `context` | Injects advisory watchdog reminders when context > 30%; delivers readonly toggle nudges |
| `input` | Queues skill/prompt names for deferred readonly frontmatter resolution |
| `tool_call` | Readonly blocks write/edit/unguarded bash; blocks handoff unless a requested bypass is active |
| `session_start` | Rehydrates notebook pages and readonly state; resets on `/new` |
| `turn_end` | Updates TUI indicators (context %, notebook count, topic, readonly) |
| `agent_end` | Records last context usage percent; manages handoff enforcement cleanup |
| `session_before_compact` | Consumes pending handoff task and sets it as compaction summary |

All state lives in a single `AgenticodingState` instance:

```typescript
interface AgenticodingState {
  notebookPages: Map<string, string>
  activeNotebookTopic: string | null
  activeNotebookTopicSource: "human" | "agent" | null
  pendingTopicBoundaryHint: { from, to } | null
  readonlyEnabled: boolean
  epoch: number
  lastContextPercent: number | null
  pendingHandoff: { task, source } | null
  pendingRequestedHandoff: { direction, resumeReadonlyAfterHandoff, ... } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

</details>

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow and quality expectations.

## License

MIT — see [LICENSE](LICENSE).
