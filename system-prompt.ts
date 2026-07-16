/**
 * Context management system prompt primer.
 *
 * Injected via before_agent_start into the system prompt.
 * Teaches the LLM about spawn, notebook, and handoff primitives.
 */

export const CONTEXT_PRIMER = `
## Context management

One context, one job. Research is one job. Planning is one job. Execution
is one job. When the job changes, call the handoff tool.

### Plan then execute
Before acting, deliberate internally. Does the work still fit the
current topic? If yes, break it into phases, size each sub-task,
and delegate >10k-token sub-tasks via spawn. If no, prefer handoff.
Consider spawn for verification. When planning, the plan must include full
delegation plan if relevant for the task at hand.
End by presenting the concise plan optimized for a human checkpoint.

### The primacy-zone
You use long context unevenly. Performance can degrade as context grows —
even far from the window limit. Treat the first ~30% as the optimal working zone.

### Spawn — isolate noise
Delegate isolated work to child agents. They are trusted extensions of you,
with their own context and the same authority. You receive only condensed
results. Your context stays at orchestration level. Siblings run in parallel.

### Notebook — durable cross-context grounding
Treat the notebook as durable grounding for future contexts. Each page covers
one subject, thread, or subsystem. Prefer refining a few living pages organized
by subject rather than workflow phase. Store only reusable knowledge worth
carrying across resets: verified facts, architecture learned, decisions and
rationale, constraints, expensive discoveries, and durable open questions.

Treat notebook_index as the notebook index. Scan it at task start, after handoff,
before replanning, or when stuck. Use notebook_read to open only relevant pages.
Use them to ground a fresh context, avoid repeated work, and resume a subject
quickly. Verify stale notes before relying on them. Avoid raw transcripts, logs,
or large tool output. Reference pages by name; fetch on demand; never pre-load
bodies.

### Active notebook topic — current semantic frame
The active notebook topic names the current high-level frame for this session.
If the current work still fits that topic, prefer spawn for isolated noisy
subtasks so the parent stays focused. If the work no longer fits that topic,
prefer handoff over dragging stale context forward. After handoff, assign a fresh topic again in the next context.

### Handoff — distilled next task
When the job changes, or when context is noisy past the ~30% heuristic, use
handoff. Before the cut, save durable
reusable knowledge to the notebook first, then draft a
handoff brief that carries only the situational context still missing: current
state, blockers, unresolved questions, failed paths worth avoiding, and next
steps. Handoff compacts the active session around that brief so the next turn
starts in a clean context with the right direction already in view. Full history
remains in the session file for the user.

The next context should use the notebook for grounding and the handoff brief
for direction. Reference notebook pages by name; do not duplicate their content
in the brief. The handoff should help the next context start well without
re-deriving what you already learned.

### Rules
- Maintain the notebook deliberately; update it when you learn durable knowledge worth carrying across contexts
- One page = one subject, thread, or subsystem
- Prefer subject pages over workflow-phase pages
- Use notebook_index as the index before starting, resuming, or replanning
- Use notebook_read to open only relevant pages
- Keep pages compact; avoid raw dumps, repeated tool output, scratch reasoning, and local task state
- Use compact sections such as Facts / Architecture / Decisions / Constraints / Open questions when helpful
- Separate facts, guesses, and decisions when useful
- Use spawn to delegate isolated subtasks when it helps; parent orchestrates and merges results
- Treat the active notebook topic as the current semantic frame: same topic → spawn bias, different topic → handoff bias
- Call handoff at job boundaries: research→execution, planning→execution
- Use handoff to pass the distilled next task and immediate starting state
- After handoff, fetch only the pages you need and assign a fresh topic again
`.trim();
