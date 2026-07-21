import type { LearnerSnapshot, LearnerState } from "./types";

/** Merge a live state without allowing a late GET/SSE response to rewind UI. */
export function applyLearnerState(
  current: LearnerSnapshot | null,
  incoming: LearnerState,
  userId: string,
): LearnerSnapshot {
  const currentRevision = current?.learner_state?.revision ?? 0;
  const incomingRevision = incoming.revision ?? 0;
  if (current && incomingRevision < currentRevision) return current;

  return {
    user_id: current?.user_id ?? userId,
    schema_version: incoming.schema_version,
    sessions: current?.sessions ?? [],
    evidence: current?.evidence ?? [],
    learner_state: incoming,
    concept_beliefs: incoming.concept_beliefs,
    latent_trajectory: incoming.latent_trajectory,
    adapter_version: incoming.adapter.base_version,
    online_step_count: incoming.adapter.online_steps,
    rollback_count: incoming.adapter.rollback_count,
    mastery_summary: current?.mastery_summary ?? {
      mastered: [],
      struggling: [],
      seen: incoming.concept_beliefs.map((belief) => belief.name),
    },
  };
}

/** Merge a GET snapshot through the same monotonic revision guard. */
export function applyLearnerSnapshot(
  current: LearnerSnapshot | null,
  incoming: LearnerSnapshot,
): LearnerSnapshot {
  const currentRevision = current?.learner_state?.revision ?? 0;
  const incomingRevision = incoming.learner_state?.revision ?? 0;
  return current && incomingRevision < currentRevision ? current : incoming;
}
