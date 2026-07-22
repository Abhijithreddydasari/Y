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
  hierarchy?: string[];
  facets?: Partial<Record<AssessedDimensionName, {
    score: number;
    confidence: number;
  }>>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  source?: "lesson" | "assessment" | "chat";
  pending?: boolean;
  error?: boolean;
}

export type LearningDimensionName =
  | "knowledge"
  | "understanding"
  | "retention"
  | "reasoning"
  | "application";

export type AssessedDimensionName = Exclude<LearningDimensionName, "retention">;

export interface DimensionBelief {
  mean: number;
  std: number;
  credible_low: number;
  credible_high: number;
  evidence_count: number;
  status: "insufficient-evidence" | "needs-support" | "developing" | "well-supported" | string;
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
    representation?: AdaptationOutcome;
    mastery?: AdaptationOutcome;
  };
}

export interface AdaptationOutcome {
  adapted: boolean;
  reason?: string;
  steps?: number;
  rolled_back?: boolean;
  before_loss?: number;
  after_loss?: number;
}

export interface ConceptBelief {
  name: string;
  display_name?: string;
  hierarchy?: string[];
  dimensions?: Record<LearningDimensionName, DimensionBelief>;
  mastery_mean: number;
  mastery_std: number;
  credible_low: number;
  credible_high: number;
  evidence_count: number;
  help_evidence_count: number;
  strong_evidence_count: number;
  last_evidence_at: string;
  mastery_delta: number;
  uncertainty_delta: number;
  trend: number;
  misconception?: string;
}

export interface KnowledgeNode {
  id: string;
  name: string;
  level: "subject" | "field" | "subfield" | "topic" | "subtopic" | "concept" | string;
  path: string[];
  children: KnowledgeNode[];
  concept_names: string[];
  concept_count: number;
  evidence_count: number;
  dimensions: Record<LearningDimensionName, DimensionBelief>;
}

export interface ConceptRelation {
  source: string;
  target: string;
  strength: number;
  kind: "semantic" | "co-occurrence" | "mixed" | string;
}

export interface LearnerActivity {
  evidence_id?: string;
  source?: LearningEvidence["source"];
  timestamp?: string;
  concepts?: string[];
  representation_adapted?: boolean;
  mastery_adapted?: boolean;
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
  revision: number;
  updated_at: string;
  observations: number;
  concept_beliefs: ConceptBelief[];
  latent_point: LatentPoint;
  latent_trajectory: LatentPoint[];
  concept_relations: ConceptRelation[];
  knowledge_hierarchy?: KnowledgeNode[];
  last_activity: LearnerActivity;
  profile_text: string;
  adapter: {
    base_version: string;
    parameter_count?: number;
    online_steps: number;
    rollback_count: number;
    representation_steps: number;
    representation_rollbacks: number;
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
  | { event: "generation_complete"; data: Record<string, never> }
  | { event: "educator_notes"; data: EducatorNotes }
  | { event: "learner_update"; data: LearnerUpdateEvent }
  | { event: "learner_state"; data: LearnerState }
  | { event: "checkpoint"; data: Checkpoint }
  | { event: "evidence"; data: LearningEvidence }
  | { event: "done"; data: { reason: string } }
  | { event: "error"; data: { message: string } };
