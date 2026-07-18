// Shared types for the Y client. The protocol mirrors api/parser.py +
// schema/primitives.json. Keep these literal strings in sync with both.

export type PrimitiveName =
  | "title"
  | "text"
  | "equation"
  | "box"
  | "node"
  | "arrow"
  | "line"
  | "draw"
  | "draw_part";

export interface PrimitiveTag {
  tag: PrimitiveName;
  args: Record<string, string | number>;
}

export interface EducatorNotes {
  misconceptions?: string[];
  follow_ups?: string[];
  prereqs?: string[];
  difficulty?: string;
  error?: string;
}

export interface LearnerSession {
  ts: string;
  topic: string;
  primitives_count: number;
  concepts_seen: string[];
  mastered: string[];
  struggling: string[];
  summary: string;
  embedding?: number[];
}

export interface EvidenceConcept {
  name: string;
  description: string;
  confidence: number;
}

export interface LearningEvidence {
  evidence_id: string;
  user_id: string;
  conversation_id: string;
  source: "help_request" | "checkpoint_answer" | "legacy";
  timestamp: string;
  concepts: EvidenceConcept[];
  outcome: { correct: number; partial: number; incorrect: number };
  independence: number;
  evidence_strength: number;
  response_summary: string;
  misconception?: string;
  adaptation?: {
    adapted: boolean;
    reason?: string;
    steps?: number;
    rolled_back?: boolean;
  };
}

export interface ConceptBelief {
  name: string;
  mastery_mean: number;
  mastery_std: number;
  credible_low: number;
  credible_high: number;
  evidence_count: number;
  trend: number;
  misconception?: string;
}

export interface LatentPoint {
  ts: string;
  x: number;
  y: number;
  z: number;
  observations: number;
}

export interface LearnerState {
  schema_version: number;
  updated_at: string;
  observations: number;
  concept_beliefs: ConceptBelief[];
  latent_point: LatentPoint;
  latent_trajectory: LatentPoint[];
  profile_text: string;
  adapter: {
    base_version: string;
    parameter_count?: number;
    online_steps: number;
    rollback_count: number;
    trained_checkpoint?: boolean;
  };
}

export interface Checkpoint {
  checkpoint_id: string;
  conversation_id: string;
  question: string;
  concepts: string[];
  rubric: string;
  difficulty: "introductory" | "intermediate" | "transfer" | string;
  created_at: string;
}

export interface LearnerSnapshot {
  user_id: string;
  schema_version: number;
  sessions: LearnerSession[];
  evidence: LearningEvidence[];
  learner_state: LearnerState;
  concept_beliefs: ConceptBelief[];
  latent_trajectory: LatentPoint[];
  adapter_version: string;
  online_step_count: number;
  rollback_count: number;
  mastery_summary: {
    mastered: string[];
    struggling: string[];
    seen: string[];
  };
}

export interface LearnerUpdateEvent {
  ts?: string;
  topic?: string;
  primitives_count?: number;
  concepts_seen?: string[];
  mastered?: string[];
  struggling?: string[];
  summary?: string;
  has_embedding?: boolean;
  error?: string;
}

export type LessonEvent =
  | { event: "token"; data: { text: string } }
  | { event: "primitive"; data: PrimitiveTag }
  | { event: "educator_notes"; data: EducatorNotes }
  | { event: "learner_update"; data: LearnerUpdateEvent }
  | { event: "learner_state"; data: LearnerState }
  | { event: "checkpoint"; data: Checkpoint }
  | { event: "evidence"; data: LearningEvidence }
  | { event: "done"; data: { reason: string } }
  | { event: "error"; data: { message: string } };
