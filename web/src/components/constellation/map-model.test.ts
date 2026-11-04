import { describe, expect, it } from "vitest";
import type { ProfileEvent, ProfileHistory, ProfileRevision } from "@/lib/learner-contracts";
import { layout } from "./layout";
import { MAX_NODES, blend, conceptLabel, fromHistory, nodeState, regionLabel } from "./map-model";
import { sampleMap } from "./sample";

const NOW = new Date("2026-11-03T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111", S2 = "22222222-2222-4222-8222-222222222222";
const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`);
const [A, B, C] = ids(3, "a");

const event = (id: string, concept: string, at: string, outcome: ProfileEvent["outcome"] = "correct"): ProfileEvent => ({
  id, concept, dimension: "understand", outcome, modality: "tap", created_at: at, question: `Q about ${concept}`, answer: "an answer",
});

function revision(n: number, extra: Partial<ProfileRevision> = {}): ProfileRevision {
  return {
    schema_version: 1, revision: n, parent_revision: n > 1 ? n - 1 : null, session_id: n === 1 ? S1 : S2,
    observation_ids: [], beliefs: [], misconceptions: [], notes: [], links: [], consolidator: null,
    created_at: `2026-11-0${n}T10:00:00Z`, ...extra,
  };
}

const history: ProfileHistory = {
  revisions: [
    revision(1, {
      observation_ids: [A],
      beliefs: [{ concept: "attention.softmax", dimension: "understand", alpha: 1.2, beta: 2.8, half_life_hours: 24, last_evidence_at: "2026-11-03T10:00:00Z" }],
      misconceptions: [{ id: "attention.softmax/belief-equal", concept: "attention.softmax", description: "On attention.softmax: thinks weights are equal", status: "suspected", strength: 0.3, evidence: [A] }],
    }),
    revision(2, {
      observation_ids: [B, C],
      beliefs: [
        { concept: "attention.softmax", dimension: "understand", alpha: 4, beta: 1.5, half_life_hours: 48, last_evidence_at: "2026-11-03T11:00:00Z" },
        { concept: "attention.softmax", dimension: "apply", alpha: 2, beta: 1, half_life_hours: 24, last_evidence_at: "2026-11-03T11:00:00Z" },
        { concept: "linalg.dot_product", dimension: "recall", alpha: 3.5, beta: 1, half_life_hours: 1, last_evidence_at: "2026-11-01T00:00:00Z" },
      ],
      misconceptions: [{ id: "attention.softmax/belief-equal", concept: "attention.softmax", description: "On attention.softmax: thinks weights are equal", status: "active", strength: 0.9, evidence: [A, B] }],
      notes: [{ text: "Build on the dot-product picture.", cites: [B] }],
      links: [
        { source: "linalg.dot_product", target: "attention.softmax", kind: "builds_on", why: "Used dot products.", strength: 1, evidence: [B], provenance: "model", first_revision: 2 },
        { source: "attention.softmax", target: "nowhere.x", kind: "builds_on", why: "Dangling.", strength: 1, evidence: [B], provenance: "model", first_revision: 2 },
      ],
    }),
  ],
  events: [event(A, "attention.softmax", "2026-11-02T10:00:00Z", "incorrect"), event(C, "attention.softmax", "2026-11-03T10:30:00Z"),
    event(B, "linalg.dot_product", "2026-11-03T10:10:00Z")],
};

describe("profile → learner map", () => {
  it("is null for an empty profile, so the overlay shows the labelled sample", () => {
    expect(fromHistory({ revisions: [], events: [] })).toBeNull();
    const sample = sampleMap();
    expect(sample.sample).toBe(true);
    expect(sample.frames.map((f) => f.revision)).toEqual([1, 2]);
    // Nodes no revision has touched yet are unseen until a revision reaches them.
    expect(sample.frames[0].nodes.scaled_dot_product.state).toBe("unseen");
    expect(sample.frames[1].nodes.scaled_dot_product.state).not.toBe("unseen");
  });

  it("builds one frame per revision with dimensions, counts, states and regions", () => {
    const map = fromHistory(history, NOW)!;
    expect(map.sample).toBe(false);
    const [one, two] = map.frames;
    const soft = two.nodes["attention.softmax"];
    expect(soft.label).toBe("Softmax");
    expect(soft.dims[1]).toBeCloseTo(4 / 5.5);
    expect(soft.dims[2]).toBeCloseTo(2 / 3);
    expect(soft.dims[0]).toBeNull();
    expect(soft.counts[1]).toBe(4); // alpha + beta − 2
    expect(soft.state).toBe("misconception");
    expect(one.nodes["attention.softmax"].state).toBe("shaky"); // suspected does not mark a misconception
    expect(two.nodes["linalg.dot_product"].due).toBe(true); // past its 1 h half-life
    expect(two.nodes["linalg.dot_product"].state).toBe("solid"); // due is shown apart, never as a colour
    expect(map.regions.map((r) => r.label).sort()).toEqual(["Attention", "Linear algebra"]);
    expect(two.changed.sort()).toEqual(["attention.softmax", "linalg.dot_product"]);
  });

  it("keeps active, suspected and resolved misconceptions with their strength", () => {
    const map = fromHistory(history, NOW)!;
    expect(map.frames[0].nodes["attention.softmax"].misconceptions[0]).toMatchObject({ status: "suspected", strength: 0.3 });
    expect(map.frames[1].nodes["attention.softmax"].misconceptions[0]).toMatchObject({ status: "active", strength: 0.9 });
  });

  it("drops links with an unknown end and orders the replay path by answer time", () => {
    const map = fromHistory(history, NOW)!;
    const two = map.frames[1];
    expect(two.links.map((l) => l.target)).toEqual(["attention.softmax"]);
    expect(two.path).toEqual(["linalg.dot_product", "attention.softmax"]);
    expect(two.nodes["linalg.dot_product"].evidence).toEqual([B]);
  });

  it("satisfies the H0 ConstellationGraph contract", () => {
    const { graph } = fromHistory(history, NOW)!;
    const known = new Set(graph.nodes.map((n) => n.id));
    expect(graph.revision).toBe(2);
    expect(graph.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(graph.edges.every((e) => known.has(e.source) && known.has(e.target) && e.source !== e.target)).toBe(true);
    expect(graph.edges[0].kind).toBe("prerequisite");
    expect(graph.revisions.flatMap((r) => r.nodes).every((n) => known.has(n.id))).toBe(true);
    const soft = graph.nodes.find((n) => n.id === "attention.softmax")!;
    expect(soft.dimensions.map((d) => d.dimension)).toEqual(["understand", "apply"]);
    expect(soft.misconceptions).toEqual(["attention.softmax/belief-equal"]);
  });

  it("caps the map at 150 neurons by evidence weight", () => {
    const beliefs = Array.from({ length: 180 }, (_, i) => ({ concept: `topic.c${String(i).padStart(3, "0")}`, dimension: "recall" as const,
      alpha: 1 + (i % 7), beta: 1, half_life_hours: null, last_evidence_at: null }));
    const map = fromHistory({ revisions: [revision(1, { beliefs })], events: [] }, NOW)!;
    const nodes = Object.values(map.frames[0].nodes);
    expect(nodes).toHaveLength(MAX_NODES);
    expect(Math.min(...nodes.map((n) => n.weight))).toBeGreaterThanOrEqual(1);
    const placed = layout(map);
    expect(Object.keys(placed.nodes)).toHaveLength(MAX_NODES);
    expect(Object.values(placed.nodes).every((p) => Math.hypot(p[0] / 0.92, p[1] / 0.62, p[2] / 0.76) <= 1.0001)).toBe(true);
  });

  it("places neurons deterministically, so scrubbing never moves them", () => {
    const map = fromHistory(history, NOW)!;
    expect(layout(map)).toEqual(layout(map));
  });

  it("blends frames for the replay", () => {
    const [one, two] = fromHistory(history, NOW)!.frames;
    const mid = blend(one, two, 0.5);
    expect(mid.nodes["attention.softmax"].dims[1]).toBeCloseTo((0.3 + 4 / 5.5) / 2);
    expect(blend(one, two, 0.2).links).toEqual([]); // links written at this revision draw in later
    expect(blend(one, two, 1)).toBe(two);
  });

  it("names states, concepts and regions", () => {
    expect(nodeState([null, null, null, null, null], [])).toBe("unseen");
    expect(nodeState([0.8, null, null, null, null], [])).toBe("solid");
    expect(nodeState([0.8, null, null, null, null], [], 0.3)).toBe("shaky"); // the pooled mean decides when given
    expect(nodeState([0.5, null, null, null, null], [])).toBe("learning");
    expect(conceptLabel("attention.scaled_dot-product")).toBe("Scaled dot product");
    expect(conceptLabel("transformer.ffn-role", ["What does the FFN do at each position?"])).toBe("FFN role");
    expect(conceptLabel("attention.kv-cache", ["Why does the KV cache grow?", "kv again"])).toBe("KV cache");
    expect(conceptLabel("attention.scaling", ["Why Scale BY root d?"])).toBe("Scaling");
    expect(regionLabel("prob")).toBe("Probability");
    expect(regionLabel("transformer")).toBe("Transformer");
  });
});
