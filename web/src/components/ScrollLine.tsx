"use client";

import { useEffect, useRef } from "react";

export default function ScrollLine() {
  const svgRef = useRef<SVGSVGElement>(null);
  const trackRef = useRef<SVGPathElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const track = trackRef.current;
    const line = lineRef.current;
    const dot = dotRef.current;
    const page = svg?.parentElement;
    if (!svg || !track || !line || !dot || !page) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let height = 1;
    let points: Array<[number, number]> = [];
    let displacement = new Float32Array(1);
    let mouseX = -999;
    let mouseY = -999;
    let progress = 0;
    let frame = 0;

    const build = () => {
      height = page.offsetHeight;
      const count = Math.ceil(height / 30) + 1;
      points = [];
      displacement = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        const y = (index * height) / (count - 1);
        const x = 34 + 15 * (0.75 + 0.25 * Math.sin(y / 900)) * Math.sin((y * 2 * Math.PI) / 620);
        points.push([x, y]);
      }
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `0 0 70 ${height}`);
    };

    const makePath = () => {
      const moved = points.map((point, index) => [point[0] + displacement[index], point[1]]);
      let value = `M${moved[0][0]} ${moved[0][1]}`;
      for (let index = 0; index < moved.length - 1; index += 1) {
        const previous = moved[index - 1] || moved[index];
        const current = moved[index];
        const next = moved[index + 1];
        const following = moved[index + 2] || next;
        value += `C${current[0] + (next[0] - previous[0]) / 6} ${current[1] + (next[1] - previous[1]) / 6} ${next[0] - (following[0] - current[0]) / 6} ${next[1] - (following[1] - current[1]) / 6} ${next[0]} ${next[1]}`;
      }
      return value;
    };

    const pointerMove = (event: PointerEvent) => {
      const bounds = svg.getBoundingClientRect();
      mouseX = event.clientX - bounds.left;
      mouseY = event.clientY + window.scrollY;
    };
    const pointerLeave = () => { mouseX = mouseY = -999; };

    const tick = () => {
      for (let index = 0; index < points.length; index += 1) {
        const dx = mouseX - points[index][0];
        const dy = mouseY - points[index][1];
        const distance = Math.hypot(dx, dy);
        const force = distance < 140 ? (1 - distance / 140) ** 2 : 0;
        const target = Math.max(-14, Math.min(14, force * dx * 0.3));
        displacement[index] += (target - displacement[index]) * 0.07;
      }
      const path = makePath();
      track.setAttribute("d", path);
      line.setAttribute("d", path);
      const length = line.getTotalLength();
      const target = Math.min(1, Math.max(0, (window.scrollY + window.innerHeight * 0.7) / height));
      progress = reduce ? target : progress + (target - progress) * 0.06;
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length * (1 - progress));
      const point = line.getPointAtLength(Math.max(0.1, length * progress));
      dot.setAttribute("cx", String(point.x));
      dot.setAttribute("cy", String(point.y));
      frame = window.requestAnimationFrame(tick);
    };

    build();
    const observer = new ResizeObserver(build);
    observer.observe(page);
    window.addEventListener("resize", build);
    if (!reduce) {
      window.addEventListener("pointermove", pointerMove);
      document.addEventListener("pointerleave", pointerLeave);
    }
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", build);
      window.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("pointerleave", pointerLeave);
    };
  }, []);

  return (
    <svg ref={svgRef} className="absolute left-[clamp(18px,4vw,58px)] top-0 hidden w-[70px] overflow-visible pointer-events-none sm:block" aria-hidden="true">
      <path ref={trackRef} fill="none" stroke="#e6e4dc" strokeWidth="2" />
      <path ref={lineRef} fill="none" stroke="#f5b041" strokeWidth="3.5" strokeLinecap="round" />
      <circle ref={dotRef} r="5.5" fill="#f59e0b" />
    </svg>
  );
}
