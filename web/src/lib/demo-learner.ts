import type { ConceptBelief, LearnerSnapshot, LearningDimensionName, DimensionBelief } from "./types";

// Presentation-only fixture. Never save it or send it as tutor context.
const topics: [string, string[], number, number][] = [
  ["Force components", ["Physics", "Mechanics", "Forces"], .72, 7],
  ["Normal force", ["Physics", "Mechanics", "Forces"], .42, 4],
  ["Newton's second law", ["Physics", "Mechanics", "Motion"], .84, 9],
  ["Conservation of energy", ["Physics", "Mechanics", "Energy"], .61, 5],
  ["Pythagorean theorem", ["Mathematics", "Geometry", "Triangles"], .88, 8],
  ["Trigonometric ratios", ["Mathematics", "Geometry", "Triangles"], .69, 6],
  ["Differentiation", ["Mathematics", "Calculus", "Derivatives"], .57, 4],
  ["Integration", ["Mathematics", "Calculus", "Integrals"], .38, 2],
];
const dimensions: LearningDimensionName[] = ["knowledge", "understanding", "retention", "reasoning", "application"];
const concepts: ConceptBelief[] = topics.map(([name, hierarchy, mean, count], index) => ({
  name, display_name: name, hierarchy,
  mastery_mean: mean, mastery_std: .12,
  credible_low: Math.max(0, mean - .2), credible_high: Math.min(1, mean + .2),
  evidence_count: count, help_evidence_count: 1, strong_evidence_count: count - 1,
  last_evidence_at: "2026-09-28T10:00:00Z", mastery_delta: index === 1 ? -.04 : .06,
  uncertainty_delta: -.02, trend: .03,
  dimensions: Object.fromEntries(dimensions.map((dimension, i) => {
    const value = Math.max(.1, Math.min(.95, mean + (2 - i) * .04));
    return [dimension, { mean: value, std: .12, credible_low: Math.max(0, value - .2), credible_high: Math.min(1, value + .2), evidence_count: count, status: value > .75 ? "well-supported" : value < .45 ? "needs-support" : "developing" }];
  })) as Record<LearningDimensionName, DimensionBelief>,
}));

export const DEMO_LEARNER: LearnerSnapshot = {
  user_id: "illustrative-sample-only", schema_version: 2, sessions: [], evidence: [],
  concept_beliefs: concepts, latent_trajectory: [], adapter_version: "sample", online_step_count: 0, rollback_count: 0,
  mastery_summary: { mastered: [], struggling: [], seen: concepts.map((c) => c.name) },
  learner_state: {
    schema_version: 2, revision: 1, updated_at: "2026-09-28T10:00:00Z", observations: 45,
    concept_beliefs: concepts, concept_relations: [], latent_trajectory: [],
    latent_point: { ts: "2026-09-28T10:00:00Z", x: 0, y: 0, z: 0, observations: 45 },
    last_activity: { concepts: ["Force components", "Normal force"] },
    profile_text: "Illustrative student: comfortable with Newton's second law; needs support distinguishing normal force from weight. These values are fictional, not measured learning outcomes.",
    adapter: { base_version: "sample", online_steps: 0, rollback_count: 0, representation_steps: 0, representation_rollbacks: 0, trained_checkpoint: false },
  },
};
