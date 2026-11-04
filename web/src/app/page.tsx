"use client";

import React, { useState } from "react";
import Link from "next/link";
import ScrollLine from "@/components/ScrollLine";
import YMark from "@/components/YMark";
import s from "./landing.module.css";

const topics = ["Pythagorean theorem", "Harmonics", "Normal distribution"];
const captions = ["The squares of the two shorter sides add up to the square of the hypotenuse.", "Combine a fundamental wave with a third harmonic to explore a different shape.", "For a normal distribution, about 68% of values lie within one standard deviation of the mean."];
function wave(fn: (x: number) => number) {
  return Array.from({ length: 66 }, (_, i) => `${i ? "L" : "M"}${20 + i * 4} ${fn(20 + i * 4).toFixed(2)}`).join(" ");
}
export default function LandingPage() {
  const [revealed, setRevealed] = useState(false);
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
          <p className={s.sub}>A place to work through what you don’t understand. Sketch a problem, follow a visual explanation, and ask the question that comes next.</p>
          <div className={s.cta}><Link className={s.button} href="/app">Ask Y ↗</Link><a className={s.ghost} href="#how">See how it works</a></div>
          <div className={s.board}>
            <div className={s.boardTop}><span className={s.dots} aria-hidden="true">● ● ●</span><span>THE SHARED WHITEBOARD</span><span className={s.badge}>Illustrative preview</span></div>
            <div className={s.boardGrid}>
              <div className={s.pad}>
                <div className={s.question}><span>A closed cylinder in a uniform field.<br />What is the net electric flux?</span><span className={s.questionMark}>?</span></div>
                <svg viewBox="0 0 300 180" role="img" aria-label="Uniform electric field passing through a closed cylinder">
                  <g fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M15 60H280M15 90H280M15 120H280"/><path d="m274 54 8 6-8 6m0 18 8 6-8 6m0 18 8 6-8 6"/></g>
                  <g stroke="#292524" strokeWidth="2" fill="#fef3c7" fillOpacity=".65"><ellipse cx="95" cy="90" rx="22" ry="50"/><path d="M95 40H215M95 140H215" fill="none"/><ellipse cx="215" cy="90" rx="22" ry="50"/></g>
                  <text x="23" y="35" fill="#2563eb" fontSize="15">E →</text><text x="75" y="166" fill="#78716c" fontSize="12">No enclosed charge</text>
                </svg>
              </div>
              <div className={s.steps} aria-live="polite">
                <div className={s.step}>Φ = ∮ E · dA<small>Split the surface into two end caps and a curved side.</small></div>
                {revealed ? <><div className={s.step}>Φ<sub>side</sub> = 0<small>The field runs parallel to the curved side.</small></div><div className={s.step}>Φ = −EA + EA = 0<small>Flux entering one cap equals flux leaving the other.</small></div></> : <p className={s.previewHint}>A diagram. The essential steps.<br />Space to see why it works.</p>}
                <p className={s.note}>Brief on the board. More reasoning in chat.</p>
              </div>
            </div>
            <div className={s.boardFooter}><button className={s.button} onClick={() => setRevealed(v => !v)}>{revealed ? "Reset preview" : "Show explanation"}</button><span>A sample interaction, no model request needed.</span></div>
          </div>
        </section>
        <section id="features" className={s.section}>
          <p className={s.eyebrow}>Made for thinking things through</p><h2>Give your questions room.</h2>
          <div className={s.features}>
            <article><span>01 / INPUT</span><h3>Start with your working</h3><p>Write an equation or sketch a diagram. Mark what you’re trying to find with a question mark.</p></article>
            <article><span>02 / EXPLANATION</span><h3>See the essential steps</h3><p>Follow equations, diagrams, and short captions on the board. Open chat for the fuller explanation.</p></article>
            <article><span>03 / UNDERSTANDING</span><h3>Explore a learning profile</h3><p>See concepts and uncertainty in the knowledge atlas. A labelled sample lets you explore the idea before building your own history.</p></article>
          </div>
        </section>
        <section id="how" className={s.section}><h2>Follow the question.</h2><ol className={s.how}>
          {[["Sketch your question", "Write, draw, or pick a sample to get started."], ["Tap Teach me", "Y reads the canvas and builds a visual explanation with optional narration."], ["Keep exploring", "Ask a follow-up in chat, replay the explanation, or try another problem."]].map(([title, body], i) => <li key={title}><b>0{i + 1}</b><div><h3>{title}</h3><p>{body}</p></div></li>)}
        </ol></section>
        <section className={s.section}><h2>Visualize the abstract.</h2><p className={s.sub}>Sometimes a few lines make the idea click.</p>
          <div className={s.tabs} aria-label="Diagram topics">{topics.map((name, i) => <button key={name} aria-pressed={topic === i} onClick={() => setTopic(i)}>{name}</button>)}</div>
          <div className={s.stage}><svg key={topic} viewBox="0 0 300 180" role="img" aria-label={topics[topic]}>
            {topic === 0 ? <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M75 150H225V50Z M213 150V138H225" stroke="#292524" strokeWidth="2.5"/><g className={s.diagramLabels} fill="#292524" fontSize="15"><text x="141" y="170">b</text><text x="236" y="108">a</text><text x="133" y="93">c</text><text x="45" y="28" fill="#b45309">a² + b² = c²</text></g></> : topic === 1 ? <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M20 90H280" stroke="#d6d3d1"/><path className={s.drawPath} pathLength="1" style={{"--delay":".25s"} as React.CSSProperties} d={wave(x => 90 - 45 * Math.sin((x - 20) / 260 * Math.PI * 2))} stroke="#a8a29e"/><path className={s.drawPath} pathLength="1" style={{"--delay":".5s"} as React.CSSProperties} d={wave(x => 90 - 15 * Math.sin((x - 20) / 260 * Math.PI * 6))} stroke="#d97706"/><path className={s.drawPath} pathLength="1" style={{"--delay":".75s"} as React.CSSProperties} d={wave(x => 90 - 45 * Math.sin((x - 20) / 260 * Math.PI * 2) - 15 * Math.sin((x - 20) / 260 * Math.PI * 6))} stroke="#292524" strokeWidth="2.5"/></> : <><path className={s.drawPath} pathLength="1" style={{"--delay":"0s"} as React.CSSProperties} d="M20 140H280 M150 30V140" stroke="#a8a29e"/><path className={s.drawPath} pathLength="1" style={{"--delay":".35s"} as React.CSSProperties} d={wave(x => 140 - 110 * Math.exp(-(((x - 150) / 48) ** 2) / 2))} stroke="#d97706" strokeWidth="3"/><g className={s.diagramLabels}><text x="144" y="162" fill="#292524">μ</text><text x="105" y="20" fill="#78716c" fontSize="12">±1σ ≈ 68%</text></g></>}
          </svg><p>{captions[topic]}</p></div>
        </section>
        <section className={s.end}><p className={s.eyebrow}>Bring your curiosity</p><h2>What are you stuck on?</h2><div className={s.cta}><Link className={s.button} href="/app">Ask Y ↗</Link><Link className={s.ghost} href="/app?ui=mobile">Try it on your phone</Link></div><p className={s.note}>An early prototype. Best with a tablet or a larger screen.</p></section>
      </main>
      <footer className={s.footer}><span>© 2026 Y. Room to think.</span><a href="https://github.com/Abhijithreddydasari/Y">GitHub ↗</a></footer>
    </div></div>
  );
}
