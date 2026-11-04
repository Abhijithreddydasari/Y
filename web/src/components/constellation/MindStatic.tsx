"use client";

// Reduced motion or no WebGL: the same map as a still SVG (same positions, colours, dendrites, halos,
// links), no animation. Every neuron is a focusable button that opens the same evidence sheet.
import { useMemo } from "react";
import { bend, cortex, layout, type Vec3 } from "./layout";
import { EARLY_BELOW, type MindFrame, type MindMap } from "./map-model";
import { PALETTES, stateColor, valueColor, type Palette } from "./palette";

const W = 900, H = 560, YAW = -0.5, PITCH = 0.2;

function project(p: Vec3): [number, number, number] {
  const cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  const x = p[0] * cy - p[2] * sy, z = p[0] * sy + p[2] * cy;
  const y = p[1] * cp - z * sp, depth = p[1] * sp + z * cp;
  const s = 3.4 / (3.4 - depth), k = 330;
  return [W / 2 + x * s * k, H / 2 - y * s * k, s];
}

export default function MindStatic({ map, frame, selected, onSelect, palette: p = PALETTES.dark, focus = null }: {
  map: MindMap; frame: MindFrame; selected: string | null; onSelect(id: string): void; palette?: Palette; focus?: ReadonlySet<string> | null;
}) {
  const placed = useMemo(() => layout(map), [map]);
  const dots = useMemo(() => {
    const c = cortex();
    const out: [number, number][] = [];
    for (let i = 0; i < c.count; i += 5) {
      const [x, y] = project([c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]]);
      out.push([x, y]);
    }
    return out;
  }, []);
  const nodes = Object.values(frame.nodes).filter((n) => placed.nodes[n.id])
    .map((n) => ({ n, p: project(placed.nodes[n.id]) })).sort((a, b) => a.p[2] - b.p[2]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="group" aria-label="Mind, still view">
      <rect width={W} height={H} fill={p.bg} />
      <g fill={p.cortex} opacity={p.additive ? 0.55 : 0.7}>{dots.map(([x, y], i) => <rect key={i} x={x} y={y} width={1.4} height={1.4} />)}</g>
      {frame.links.map((l) => {
        const a = placed.nodes[l.source], b = placed.nodes[l.target];
        if (!a || !b) return null;
        const [ax, ay] = project(a), [bx, by] = project(b), [cx, cy] = project(bend(a, b));
        return <path key={`${l.kind}${l.source}${l.target}`} d={`M${ax},${ay} Q${cx},${cy} ${bx},${by}`} fill="none"
          stroke={l.kind === "builds_on" ? p.synapse : p.misfire} strokeWidth={l.kind === "builds_on" ? 1 + Math.min(l.strength, 3) * 0.6 : 1.4}
          strokeDasharray={l.kind === "confused_with" ? "3 3" : undefined} opacity={0.75} />;
      })}
      {nodes.map(({ n, p: [x, y, s] }) => {
        const r = (5 + Math.min(n.weight, 8) * 1.1) * s;
        const halo = n.misconceptions.find((m) => m.status === "active") ?? n.misconceptions.find((m) => m.status === "suspected") ?? n.misconceptions[0];
        return (
          <g key={n.id} role="button" tabIndex={0} aria-label={`${n.label}${selected === n.id ? ", selected" : ""}`} data-node={n.id}
            opacity={focus && !focus.has(n.id) ? 0.14 : 1}
            onClick={() => onSelect(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.id); } }}
            className="cursor-pointer outline-none [&:focus-visible>circle.focus]:opacity-100">
            {n.dims.map((v, i) => {
              const a = Math.PI / 2 - (i * Math.PI * 2) / 5, len = v == null ? 4 : (7 + 26 * v) * s;
              return <line key={i} x1={x + Math.cos(a) * r} y1={y - Math.sin(a) * r} x2={x + Math.cos(a) * (r + len)} y2={y - Math.sin(a) * (r + len)}
                stroke={v == null ? p.unseen : valueColor(v, p)} strokeWidth={v == null ? 1 : 2.2} strokeDasharray={v == null ? "2 2" : undefined} strokeLinecap="round" />;
            })}
            <circle cx={x} cy={y} r={r} fill={n.mean == null ? p.unseenSoma : stateColor(n.state, p)} stroke={n.mean == null ? p.unseen : stateColor(n.state, p)}
              strokeDasharray={n.mean != null && n.weight < EARLY_BELOW ? "2 2" : undefined} />
            {halo && <circle cx={x} cy={y} r={r + 6 + Math.min(halo.strength, 2) * 3} fill="none" stroke={halo.status === "resolved" ? p.resolved : p.misconception}
              strokeWidth={halo.status === "active" ? 2 : 1.2} strokeDasharray={halo.status === "suspected" ? "3 3" : undefined} />}
            <circle className="focus" cx={x} cy={y} r={r + 16} fill="none" stroke={p.selected} strokeWidth={1.2} opacity={selected === n.id ? 0.7 : 0} />
            <text x={x} y={y + r + 40 * s} textAnchor="middle" fontSize={12} fill={n.mean == null ? p.unseen : p.label}>{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
