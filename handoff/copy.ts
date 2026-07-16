/** Shared handoff status copy used by command and tool lifecycle paths. */

/** Status shown after a handoff is requested but is not yet eligible. */
export const HANDOFF_REQUESTED_STATUS = "🤝 Handoff requested — waiting for eligible context";
/** Status shown when a topic boundary requires an eligible handoff. */
export const HANDOFF_REQUIRED_STATUS = "🤝 Handoff required — ready to compact";
/** Status shown while compaction is queued or running. */
export const HANDOFF_IN_PROGRESS_STATUS = "🤝 Handoff in progress";
