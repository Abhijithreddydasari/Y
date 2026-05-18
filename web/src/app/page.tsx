import Link from "next/link";
import ScrollLine from "@/components/ScrollLine";

// Color palette inlined as arbitrary Tailwind values so we don't have to
// extend tailwind.config (we're on v4, where arbitrary hex is idiomatic):
//   ink-black:        #141414
//   learning-yellow:  #f5b041
//   paper-white:      #ffffff
//   surface-bright:   #f9f9f9
//   surface-low:      #f3f3f4
//   surface-lowest:   #ffffff
//   on-surface:       #1a1c1c
//   tertiary:         #5e5e5e
//   on-surface-variant:#514535

export default function LandingPage() {
  return (
    <div
      className="font-[var(--font-jakarta)] flex flex-col min-h-screen relative bg-white text-[#1a1c1c] antialiased"
    >
      <ScrollLine />

      {/* Top nav */}
      <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-xl border-b border-[#1a1c1c]/10">
        <div className="flex justify-between items-center w-full px-4 md:px-12 py-4 max-w-[1200px] mx-auto relative z-10">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#f5b041] text-[#141414] font-extrabold text-lg shadow-sm">
              Y
            </span>
            <span className="text-[20px] font-extrabold tracking-tight text-[#141414]">
              Y
            </span>
          </Link>
          <div className="hidden md:flex gap-8 items-center text-[16px] text-[#514535]">
            <a href="#how" className="nav-link transition-colors hover:text-[#f5b041]">
              How it Works
            </a>
            <a href="#features" className="nav-link transition-colors hover:text-[#f5b041]">
              Features
            </a>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-link transition-colors hover:text-[#f5b041]"
            >
              GitHub
            </a>
          </div>
          <Link
            href="/app"
            className="hidden md:inline-flex primary-btn px-6 py-2 rounded-full font-mono uppercase tracking-wider text-[12px]"
          >
            Start Learning
          </Link>
          <Link
            href="/app"
            className="md:hidden inline-flex primary-btn px-4 py-1.5 rounded-full font-mono uppercase tracking-wider text-[11px]"
          >
            Try it
          </Link>
        </div>
      </nav>

      <main className="flex-grow pt-32 pb-24 px-4 md:px-12 w-full max-w-[1200px] mx-auto flex flex-col gap-[120px] relative z-10">
        {/* Hero */}
        <section className="relative min-h-[60vh] flex flex-col justify-center items-center text-center w-full max-w-4xl mx-auto z-10 pt-16">
          <div className="hero-flow-bg hidden md:block">
            <svg
              className="w-full h-full"
              preserveAspectRatio="xMidYMid slice"
              viewBox="0 0 1200 600"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                className="hero-flow-path"
                d="M -100,300 C 200,100 300,500 600,300 C 900,100 1000,500 1300,300"
              />
              <path
                className="hero-flow-path"
                opacity="0.5"
                d="M -100,400 C 150,200 400,600 700,400 C 1000,200 1100,600 1300,400"
              />
            </svg>
          </div>

          <div className="mb-6 inline-block">
            <span className="bg-[#f3f3f4] text-[#1a1c1c] font-mono text-[12px] px-4 py-1.5 rounded-full border border-[#1a1c1c]/10">
              Now exploring the universe of knowledge
            </span>
          </div>

          <h1 className="text-[28px] md:text-[48px] leading-tight font-extrabold tracking-tight text-[#141414] mb-6 max-w-3xl">
            The AI Moment for{" "}
            <span className="relative whitespace-nowrap">
              <span className="relative z-10">Education</span>
              <span className="absolute bottom-1 left-0 w-full h-3 bg-[#f5b041]/40 -z-10 skew-x-12" />
            </span>
          </h1>

          <p className="text-[18px] leading-7 text-[#5e5e5e] max-w-2xl mx-auto mb-10">
            A learning companion that understands your confusion and draws
            your understanding. From quantum physics to genetics, master
            complex topics through fluid, visual conversations.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
            <Link
              href="/app"
              className="primary-btn px-8 py-3 rounded-full font-mono text-[12px] uppercase tracking-wider flex items-center gap-2"
            >
              Begin Your Journey
              <span className="material-symbols-outlined text-[18px] leading-none">
                arrow_forward
              </span>
            </Link>
            <a
              href="#how"
              className="px-8 py-3 rounded-full font-mono text-[12px] uppercase tracking-wider border border-[#1a1c1c]/20 text-[#1a1c1c] hover:bg-[#f3f3f4] transition-colors flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px] leading-none">
                play_circle
              </span>
              See how it works
            </a>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="w-full">
          <div className="flex flex-col items-center mb-16 text-center">
            <h2 className="text-[32px] md:text-[40px] font-bold text-[#141414] tracking-tight mb-4">
              Fluid Intelligence
            </h2>
            <div className="w-16 h-px bg-[#141414]/20" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard
              icon="draw"
              title="Understands what you draw"
              body="Hand-write or sketch your question on a whiteboard. Mark the unknown with a ?. Y reads the canvas like a tutor reads a chalkboard."
            />
            <FeatureCard
              className="md:mt-12"
              icon="gesture"
              title="Draws like a human"
              body="The explanation appears stroke by stroke alongside spoken narration. Visual rhythm, not a wall of text."
            />
            <FeatureCard
              icon="psychology"
              title="Knows what you know"
              body="A learner profile tracks the concepts you've practiced and adapts the next lesson. Teacher Mode adds private notes for educators."
            />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="w-full relative py-16 rounded-3xl overflow-hidden border border-[#1a1c1c]/5 bg-[#f9f9f9]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 px-8 md:px-16">
            <Step n={1} title="Sketch your question" body="Open the whiteboard, write equations or doodle a diagram, and place a ? where you need help." />
            <Step n={2} title="Tap Solve" body="A local Gemma 4 vision model reads your canvas and streams a tag-by-tag lesson back." />
            <Step n={3} title="Watch and listen" body="The renderer draws each step on the same canvas while a built-in voice narrates. Replay any time." />
          </div>
        </section>

        {/* Illustration */}
        <section className="w-full relative py-20 rounded-3xl overflow-hidden border border-[#1a1c1c]/5 bg-[#f9f9f9] flex items-center justify-center min-h-[400px]">
          <div className="absolute inset-0 z-0 flex items-center justify-center opacity-40">
            <svg
              height="80%"
              width="80%"
              viewBox="0 0 400 400"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M50,200 C100,50 300,350 350,200"
                fill="none"
                stroke="#f5b041"
                strokeWidth={2}
              />
              <circle cx="50" cy="200" fill="#141414" r={4} />
              <circle cx="350" cy="200" fill="#141414" r={4} />
              <circle
                cx="200"
                cy="200"
                fill="none"
                r={8}
                stroke="#141414"
                strokeWidth={1}
              />
              <path
                d="M150,200 L250,200"
                stroke="#141414"
                strokeDasharray="4,4"
                strokeWidth={1}
              />
            </svg>
          </div>
          <div className="relative z-10 text-center max-w-lg px-6">
            <h3 className="text-[28px] md:text-[32px] font-bold text-[#141414] tracking-tight mb-4">
              Visualize the Abstract
            </h3>
            <p className="text-[16px] text-[#5e5e5e] mb-8">
              When words fail, lines connect. Watch complex theories distill
              into elegant single-stroke diagrams.
            </p>
            <Link
              href="/app"
              className="primary-btn inline-flex px-6 py-2.5 rounded-full font-mono text-[12px] uppercase tracking-wider items-center gap-2"
            >
              Try the whiteboard
              <span className="material-symbols-outlined text-[18px] leading-none">arrow_forward</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="w-full py-12 bg-white border-t border-[#1a1c1c]/5 mt-auto relative z-10">
        <div className="flex flex-col md:flex-row justify-between items-center px-4 md:px-12 gap-6 max-w-[1200px] mx-auto w-full">
          <div className="flex flex-col items-center md:items-start gap-2 mb-6 md:mb-0">
            <span className="text-[20px] font-extrabold text-[#1a1c1c]">Y</span>
            <span className="font-mono text-[12px] text-[#5e5e5e]">
              {`(c) ${new Date().getFullYear()} Y. Drawn with precision.`}
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-6 font-mono text-[12px] text-[#514535]">
            <a className="hover:text-[#f5b041] transition-colors" href="#">Twitter</a>
            <a className="hover:text-[#f5b041] transition-colors" href="#">GitHub</a>
            <a className="hover:text-[#f5b041] transition-colors" href="#">LinkedIn</a>
            <a className="hover:text-[#f5b041] transition-colors" href="#">Privacy</a>
            <a className="hover:text-[#f5b041] transition-colors" href="#">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard(props: { icon: string; title: string; body: string; className?: string }) {
  return (
    <div className={`minimalist-card rounded-2xl p-10 flex flex-col items-start gap-6 h-full ${props.className ?? ""}`}>
      <div className="w-12 h-12 rounded-full bg-[#f3f3f4] flex items-center justify-center border border-[#1a1c1c]/5">
        <span className="material-symbols-outlined text-[#f5b041] text-2xl">{props.icon}</span>
      </div>
      <div>
        <h3 className="text-[18px] font-bold text-[#141414] mb-2">{props.title}</h3>
        <p className="text-[16px] text-[#5e5e5e]">{props.body}</p>
      </div>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#141414] text-white font-mono text-sm">
          {n}
        </span>
        <h3 className="text-[18px] font-bold text-[#141414]">{title}</h3>
      </div>
      <p className="text-[16px] text-[#5e5e5e] leading-7">{body}</p>
    </div>
  );
}
