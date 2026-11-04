"use client";

// The 3D learner map. Loaded only when the map opens (next/dynamic), rendered on demand: frames are
// requested only while something moves (camera, springs, replay) or briefly after an interaction.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { bend, bezier, cortex, layout, type Vec3 } from "./layout";
import { EARLY_BELOW, type MindFrame, type MindLink, type MindMap, type MindNode } from "./map-model";
import { stateColor, valueColor, type Palette } from "./palette";

export type Level = "brain" | "region" | "neurons";
export interface MindControl { zoom(by: number): void; flyTo(region: string): void; overview(): void; frame(ids: string[]): void }
export interface SceneProps {
  map: MindMap; frame: MindFrame; replay: { path: string[]; u: number } | null; selected: string | null; palette: Palette;
  /** Neurons a filter or search keeps lit; the rest dim. Synapses are not affected. Null: all. */
  focus: ReadonlySet<string> | null;
  onSelect(id: string): void; onLevel(level: Level): void;
  labels: RefObject<Record<string, HTMLElement | null>>; regionLabels: RefObject<Record<string, HTMLElement | null>>;
  control: RefObject<MindControl | null>;
}

const AWAKE_MS = 6000; // spikes keep firing this long after the last interaction, then rendering stops
const DIST = 3.4;
const levelOf = (lod: number): Level => (lod < 0.35 ? "brain" : lod < 0.85 ? "region" : "neurons");
const lodOf = (zoom: number) => Math.min(1, Math.max(0, (zoom - 1.15) / 0.9));
const somaRadius = (n: MindNode) => 0.016 + 0.0045 * Math.min(n.weight, 8);

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,255,255,.45)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Quads in the billboard plane: segments [x0, y0, x1, y1, width, color]. */
function quads(segments: [number, number, number, number, number, THREE.Color][]) {
  const pos: number[] = [], col: number[] = [];
  for (const [x0, y0, x1, y1, w, c] of segments) {
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * w / 2, ny = (dx / l) * w / 2;
    const p = [[x0 + nx, y0 + ny], [x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x0 + nx, y0 + ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny]];
    for (const [x, y] of p) { pos.push(x, y, 0); col.push(c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

function ring(radius: number, width: number, color: THREE.Color, dashes = 0) {
  const n = dashes || 48, segs: [number, number, number, number, number, THREE.Color][] = [];
  for (let i = 0; i < n; i++) {
    if (dashes && i % 2) continue;
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    segs.push([Math.cos(a0) * radius, Math.sin(a0) * radius, Math.cos(a1) * radius, Math.sin(a1) * radius, width, color]);
  }
  return segs;
}

/** Five dendrites clockwise from the top (recall, understand, apply, analyze, transfer); length = mean. */
function dendrites(n: MindNode, r: number, p: Palette) {
  const segs: [number, number, number, number, number, THREE.Color][] = [];
  const grey = new THREE.Color(p.stub);
  n.dims.forEach((v, i) => {
    const a = Math.PI / 2 - (i * Math.PI * 2) / 5, cx = Math.cos(a), cy = Math.sin(a);
    if (v == null) {
      for (let j = 0; j < 2; j++) segs.push([cx * (r + 0.004 + j * 0.008), cy * (r + 0.004 + j * 0.008), cx * (r + 0.008 + j * 0.008), cy * (r + 0.008 + j * 0.008), 0.0025, grey]);
      return;
    }
    const len = 0.024 + 0.085 * v, color = new THREE.Color(valueColor(v, p));
    const ex = cx * (r + len), ey = cy * (r + len);
    segs.push([cx * r, cy * r, ex, ey, 0.005, color]);
    for (const o of [-0.5, 0.5]) segs.push([ex, ey, ex + Math.cos(a + o) * len * 0.32, ey + Math.sin(a + o) * len * 0.32, 0.0026, color]);
  });
  if (n.mean != null && n.weight < EARLY_BELOW) segs.push(...ring(r * 1.35, 0.0022, new THREE.Color(stateColor(n.state, p)), 20));
  if (n.mean == null) segs.push(...ring(r, 0.0024, grey));
  return quads(segs);
}

function haloOf(n: MindNode, r: number, p: Palette) {
  const m = [...n.misconceptions].sort((a, b) => (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1))[0];
  if (!m) return null;
  const radius = r * 1.7 + 0.006 + Math.min(m.strength, 2) * 0.006;
  if (m.status === "resolved") return { geometry: quads(ring(radius, 0.004, new THREE.Color(p.resolved))), pulse: false };
  return { geometry: quads(ring(radius, m.status === "active" ? 0.005 : 0.003, new THREE.Color(p.misconception), m.status === "suspected" ? 28 : 0)), pulse: m.status === "active" };
}

interface Sim { rest: Record<string, THREE.Vector3>; q: Record<string, THREE.Vector3>; v: Record<string, THREE.Vector3>; flash: Record<string, number> }

interface NeuronParts { root: THREE.Group; face: THREE.Group; glow: THREE.Sprite; halo: THREE.Mesh | null; pulse: boolean }

function Neuron({ node, selected, dimmed, sim, register, detail, glow, palette: p }: {
  node: MindNode; selected: boolean; dimmed: boolean; sim: Sim; register(id: string, parts: NeuronParts | null): void;
  detail: THREE.MeshBasicMaterial; glow: THREE.Texture; palette: Palette;
}) {
  const root = useRef<THREE.Group>(null), face = useRef<THREE.Group>(null), sprite = useRef<THREE.Sprite>(null), halo = useRef<THREE.Mesh>(null);
  const r = somaRadius(node);
  const key = `${node.dims.map((d) => (d == null ? "-" : d.toFixed(3))).join(",")}|${node.weight.toFixed(2)}|${node.state}|${p.theme}`;
  const dend = useMemo(() => dendrites(node, r, p), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const haloKey = node.misconceptions.map((m) => `${m.status}:${m.strength.toFixed(2)}`).join(",");
  const ringGeo = useMemo(() => haloOf(node, r, p), [haloKey, r, p]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useMemo(() => quads(ring(r * 2.4 + 0.05, 0.0025, new THREE.Color(p.selected))), [r, p]);
  useEffect(() => () => { dend.dispose(); }, [dend]);
  useEffect(() => () => { ringGeo?.geometry.dispose(); }, [ringGeo]);
  useEffect(() => () => { select.dispose(); }, [select]);
  useEffect(() => {
    if (root.current && face.current && sprite.current) {
      register(node.id, { root: root.current, face: face.current, glow: sprite.current, halo: halo.current, pulse: !!ringGeo?.pulse });
      const q = sim.q[node.id];
      if (q) root.current.position.copy(q);
    }
    return () => register(node.id, null);
  });
  const color = node.mean == null ? p.unseenSoma : stateColor(node.state, p);
  return (
    <group ref={root}>
      <sprite ref={sprite} scale={[r * 5.5, r * 5.5, 1]}>
        <spriteMaterial map={glow} color={node.mean == null ? p.unseen : stateColor(node.state, p)} transparent opacity={node.mean == null ? 0.18 : p.glow} depthWrite={false} blending={p.additive ? THREE.AdditiveBlending : THREE.NormalBlending} />
      </sprite>
      <mesh><sphereGeometry args={[r, 18, 14]} /><meshBasicMaterial key={dimmed ? "dim" : "lit"} color={color} transparent={dimmed} opacity={dimmed ? 0.14 : 1} /></mesh>
      <group ref={face} visible={!dimmed}>
        <mesh geometry={dend} material={detail} />
        {ringGeo && <mesh ref={halo} geometry={ringGeo.geometry} material={detail} />}
        {selected && <mesh geometry={select} material={detail} />}
      </group>
    </group>
  );
}

function linkCurve(l: MindLink, sim: Sim) {
  const a = sim.q[l.source], b = sim.q[l.target];
  if (!a || !b) return null;
  const A: Vec3 = [a.x, a.y, a.z], B: Vec3 = [b.x, b.y, b.z], C = bend(A, B);
  if (l.kind === "builds_on") return new THREE.QuadraticBezierCurve3(new THREE.Vector3(...A), new THREE.Vector3(...C), new THREE.Vector3(...B));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24, p = bezier(A, C, B, u), w = Math.sin(u * Math.PI * 9) * 0.012 * Math.sin(u * Math.PI);
    pts.push(new THREE.Vector3(p[0], p[1] + w, p[2] + w * 0.6));
  }
  return new THREE.CatmullRomCurve3(pts);
}

function Rig(props: SceneProps) {
  const { camera, gl, invalidate, size } = useThree();
  const live = useRef(props);
  live.current = props;
  const placed = useMemo(() => layout(props.map), [props.map]);
  const cortexGeo = useMemo(() => {
    const c = cortex();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(c.positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(c.count * 3), 3));
    return g;
  }, []);
  const glow = useMemo(glowTexture, []);
  const detail = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }), []);
  const pal = props.palette;
  const blending = pal.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  const cortexMat = useMemo(() => new THREE.PointsMaterial({ size: 0.03, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending, sizeAttenuation: true }), [glow, blending]);
  const synapseMat = useMemo(() => new THREE.MeshBasicMaterial({ color: pal.synapse, transparent: true, opacity: 0.6, depthWrite: false, blending }), [pal, blending]);
  const misfireMat = useMemo(() => new THREE.MeshBasicMaterial({ color: pal.misfire, transparent: true, opacity: 0.7, depthWrite: false }), [pal]);
  const spikeMat = useMemo(() => new THREE.SpriteMaterial({ map: glow, color: pal.spike, transparent: true, depthWrite: false, blending }), [glow, pal, blending]);
  const pathMat = useMemo(() => new THREE.LineBasicMaterial({ color: pal.path, transparent: true, opacity: 0.85 }), [pal]);
  const headMat = useMemo(() => new THREE.SpriteMaterial({ map: glow, color: pal.path, transparent: true, depthWrite: false, blending }), [glow, pal, blending]);
  useEffect(() => () => {
    for (const d of [cortexGeo, glow, detail, cortexMat, synapseMat, misfireMat, spikeMat, pathMat, headMat]) d.dispose();
  }, [cortexGeo, glow, detail, cortexMat, synapseMat, misfireMat, spikeMat, pathMat, headMat]);

  const sim = useRef<Sim>({ rest: {}, q: {}, v: {}, flash: {} }).current;
  for (const [id, p] of Object.entries(placed.nodes)) {
    if (!sim.rest[id]) { sim.rest[id] = new THREE.Vector3(...p); sim.q[id] = new THREE.Vector3(...p); sim.v[id] = new THREE.Vector3(); }
  }
  const groups = useRef<Record<string, NeuronParts | undefined>>({}).current;
  const register = useCallback((id: string, parts: NeuronParts | null) => { if (parts) groups[id] = parts; else delete groups[id]; }, [groups]);
  const cam = useRef({ yaw: -0.5, pitch: 0.2, zoom: 1, target: new THREE.Vector3(), tYaw: -0.5, tPitch: 0.2, tZoom: 1, tTarget: new THREE.Vector3() }).current;
  const awake = useRef(performance.now() + AWAKE_MS);
  const level = useRef<Level>("brain");
  const drag = useRef<{ id: string; z: number; moved: number; x: number; y: number } | null>(null);
  const fps = useRef<number[] | null>(null);
  const wake = (ms = AWAKE_MS) => { awake.current = Math.max(awake.current, performance.now() + ms); invalidate(); };

  // Region glow on the cortex: points near a studied region take its mastery colour.
  useEffect(() => {
    const pos = cortexGeo.getAttribute("position") as THREE.BufferAttribute, col = cortexGeo.getAttribute("color") as THREE.BufferAttribute;
    const regions = props.map.regions.map((r) => {
      const means = r.nodes.map((id) => props.frame.nodes[id]?.mean).filter((m): m is number => m != null);
      const mean = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
      return { at: new THREE.Vector3(...placed.regions[r.id]), color: mean == null ? null : new THREE.Color(valueColor(mean, pal)) };
    });
    const base = new THREE.Color(pal.cortex), p = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      let best = 0, tint: THREE.Color | null = null;
      for (const r of regions) {
        if (!r.color) continue;
        const w = 1 - p.distanceTo(r.at) / 0.45;
        if (w > best) { best = w; tint = r.color; }
      }
      c.copy(base).multiplyScalar(pal.cortexGain);
      if (tint) c.lerp(tint, Math.min(1, best * 2)).multiplyScalar(pal.additive ? 0.7 + best * 1.3 : 1);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    invalidate();
  }, [props.frame, props.map, placed, cortexGeo, invalidate, pal]);

  // Links: tubes rebuilt only when an end moves.
  const linkMeshes = useRef<Record<string, { mesh: THREE.Mesh; curve: THREE.Curve<THREE.Vector3>; ends: string }>>({}).current;
  const linkGroup = useRef<THREE.Group>(null);
  const spikeGroup = useRef<THREE.Group>(null);
  const linkKey = (l: MindLink) => `${l.kind}|${l.source}|${l.target}`;
  const buildLinks = () => {
    const g = linkGroup.current, s = spikeGroup.current;
    if (!g || !s) return;
    const wanted = new Map(live.current.frame.links.map((l) => [linkKey(l), l]));
    for (const [k, v] of Object.entries(linkMeshes)) {
      if (!wanted.has(k)) { g.remove(v.mesh); v.mesh.geometry.dispose(); delete linkMeshes[k]; }
    }
    for (const [k, l] of wanted) {
      const a = sim.q[l.source], b = sim.q[l.target];
      if (!a || !b) continue;
      const ends = `${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)}|${b.x.toFixed(4)},${b.y.toFixed(4)},${b.z.toFixed(4)}|${l.strength.toFixed(2)}`;
      const have = linkMeshes[k];
      if (have && have.ends === ends) continue;
      const curve = linkCurve(l, sim);
      if (!curve) continue;
      const radius = l.kind === "builds_on" ? 0.0014 + 0.0011 * Math.min(l.strength, 3) : 0.0014;
      const geo = new THREE.TubeGeometry(curve, 32, radius, 5, false);
      if (have) { have.mesh.geometry.dispose(); have.mesh.geometry = geo; have.curve = curve; have.ends = ends; }
      else {
        const mesh = new THREE.Mesh(geo, l.kind === "builds_on" ? synapseMat : misfireMat);
        g.add(mesh); linkMeshes[k] = { mesh, curve, ends };
      }
    }
    const spikes = [...wanted.entries()].filter(([, l]) => l.kind === "builds_on").length * 5;
    while (s.children.length < spikes) s.add(new THREE.Sprite(spikeMat));
    while (s.children.length > spikes) s.remove(s.children[s.children.length - 1]);
  };
  useEffect(() => { buildLinks(); invalidate(); });
  useEffect(() => () => { for (const v of Object.values(linkMeshes)) v.mesh.geometry.dispose(); }, [linkMeshes]);

  // The replay's path through this session's answers.
  const pathGeo = useMemo(() => {
    const path = props.replay?.path ?? [];
    const pts: number[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = placed.nodes[path[i]], b = placed.nodes[path[i + 1]];
      if (!a || !b) continue;
      const c = bend(a, b, 0.12);
      for (let j = i ? 1 : 0; j <= 20; j++) pts.push(...bezier(a, c, b, j / 20));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [props.replay?.path, placed]);  
  useEffect(() => () => { pathGeo.dispose(); }, [pathGeo]);
  const pathLine = useMemo(() => new THREE.Line(pathGeo, pathMat), [pathGeo, pathMat]);
  const head = useRef<THREE.Sprite>(null);

  // Camera control for the overlay's buttons and region cards.
  useEffect(() => {
    props.control.current = {
      zoom: (by) => { cam.tZoom = Math.min(3.6, Math.max(0.8, cam.tZoom * by)); if (cam.tZoom < 1.3) cam.tTarget.set(0, 0, 0); wake(); },
      flyTo: (region) => { const a = placed.regions[region]; if (a) { cam.tTarget.set(...a); cam.tZoom = Math.max(cam.tZoom, 2.3); wake(); } },
      overview: () => { cam.tTarget.set(0, 0, 0); cam.tZoom = 1; wake(); },
      frame: (ids) => {
        const at = ids.map((id) => sim.rest[id]).filter(Boolean);
        if (!at.length) return;
        const c = at.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / at.length);
        const spread = Math.max(0.15, ...at.map((v) => v.distanceTo(c)));
        cam.tTarget.copy(c); cam.tZoom = Math.min(3, Math.max(1.6, 0.9 / spread)); wake();
      },
    };
  });  

  // Focus: fly to the selected neuron.
  useEffect(() => {
    const q = props.selected ? sim.q[props.selected] : null;
    if (q) { cam.tTarget.copy(q); cam.tZoom = Math.max(cam.tZoom, 2.7); wake(); }
  }, [props.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { wake(); }, [props.frame, props.replay?.u]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fps") === "1") {
      fps.current = [];
      (window as unknown as { __mindFps?: () => unknown }).__mindFps = () => {
        const ms = [...(fps.current ?? [])].filter((d) => d > 0 && d < 1000);
        const rates = ms.map((d) => 1000 / d).sort((a, b) => a - b);
        const at = (p: number) => Math.round((rates[Math.floor(p * (rates.length - 1))] ?? 0) * 10) / 10;
        fps.current = [];
        return { frames: rates.length, p50: at(0.5), p5: at(0.05), min: at(0) };
      };
    }
  }, []);

  // Pointer input: drag a neuron (spring), drag space to orbit, wheel or pinch to zoom, tap to focus.
  useEffect(() => {
    const el = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let orbit: { x: number; y: number; yaw: number; pitch: number; moved: number } | null = null;
    let pinch: { d: number; zoom: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    const pick = (x: number, y: number, w: number, h: number) => {
      let best: string | null = null, bd = Infinity;
      const v = new THREE.Vector3(), scale = h / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360));
      for (const [id, q] of Object.entries(sim.q)) {
        const n = live.current.frame.nodes[id];
        if (!n) continue;
        v.copy(q).project(camera);
        if (v.z > 1) continue;
        const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h, d = Math.hypot(sx - x, sy - y);
        const rpx = (somaRadius(n) * scale) / camera.position.distanceTo(q);
        if (d < Math.max(16, rpx + 10) && d < bd) { bd = d; best = id; }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      const p = local(e);
      try { el.setPointerCapture(e.pointerId); } catch { /* not an active pointer (synthetic input) */ }
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.tZoom }; orbit = null; drag.current = null;
      } else {
        const id = lodOf(cam.zoom) > 0.3 ? pick(p.x, p.y, p.w, p.h) : null;
        if (id) drag.current = { id, z: sim.q[id].clone().project(camera).z, moved: 0, x: p.x, y: p.y };
        else orbit = { x: p.x, y: p.y, yaw: cam.tYaw, pitch: cam.tPitch, moved: 0 };
      }
      wake();
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        cam.tZoom = Math.min(3.6, Math.max(0.8, (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / (pinch.d || 1)));
      } else if (drag.current) {
        const d = drag.current;
        d.moved += Math.abs(p.x - d.x) + Math.abs(p.y - d.y); d.x = p.x; d.y = p.y;
        sim.q[d.id].copy(new THREE.Vector3((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1, d.z).unproject(camera));
        sim.v[d.id].set(0, 0, 0);
      } else if (orbit) {
        orbit.moved += 1;
        cam.tYaw = orbit.yaw - (p.x - orbit.x) * 0.008;
        cam.tPitch = Math.max(-0.8, Math.min(0.9, orbit.pitch + (p.y - orbit.y) * 0.006));
        cam.yaw = cam.tYaw; cam.pitch = cam.tPitch;
      }
      wake();
    };
    const up = (e: PointerEvent) => {
      const p = local(e);
      if (drag.current && drag.current.moved < 6) live.current.onSelect(drag.current.id);
      else if (orbit && Math.hypot(p.x - orbit.x, p.y - orbit.y) < 6) { const id = pick(p.x, p.y, p.w, p.h); if (id) live.current.onSelect(id); }
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      drag.current = null; orbit = null;
      wake();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.tZoom = Math.min(3.6, Math.max(0.8, cam.tZoom * Math.exp(-e.deltaY * 0.0015)));
      if (cam.tZoom < 1.3) cam.tTarget.set(0, 0, 0);
      wake();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); el.removeEventListener("wheel", wheel);
    };
  }, [gl, camera]); // eslint-disable-line react-hooks/exhaustive-deps

  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), f: new THREE.Vector3() }), []);
  useFrame((state, delta) => {
    const now = performance.now();
    if (fps.current) fps.current.push(delta * 1000);
    const dt = Math.min(0.033, delta || 0.016);
    const ease = Math.min(1, dt * 6.5);
    let moving = Math.abs(cam.tZoom - cam.zoom) + cam.target.distanceTo(cam.tTarget) + Math.abs(cam.tYaw - cam.yaw) + Math.abs(cam.tPitch - cam.pitch);
    cam.zoom += (cam.tZoom - cam.zoom) * ease; cam.yaw += (cam.tYaw - cam.yaw) * ease; cam.pitch += (cam.tPitch - cam.pitch) * ease;
    cam.target.lerp(cam.tTarget, ease);
    const d = DIST / cam.zoom;
    camera.position.set(cam.target.x + d * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.target.y + d * Math.sin(cam.pitch), cam.target.z + d * Math.cos(cam.pitch) * Math.cos(cam.yaw));
    camera.lookAt(cam.target);
    // lookAt leaves matrixWorldInverse for the renderer to refresh; the DOM labels below project with it, so
    // without this they used last frame's camera and trailed their neurons by a frame while dragging.
    camera.updateMatrixWorld();
    const lod = lodOf(cam.zoom);
    const lv = levelOf(lod);
    if (lv !== level.current) { level.current = lv; live.current.onLevel(lv); }
    cortexMat.opacity = pal.cortexAlpha * (1 - 0.7 * lod);
    cortexMat.size = pal.cortexSize * (1 - 0.2 * lod);
    detail.opacity = lod;
    synapseMat.opacity = 0.22 + 0.45 * lod;

    // Springs: a dragged neuron is pinned; others return to rest and tug their linked neighbours.
    const frame = live.current.frame;
    let energy = 0;
    for (const id of Object.keys(sim.q)) {
      if (drag.current?.id === id) continue;
      const q = sim.q[id], v = sim.v[id], rest = sim.rest[id];
      tmp.f.copy(rest).sub(q).multiplyScalar(110);
      for (const l of frame.links) {
        const other = l.source === id ? l.target : l.target === id ? l.source : null;
        if (!other || !sim.q[other]) continue;
        tmp.v.copy(sim.q[other]).sub(sim.rest[other]).sub(tmp.w.copy(q).sub(rest));
        tmp.f.addScaledVector(tmp.v, 40);
      }
      v.addScaledVector(tmp.f, dt).multiplyScalar(Math.pow(0.025, dt));
      q.addScaledVector(v, dt);
      energy += v.length() + q.distanceTo(rest);
    }
    for (const [id, g] of Object.entries(groups)) {
      if (!g) continue;
      g.root.position.copy(sim.q[id]);
      g.face.quaternion.copy(camera.quaternion);
      const n = frame.nodes[id];
      const flash = (sim.flash[id] = Math.max(0, (sim.flash[id] ?? 0) - dt * 2.2));
      (g.glow.material as THREE.SpriteMaterial).opacity = live.current.focus && !live.current.focus.has(id) ? 0 : (n?.mean == null ? 0.18 : pal.glow) + (pal.additive ? 0.5 : 0.3) * flash;
      const r = n ? somaRadius(n) : 0.02;
      g.glow.scale.setScalar(r * (5.5 + 5 * flash));
      if (g.halo && g.pulse) g.halo.scale.setScalar(1 + 0.12 * Math.sin(state.clock.elapsedTime * 4));
    }
    if (energy > 0.0005 || drag.current) buildLinks();

    // Spikes run along builds_on synapses; arrival flashes the target neuron.
    const spikes = spikeGroup.current;
    const t = state.clock.elapsedTime;
    let s = 0;
    for (const l of frame.links) {
      if (l.kind !== "builds_on") continue;
      const m = linkMeshes[linkKey(l)];
      const phase = (t * 0.42 + (l.source.length * 0.37 + l.target.length * 0.11)) % 1.4;
      for (let j = 0; j < 5; j++, s++) {
        const sp = spikes?.children[s] as THREE.Sprite | undefined;
        if (!sp) continue;
        const u = phase - j * 0.025;
        sp.visible = !!m && u >= 0 && u <= 1 && lod > 0.1;
        if (sp.visible && m) { m.curve.getPoint(u, sp.position); sp.scale.setScalar((0.026 - j * 0.004) * (0.7 + 0.5 * lod)); }
      }
      if (phase > 0.95 && phase < 1.02) sim.flash[l.target] = Math.max(sim.flash[l.target] ?? 0, 1 - Math.abs(phase - 0.99) * 12);
    }
    misfireMat.opacity = 0.35 + 0.45 * (Math.sin(t * 13) > 0 ? 1 : 0.3);

    // Replay: the gold spike traces this session's answers.
    const rp = live.current.replay;
    const total = (pathGeo.getAttribute("position") as THREE.BufferAttribute | undefined)?.count ?? 0;
    pathLine.visible = !!rp && total > 1;
    if (rp && total > 1) {
      const n = Math.max(1, Math.floor(total * rp.u));
      pathGeo.setDrawRange(0, n);
      if (head.current) {
        head.current.visible = rp.u < 1;
        head.current.position.fromBufferAttribute(pathGeo.getAttribute("position") as THREE.BufferAttribute, n - 1);
        head.current.scale.setScalar(0.07);
      }
      const reached = rp.path[Math.min(rp.path.length - 1, Math.round(rp.u * (rp.path.length - 1)))];
      if (reached) sim.flash[reached] = 1;
    } else if (head.current) head.current.visible = false;

    // DOM labels: neurons when zoomed in (nearest 40), region cards when zoomed out.
    const w = size.width, h = size.height;
    const labels = live.current.labels.current ?? {};
    const near = Object.keys(labels).filter((id) => sim.q[id]).sort((a, b) => sim.q[a].distanceTo(cam.target) - sim.q[b].distanceTo(cam.target)).slice(0, 40);
    const shown = new Set(near);
    for (const [id, el] of Object.entries(labels)) {
      if (!el || !sim.q[id]) continue;
      tmp.v.copy(sim.q[id]).project(camera);
      const n = frame.nodes[id];
      const r = n ? somaRadius(n) : 0.02;
      const off = (r + 0.03) * (h / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360))) / camera.position.distanceTo(sim.q[id]);
      // A filter or search names its neurons at any zoom, and only those.
      const focus = live.current.focus;
      const visible = tmp.v.z < 1 && (focus ? focus.has(id) : shown.has(id) && lod > 0.4);
      el.style.opacity = visible ? (focus ? "1" : String(Math.min(1, (lod - 0.4) * 2.5))) : "0";
      // Whole pixels, centred by measured width: a subpixel or percentage offset makes text shimmer while turning.
      el.style.transform = `translate3d(${Math.round(((tmp.v.x + 1) / 2) * w - el.offsetWidth / 2)}px, ${Math.round(((1 - tmp.v.y) / 2) * h + off)}px, 0)`;
    }
    const regionLabels = live.current.regionLabels.current ?? {};
    for (const [id, el] of Object.entries(regionLabels)) {
      const a = placed.regions[id];
      if (!el || !a) continue;
      tmp.v.set(a[0], a[1] + 0.3, a[2]).project(camera);
      const o = Math.max(0, 1 - lod / 0.6);
      el.style.opacity = tmp.v.z < 1 ? String(o) : "0";
      el.style.pointerEvents = o > 0.3 ? "auto" : "none";
      el.style.transform = `translate3d(${Math.round(((tmp.v.x + 1) / 2) * w - el.offsetWidth / 2)}px, ${Math.round(((1 - tmp.v.y) / 2) * h - el.offsetHeight)}px, 0)`;
    }

    moving += energy;
    if (moving > 0.0005 || drag.current || (rp && rp.u < 1) || now < awake.current) invalidate();
  });

  return (
    <>
      <color attach="background" args={[pal.bg]} />
      <points geometry={cortexGeo} material={cortexMat} />
      <group ref={linkGroup} />
      <group ref={spikeGroup} />
      <primitive object={pathLine} />
      <sprite ref={head} material={headMat} visible={false} />
      {Object.values(props.frame.nodes).map((n) => (
        <Neuron key={n.id} node={n} selected={props.selected === n.id} dimmed={!!props.focus && !props.focus.has(n.id)} sim={sim} register={register} detail={detail} glow={glow} palette={pal} />
      ))}
    </>
  );
}

export default function MindScene(props: SceneProps) {
  return (
    <Canvas frameloop="demand" dpr={[1, 1.75]} camera={{ fov: 40, near: 0.01, far: 50, position: [0, 0, DIST] }}
      gl={{ antialias: true, powerPreference: "high-performance" }} style={{ touchAction: "none", cursor: "grab" }}
      aria-hidden="true">
      <Rig {...props} />
    </Canvas>
  );
}
