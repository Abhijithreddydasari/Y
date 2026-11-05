"use client";

import React, { useState } from "react";
import Link from "next/link";
import LandingFrames from "@/components/LandingFrames";
import ScrollLine from "@/components/ScrollLine";
import YMark from "@/components/YMark";
import s from "./landing.module.css";

const topics = ["Pythagorean theorem", "Harmonics", "Normal distribution"];
const captions = ["The squares of the two shorter sides add up to the square of the hypotenuse.", "Combine a fundamental wave with a third harmonic to explore a different shape.", "For a normal distribution, about 68% of values lie within one standard deviation of the mean."];
function wave(fn: (x: number) => number) {
  return Array.from({ length: 66 }, (_, i) => `${i ? "L" : "M"}${20 + i * 4} ${fn(20 + i * 4).toFixed(2)}`).join(" ");
}
export default function LandingPage() {
  const [topic, setTopic] = useState(0);
  return (
    <div className={s.page}><ScrollLine /><div className={s.content}>
      <header className={s.header}>
        <Link href="/" className={s.logo} aria-label="Y home"><YMark size={46} /></Link>
        <nav aria-label="Main navigation"><a className={s.navLink} href="#how">How it works</a><a className={s.navLink} href="#features">Features</a><Link className={s.button} href="/app">Ask Y ↗</Link></nav>
      </header>
      <main>
        <section className={s.hero}>
          <p className={s.eyebrow}>A little curiosity. A different way to learn.</p>
          <h1>Draw the question.<br />See <span className={s.mark}><span>understanding</span><svg viewBox="0 0 420 16" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M6 10C90 5 250 3 414 9" /></svg></span><br />take shape.</h1>
          <p className={s.sub}>Ask anything, out loud or typed. Y teaches on a shared whiteboard, checks what you understood, and remembers how you think, so the next lesson starts from there.</p>
          <div className={s.cta}><Link className={s.button} href="/app">Ask Y ↗</Link><a className={s.ghost} href="#how">See how it works</a></div>
          <LandingFrames />
        </section>
        <section id="features" className={s.section}>
          <p className={s.eyebrow}>Made for thinking things through</p><h2>Give your questions room.</h2>
          <div className={s.features}>
            <article><span>01 / INPUT</span><h3>Start with your question</h3><p>Type or speak it, on an empty board or beside your own working. Circle a step if that is where you are stuck.</p></article>
            <article><span>02 / EXPLANATION</span><h3>See the essential steps</h3><p>Follow handwritten steps, equations, editable diagrams and live widgets on the board, with a voice that keeps pace.</p></article>
            <article><span>03 / UNDERSTANDING</span><h3>See what Y knows about you</h3><p>Mind maps what you know and the wrong beliefs Y has noticed, each with the answers behind it. Try a sample learner, or build your own.</p></article>
          </div>
        </section>
        <section id="how" className={s.section}><h2>Follow the question.</h2><ol className={s.how}>
          {[["Ask your question", "Type or speak it. Y reads what is on the board, including your handwriting."], ["Learn and answer", "Y teaches a step at a time and stops to check. A wrong answer gets a different explanation, not the same one."], ["Come back", "End the session and Y saves what it learned. The next lesson starts from what you got wrong."]].map(([title, body], i) => <li key={title}><b>0{i + 1}</b><div><h3>{title}</h3><p>{body}</p></div></li>)}
        </ol></section>
        <section className={s.section}><h2>Visualize the abstract.</h2><p className={s.sub}>Sometimes a few lines make the idea click.</p>
          <div className={s.tabs} aria-label="Diagram topics">{topics.map((name, i) => <button key={name} aria-pressed={topic === i} onClick={() => setTopic(i)}>{name}</button>)}</div>
          <div className={s.stage}><svg key={topic} viewBox="0 0 300 180" role="img" aria-label={topics[topic]}>
            {topic === 0 ? <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M75 150H225V50Z M213 150V138H225" stroke="#292524" strokeWidth="2.5"/><g className={s.diagramLabels} fill="#292524" fontSize="15"><text x="141" y="170">b</text><text x="236" y="108">a</text><text x="133" y="93">c</text><text x="45" y="28" fill="#b45309">a² + b² = c²</text></g></> : topic === 1 ? <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M20 90H280" stroke="#d6d3d1"/><path className={s.drawPath} pathLength="1" style={{"--delay":".25s"} as React.CSSProperties} d={wave(x => 90 - 45 * Math.sin((x - 20) / 260 * Math.PI * 2))} stroke="#a8a29e"/><path className={s.drawPath} pathLength="1" style={{"--delay":".5s"} as React.CSSProperties} d={wave(x => 90 - 15 * Math.sin((x - 20) / 260 * Math.PI * 6))} stroke="#d97706"/><path className={s.drawPath} pathLength="1" style={{"--delay":".75s"} as React.CSSProperties} d={wave(x => 90 - 45 * Math.sin((x - 20) / 260 * Math.PI * 2) - 15 * Math.sin((x - 20) / 260 * Math.PI * 6))} stroke="#292524" strokeWidth="2.5"/></> : <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M20 140H280 M150 30V140" stroke="#a8a29e"/><path className={s.drawPath} pathLength="1" style={{"--delay":".35s"} as React.CSSProperties} d={wave(x => 140 - 110 * Math.exp(-(((x - 150) / 48) ** 2) / 2))} stroke="#d97706" strokeWidth="3"/><g className={s.diagramLabels}><text x="144" y="162" fill="#292524">μ</text><text x="105" y="20" fill="#78716c" fontSize="12">±1σ ≈ 68%</text></g></>}
          </svg><p>{captions[topic]}</p></div>
        </section>
        <section className={s.end}><p className={s.eyebrow}>Bring your curiosity</p><h2>What are you stuck on?</h2><div className={s.cta}><Link className={s.button} href="/app">Ask Y ↗</Link><Link className={s.ghost} href="/app?ui=mobile">Try it on your phone</Link></div><p className={s.note}>An early prototype. Best with a tablet or a larger screen.</p></section>
      </main>
      <footer className={s.footer}><span>© 2026 Y. Room to think.</span><a href="https://github.com/Abhijithreddydasari/ask-Y">GitHub ↗</a></footer>
    </div></div>
  );
}
