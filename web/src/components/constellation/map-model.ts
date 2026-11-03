// Learner map ("Your mind") model: profile revisions -> frames the brain view draws, plus the H0
// ConstellationGraph contract. Pure; the scene and the static view only read what this returns.
import {
  LEARNING_DIMENSIONS, beliefMean,
  type ConstellationGraph, type ConstellationNode, type MisconceptionEntry, type NodeState, type ProfileEvent,
  type ProfileHistory, type ProfileRevision, type TeachingNote,
} from "@/lib/learner-contracts";

export const MAX_NODES = 150;
export const MAX_EDGES = 600;
export const SOLID_AT = 0.7;
export const SHAKY_BELOW = 0.45;
/** Below this much evidence weight a neuron is drawn with a dashed membrane ("early read"). */
export const EARLY_BELOW = 3;
const PRIOR = 1; // Beta(1, 1): alpha + beta − 2 is the evidence weight a belief has absorbed

export interface MindMisconception { id: string; description: string; status: MisconceptionEntry["status"]; strength: number; evidence: string[] }
export interface MindLink {
  source: string; target: string; kind: "builds_on" | "confused_with"; why: string; strength: number;
  provenance: "model" | "system" | "sample"; evidence: string[]; first_revision: number;
}
export interface MindNode {
  id: string; label: string; region: string;
  /** Mean per dimension in LEARNING_DIMENSIONS order; null = never tested. */
  dims: (number | null)[];
  counts: number[];
  weight: number; mean: number | null; state: NodeState; due: boolean;
  misconceptions: MindMisconception[]; evidence: string[];
}
export interface MindFrame {
  revision: number; session_id: string; created_at: string; summary: string;
  nodes: Record<string, MindNode>; links: MindLink[]; notes: TeachingNote[];
  /** Concepts in the order this session's answers touched them (the replay's spike path). */
  path: string[];
  /** Nodes whose state changed at this revision. */
  changed: string[];
}
export interface MindRegion { id: string; label: string; nodes: string[] }
export interface MindMap { sample: boolean; frames: MindFrame[]; regions: MindRegion[]; events: Record<string, ProfileEvent>; graph: ConstellationGraph }

const REGION_NAMES: Record<string, string> = {
  attention: "Attention", linalg: "Linear algebra", prob: "Probability", calc: "Calculus", stats: "Statistics",
  ml: "Machine learning", nn: "Neural networks", algebra: "Algebra", geometry: "Geometry", physics: "Physics",
};

const sentence = (text: string) => {
  const t = text.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : text;
};
export const regionOf = (concept: string) => (concept.includes(".") ? concept.split(".")[0] : "general");
export const regionLabel = (region: string) => REGION_NAMES[region] ?? (region === "general" ? "General" : sentence(region));
/**
 * A readable name from the concept id. Words the learner's questions spell with capitals inside them
 * keep that spelling ("transformer.ffn-role" with "What does the FFN do?" reads "FFN role", not "Ffn role").
 */
export function conceptLabel(concept: string, texts: string[] = []): string {
  const tail = concept.includes(".") ? concept.slice(concept.indexOf(".") + 1) : concept;
  const label = sentence(tail).slice(0, 80);
  if (!texts.length) return label;
  const spelled = new Map<string, string>();
  for (const word of texts.join(" ").match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    if (/[A-Z]/.test(word.slice(1)) && !spelled.has(word.toLowerCase())) spelled.set(word.toLowerCase(), word);
  }
  return label.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => spelled.get(word.toLowerCase()) ?? word);
}

export function nodeState(dims: (number | null)[], misconceptions: MindMisconception[], due: boolean): NodeState {
  if (misconceptions.some((m) => m.status === "active")) return "misconception";
  const seen = dims.filter((d): d is number => d != null);
  if (!seen.length) return "unseen";
  const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
  if (mean >= SOLID_AT && !due) return "solid";
  if (mean < SHAKY_BELOW || due) return "shaky";
  return "learning";
}

export const meanOf = (dims: (number | null)[]) => {
  const seen = dims.filter((d): d is number => d != null);
  return seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : null;
};

function hoursBetween(earlier: string, later: Date) {
  const t = Date.parse(earlier);
  return Number.isFinite(t) ? (later.getTime() - t) / 3_600_000 : 0;
}

/** One frame from a full revision. `now` decides which beliefs are due by half-life. */
export function frameOf(revision: ProfileRevision, events: Record<string, ProfileEvent>, now: Date): MindFrame {
  const nodes: Record<string, MindNode> = {};
  const node = (concept: string) => (nodes[concept] ??= {
    id: concept, label: conceptLabel(concept), region: regionOf(concept), dims: LEARNING_DIMENSIONS.map(() => null),
    counts: LEARNING_DIMENSIONS.map(() => 0), weight: 0, mean: null, state: "unseen", due: false, misconceptions: [], evidence: [],
  });
  for (const belief of revision.beliefs) {
    const i = LEARNING_DIMENSIONS.indexOf(belief.dimension);
    if (i < 0 || !(belief.alpha > 0) || !(belief.beta > 0)) continue;
    const n = node(belief.concept);
    const absorbed = Math.max(0, belief.alpha + belief.beta - 2 * PRIOR);
    n.dims[i] = beliefMean(belief);
    n.counts[i] = Math.round(absorbed);
    n.weight += absorbed;
    if (belief.half_life_hours && belief.last_evidence_at && hoursBetween(belief.last_evidence_at, now) > belief.half_life_hours) n.due = true;
  }
  for (const m of revision.misconceptions) {
    node(m.concept).misconceptions.push({ id: m.id, description: m.description, status: m.status,
      strength: m.strength ?? 1, evidence: m.evidence });
  }
  const asked: Record<string, string[]> = {};
  for (const id of revision.observation_ids) {
    const event = events[id];
    if (event && nodes[event.concept]) { nodes[event.concept].evidence.push(id); (asked[event.concept] ??= []).push(event.question); }
  }
  for (const n of Object.values(nodes)) {
    if (asked[n.id]) n.label = conceptLabel(n.id, [...asked[n.id], ...n.misconceptions.map((m) => m.description ?? "")]);
  }
  // Cap by evidence weight; misconception-only concepts keep their place by strength.
  const ranked = Object.values(nodes).sort((a, b) => (b.weight + b.misconceptions.length) - (a.weight + a.misconceptions.length) || a.id.localeCompare(b.id));
  const kept: Record<string, MindNode> = {};
  for (const n of ranked.slice(0, MAX_NODES)) {
    n.mean = meanOf(n.dims);
    n.state = nodeState(n.dims, n.misconceptions, n.due);
    kept[n.id] = n;
  }
  const links: MindLink[] = (revision.links ?? [])
    .filter((l) => kept[l.source] && kept[l.target] && l.source !== l.target)
    .slice(0, MAX_EDGES)
    .map((l) => ({ ...l }));
  const path: string[] = [];
  for (const id of [...revision.observation_ids].sort((a, b) => (events[a]?.created_at ?? "").localeCompare(events[b]?.created_at ?? ""))) {
    const concept = events[id]?.concept;
    if (concept && kept[concept] && path[path.length - 1] !== concept) path.push(concept);
  }
  return { revision: revision.revision, session_id: revision.session_id, created_at: revision.created_at,
    summary: summarize(revision), nodes: kept, links, notes: revision.notes, path, changed: [] };
}

function summarize(revision: ProfileRevision) {
  const active = revision.misconceptions.filter((m) => m.status === "active").length;
  const answers = revision.observation_ids.length;
  return `Session ${revision.revision}: ${answers} answer${answers === 1 ? "" : "s"} sealed`
    + (active ? `, ${active} misconception${active === 1 ? "" : "s"} active` : "");
}

const sameNode = (a: MindNode | undefined, b: MindNode) => !!a && a.state === b.state
  && a.dims.every((d, i) => (d == null ? b.dims[i] == null : b.dims[i] != null && Math.abs(d - (b.dims[i] as number)) < 1e-6))
  && JSON.stringify(a.misconceptions.map((m) => [m.id, m.status, m.strength])) === JSON.stringify(b.misconceptions.map((m) => [m.id, m.status, m.strength]));

function markChanges(frames: MindFrame[]) {
  frames.forEach((frame, k) => {
    const before = k ? frames[k - 1].nodes : {};
    frame.changed = Object.values(frame.nodes).filter((n) => !sameNode(before[n.id], n)).map((n) => n.id);
  });
  return frames;
}

function regionsOf(frames: MindFrame[]): MindRegion[] {
  const last = frames[frames.length - 1];
  const all = new Map<string, MindNode>();
  for (const f of frames) for (const n of Object.values(f.nodes)) all.set(n.id, n);
  const groups = new Map<string, string[]>();
  for (const n of all.values()) groups.set(n.region, [...(groups.get(n.region) ?? []), n.id]);
  const weight = (ids: string[]) => ids.reduce((s, id) => s + (last.nodes[id]?.weight ?? 0), 0);
  return [...groups.entries()].sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]))
    .map(([id, nodes]) => ({ id, label: regionLabel(id), nodes: nodes.sort() }));
}

const toContractNode = (n: MindNode): ConstellationNode => ({
  id: n.id, label: n.label, state: n.state,
  dimensions: n.dims.flatMap((mean, i) => (mean == null ? [] : [{ dimension: LEARNING_DIMENSIONS[i], mean, evidence_count: n.counts[i] }])),
  misconceptions: n.misconceptions.filter((m) => m.status !== "resolved").map((m) => m.id).slice(0, 8),
  evidence: n.evidence.slice(-64), due: n.due,
});

/** The H0 contract: final nodes, links as edges (builds_on → prerequisite, confused_with → related), changed nodes per revision. */
export function toConstellationGraph(frames: MindFrame[]): ConstellationGraph {
  const last = frames[frames.length - 1];
  if (!last) return { schema_version: 1, revision: 0, nodes: [], edges: [], revisions: [] };
  return {
    schema_version: 1, revision: last.revision, nodes: Object.values(last.nodes).map(toContractNode),
    edges: last.links.map((l) => ({ source: l.source, target: l.target, kind: l.kind === "builds_on" ? "prerequisite" : "related" })),
    revisions: frames.map((f) => ({ revision: f.revision, session_id: f.session_id, created_at: f.created_at, summary: f.summary.slice(0, 240),
      nodes: f.changed.map((id) => toContractNode(f.nodes[id])) })),
  };
}

/** Null when the learner has no sealed revision yet (the overlay then shows the labelled sample). */
export function fromHistory(history: ProfileHistory, now = new Date()): MindMap | null {
  const revisions = [...(history.revisions ?? [])].sort((a, b) => a.revision - b.revision);
  if (!revisions.length) return null;
  const events = Object.fromEntries((history.events ?? []).map((e) => [e.id, e]));
  const frames = markChanges(revisions.map((r) => frameOf(r, events, now)));
  return { sample: false, frames, regions: regionsOf(frames), events, graph: toConstellationGraph(frames) };
}

/** Replays a ConstellationGraph (the H0 mock) into frames: each revision overwrites the nodes it lists. */
export function fromGraph(graph: ConstellationGraph, regionFor: (id: string) => string, sample = true): MindMap {
  const later = new Set(graph.revisions.flatMap((r) => r.nodes.map((n) => n.id)));
  const toMind = (c: ConstellationNode): MindNode => {
    const dims: (number | null)[] = LEARNING_DIMENSIONS.map(() => null);
    const counts = LEARNING_DIMENSIONS.map(() => 0);
    for (const d of c.dimensions) { const i = LEARNING_DIMENSIONS.indexOf(d.dimension); dims[i] = d.mean; counts[i] = d.evidence_count; }
    const misconceptions = c.misconceptions.map((id) => ({ id, description: sentence(id.split("/").pop() ?? id), status: "active" as const, strength: 1, evidence: [] }));
    return { id: c.id, label: c.label, region: regionFor(c.id), dims, counts, weight: counts.reduce((a, b) => a + b, 0),
      mean: meanOf(dims), state: c.state, due: c.due, misconceptions, evidence: c.evidence };
  };
  const unseen = (n: MindNode): MindNode => ({ ...n, dims: n.dims.map(() => null), counts: n.counts.map(() => 0), weight: 0,
    mean: null, state: "unseen", misconceptions: [], evidence: [] });
  // Nodes no revision has touched yet stay visible as unseen neurons.
  let current: Record<string, MindNode> = Object.fromEntries(graph.nodes.map((n) => [n.id, later.has(n.id) ? unseen(toMind(n)) : toMind(n)]));
  const links: MindLink[] = graph.edges.map((e) => ({ source: e.source, target: e.target, kind: "builds_on", why: "Sample link", strength: 1,
    provenance: "sample", evidence: [], first_revision: 1 }));
  const frames = graph.revisions.map((r) => {
    current = { ...current, ...Object.fromEntries(r.nodes.map((n) => [n.id, toMind(n)])) };
    const nodes = current;
    return { revision: r.revision, session_id: r.session_id, created_at: r.created_at, summary: r.summary, nodes,
      links: links.filter((l) => nodes[l.source] && nodes[l.target]), notes: [], path: r.nodes.map((n) => n.id), changed: [] } satisfies MindFrame;
  });
  return { sample, frames: markChanges(frames), regions: regionsOf(frames), events: {}, graph };
}

const lerp = (a: number | null, b: number | null, u: number) =>
  a == null && b == null ? null : a == null ? (u < 0.5 ? null : (b as number) * (u - 0.5) * 2) : b == null ? (u < 0.5 ? a : null) : a + (b - a) * u;

/** Frame `to` as seen `u` (0–1) of the way from `from`; used by the replay animation. */
export function blend(from: MindFrame | null, to: MindFrame, u: number): MindFrame {
  if (!from || u >= 1) return to;
  const nodes: Record<string, MindNode> = {};
  for (const id of new Set([...Object.keys(from.nodes), ...Object.keys(to.nodes)])) {
    const a = from.nodes[id], b = to.nodes[id];
    const base = b ?? a;
    const dims = base.dims.map((_, i) => lerp(a?.dims[i] ?? null, b?.dims[i] ?? null, u));
    const misconceptions = (u < 0.5 ? a : b)?.misconceptions ?? [];
    const weight = (a?.weight ?? 0) + ((b?.weight ?? 0) - (a?.weight ?? 0)) * u;
    if (!b && u >= 0.5) continue;
    nodes[id] = { ...base, dims, weight, misconceptions, mean: meanOf(dims), state: nodeState(dims, misconceptions, base.due) };
  }
  const links = to.links.filter((l) => l.first_revision < to.revision || u > 0.4);
  return { ...to, nodes, links };
}
