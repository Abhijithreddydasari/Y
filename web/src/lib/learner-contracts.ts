// Learner-model contracts mirrored from api/learning/learner_contracts.py (learner-v1).
// The server validates; these types describe what the API returns.
import type { Assistance } from "./board-types";
import type { TutorMove } from "./tutor-moves";

export const LEARNER_CONTRACTS_VERSION = "learner-v1";
export const LEARNING_DIMENSIONS = ["recall", "understand", "apply", "analyze", "transfer"] as const;
export type LearningDimension = typeof LEARNING_DIMENSIONS[number];
export type Outcome = "correct" | "partial" | "incorrect" | "unanswered";
export type MissClass = "cue" | "discrimination" | "execution" | "careless" | "structural";
export type Modality = "tap" | "typed" | "spoken" | "ink";
export type KeyStatus = "ok" | "suspect" | "wrong";

export interface EvidenceSource { event_id: string; modality: Modality; content_hash: string; element_ids: string[]; author: "learner" }
export interface Observation {
  schema_version: 1; observation_id: string; session_id: string; check_id: string;
  concept: string; dimension: LearningDimension; outcome: Outcome;
  misconception: string | null; miss_class: MissClass | null;
  assistance: Assistance & { hint_ids: string[] };
  confidence: number | null; labeler: "deterministic" | "baseten" | "openai" | "none"; label_confidence: number | null;
  outcome_p?: Partial<Record<Outcome, number>> | null; misconception_p?: Record<string, number>;
  other_misconception_p?: number | null; reasoning?: number | null; reasoning_shown?: number | null;
  format_weight: number; key_status: KeyStatus;
  sources: EvidenceSource[]; created_at: string;
}

/** Brief ids (K known, S shaky, M misconception, P preference, N note) are what `because` moves cite. */
export interface BriefItem { id: string; kind: "known" | "shaky" | "misconception" | "preference" | "note"; concept: string | null; text: string; evidence: string[] }
export interface LearnerBrief { schema_version: 1; brief_id: string; topic: string; profile_revision: number; items: BriefItem[] }

export interface Belief { concept: string; dimension: LearningDimension; alpha: number; beta: number; half_life_hours: number | null; last_evidence_at: string | null }
export interface MisconceptionEntry { id: string; concept: string; description: string; status: "active" | "suspected" | "resolved"; strength?: number; evidence: string[] }
export interface TeachingNote { text: string; cites: string[] }
export interface ProfileRevision {
  schema_version: 1; revision: number; parent_revision: number | null; session_id: string;
  observation_ids: string[]; beliefs: Belief[]; misconceptions: MisconceptionEntry[]; notes: TeachingNote[];
  consolidator: string | null; created_at: string;
}

export type NodeState = "unseen" | "learning" | "shaky" | "solid" | "misconception";
export interface DimensionState { dimension: LearningDimension; mean: number; evidence_count: number }
export interface ConstellationNode { id: string; label: string; state: NodeState; dimensions: DimensionState[]; misconceptions: string[]; evidence: string[]; due: boolean }
export interface ConstellationEdge { source: string; target: string; kind: "prerequisite" | "related" }
/** Nodes changed at this revision with their full state; replay in order to scrub. */
export interface GraphRevision { revision: number; session_id: string; created_at: string; summary: string; nodes: ConstellationNode[] }
export interface ConstellationGraph { schema_version: 1; revision: number; nodes: ConstellationNode[]; edges: ConstellationEdge[]; revisions: GraphRevision[] }

/** Shape of fixtures/attention-arc.v1.json, the two-session demo arc used for mocks. */
export interface DemoArcFixture {
  schema_version: 1; description: string;
  observations: Observation[]; profile_revision: ProfileRevision; brief: LearnerBrief;
  turn: { moves: TutorMove[] }; constellation: ConstellationGraph;
}

export const beliefMean = (belief: Pick<Belief, "alpha" | "beta">) => belief.alpha / (belief.alpha + belief.beta);
