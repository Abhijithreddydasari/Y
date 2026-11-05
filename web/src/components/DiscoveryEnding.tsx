"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import s from "@/app/landing.module.css";
import { PORTRAITS } from "@/lib/discovery-portraits";

const PLAY_MS = 15_000; // about 7 faces a second through the middle, gentle for anyone sensitive to flashing
const REVEAL_MS = 800;
const PORTRAIT_MS = PLAY_MS - REVEAL_MS;
const LOOK_AHEAD = 16;
const FIRST_FRAME_WAIT_MS = 1_500;
// The first faces hold longer, so you can see what is happening before it speeds up.
const BEATS = PORTRAITS.map((_, i) => (i === 0 ? 5 : i < 5 || i > PORTRAITS.length - 5 ? 1.7 : 1));
const TOTAL_BEATS = BEATS.reduce((sum, beat) => sum + beat, 0);
const STARTS = BEATS.reduce<number[]>((list, beat) => [...list, list[list.length - 1] + (beat / TOTAL_BEATS) * PORTRAIT_MS], [0]);
const MASK = 'url("/discovery/y-mask.png") center / 100% 100% no-repeat';

type Phase = "idle" | "playing" | "done";

/** Faces of science come into focus inside the Y. Plays once on arrival; stays on the mark for reduced motion. */
export default function DiscoveryEnding() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [reduced, setReduced] = useState(false);
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLDivElement>(null);
  const mask = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const controls = useRef<{ play: () => void; finish: () => void }>({ play: () => {}, finish: () => {} });

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const images = new Map<number, { image: HTMLImageElement; loaded: Promise<unknown> }>();
    let run = 0, frame = 0, elapsed = 0, last: number | null = null, raf = 0, played = false, onScreen = false, playing = false;

    const load = (index: number) => {
      let entry = images.get(index);
      if (!entry) {
        const image = new window.Image();
        image.alt = "";
        image.decoding = "async";
        const loaded = new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
        image.src = `/discovery/frames/${PORTRAITS[index].frame}`;
        entry = { image, loaded };
        images.set(index, entry);
      }
      return entry;
    };
    const buffer = () => { for (let i = frame; i < Math.min(frame + LOOK_AHEAD, PORTRAITS.length); i += 1) load(i); };
    const showMark = (opacity: number) => { if (mark.current) mark.current.style.opacity = String(opacity); };

    const show = () => {
      const { image } = load(frame);
      const holder = mask.current;
      if (!holder || !image.complete || !image.naturalWidth || image === holder.lastElementChild) return;
      while (holder.children.length > 1) holder.firstElementChild?.remove();
      holder.append(image);
      if (holder.children.length > 1) image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 70, easing: "ease-out" });
      if (label.current) label.current.textContent = `${String(frame + 1).padStart(2, "0")} / ${PORTRAITS.length} · ${PORTRAITS[frame].name}`;
    };
    const paint = () => {
      const t = Math.min(elapsed / (PORTRAIT_MS + REVEAL_MS * 0.6), 1);
      const focus = (1 - t) ** 1.8;
      const zoom = 5.8 ** focus;
      if (camera.current) camera.current.style.transform = `translateY(${-9 * focus * zoom}%) scale(${zoom})`;
      showMark(Math.max(0, (elapsed - PORTRAIT_MS) / REVEAL_MS));
    };
    const finish = () => {
      run += 1;
      playing = false;
      window.cancelAnimationFrame(raf);
      if (camera.current) camera.current.style.transform = "";
      mask.current?.replaceChildren();
      showMark(1);
      if (label.current) label.current.textContent = "";
      setPhase("done");
    };
    const tick = (now: number) => {
      if (!playing) return;
      // Hold while off screen or in a background tab: nobody should miss it, and it costs nothing there.
      if (!onScreen || document.hidden) { last = null; raf = window.requestAnimationFrame(tick); return; }
      if (last !== null) elapsed += now - last;
      last = now;
      if (elapsed >= PLAY_MS) { finish(); return; }
      if (frame + 1 < PORTRAITS.length && elapsed >= STARTS[frame + 1]) {
        do { frame += 1; } while (frame + 1 < PORTRAITS.length && elapsed >= STARTS[frame + 1]);
        buffer();
      }
      show();
      paint();
      raf = window.requestAnimationFrame(tick);
    };
    const play = async () => {
      const current = ++run;
      played = true;
      frame = 0;
      elapsed = 0;
      last = null;
      mask.current?.replaceChildren();
      showMark(0);
      paint();
      buffer();
      let timer = 0;
      await Promise.race([load(0).loaded, new Promise((resolve) => { timer = window.setTimeout(resolve, FIRST_FRAME_WAIT_MS); })]);
      window.clearTimeout(timer);
      if (run !== current) return;
      if (!load(0).image.naturalWidth) { finish(); return; }
      playing = true;
      setPhase("playing");
      raf = window.requestAnimationFrame(tick);
    };
    controls.current = { play: () => { void play(); }, finish };

    const stayStill = () => { setReduced(true); finish(); };
    if (motion.matches) {
      stayStill();
      return () => { run += 1; };
    }
    showMark(0);
    const node = section.current, view = stage.current;
    if (!node || !view || !("IntersectionObserver" in window)) { finish(); return () => { run += 1; }; }
    const nearby = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { buffer(); nearby.disconnect(); }
    }, { rootMargin: "1200px" });
    nearby.observe(node);
    const visible = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen && !played) void play();
    }, { threshold: 0.45 });
    visible.observe(view);
    const stopForMotion = (event: MediaQueryListEvent) => { if (event.matches) stayStill(); };
    motion.addEventListener("change", stopForMotion);
    return () => {
      run += 1;
      playing = false;
      window.cancelAnimationFrame(raf);
      nearby.disconnect();
      visible.disconnect();
      motion.removeEventListener("change", stopForMotion);
    };
  }, []);

  return (
    <section ref={section} className={s.ending}>
      <div className={s.endingInner}>
        <div ref={stage} className={s.endingStage} role="img"
          aria-label="A gold Y. When it plays, portraits of scientists appear inside the letter before the Y comes into focus.">
          <div ref={camera} className={s.endingCamera} aria-hidden="true">
            <div ref={mask} className={s.endingMask} style={{ mask: MASK, WebkitMask: MASK }} />
            <div ref={mark} className={s.endingMark}><Image src="/discovery/y-mark.png" alt="" width={588} height={517} sizes="(max-width: 700px) 62vw, 340px" /></div>
          </div>
        </div>
        <div className={s.endingStatus}>
          <span ref={label} aria-hidden="true" />
          {!reduced && phase !== "idle" && (
            <button type="button" onClick={() => (phase === "playing" ? controls.current.finish() : controls.current.play())}>
              {phase === "playing" ? "Skip" : "Replay"}
            </button>
          )}
        </div>
        <h2>Every discovery started with a why.</h2>
        <div className={s.endingCta}>
          <Link className={s.button} href="/app">Ask Y ↗</Link>
          <Link className={s.endingGhost} href="/app?ui=mobile">Try it on your phone</Link>
        </div>
        <div className={s.endingFoot}>
          <dl className={s.definition}>
            <dt>Y <span>/waɪ/</span></dt>
            <dd><i>I.</i> The question that starts everything.</dd>
            <dd><i>II.</i> A tutor that asks it back.</dd>
          </dl>
          <div className={s.endingLinks}>
            <p>An early prototype. Best with a tablet or a larger screen.</p>
            <nav aria-label="Footer">
              <a href="https://github.com/Abhijithreddydasari/ask-Y">GitHub ↗</a>
              <Link href="/credits">Portrait credits</Link>
            </nav>
            <p>© 2026 Y. Room to think.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
