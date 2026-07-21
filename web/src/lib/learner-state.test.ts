import { describe, expect, it } from "vitest";
import { applyLearnerSnapshot, applyLearnerState } from "./learner-state";
import type { LearnerSnapshot, LearnerState } from "./types";

function state(revision: number): LearnerState {
  return {
    schema_version: 2,
    revision,
    updated_at: "2026-07-21T00:00:00Z",
    observations: revision,
    concept_beliefs: [],
    latent_point: { ts: "now", x: 0, y: 0, z: 0, observations: revision },
    latent_trajectory: [],
    concept_relations: [],
    last_activity: {},
    profile_text: "",
    adapter: {
      base_version: "test",
      online_steps: revision,
      rollback_count: 0,
      representation_steps: revision,
      representation_rollbacks: 0,
    },
  };
}

function snapshot(revision: number): LearnerSnapshot {
  const learnerState = state(revision);
  return {
    user_id: "learner",
    schema_version: 2,
    sessions: [],
    evidence: [],
    learner_state: learnerState,
    concept_beliefs: [],
    latent_trajectory: [],
    adapter_version: "test",
    online_step_count: revision,
    rollback_count: 0,
    mastery_summary: { mastered: [], struggling: [], seen: [] },
  };
}

describe("learner state revision guard", () => {
  it("applies an SSE state immediately and rejects older SSE data", () => {
    const live = applyLearnerState(null, state(4), "learner");
    expect(live.learner_state.revision).toBe(4);
    expect(applyLearnerState(live, state(3), "learner")).toBe(live);
  });

  it("does not let a late GET response rewind the live state", () => {
    const live = snapshot(8);
    expect(applyLearnerSnapshot(live, snapshot(7))).toBe(live);
    expect(applyLearnerSnapshot(live, snapshot(9)).learner_state.revision).toBe(9);
  });
});
