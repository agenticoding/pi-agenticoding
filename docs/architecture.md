# Architecture

pi-agenticoding is a Pi extension. It registers tools and hooks into the agent lifecycle, and keeps session state in one `AgenticodingState` instance.

## Lifecycle hooks

| Hook | Role |
|---|---|
| `before_agent_start` | Injects the context-management primer and live notebook index; resolves deferred `readonly:` frontmatter |
| `context` | Advisory watchdog reminders when context is elevated; readonly toggle nudges |
| `input` | Queues skill/prompt names for deferred readonly frontmatter resolution |
| `tool_call` | Readonly blocks write/edit/unguarded bash; blocks handoff unless a requested bypass is active |
| `session_start` | Rehydrates notebook pages and readonly state; resets on `/new` |
| `turn_end` | Updates TUI indicators (context %, notebook count, topic, readonly) |
| `agent_end` | Records last context usage percent; handoff enforcement cleanup |
| `session_before_compact` | Consumes the pending handoff task and sets it as the compaction summary |

## State

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

## Behavioral notes

**Spawn** — Child inherits model, thinking level, cwd, and active registered tools executable in the child session (including MCP/extension tools when registered). Child-local notebook tools remain available. Children cannot spawn grandchildren or handoff. Under readonly, children inherit the posture.

**Notebook** — Agent-curated named pages **scoped to the current conversation/task**, not a long-lived memory product. Stored as session custom entries so pages survive handoff and resume of the same work stream; `/new` (fresh session) clears them with the conversation. That coupling avoids the stale-entry / invalidation problem of forever-memory systems. Active topic (`notebook_topic_set` or `/notebook <topic>`) frames spawn-vs-handoff preference; human-set topics are authoritative. Topic clears after a successful handoff.

**Handoff** — Requires a real brief and a meaningful context load (rejects empty briefs, very small sessions, or missing usage). Notebook bodies are not inlined into the brief; the next context in this work stream fetches pages by name. Under readonly, handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly can resume after compaction. Compaction replaces the prior transcript with the brief: the next turns see a small context again (quality), and providers start a new input prefix for billing/cache (the dropped history is no longer in that prefix). Spawn runs children in separate context so their token use does not permanently inflate the parent. This extension does not configure provider cache TTLs or breakpoints.

**Readonly** — Session-persisted research posture. Toggle via `/readonly`, Ctrl+Shift+R, or `--readonly`. Skills/prompts may set `readonly: true` in frontmatter to defer-enable when invoked. Write/edit always blocked at the tool boundary. Bash uses a two-layer guard:

| Platform | Enforcement |
|---|---|
| **macOS** | OS sandbox via `sandbox-exec` (Seatbelt) — kernel denies file writes outside the OS temp dir; classifier is secondary |
| **Linux** | OS sandbox via `bwrap` when available — read-only root + writable temp; classifier is secondary. Without `bwrap`, classifier only |
| **Windows** | **No OS / syscall-level sandbox.** `canUseOsSandbox()` is always false. Only the shell-command **classifier** runs — best-effort pattern matching. Known gaps: interpreter one-liners (`node -e`, `python -c`, …), piped indirection (`xargs`, etc.). **Not true write protection.** |

Coding-agent guardrail on every OS — not a hardened security boundary. Strongest on macOS/Linux with sandbox binaries present; weakest on Windows. UI-oriented toggle; state rehydrates on resume.

**Watchdog** — Band-throttled advisory reminders as context crosses practical pressure bands; high-usage TUI widget reinforces spawn-vs-handoff guidance (topic- and readonly-aware).

## Package layout (high level)

| Area | Role |
|---|---|
| `index.ts` | Extension entry: tools, hooks, wiring |
| `spawn/` | Child sessions and live TUI rendering |
| `notebook/` | Page store, tools, topic, rehydration |
| `handoff/` | Eligibility, brief, compaction bridge |
| `readonly-*.ts` / `os-sandbox.ts` | Readonly posture, bash policy, sandbox |
| `watchdog.ts` / `tui.ts` / `state.ts` | Pressure advisories, status UI, shared state |

## See also

- [README](../README.md) — install and primitives
- [why.md](why.md) — product rationale
