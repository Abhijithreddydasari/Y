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
  | "draw";

export interface PrimitiveTag {
  tag: PrimitiveName;
  args: Record<string, string | number>;
}

export type LessonEvent =
  | { event: "token"; data: { text: string } }
  | { event: "primitive"; data: PrimitiveTag }
  | { event: "done"; data: { reason: string } }
  | { event: "error"; data: { message: string } };
