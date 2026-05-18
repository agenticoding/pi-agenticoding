# pi-agenticoding

[![pi.dev package](https://img.shields.io/badge/pi.dev-package-purple)](https://pi.dev/packages/pi-agenticoding)
[![npm version](https://img.shields.io/badge/npm-0.1.0-blue)](https://www.npmjs.com/package/pi-agenticoding)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)

**A Pi extension that gives the LLM tools to manage its own context.** `spawn`, `ledger`, and `handoff` let the agent actively isolate work, persist reusable knowledge, and restart clean — without platform compaction or manual copy-paste.

---

## Table of Contents

- [Install](#install)
- [30-Second Try](#30-second-try)
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

That's it. Your agent now has `spawn`, `ledger_add`, `ledger_get`, `ledger_list`, and `handoff`. The status bar shows context usage and ledger count.

---

## What You Get

| Feature | What it looks like |
|---------|-------------------|
| **Context usage %** | `ctx 65%` in status bar — green < 30%, yellow < 50%, orange < 70%, red ≥ 70% |
| **Ledger count** | 📒 `3` when entries exist, hidden when empty |
| **`/handoff` command** | Instant pivot — agent drafts brief, compacts context, resumes |
| **`/ledger` command** | Overlay showing all entries with previews |
| **Auto-rehydration** | Ledger entries survive session restarts |
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

The agent uses three primitives as part of its normal workflow — not triggered by the user, not forced by the platform:

```
You: "Add OAuth to the backend"

  spawn("research OAuth best practices")
  spawn("audit current auth code")
         │
         ▼
  ledger_add("oauth-decisions", "Flow: PKCE. Scope: read+write.")
         │
         ├── spawn("implement token endpoint")
         └── spawn("write tests")
         │
         ▼
  handoff("Wire OAuth routes into the middleware stack.
           Ledger 'oauth-decisions' holds the constraints.")
```

The agent decided to spawn research children, save reusable findings to the ledger, delegate implementation subtasks, and handoff when context got noisy. **You said one sentence.**

---

## Core Primitives

### Spawn — Isolate Noise

Delegate messy work to an isolated child agent with clean context. The child inherits the parent's model and tools, works independently, and returns only the condensed result. Siblings run in parallel; the parent stays focused on orchestration. Children cannot spawn grandchildren (explosive branch prevention).

### Ledger — Continuity Across Cuts

A sparse continuity cache the agent curates while working. After discovering something reusable — a fact, constraint, decision, or expensive finding — it saves a named entry. Later contexts fetch entries on demand instead of re-deriving the work. The ledger persists across handoffs, context resets, and session restarts.

### Handoff — Deliberate Compaction

When context degrades or the job changes, the agent saves reusable state to the ledger, writes a focused brief preserving what's still missing, and restarts clean. The new context starts with the brief front-and-center, all ledger entries accessible, and zero noise.

**Rule of thumb:** The ledger holds reusable learned knowledge. Handoff carries the remaining situational context.

---

## The Primacy-Zone Heuristic

Research shows LLMs don't use context evenly — performance degrades **far from the token limit** as relevant information drifts into the "lost in the middle" zone. The first ~30% of the context window is a practical heuristic for where the model pays attention.

pi-agenticoding injects advisory watchdog reminders when context passes 30%, 50%, and 70%. These don't force action — but they give the agent awareness to decide: "Am I mid-task and clear, or has my context become noise?"

No other tool or platform provides this. They treat context as one undifferentiated block. pi-agenticoding gives the agent the visibility to act on what it knows about its own working memory.

---

## Why This Exists

The "lost in the middle" problem is well-documented academically (Liu et al., 2023). But the industry's response has been to manage context *around* the LLM — platform compaction, `/compact` commands, static injection files. None of these work well because none of them let the agent act on what it knows about its own state.

pi-agenticoding is directly tied to the [agenticoding.ai](https://agenticoding.ai) course, which teaches a disciplined Research → Plan → Execute → Validate workflow for production coding agents. This extension provides the context-management primitives that make that workflow automatable across long-running tasks and clean phase transitions.

A single summary blob mixes durable knowledge with transient situational context. pi-agenticoding separates them:

| Operation | Primitive | What It Prevents |
|-----------|-----------|-----------------|
| **Isolate** | Spawn | Context pollution from noisy subtasks |
| **Persist** | Ledger | Knowledge loss across resets and pivots |
| **Compact** | Handoff | Degradation from overstuffed context |

---

## Comparison

| | Platform auto-compaction | User-triggered compaction | Manual `/clear` or `/new` | **pi-agenticoding** |
|---|---|---|---|---|
| **Compaction** | Runtime decides | User decides | Manual wipe + copy-paste | **Agent decides** |
| **Subagents** | Pre-defined or manual trigger | None | None | **Agent spawns dynamically** |
| **Persistent memory** | Background-generated (if at all) | None | None — gone on reset | **Ledger — agent-curated reusable continuity** |
| **Context awareness** | Token count only | Token count only | None | **Primacy-zone heuristic (~30%)** |
| **Cross-session continuity** | Rare (opt-in, background) | Manual copy-paste | Manual copy-paste | **Ledger persists across restarts** |
| **Structured handoff** | No | No | No | **Yes — resets context while carrying forward non-ledger state explicitly** |

---

## Architecture

<details>
<summary><strong>How the three primitives wire together</strong></summary>

The extension hooks into pi's lifecycle:

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
  ledger: Map<string, string>
  epoch: number
  lastContextPercent: number | null
  pendingHandoff: { task, source } | null
  pendingRequestedHandoff: { direction, ... } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

</details>

<details>
<summary><strong>Deep dive → ARCHITECTURE.md</strong></summary>

See [ARCHITECTURE.md](ARCHITECTURE.md) for full module breakdown, tool schemas, lifecycle wiring, spawn depth tracking, and ledger rehydration algorithm.

</details>

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
