import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/attention-arc.v1.json";
import { LEARNING_DIMENSIONS, beliefMean, type DemoArcFixture } from "./learner-contracts";
import { MOVE_FIELDS, MOVE_KINDS, WIDGET_KINDS, isQuestion, widgetSpec, type MoveKind, type MoveOf } from "./tutor-moves";

interface Variant { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean }
const schema = JSON.parse(readFileSync(path.resolve(__dirname, "../../../schema/tutor-moves.v1.json"), "utf-8"));
const variants: Variant[] = schema.properties.moves.items.anyOf;
const byKind = Object.fromEntries(variants.map(v => [v.properties.type.enum![0], v])) as Record<MoveKind, Variant>;
const arc = fixture as unknown as DemoArcFixture;

describe("tutor move contract matches the strict schema", () => {
  it("lists the same kinds and properties in the same order", () => {
    expect(variants.map(v => v.properties.type.enum)).toEqual(MOVE_KINDS.map(kind => [kind]));
    for (const kind of MOVE_KINDS) {
      expect(Object.keys(byKind[kind].properties)).toEqual(MOVE_FIELDS[kind]);
      expect(byKind[kind].required).toEqual(MOVE_FIELDS[kind]);
      expect(byKind[kind].additionalProperties).toBe(false);
    }
  });

  it("shares enums with the TypeScript unions", () => {
    expect(byKind.widget.properties.kind.enum).toEqual(WIDGET_KINDS);
    expect(byKind.check.properties.dim.enum).toEqual(LEARNING_DIMENSIONS);
    expect(byKind.check.properties.kind.enum).toEqual(["mcq", "free"]);
    expect(byKind.turn_end.properties.reason.enum).toEqual(["wait", "done"]);
  });
});

describe("attention demo-arc fixture", () => {
  const moves = arc.turn.moves;

  it("is a waiting turn whose moves have exactly the schema fields", () => {
    for (const move of moves) expect(Object.keys(move)).toEqual(MOVE_FIELDS[move.type]);
    expect(moves.at(-1)).toEqual({ type: "turn_end", reason: "wait" });
    expect(moves.filter(m => m.type === "check")).toHaveLength(1);
    expect(moves.some(isQuestion)).toBe(true);
  });

  it("cites only brief ids and carries a parseable widget spec", () => {
    const refs = new Set(arc.brief.items.map(item => item.id));
    for (const move of moves.filter((m): m is MoveOf<"because"> => m.type === "because")) {
      for (const ref of move.refs) expect(refs).toContain(ref);
    }
    const widget = moves.find((m): m is MoveOf<"widget"> & { kind: "attention" } => m.type === "widget" && m.kind === "attention")!;
    expect(widgetSpec(widget).tokens).toEqual(["the", "cat", "sat", "down"]);
  });

  it("has a connected Constellation with ascending revisions", () => {
    const { nodes, edges, revisions, revision } = arc.constellation;
    const ids = new Set(nodes.map(node => node.id));
    for (const edge of edges) expect(ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target).toBe(true);
    expect(revisions.map(r => r.revision)).toEqual([1, 2]);
    expect(revisions.at(-1)!.revision).toBe(revision);
    const softmax = revisions[0].nodes.find(node => node.id === "softmax")!;
    expect(softmax.state).toBe("misconception");
  });

  it("links evidence, profile and brief", () => {
    const observed = new Set(arc.observations.map(o => o.observation_id));
    expect(new Set(arc.profile_revision.observation_ids)).toEqual(observed);
    for (const note of arc.profile_revision.notes) for (const id of note.cites) expect(observed.has(id)).toBe(true);
    expect(arc.brief.profile_revision).toBe(arc.profile_revision.revision);
    expect(beliefMean({ alpha: 1, beta: 3 })).toBe(0.25);
  });
});
