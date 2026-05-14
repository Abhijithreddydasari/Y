// Render LaTeX strings to PNG data URLs Excalidraw can embed as images.
// We let KaTeX produce its native HTML in an offscreen host (Next has already
// injected katex.min.css from the package), then rasterize that host with
// html2canvas-pro. PNG is preferred over inline SVG because Excalidraw's
// image element resamples cleanly and html2canvas captures the live computed
// styles from the bundled stylesheet, which raw foreignObject cannot.

import "katex/dist/katex.min.css";

interface RasterResult {
  dataURL: string;
  width: number;
  height: number;
}

const FONT_SIZE = 22;
const DPR = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 2;

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

export async function renderLatexToImage(latex: string): Promise<RasterResult> {
  const [{ default: katex }, { default: html2canvas }] = await Promise.all([
    import("katex"),
    import("html2canvas-pro"),
  ]);

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

  // Allow KaTeX styles to settle before measuring.
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  const rect = inner.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));

  const canvas = await html2canvas(inner, {
    backgroundColor: null,
    scale: Math.max(2, DPR),
    logging: false,
    useCORS: true,
  });
  return { dataURL: canvas.toDataURL("image/png"), width, height };
}
