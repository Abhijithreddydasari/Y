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

export interface LearnerSnapshot {
  user_id: string;
  sessions: LearnerSession[];
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
  | { event: "done"; data: { reason: string } }
  | { event: "error"; data: { message: string } };
