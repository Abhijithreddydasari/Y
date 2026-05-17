// Render a [draw] primitive's inline SVG to a PNG data URL Excalidraw can
// embed as an image. Mirrors the katex.ts pattern: keep an offscreen <svg>
// host, write the model's markup into it, rasterise via an Image + canvas
// pipeline (no html2canvas needed because SVG is its own renderer).
//
// We also expose `parseSvgPaths` for the player so it can animate each <path>
// stroke-by-stroke before swapping in the rasterised image.

import { roughifyInnerSvg } from "./rough-svg";

interface RasterResult {
  dataURL: string;
  width: number;
  height: number;
}

// Toggle: pass every inner-SVG through roughjs before parsing/rasterising so
// shapes look hand-drawn. Turning this off is useful for tests / debug.
const ROUGHIFY = true;

const DPR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 2;

export interface SvgPath {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  length: number;
}

export interface ParsedSvg {
  /** Full <svg> wrapper as a string (ready to embed). */
  outerSvg: string;
  /** ViewBox parsed: [minX, minY, width, height]. */
  viewBox: [number, number, number, number];
  /** Drawing-order paths (only `<path>` elements; used for stroke animation). */
  paths: SvgPath[];
  /** Total measured stroke length across all paths. Drives animation pacing. */
  totalLength: number;
}

const DEFAULT_VIEWBOX: [number, number, number, number] = [0, 0, 400, 300];

function parseViewBox(raw: string | undefined): [number, number, number, number] {
  if (!raw) return DEFAULT_VIEWBOX;
  const parts = raw
    .split(/[\s,]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
  if (parts.length !== 4) return DEFAULT_VIEWBOX;
  return parts as [number, number, number, number];
}

/**
 * Wrap the LLM's inner SVG markup with a proper <svg> element. We always set
 * xmlns (required for rasterisation via Image) and a sane default viewBox.
 */
export function wrapInnerSvg(innerSvg: string, viewBox: string): string {
  const vb = viewBox.trim() || "0 0 400 300";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">` +
    innerSvg +
    `</svg>`
  );
}

/**
 * Parse an inner-SVG fragment into a ParsedSvg by mounting it inside an
 * offscreen <svg> and walking its DOM. Done in the browser to avoid pulling
 * in a server-side XML parser.
 *
 * If `ROUGHIFY` is enabled the inner SVG is first re-rendered through
 * rough.js so each shape looks hand-drawn before we measure stroke lengths
 * (which is what the player uses to pace stroke-by-stroke reveals).
 */
export function parseSvg(innerSvg: string, viewBox: string): ParsedSvg {
  const styled = ROUGHIFY ? roughifyInnerSvg(innerSvg, viewBox) : innerSvg;
  const outerSvg = wrapInnerSvg(styled, viewBox);
  const vb = parseViewBox(viewBox);

  if (typeof window === "undefined") {
    return { outerSvg, viewBox: vb, paths: [], totalLength: 0 };
  }

  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.left = "-99999px";
  host.style.top = "-99999px";
  host.innerHTML = outerSvg;
  document.body.appendChild(host);
  try {
    const svg = host.querySelector("svg");
    if (!svg) return { outerSvg, viewBox: vb, paths: [], totalLength: 0 };
    const pathEls = Array.from(svg.querySelectorAll("path"));
    const paths: SvgPath[] = [];
    let totalLength = 0;
    for (const p of pathEls) {
      const d = p.getAttribute("d") ?? "";
      let length = 0;
      try {
        length = (p as SVGPathElement).getTotalLength();
      } catch {
        length = 0;
      }
      if (!Number.isFinite(length) || length <= 0) length = 100;
      paths.push({
        d,
        stroke: p.getAttribute("stroke") ?? "#111111",
        strokeWidth: Number(p.getAttribute("stroke-width") ?? "2"),
        fill: p.getAttribute("fill") ?? "none",
        length,
      });
      totalLength += length;
    }
    return { outerSvg, viewBox: vb, paths, totalLength };
  } finally {
    host.remove();
  }
}

/**
 * Rasterise an outer SVG string to a PNG data URL via Image + canvas. We
 * resolve once the Image loads; on error we resolve with a 1x1 transparent
 * PNG so the player still moves on (a missing diagram is better than a
 * stalled lesson).
 */
export async function rasterSvgToPng(
  outerSvg: string,
  width: number,
  height: number,
): Promise<RasterResult> {
  if (typeof window === "undefined") {
    return { dataURL: "", width, height };
  }
  const blob = new Blob([outerSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const scale = Math.max(2, DPR);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return { dataURL: canvas.toDataURL("image/png"), width, height };
  } catch {
    // Transparent 1x1 fallback.
    return {
      dataURL:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
