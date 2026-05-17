// Take the model's clean inner SVG and re-render every primitive shape
// (path, circle, rect, line, polygon, polyline, ellipse) using rough.js so
// the result has the same hand-drawn aesthetic as Excalidraw's strokes. We
// keep <text> elements untouched -- text would just look smudged through
// roughjs.
//
// Why a styler at all? Two reasons:
//   1. Visual cohesion. Excalidraw is a hand-drawn canvas; LLM-emitted SVG
//      is laser-straight. Without rough.js the diagram pops out as obviously
//      machine-generated.
//   2. Forgiveness for the model. Roughjs adds a slight wobble to every
//      stroke, which masks small precision errors (a benzene ring whose
//      vertices are 2px off, a force arrow whose head is slightly skewed).
//
// We do *not* rough up the wrapper SVG itself; only its inner shapes.

import rough from "roughjs";
import type { RoughSVG } from "roughjs/bin/svg";
import type { Options as RoughOptions } from "roughjs/bin/core";

const ROUGH_OPTS: RoughOptions = {
  stroke: "#111111",
  strokeWidth: 2,
  fill: "none",
  roughness: 1.4,    // Excalidraw default is 1; bump slightly for a more "lesson sketch" feel.
  bowing: 1.2,
  preserveVertices: true,
  fillStyle: "hachure",
};

const _SHAPE_TAGS = new Set(["path", "circle", "rect", "line", "polygon", "polyline", "ellipse"]);

function num(el: Element, attr: string, fallback = 0): number {
  const v = el.getAttribute(attr);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function points(el: Element): [number, number][] {
  const raw = el.getAttribute("points") ?? "";
  const out: [number, number][] = [];
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const x = Number(tokens[i]);
    const y = Number(tokens[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/**
 * Replace every shape element under `host` with its rough.js equivalent.
 * Mutates the DOM in place. Text elements are left alone. Unknown elements
 * are also left alone -- the caller is expected to have run validator.
 */
function roughify(rs: RoughSVG, host: SVGSVGElement): void {
  const candidates = Array.from(host.querySelectorAll("*"));
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    if (!_SHAPE_TAGS.has(tag)) continue;
    let replacement: SVGGElement | null = null;
    try {
      switch (tag) {
        case "path": {
          const d = el.getAttribute("d");
          if (!d) break;
          replacement = rs.path(d, ROUGH_OPTS);
          break;
        }
        case "circle": {
          const cx = num(el, "cx");
          const cy = num(el, "cy");
          const r = num(el, "r");
          if (r <= 0) break;
          replacement = rs.circle(cx, cy, r * 2, ROUGH_OPTS);
          break;
        }
        case "ellipse": {
          const cx = num(el, "cx");
          const cy = num(el, "cy");
          const rx = num(el, "rx");
          const ry = num(el, "ry");
          if (rx <= 0 || ry <= 0) break;
          replacement = rs.ellipse(cx, cy, rx * 2, ry * 2, ROUGH_OPTS);
          break;
        }
        case "rect": {
          const x = num(el, "x");
          const y = num(el, "y");
          const w = num(el, "width");
          const h = num(el, "height");
          if (w <= 0 || h <= 0) break;
          replacement = rs.rectangle(x, y, w, h, ROUGH_OPTS);
          break;
        }
        case "line": {
          const x1 = num(el, "x1");
          const y1 = num(el, "y1");
          const x2 = num(el, "x2");
          const y2 = num(el, "y2");
          replacement = rs.line(x1, y1, x2, y2, ROUGH_OPTS);
          break;
        }
        case "polyline": {
          const pts = points(el);
          if (pts.length < 2) break;
          replacement = rs.linearPath(pts, ROUGH_OPTS);
          break;
        }
        case "polygon": {
          const pts = points(el);
          if (pts.length < 3) break;
          replacement = rs.polygon(pts, ROUGH_OPTS);
          break;
        }
      }
    } catch (exc) {
      console.warn("[rough-svg] failed to roughify", tag, exc);
      replacement = null;
    }
    if (replacement && el.parentNode) {
      el.parentNode.replaceChild(replacement, el);
    }
  }
}

/**
 * Take an inner-SVG fragment (as produced by the validator) and return a
 * new inner-SVG string where every primitive shape has been redrawn with
 * rough.js for a hand-drawn look. Falls back to the input unchanged if the
 * browser context is missing (SSR) or roughjs throws.
 */
export function roughifyInnerSvg(innerSvg: string, viewBox: string): string {
  if (typeof window === "undefined" || !innerSvg) return innerSvg;
  const host = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  host.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  host.setAttribute("viewBox", viewBox || "0 0 400 300");
  // We mount the SVG into a hidden host because roughjs uses
  // ownerDocument-based createElementNS internally.
  const wrapper = document.createElement("div");
  wrapper.style.position = "absolute";
  wrapper.style.left = "-99999px";
  wrapper.style.top = "-99999px";
  wrapper.appendChild(host);
  document.body.appendChild(wrapper);
  try {
    host.innerHTML = innerSvg;
    const rs = rough.svg(host);
    roughify(rs, host);
    return host.innerHTML;
  } catch (exc) {
    console.warn("[rough-svg] roughifyInnerSvg failed; passing through", exc);
    return innerSvg;
  } finally {
    wrapper.remove();
  }
}
