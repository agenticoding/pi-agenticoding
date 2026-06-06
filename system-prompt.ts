/**
 * Context management system prompt primer.
 *
 * Injected via before_agent_start into the system prompt.
 * Teaches the LLM about spawn, notebook, and handoff primitives.
 */

function buildContextPrimer(handoffAutomaticEnabled: boolean, manualHandoffActive = false): string {
	const pivotGuidance = manualHandoffActive
		? `### Manual handoff — explicit operator request active
A manual /handoff request from the operator is active for this generated turn.
Save any durable reusable knowledge that aligns with the request to the
notebook first, then draft the handoff brief and call the handoff tool. Do not
replace the operator-requested handoff with ordinary automatic-disabled
clean-transition fallback guidance.`
		: handoffAutomaticEnabled
			? `### Handoff — distilled next task
When the job changes, or when context is noisy past the ~30% heuristic, use
handoff to finish extracting what matters from the current context before the
cut. Save durable reusable knowledge to the notebook first, then draft a
handoff brief that carries only the situational context still missing: current
state, blockers, unresolved questions, failed paths worth avoiding, and next
steps. Handoff compacts the active session around that brief so the next turn
starts in a clean context with the right direction already in view. Full history
remains in the session file for the user.

The next context should use the notebook for grounding and the handoff brief
for direction. Reference notebook pages by name; do not duplicate their content
in the brief. The handoff should help the next context start well without
re-deriving what you already learned.`
			: `### Context pivoting when automatic handoff is disabled
Automatic context compaction is guarded in normal agent turns. The handoff
tool is disabled for normal turns; use it only after an explicit manual
handoff request. At job boundaries or when context gets noisy, save durable
reusable knowledge to the notebook first. Then either continue inline if it is
still safe and clear, or tell the operator that a clean-context transition
would help and summarize the next direction they should provide.`;

	const topicGuidance = manualHandoffActive
		? `A manual /handoff request is active in this generated turn. Use the topic as
context to preserve, save durable notebook findings, draft the brief, and call
the handoff tool for the operator-requested transition.`
		: handoffAutomaticEnabled
			? `If the current work still fits that topic, prefer spawn for isolated noisy
subtasks so the parent stays focused. If the work no longer fits that topic,
prefer handoff over dragging stale context forward. After handoff, assign a
fresh topic again in the next context.`
			: `If the current work still fits that topic, prefer spawn for isolated noisy
subtasks so the parent stays focused. If the work no longer fits that topic,
save durable findings, continue inline only if safe, or tell the operator what
clean-context direction is needed.`;

	const jobBoundaryRule = manualHandoffActive
		? `- Complete the active manual /handoff request for this generated turn
- Save durable findings first, then call handoff with the distilled brief
- After handoff, fetch only the pages you need and assign a fresh topic again`
		: handoffAutomaticEnabled
			? `- Call handoff at job boundaries: research→execution, planning→execution
- Use handoff to pass the distilled next task and immediate starting state
- After handoff, fetch only the pages you need and assign a fresh topic again`
			: `- At job boundaries, save durable findings and avoid dragging stale context forward
- If continuing inline is unsafe, tell the operator the clean next direction clearly
- In any fresh context, fetch only the pages you need and assign a fresh topic again`;

	return `
## Context management

One context, one job. Research is one job. Planning is one job. Execution
is one job. ${manualHandoffActive ? "For this generated turn, complete the active manual /handoff request." : handoffAutomaticEnabled ? "When the job changes, call the handoff tool." : "When the job changes, save durable findings and keep the next direction explicit."}

### The primacy-zone heuristic
You use long context unevenly. Performance can degrade as context grows —
even far from the window limit. Treat the first ~30% as a practical heuristic
for keeping the current job near the front of attention. The system tells you
exact context usage after each turn, and watchdog reminders may be injected
before LLM calls when context is past the heuristic. Watchdog reminders are
advisory only.

### Spawn — isolate noise
Delegate isolated work to child agents. They are trusted extensions of you,
with their own context and the same authority. You receive only condensed
results. Parent context stays at orchestration level. Siblings run in parallel.

### Notebook — durable cross-context grounding
Treat the notebook as durable grounding for future contexts. Each page covers
one subject, thread, or subsystem. Prefer refining a few living pages organized
by subject rather than workflow phase. Store only reusable knowledge worth
carrying across resets: verified facts, architecture learned, decisions and
rationale, constraints, expensive discoveries, and durable open questions.

Treat notebook_index as the notebook index. Scan it at task start, after a clean
context transition, before replanning, or when stuck. Use notebook_read to open
only relevant pages. Use them to ground a fresh context, avoid repeated work,
and resume a subject quickly. Verify stale notes before relying on them. Avoid
raw transcripts, logs, or large tool output. Reference pages by name; fetch on
demand; never pre-load bodies.

### Active notebook topic — current semantic frame
The active notebook topic names the current high-level frame for this session.
${topicGuidance}

${pivotGuidance}

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
- Treat the active notebook topic as the current semantic frame: same topic → spawn bias, different topic → ${handoffAutomaticEnabled ? "handoff bias" : "clean-transition caution"}
${jobBoundaryRule}
`.trim();
}

export const CONTEXT_PRIMER = buildContextPrimer(true);

export function getContextPrimer(handoffAutomaticEnabled: boolean, manualHandoffActive = false): string {
	return buildContextPrimer(handoffAutomaticEnabled, manualHandoffActive);
}
