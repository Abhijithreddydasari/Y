"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import s from "@/app/landing.module.css";

const FRAMES = [
  { key: "Ask", src: "/landing/ask.jpg", caption: "Ask out loud or type, about anything.",
    alt: "The Y whiteboard with a question typed in the composer: why does attention use a softmax?" },
  { key: "Learn", src: "/landing/learn.jpg", caption: "Y teaches step by step, right on the board.",
    alt: "A lesson on the board with handwritten steps, an equation, and an interactive attention widget" },
  { key: "Check", src: "/landing/check.jpg", caption: "It checks what you understood before moving on.",
    alt: "A check question on the board with an answer card, confidence choices, a hint and just tell me" },
  { key: "Remember", src: "/landing/mind.jpg", caption: "It remembers how you think, and shows you why.",
    alt: "Mind: a brain-shaped map of concepts, marked solid, learning, shaky or wrong belief" },
];
const FRAME_MS = 3800;

/** Real app screens, crossfading. Stops for reduced motion, on hover or focus, and once a step is chosen. */
export default function LandingFrames() {
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setStill(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (held || paused || still) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setActive((value) => (value + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [held, paused, still]);

  return (
    <div ref={root} className={s.frames} onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={(event) => { if (!root.current?.contains(event.relatedTarget as Node)) setPaused(false); }}>
      <div className={s.window}>
        <div className={s.windowBar} aria-hidden="true"><span /><span /><span /></div>
        <div className={s.windowView}>
          {FRAMES.map((frame, index) => (
            <Image key={frame.key} className={s.frame} data-active={index === active} src={frame.src} alt={index === active ? frame.alt : ""}
              aria-hidden={index !== active} width={1500} height={1000} sizes="(max-width: 1000px) 100vw, 920px" preload={index === 0} />
          ))}
        </div>
      </div>
      <p className={s.frameCaption} aria-live="polite">{FRAMES[active].caption}</p>
      <div className={s.frameSteps} role="group" aria-label="Show a step">
        {FRAMES.map((frame, index) => (
          <button key={frame.key} type="button" aria-pressed={index === active} onClick={() => { setActive(index); setHeld(true); }}>
            <b>0{index + 1}</b>{frame.key}
          </button>
        ))}
      </div>
    </div>
  );
}
