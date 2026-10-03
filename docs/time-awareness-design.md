# Time awareness for the pi agent

The agent cannot feel time. Most wall-clock is spent inside tools, and a few calls dominate it, yet the model sees none of it — it cannot tell a 0.1s grep from a 4-minute suite. Pi already measures most of this; the work is to surface it.

Three rules carry the design:

1. **Measure work, not wall clock.** A human may pause and return the next day; that must not move the agent's sense of elapsed time. Elapsed is accumulated *active* time, never a timestamp difference that spans idle. A step that fails or is cancelled is not exempt: observed execution advances the clock. A footer is shown only when Pi invokes the result hook (see §1).
2. **Every model-visible time is logical and relative.** An annotation carries only task-active elapsed time, expressed as a duration: a delta from the task origin, or a delta of one block. The cut anchor of §2 is one such logical duration, not an exception. No annotation we write is an absolute timestamp. The model may still encounter absolute wall-clock incidentally — a `date` call, a log line — but nothing we inject is absolute, so the agent's task sense stays anchored in logical deltas and cannot be skewed by idle gaps or by stray wall-clock readings. The single exception is the coarse current period (month and year) injected as an environment fact for retrieval freshness; see §3. It is not an elapsed-time annotation and carries no time of day.
3. **Record once, at the event; never write a per-request current value down.** Written annotations are historical facts — tool-result footers and the cut anchor of §2 — append-only, cache-stable, rewind-correct.

Absolute time still exists in the transcript. Pi stamps every session entry with an ISO `timestamp` already, so the design never records one a second time; the tree supplies ordering (`id`/`parentId`) and the entry timestamp supplies provenance.

**Out of scope:** *time instructions* and *per-request time values* in the system prompt. Adding time instructions there was considered and dropped — there is no evidence it improves agent behavior, and a value that changes every request does not belong in the longest-lived cache prefix. Each footer instead carries its own kind label, so the annotation is self-describing without a legend. The cut anchor of §2 is a logical duration like every tool-result footer; the only non-elapsed surface is the cache-stable current-period marker in §3.

## The work clock

`L` is the accumulated active time of the current task, measured in milliseconds from the task origin (`L = 0`). It advances only while the agent is *actually working*, which is exactly the union of two interval kinds:

- **Model generation** — assistant `message_start` → `message_end`.
- **Tool execution** — `tool_execution_start` → `tool_result`.

Everything outside those intervals is not work and does not advance `L`: idle, the gaps between loop steps, provider request latency and retry backoff (all of which occur before `message_start`), and compaction or branch-summarization generation (a low-level provider stream that emits no agent-loop `message_start`/`message_end`). Human-blocking waits inside an active interval are excluded through `ui_prompt_start` / `ui_prompt_end`. **Pi 0.99.2 limitation:** these independently dispatched events have no identity or emission timestamp; a delayed earlier extension handler can reorder them. Exact wait exclusion is not guaranteed until the host supplies an ordered, timestamped lifecycle.

**Mechanism.** Track an active-*depth* counter, not a boolean: parallel tool calls (and nested calls) mean several operations can be active at once. All measurement paths use the shared process-local monotonic source (`monotonicNow`), not calendar time; only accumulated elapsed readings are persisted. On each event, if the clock is currently active (`depth > 0` and no UI prompt is blocking), add `now − lastMark` to `L`; then set `lastMark = now` and adjust the counter/flags. Increment on assistant `message_start` and `tool_execution_start`; decrement on assistant `message_end` and `tool_result`; the UI-prompt pair toggles the blocking flag. Depth counting makes overlapping intervals count once, so `L` never double-counts.

`L` is a single monotonic reading, **read, never summed**. Concurrency has no effect on it: parallel calls overlap in wall clock but share one clock, and each reading simply states how much active time has elapsed at that instant.

`L` is the agent's sense of "time spent on the task". It is a **per-position value**, tracked on pi's session tree (see §2), never a lone mutable counter — after a rewind such a counter would still hold the abandoned branch's value, silently counting work that never happened.

### Precision vs rendering

Store `L` as an **integer number of milliseconds**. Round only when rendering, through one shared `formatDuration(ms)` used for every surface, and never persist the formatted string. The model never needs sub-second precision for a task measured in minutes or hours; the raw value stays exact on the tree and can be re-rendered later.

### Boundaries and carries

| Transition | Clock |
|---|---|
| `/new` | reset to 0; the task origin is the context's first prompt |
| compaction, `/handoff` | carry forward — same task; the origin reading is still on the branch; a retain-none cut also anchors the next context (§2) |
| fork, clone | inherit the conversation's `L` at the branch point |
| resume | restore `L` to the resumed position (the past) |
| rewind | read/restore `L` at the position |

Every carry is a read of the branch, not a value copied into a summary. The handoff anchor is the reverse direction: a display derived from the branch and written into the summary.

## 1. Annotate tool results

Tool results are the only annotated block — written once, at the event:

- **Tool results** (`tool_result` hook): append the footer to the model-facing content.
- **Assistant messages**: none. An earlier design stamped the generation interval on each assistant message, but the model reads those stamps in prior assistant turns and continues the pattern in its own output. Removing the stamp removes the same-role example; generation time still advances `L` (see The work clock), it is simply not annotated.
- **User prompts**: none. `L` is paused across human input, so a stamp on the next user prompt would carry the same reading as the preceding block end — a zero delta. The task's first prompt is the origin (`L = 0`), so it too would be constant. A stamp would be pure noise. The cut anchor of §2 is not a prompt stamp: it is written at the compaction event.

**Tool duration is measured uniformly.** Record a timestamp at `tool_execution_start` keyed by `toolCallId`; at `tool_result`, the block delta is `now − start`. This works for every tool — built-in, custom, MCP — with no per-tool handling, keeps the measurement independent of any value a tool self-reports, and closes the interval for results that reach this hook. If Pi ends execution without invoking it, `tool_execution_end` closes and persists the remaining span without adding a footer. The duration is the block's own execution; it is work, so it is measured, not timestamped. Constraints:

- Do not special-case any tool (for example bash's `wall_time_seconds`); there is one code path.
- Correlate on `toolCallId`; `tool_result` carries no timestamp of its own.
- Skip nested calls (`parentToolCallId` set): their results never reach the transcript, and their time is already inside the parent's interval.
- If no start was recorded (a call blocked before execution), omit the delta rather than invent one.
- When appending to `content`, return `structuredContent` unchanged too: replacing `content` without it drops the structured result.

### Failures and cancellations

Results that reach `tool_result` are annotated regardless of `isError`. Pi can bypass that hook for blocked, immediate, truncated, or pre-execution-aborted calls; synthetic error messages are not evidence that the hook ran.

- A footer carries a delta only when an execution start was observed; no start means no invented duration.
- If a started call ends without a result hook, `tool_execution_end` records its active time as model-invisible clock metadata. No footer is fabricated.
- Persistence depends on receiving a boundary event; abrupt process termination cannot record unobserved work.

Highest-value, cheapest signal. Written once and never edited, the footer joins the stable prefix — no recurring cost, no cache churn — and rewind re-reads it as a true historical fact.

**Parallel calls.** Each call's delta is measured independently from its own `tool_execution_start` to its own `tool_result`. Never sum a batch's deltas: parallel intervals overlap, so the sum can exceed the real elapsed time. The batch's contribution to `L` is already counted once by the continuous clock.

## 2. Track the clock on the history tree

`L` lives on pi's session tree as append-only `custom` entries — `pi.appendEntry("pi-schematic-clock", { version, l, toolCallId? })` at each boundary. Custom entries are branch-scoped and excluded from model context, which is exactly what a clock reading needs: durable for reconstruction, silent to the model until we choose to format it.

This is the mechanism pi-schematic already uses for the notebook (`notebook-entry` / `notebook-generation`, rebuilt by walking `sessionManager.getBranch()`) and that pi uses for virtual-model route state. The clock reading itself is a plain number; the entry's own `timestamp` already supplies absolute provenance, so nothing is duplicated.

- **Reconstruct** on `session_start` and `session_tree`: walk `getBranch()` in transcript order, applying independent boundary readings directly and tool-associated readings only at their retained result messages. Parallel completions can precede all batch results; associating by call ID prevents a partial rewind from inheriting a later tool's reading. Never parse rendered footers. `getBranch()` returns the full path including entries before a compaction, so the base survives compaction and `/handoff`.
- **Inject** only when writing a model-visible annotation (§1, §2): format the reading then, never store a formatted string.
- **Record** at each boundary — assistant message end, tool result, the UI-prompt pause/resume, and the compaction/handoff cut — so the series is fine-grained enough to reconstruct any interval; formatting remains coarse. Boundaries reached on an error or abort are recorded too, so a cancelled spike survives into the next context and across resume.

Compaction and branch summaries never store or carry the clock — the tree does — so the metadata stays deterministic and independent of any summary text. A cut is not a new origin either: it does not reset `L`, and the compaction generation itself is not measured (see The work clock).

A cut can, however, discard every footer that carried the reading. The new context is therefore anchored at the cut:

- **Retain-none cut (`/handoff`):** the logical now is embedded in the extension-owned compaction summary — the same block that already carries the continuation frame and the per-cut marker. `session_before_compact` reads `L` after the aborted run is finalized and renders it with `formatDuration`; written once, never edited.
- **Native compaction (Pi-generated summary):** the extension sends a one-shot model-visible custom message when compaction succeeds; it never uses a user turn, which handoff recovery would treat as delivery. **Pi 0.99.2 limitation:** idle sends persist immediately, but streaming sends with `triggerTurn: false` queue until a later turn end. Between-turn threshold compaction can therefore omit the anchor from immediate continuation and leave it non-durable until the queue flushes. The current public API cannot guarantee a durable cut anchor at this boundary; fixing that guarantee requires a host API change or explicit approval of a different feature contract.
- **Covered span (display only):** a summary may also show the active time it covers (`L_end − L_start`), so the model sees the span it lost. Both numbers come from the same clock readings at the cut and, when both are shown, are rendered in one line — never duplicated into a second surface.

## 3. Current period (month and year)

For web searches and prompts that reference "latest" / "current" / "bleeding edge", the agent needs a coarse sense of *when* it is. This is deliberately separate from `L`:

- **Content:** month and year only (for example `July 2025`). No day, weekday, time, or timezone — those invite exactly the wall-clock reasoning the rest of this design avoids.
- **Placement:** a stable system-prompt section (alongside the existing primer), present from the first request. The system prompt is never compacted, so it survives compaction and `/handoff` unchanged; only the month value rolls over.
- **Cadence:** refreshed at run boundaries. Because the text is invariant within a calendar month, re-rendering produces byte-identical content and does not churn the cached prefix; it changes only when the month rolls over.
- **Rationale:** it answers "what period is this?" for retrieval freshness, not "how long have I been working?". It is an environment fact, not an elapsed-time annotation.

## Time format

Self-describing, token-efficient, logical and relative:

| Surface        | Format                               | Example                     |
| -------------- | ------------------------------------ | --------------------------- |
| Tool footer    | `[<tool> +<step> \| task <elapsed>]` | `[read +6.1s \| task 2m14s]` |
| Cut anchor     | `[task elapsed <reading>]`           | `[task elapsed 47m12s]`     |
| Current period | `<Month> <Year>`                     | `July 2025`                 |

- `<tool>` names the tool whose result carries the footer, so each footer states *what* it measures, not just when.
- `<step>` is the element's own independently measured execution, signed, and **always rendered**; a zero or sub-100ms step floors to `0.1s`. `<elapsed>` is the cumulative task-active reading at the event.
- One shared `formatDuration(ms)` renders every elapsed field: `0.4s` (one decimal only under 10s), `42s`, `2m14s`, `1h02m`.
- No ISO, no timezone, no emoji.
- The cut anchor carries no delta; it states the reading at the cut. The current period is the sole non-elapsed surface (§3).

## Rewind and cache

- A written annotation is history: rewinding re-reads it, and the shared prefix stays byte-identical, so branches stay cache-hot.
- Never edit a written annotation — that invalidates cache from that block. Annotations stay correct because they track the logical task clock, not wall clock.
- Every model-visible annotation is appended history; nothing is injected per request, so there is no ephemeral suffix to keep stable.
- A handoff cut anchor is part of the compaction summary, so it rewinds with the cut: an abandoned branch takes its anchor with it, and the new context re-anchors from the clock entries.
