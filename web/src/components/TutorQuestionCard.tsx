"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MicButton from "@/components/MicButton";
import { StepText } from "@/components/widgets/StepperWidget";
import type { TutorAnswer } from "@/hooks/useTutorSession";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { Hint, TutorQuestion } from "@/lib/tutor-turn";
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
  /** Hint ladder: rungs given so far, and a request for the next (1 nudge, 2 worked step). */
  hints?: Hint[];
  hintBusy?: boolean;
  onHint?: () => void;
}

const HINT_LABELS = ["Hint", "Show a step"];
/** "How sure?" in three steps; the server still receives a percentage. */
const SURE = [{ label: "Guessing", value: 30 }, { label: "Fairly sure", value: 65 }, { label: "Certain", value: 95 }];

const WIDTH = 380;
/** Room kept free at the bottom for the composer and its caption line. */
const COMPOSER_CLEARANCE = 164;

/** Answer controls for the waiting predict/check, placed under its card on the board. Key it by qid to reset. */
export default function TutorQuestionCard({ question, busy, cardRect, onAnswer, onListen, variant = "studio", hints = [],
  hintBusy = false, onHint }: Props) {
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [heard, setHeard] = useState("");
  // One recording answers once: free text is submitted as said; options need exactly one clear match.
  const answerByVoice = useCallback((spoken: string) => {
    if (!question || busy) return;
    if (question.kind === "free") { setText(spoken); onAnswer({ text: spoken, confidence, via: "spoken" }); return; }
    const match = matchOption(spoken, question.options);
    if (match) { setChoice(match); onAnswer({ choice: match, confidence, via: "spoken" }); }
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

  const tag = question.origin === "review" ? "Warm-up" : question.origin === "exit" ? "Exit check" : question.kind === "predict" ? "Predict" : "Check";

  return (
    <section
      ref={sectionRef}
      role="group"
      aria-label={question.kind === "predict" ? "Your prediction" : "Check your understanding"}
      data-testid="tutor-question"
      style={position}
      className={`pointer-events-auto fixed y-glass-strong flex flex-col gap-3 rounded-[22px] p-4 ${docked
        ? variant === "mobile"
          ? "bottom-[calc(16.75rem+env(safe-area-inset-bottom))] left-3 right-3 z-[55] max-h-[45dvh] overflow-y-auto"
          : "bottom-36 left-1/2 z-40 w-[min(380px,calc(100vw-2rem))] -translate-x-1/2"
        : "z-40"}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-full bg-violet-100 px-2 py-0.5 font-bold uppercase tracking-wider text-violet-800">{tag}</span>
        {question.origin === "review" && <span className="text-slate-500">Warm-up from last time</span>}
        <span className="ml-auto flex gap-1" aria-label={`Hints used: ${hints.length} of ${HINT_LABELS.length}`}>
          {HINT_LABELS.map((label, index) => (
            <span key={label} className={`h-1.5 w-1.5 rounded-full ${index < hints.length ? "bg-amber-500" : "bg-slate-300"}`} />
          ))}
        </span>
      </div>
      {docked && <p className="text-[15px] font-semibold leading-snug text-slate-900">{question.q}</p>}
      <p className="-mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{free ? "Your answer" : "Answer choices"}</p>
      {free ? (
        <textarea aria-label="Your answer" value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={2000}
          placeholder="Type your answer, or hold the mic and say it…" className="w-full resize-none rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm outline-none focus:border-violet-400" />
      ) : (
        <div className="flex flex-col gap-2">
          {question.options.map((option, index) => (
            <button key={option} type="button" aria-pressed={choice === option} onClick={() => setChoice(option)}
              className={`flex min-h-12 items-center gap-3 rounded-2xl border px-3 py-2 text-left text-sm transition ${choice === option ? "border-violet-600 bg-violet-50 text-violet-950" : "border-slate-200 bg-white/80 text-slate-800 hover:border-violet-300"}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg text-xs font-bold ${choice === option ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                {String.fromCharCode(65 + index)}
              </span>
              <span><StepText text={option} /></span>
            </button>
          ))}
        </div>
      )}
      {hints.length > 0 && (
        <ol className="flex flex-col gap-1.5" aria-label="Hints" data-testid="hints">
          {hints.map((hint) => (
            <li key={hint.level} className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              <span className="mr-1 font-semibold">{hint.level === 1 ? "Nudge:" : "Step:"}</span><StepText text={hint.text} />
            </li>
          ))}
        </ol>
      )}
      {(heard || voice.error) && (
        <p role="status" className="rounded-xl bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          {voice.error || `Heard "${heard}". Tap the option you mean.`}
        </p>
      )}
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="How sure are you?" className="flex rounded-xl bg-slate-900/5 p-0.5 text-xs font-semibold">
          {SURE.map((level) => (
            <button key={level.label} type="button" role="radio" aria-checked={confidence === level.value}
              onClick={() => setConfidence(confidence === level.value ? null : level.value)}
              className={`rounded-[10px] px-2.5 py-1.5 transition ${confidence === level.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>
              {level.label}
            </button>
          ))}
        </div>
        <button type="button" disabled={!ready} onClick={() => onAnswer(free ? { text: text.trim(), confidence } : { choice: choice!, confidence })}
          className="ml-auto min-h-10 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-40">Submit</button>
      </div>
      <div className="flex items-center gap-3 border-t border-slate-900/5 pt-2 text-xs">
        {onHint && hints.length < HINT_LABELS.length && (
          <button type="button" disabled={busy || hintBusy} onClick={onHint}
            className="min-h-8 font-semibold text-amber-700 disabled:opacity-40">
            {hintBusy ? "Thinking…" : HINT_LABELS[hints.length]}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onAnswer({ reveal: true, confidence: null })}
          className="min-h-8 text-slate-500 hover:text-slate-800 disabled:opacity-40">Just tell me</button>
        <MicButton voice={voice} disabled={busy} label={free ? "Hold to answer by voice" : "Hold and say a letter or an option"} className="ml-auto min-h-9 min-w-9" />
      </div>
    </section>
  );
}
