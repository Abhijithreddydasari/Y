// Render LaTeX strings to PNG data URLs Excalidraw can embed as images.
// KaTeX lays the formula out as HTML in an offscreen host (Next has already
// injected katex.min.css from the package), and a small painter copies that
// layout onto a canvas. KaTeX output is only text runs, border boxes (fraction
// bars, rules) and inline SVGs (roots, stretchy delimiters), so the painter
// reproduces the browser's own geometry instead of re-deriving it.
//
// Each text run is drawn at its range's top plus the font's ascent, which is
// exactly where the browser put its baseline. General HTML rasterizers draw
// at top + font-size, which only holds for fonts whose ascent is 1 em; KaTeX
// mixes fonts in one formula (the 3 in KaTeX_Main, the x in KaTeX_Math), so
// that shortcut gave every font its own baseline.

import "katex/dist/katex.min.css";

interface RasterResult {
  dataURL: string;
  width: number;
  height: number;
}

const FONT_SIZE = 22;
const DPR = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 2;
const SVG_PAINT = ["fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin"] as const;

let _container: HTMLDivElement | null = null;
function offscreen(): HTMLDivElement {
  if (_container) return _container;
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "-99999px";
  el.style.top = "-99999px";
  el.style.fontSize = `${FONT_SIZE}px`;
  el.style.color = "#111";
  el.style.background = "transparent";
  el.style.lineHeight = "1.2";
  document.body.appendChild(el);
  _container = el;
  return el;
}

const fontOf = (style: CSSStyleDeclaration) =>
  `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim()) nodes.push(node as Text);
  }
  return nodes;
}

/** KaTeX fonts load lazily on first use; layout measured before they arrive uses fallback metrics. */
async function fontsReady(root: HTMLElement): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const fonts = new Set(textNodes(root).map((node) => fontOf(getComputedStyle(node.parentElement!))));
  await Promise.all([...fonts].map((font) => document.fonts.load(font).catch(() => [])));
  await document.fonts.ready;
}

const visible = (color: string) => Boolean(color) && color !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(color);

async function svgImage(svg: SVGSVGElement, width: number, height: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // An image has no access to the page's stylesheet: inline the computed paint, currentColor resolved.
  const sources = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  sources.forEach((source, index) => {
    const style = getComputedStyle(source);
    for (const prop of SVG_PAINT) targets[index].setAttribute(prop, style.getPropertyValue(prop));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("style");
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await image.decode();
  return image;
}

/** Copy one laid-out KaTeX subtree onto `ctx`, whose origin is the host's top-left corner. */
export async function paintLayout(ctx: CanvasRenderingContext2D, node: Node, origin: { left: number; top: number }): Promise<void> {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (!text.trim() || !node.parentElement) return;
    const style = getComputedStyle(node.parentElement);
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (!rect) return;
    ctx.font = fontOf(style);
    ctx.fillStyle = style.color;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, rect.left - origin.left, rect.top - origin.top + ctx.measureText(text).fontBoundingBoxAscent);
    return;
  }
  if (!(node instanceof Element)) return;
  const style = getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return;
  const rect = node.getBoundingClientRect();
  const x = rect.left - origin.left, y = rect.top - origin.top;
  if (node instanceof SVGSVGElement) {
    if (rect.width > 0 && rect.height > 0) ctx.drawImage(await svgImage(node, rect.width, rect.height), x, y, rect.width, rect.height);
    return;
  }
  if (visible(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(x, y, rect.width, rect.height);
  }
  // Fraction bars, \rule, \overline and friends are borders on otherwise empty spans.
  for (const [side, fill] of [
    ["top", (w: number) => ctx.fillRect(x, y, rect.width, w)],
    ["bottom", (w: number) => ctx.fillRect(x, y + rect.height - w, rect.width, w)],
    ["left", (w: number) => ctx.fillRect(x, y, w, rect.height)],
    ["right", (w: number) => ctx.fillRect(x + rect.width - w, y, w, rect.height)],
  ] as const) {
    const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
    if (width > 0 && style.getPropertyValue(`border-${side}-style`) !== "none") {
      ctx.fillStyle = style.getPropertyValue(`border-${side}-color`);
      fill(width);
    }
  }
  // Roots draw a 400em-wide surd inside an overflow:hidden span; clip as the browser does.
  const clip = style.overflow !== "visible";
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, rect.width, rect.height);
    ctx.clip();
  }
  for (const child of Array.from(node.childNodes)) await paintLayout(ctx, child, origin);
  if (clip) ctx.restore();
}

export async function renderLatexToImage(latex: string): Promise<RasterResult> {
  const { default: katex } = await import("katex");

  const host = offscreen();
  host.innerHTML = "";

  // Wrap so we can pad and pick up bounding box reliably.
  const inner = document.createElement("div");
  inner.style.padding = "4px 8px";
  inner.style.display = "inline-block";
  host.appendChild(inner);

  try {
    katex.render(latex, inner, {
      throwOnError: false,
      displayMode: true,
      output: "html",
      strict: false,
    });
  } catch {
    inner.textContent = latex;
  }

  await fontsReady(inner);

  const rect = inner.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const scale = Math.max(2, DPR);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(scale, scale);
  await paintLayout(ctx, inner, { left: rect.left, top: rect.top });
  return { dataURL: canvas.toDataURL("image/png"), width, height };
}
