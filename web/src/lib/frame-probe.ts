// Board frame-time probe for the glass check: `?fps=1` records requestAnimationFrame intervals and
// exposes `window.__boardFrames()` (p50/p95/max ms since the last reset); `?glass=0` swaps the glass
// chrome for opaque surfaces so the two can be compared on the same device.
export interface FrameStats { frames: number; p50: number; p95: number; max: number; over20: number }

export function frameStats(intervals: number[]): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const round = (n: number) => Math.round(n * 10) / 10;
  return { frames: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0),
    over20: sorted.filter((ms) => ms > 20).length };
}

export function installFrameProbe(search: string): () => void {
  const params = new URLSearchParams(search);
  if (params.get("glass") === "0") document.documentElement.dataset.glass = "off";
  if (params.get("fps") !== "1") return () => {};
  let intervals: number[] = [], last = 0, handle = 0;
  const tick = (now: number) => {
    if (last) intervals.push(now - last);
    if (intervals.length > 20_000) intervals = intervals.slice(-10_000);
    last = now;
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  const target = window as Window & { __boardFrames?: (reset?: boolean) => FrameStats };
  target.__boardFrames = (reset = false) => {
    const stats = frameStats(intervals);
    if (reset) { intervals = []; last = 0; }
    return stats;
  };
  return () => { cancelAnimationFrame(handle); delete target.__boardFrames; };
}
