// Where things sit in the brain: a seeded cortex point cloud (a container, not data), one anchor per
// subject region, and a force layout of concepts around their region's anchor with links as springs.
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type SimNode } from "d3-force-3d";
import type { MindMap } from "./map-model";

export type Vec3 = [number, number, number];

/** x front (+) to back, y up, z right hemisphere (+) to left. Regions take these slots by evidence weight. */
export const REGION_SLOTS: Vec3[] = [
  [0.55, 0.22, 0.3], [-0.15, 0.5, -0.3], [-0.45, 0.18, 0.42], [0.15, -0.2, -0.55],
  [0.5, 0.18, -0.36], [-0.5, 0.25, -0.36], [0.1, 0.48, 0.34], [-0.2, -0.18, 0.55],
];

export function seeded(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export interface Cortex { positions: Float32Array; count: number }

/** About 3,000 points on a wrinkled two-hemisphere cerebrum, a striated cerebellum and a brainstem. */
export function cortex(seed = 7): Cortex {
  const rnd = seeded(seed);
  const out: number[] = [];
  for (let i = 0; i < 2900; i++) {
    const th = Math.acos(2 * rnd() - 1), ph = rnd() * Math.PI * 2;
    const wrinkle = Math.sin(11 * th + 3 * ph) * Math.sin(9 * ph + 2 * th);
    if (wrinkle < -0.55) continue; // sulci: leave grooves empty
    const k = 1 + 0.035 * wrinkle;
    const x = Math.sin(th) * Math.cos(ph) * 1.05 * k;
    let y = Math.cos(th) * 0.72 * k, z = Math.sin(th) * Math.sin(ph) * 0.86 * k;
    z += Math.sign(z) * 0.05; // longitudinal fissure
    if (Math.abs(z) < 0.16 && y > 0) y *= 0.9 + (0.1 * Math.abs(z)) / 0.16;
    if (y < -0.28) y = -0.28 + (y + 0.28) * 0.45; // flatter base
    if (x < -0.5 && y < -0.1) y += 0.08;
    const r = 0.94 + rnd() * 0.06;
    out.push(x * r, y * r, z * r);
  }
  for (let i = 0; i < 380; i++) {
    const th = Math.acos(2 * rnd() - 1), ph = rnd() * Math.PI * 2, band = Math.round(Math.cos(th) * 7) / 7;
    out.push(-0.72 + Math.sin(th) * Math.cos(ph) * 0.3, -0.47 + band * 0.17, Math.sin(th) * Math.sin(ph) * 0.5);
  }
  for (let i = 0; i < 120; i++) {
    const a = rnd() * Math.PI * 2, h = rnd();
    out.push(-0.32 + Math.cos(a) * 0.09 + h * 0.06, -0.45 - h * 0.5, Math.sin(a) * 0.09);
  }
  return { positions: new Float32Array(out), count: out.length / 3 };
}

const inside = (p: Vec3): Vec3 => {
  const d = Math.hypot(p[0] / 0.92, p[1] / 0.62, p[2] / 0.76);
  return d > 1 ? [p[0] / d, p[1] / d, p[2] / d] : p;
};

/** Stable positions for every concept in any frame, so scrubbing never moves neurons around. */
export function layout(map: MindMap): { nodes: Record<string, Vec3>; regions: Record<string, Vec3> } {
  const regions: Record<string, Vec3> = {};
  map.regions.forEach((r, i) => {
    const slot = REGION_SLOTS[i % REGION_SLOTS.length];
    const lap = Math.floor(i / REGION_SLOTS.length);
    regions[r.id] = lap ? inside([slot[0] * 0.7 + lap * 0.07, slot[1] * 0.7, slot[2] * 0.7 - lap * 0.07]) : slot;
  });
  const ids = map.regions.flatMap((r) => r.nodes);
  const regionOf: Record<string, string> = Object.fromEntries(map.regions.flatMap((r) => r.nodes.map((id) => [id, r.id])));
  const rnd = seeded(ids.length * 131 + 17);
  const S = 100; // simulate in d3's usual units
  const nodes: SimNode[] = ids.map((id) => {
    const a = regions[regionOf[id]];
    return { id, x: (a[0] + (rnd() - 0.5) * 0.2) * S, y: (a[1] + (rnd() - 0.5) * 0.2) * S, z: (a[2] + (rnd() - 0.5) * 0.2) * S };
  });
  const seen = new Set<string>();
  const links = map.frames.flatMap((f) => f.links).filter((l) => {
    const key = `${l.source}|${l.target}`;
    return !seen.has(key) && seen.add(key) && regionOf[l.source] && regionOf[l.target];
  }).map((l) => ({ source: l.source, target: l.target }));
  const anchor = (axis: 0 | 1 | 2) => (d: SimNode) => regions[regionOf[d.id]][axis] * S;
  const crowd = Math.max(...map.regions.map((r) => r.nodes.length), 1);
  forceSimulation(nodes, 3)
    .force("link", forceLink(links).id((d) => d.id).distance(22).strength(0.15))
    .force("charge", forceManyBody().strength(-40 / Math.sqrt(crowd / 6 + 1)))
    .force("x", forceX(anchor(0)).strength(0.2))
    .force("y", forceY(anchor(1)).strength(0.2))
    .force("z", forceZ(anchor(2)).strength(0.2))
    .stop()
    .tick(220);
  const out: Record<string, Vec3> = {};
  for (const n of nodes) out[n.id] = inside([(n.x ?? 0) / S, (n.y ?? 0) / S, (n.z ?? 0) / S]);
  return { nodes: out, regions };
}

/** Synapse curve control point: the midpoint pushed away from the brain's centre, so links arc like fibres. */
export function bend(a: Vec3, b: Vec3, amount = 0.22): Vec3 {
  const m: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const len = Math.hypot(...m) || 1;
  return [m[0] * (1 + amount / len), m[1] * (1 + amount / len), m[2] * (1 + amount / len)];
}

export function bezier(a: Vec3, c: Vec3, b: Vec3, u: number): Vec3 {
  const v = 1 - u;
  return [v * v * a[0] + 2 * v * u * c[0] + u * u * b[0], v * v * a[1] + 2 * v * u * c[1] + u * u * b[1], v * v * a[2] + 2 * v * u * c[2] + u * u * b[2]];
}
