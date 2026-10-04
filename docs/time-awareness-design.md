# Time awareness for the pi agent

The agent cannot feel time. Most wall-clock is spent inside tools, and a few calls dominate it, yet the model sees none of it — it cannot tell a 0.1s grep from a 4-minute suite. Pi already measures each tool call; the work is to surface it, not to build a clock.

Three rules carry the design:

1. **Measure work, not wall clock.** A footer reports one call's own execution, never a timestamp difference that spans idle. A call that fails or is cancelled is still observed execution; it carries a footer when Pi invokes the result hook (see [Tool footer](#tool-footer)).
2. **Every model-visible time is relative.** The only annotated surface is a tool-result footer, and it is a delta of one block — never a task-cumulative reading. The single exception is the coarse current period (month and year) injected as an environment fact for retrieval freshness; see §3. It is not an elapsed-time annotation and carries no time of day.
3. **Record once, at the event.** A written footer is a historical fact — append-only, cache-stable, rewind-correct. Nothing is injected per request except the cache-stable current period.

**Out of scope:** *time instructions* and *per-request time values* in the system prompt. Adding time instructions there was considered and dropped — there is no evidence it improves agent behavior, and a value that changes every request does not belong in the longest-lived cache prefix. Each footer carries its own tool-name label, so the annotation is self-describing without a legend.

## Tool footer

`tool_result` is the only annotated block, written once at the event. The footer is appended to the model-facing content by `formatBlockFooter(kind, deltaMs)` in `time/format.ts`.

**Tool duration is measured uniformly.** Record a timestamp at `tool_execution_start` keyed by `toolCallId`; at `tool_result`, the delta is `now − start`. This works for every tool — built-in, custom, MCP — with no per-tool handling, keeps the measurement independent of any value a tool self-reports, and closes the interval for results that reach this hook. Constraints:

- Do not special-case any tool (for example bash's `wall_time_seconds`); there is one code path.
- Correlate on `toolCallId`; `tool_result` carries no timestamp of its own.
- Skip nested calls (`parentToolCallId` set): their results never reach the transcript, and their time is already inside the parent's interval.
- If no start was recorded (a call blocked before execution), omit the delta rather than invent one — the footer renders `[<toolName>]`.
- When appending to `content`, return `structuredContent` unchanged too: replacing `content` without it drops the structured result.

### Body-less results

A footer must never be a result's only block: two consecutive body-less results would place two footers adjacent, unassignable to an element. When a result has no text or image body, a tool-name separator text block is inserted before the footer, so the footer is never adjacent to the previous block.

### Failures and cancellations

Results that reach `tool_result` are annotated regardless of `isError`. Pi can bypass that hook for blocked, immediate, truncated, or pre-execution-aborted calls; synthetic error messages are not evidence that the hook ran.

- A footer carries a delta only when an execution start was observed; no start means no invented duration.
- `tool_execution_end` deletes an orphaned start so the local map cannot grow. It is cleanup only: it adds no footer and persists nothing.
- Abrupt process termination cannot record unobserved work, because no result hook fires.

Highest-value, cheapest signal. Written once and never edited, the footer joins the stable prefix — no recurring cost, no cache churn — and rewind re-reads it as a true historical fact.

**Parallel calls.** Each call's delta is measured independently from its own `tool_execution_start` to its own `tool_result`. Never sum a batch's deltas: parallel intervals overlap, so the sum can exceed the real elapsed time.

## Time format

Self-describing, token-efficient, and relative:

| Surface      | Format          | Examples                                     |
| ------------ | --------------- | -------------------------------------------- |
| Tool footer  | `[<tool> +<n>]` | `[read +6.1s]`, `[bash +2m14s]`, `[grep]`     |
| Current period | `<Month> <Year>` | `July 2025`                                 |

- `<tool>` names the tool whose result carries the footer, so each footer states *what* it measures, not just when. A missing start renders `[<tool>]` with no delta.
- `<n>` is the element's own independently measured execution, signed, and **always rendered**; a zero or sub-100ms step floors to `0.1s`.
- One shared `formatDuration(ms)` renders the delta: `0.1s` (nonzero sub-100ms floors up so an abort never reads `+0s`), `0.4s` (one decimal under 10s), `42s`, `2m14s`, `1h02m`. Values are floored, never rounded; `0`, negative, or non-finite reads `0s`.
- No ISO, no timezone, no emoji.

## Current period (month and year)

For web searches and prompts that reference "latest" / "current" / "bleeding edge", the agent needs a coarse sense of *when* it is. This is deliberately separate from every elapsed measurement:

- **Content:** month and year only (for example `July 2025`). No day, weekday, time, or timezone — those invite exactly the wall-clock reasoning the rest of this design avoids.
- **Placement:** a stable system-prompt section, present from the first request. The system prompt is never compacted, so it survives compaction and `/handoff` unchanged; only the month value rolls over.
- **Cadence:** refreshed at each run boundary. Because the text is invariant within a calendar month, re-rendering produces byte-identical content and does not churn the cached prefix; it changes only when the month rolls over.
- **Rationale:** it answers "what period is this?" for retrieval freshness, not "how long have I been working?". It is an environment fact, not an elapsed-time annotation.

## Rewind and cache

- A written footer is history: rewinding re-reads it, and the shared prefix stays byte-identical, so branches stay cache-hot.
- Never edit a written footer — that invalidates cache from that block. Footers stay correct because they record a per-call delta at the event, not a live clock.
- The only injected surface is the current period; its text is invariant within a calendar month, so it does not churn the prefix.
