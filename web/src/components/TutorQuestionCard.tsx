"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MicButton from "@/components/MicButton";
import type { TutorAnswer } from "@/hooks/useTutorSession";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { TutorQuestion } from "@/lib/tutor-turn";
import { matchOption } from "@/lib/voice-input";

interface Props {
  question: TutorQuestion | null;
  busy: boolean;
  /** Screen rect of the card drawn on the board, or null when it is off-board. */
  cardRect: (qid: string) => DOMRect | null;
  onAnswer: (answer: TutorAnswer) => void;
  /** The learner started speaking: silence the narration. */
  onListen?: () => void;
  variant?: "studio" | "mobile";
}

const WIDTH = 360;
/** Room kept free at the bottom for the composer and its caption line. */
const COMPOSER_CLEARANCE = 124;

/** Answer controls for the waiting predict/check, placed under its card on the board. Key it by qid to reset. */
export default function TutorQuestionCard({ question, busy, cardRect, onAnswer, onListen, variant = "studio" }: Props) {
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [heard, setHeard] = useState("");
  // One recording answers once: free text is submitted as said; options need exactly one clear match.
  const answerByVoice = useCallback((spoken: string) => {
    if (!question || busy) return;
    if (question.kind === "free") { setText(spoken); onAnswer({ text: spoken, confidence }); return; }
    const match = matchOption(spoken, question.options);
    if (match) { setChoice(match); onAnswer({ choice: match, confidence }); }
    else setHeard(spoken);
  }, [busy, confidence, onAnswer, question]);
  const voice = useVoiceInput(answerByVoice, onListen);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const placeRef = useRef(place);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Follow the card through pan and zoom; only re-render when the position actually moves.
  useEffect(() => {
    if (!question || variant === "mobile") return;
    let frame = 0;
    const tick = () => {
      const rect = cardRect(question.qid);
      let next: { left: number; top: number } | null = null;
      if (rect && rect.bottom > 0 && rect.top < window.innerHeight - 160 && rect.right > 0 && rect.left < window.innerWidth) {
        next = { left: Math.max(12, Math.min(rect.left, window.innerWidth - WIDTH - 12)),
          // Keep the whole card, including its mic and Submit row, above the composer.
          top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - (sectionRef.current?.offsetHeight ?? 260) - COMPOSER_CLEARANCE)) };
      }
      const old = placeRef.current;
      if (next?.left !== old?.left || next?.top !== old?.top) { placeRef.current = next; setPlace(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cardRect, question, variant]);

  if (!question) return null;
  const free = question.kind === "free";
  const ready = !busy && (free ? Boolean(text.trim()) : choice !== null);
  const docked = variant === "mobile" || !place;
  const position = docked ? undefined : { left: place!.left, top: place!.top, width: WIDTH };

  return (
    <section
      ref={sectionRef}
      role="group"
      aria-label={question.kind === "predict" ? "Your prediction" : "Check your understanding"}
      data-testid="tutor-question"
      style={position}
      className={docked
        ? variant === "mobile"
          ? "pointer-events-auto fixed bottom-[calc(14.75rem+env(safe-area-inset-bottom))] left-3 right-3 z-[55] max-h-[45dvh] overflow-y-auto rounded-2xl border border-violet-200 bg-white/97 p-3 shadow-xl"
          : "pointer-events-auto fixed bottom-24 left-1/2 z-40 w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-violet-200 bg-white/97 p-3 shadow-xl"
        : "pointer-events-auto fixed z-40 rounded-2xl border border-violet-200 bg-white/97 p-3 shadow-xl"}
    >
      {docked && <p className="mb-2 text-sm font-medium text-slate-900">{question.q}</p>}
      {free ? (
        <textarea aria-label="Your answer" value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={2000}
          placeholder="Type your answer…" className="w-full resize-none rounded-xl border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-violet-400" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {question.options.map((option, index) => (
            <button key={option} type="button" aria-pressed={choice === option} onClick={() => setChoice(option)}
              className={`rounded-xl border px-3 py-2 text-left text-sm transition ${choice === option ? "border-violet-500 bg-violet-50 text-violet-900" : "border-slate-200 bg-white text-slate-800 hover:border-violet-300"}`}>
              <span className="mr-2 font-semibold">{String.fromCharCode(65 + index)}.</span>{option}
            </button>
          ))}
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
        <span className="shrink-0">How sure?</span>
        <input type="range" min={0} max={100} step={5} value={confidence ?? 50} aria-label="Confidence"
          onChange={(event) => setConfidence(Number(event.target.value))} className="flex-1 accent-violet-600" />
        <span className="w-12 text-right tabular-nums">{confidence === null ? "—" : `${confidence}%`}</span>
      </label>
      {(heard || voice.error) && (
        <p role="status" className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {voice.error || `Heard "${heard}". Tap the option you mean.`}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <button type="button" disabled={busy} onClick={() => onAnswer({ reveal: true, confidence: null })}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:underline disabled:opacity-40">Just tell me</button>
        <MicButton voice={voice} disabled={busy} label={free ? "Hold to answer by voice" : "Hold and say a letter or an option"} className="ml-auto min-h-9 min-w-9" />
        <button type="button" disabled={!ready} onClick={() => onAnswer(free ? { text: text.trim(), confidence } : { choice: choice!, confidence })}
          className="min-h-9 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-40">Submit</button>
      </div>
    </section>
  );
}
