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
  /** Bring the question's card on the board into view, with room for these controls under it. */
  onReveal?: (qid: string) => void;
}

const HINT_LABELS = ["Hint", "Show a step"];
/** "How sure?" in three steps; the server still receives a percentage. */
const SURE = [{ label: "Guessing", value: 30 }, { label: "Fairly sure", value: 65 }, { label: "Certain", value: 95 }];

const WIDTH = 380;
/** Room kept free at the bottom for the composer and its caption line. */
const COMPOSER_CLEARANCE = 164;
/** Height assumed for the controls while they are collapsed and cannot be measured. */
const TYPICAL_HEIGHT = 300;
/** Panning further than this after "Back to it" hands placement back to the normal rule. */
const OPENED_SLOP = 40;
const SETTLE_MS = 150;
/** The lesson's own closing scroll animates for about this long; a reveal made sooner would be overridden. */
const ARRIVAL_MS = 450;

type Place = { left: number; top: number; maxHeight: number } | "away" | "arriving" | null;

/**
 * Answer controls for the waiting predict/check, under its card on the board. They never sit over the lesson: when the
 * board card is off screen, or there is no room under it, or the learner closes them, they shrink to a pill above the
 * composer. The question stays open either way. Key it by qid to reset.
 */
export default function TutorQuestionCard({ question, busy, cardRect, onAnswer, onListen, variant = "studio", hints = [],
  hintBusy = false, onHint, onReveal }: Props) {
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
  const [place, setPlace] = useState<Place>(variant === "mobile" ? null : "arriving");
  const [arrived] = useState(() => performance.now());
  const [closed, setClosed] = useState(false);
  const placeRef = useRef(place);
  const sectionRef = useRef<HTMLElement | null>(null);
  const heightRef = useRef(TYPICAL_HEIGHT);
  const revealedRef = useRef(false);
  // Set by "Back to it": on a short screen the card may not fit under its anchor, so stay until the learner pans away.
  const openedRef = useRef<{ at: number; top: number | null } | null>(null);

  const reveal = useCallback(() => {
    if (!question) return;
    openedRef.current = { at: performance.now(), top: null };
    onReveal?.(question.qid);
  }, [onReveal, question]);

  // Follow the card through pan and zoom; only re-render when the position actually moves.
  useEffect(() => {
    if (!question || variant === "mobile") return;
    let frame = 0;
    const tick = () => {
      const rect = cardRect(question.qid);
      if (sectionRef.current?.scrollHeight) heightRef.current = sectionRef.current.scrollHeight;
      let next: Place = null;
      if (rect) {
        const opened = openedRef.current;
        if (opened && performance.now() - opened.at > SETTLE_MS) {
          opened.top ??= rect.top;
          if (Math.abs(rect.top - opened.top) > OPENED_SLOP) openedRef.current = null;
        }
        const top = Math.max(12, rect.bottom + 8);
        const room = window.innerHeight - top - COMPOSER_CLEARANCE;
        const seen = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        next = seen && (room >= heightRef.current || (openedRef.current && room > 160))
          // Always below its board card, never over it; on a short screen the controls scroll inside.
          ? { left: Math.max(12, Math.min(rect.left, window.innerWidth - WIDTH - 12)), top, maxHeight: room }
          : "away";
        // A new question arrives in view once, with room to answer; after that the learner's scrolling is respected.
        if (!revealedRef.current) {
          if (performance.now() - arrived < ARRIVAL_MS) next = "arriving";
          else {
            revealedRef.current = true;
            if (next === "away") { reveal(); next = "arriving"; }
          }
        }
      }
      const old = placeRef.current;
      const same = old === next || (old && next && typeof old === "object" && typeof next === "object"
        && old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight);
      if (!same) { placeRef.current = next; setPlace(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [arrived, cardRect, question, reveal, variant]);

  if (!question) return null;
  // The board card is settling into view: show nothing yet, rather than a jump. No board card at all: dock right away.
  if (place === "arriving" && !closed && cardRect(question.qid)) return null;
  const free = question.kind === "free";
  const ready = !busy && (free ? Boolean(text.trim()) : choice !== null);
  const anchored = variant !== "mobile" && place && typeof place === "object" ? place : null;
  const docked = !anchored;
  const position = anchored ? { left: anchored.left, top: anchored.top, maxHeight: anchored.maxHeight, width: WIDTH, overflowY: "auto" as const } : undefined;

  const tag = question.origin === "review" ? "Warm-up" : question.origin === "exit" ? "Exit check" : question.kind === "predict" ? "Predict" : "Check";

  if (closed || (variant !== "mobile" && place === "away")) {
    return (
      <div role="group" aria-label="Question waiting" data-testid="question-pill"
        className={`pointer-events-auto fixed y-glass-strong flex items-center gap-2 rounded-full py-1.5 pl-2 pr-1.5 text-sm ${variant === "mobile"
          ? "bottom-[calc(16.75rem+env(safe-area-inset-bottom))] left-3 z-[55]"
          : "bottom-[164px] left-1/2 z-40 -translate-x-1/2"}`}>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-violet-800">{tag}</span>
        <span className="whitespace-nowrap text-slate-700">Question waiting</span>
        <button type="button" onClick={() => { setClosed(false); reveal(); }}
          className="min-h-9 whitespace-nowrap rounded-full px-3 font-semibold text-violet-700 hover:bg-violet-50">Back to it</button>
      </div>
    );
  }

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
        <button type="button" aria-label="Close question" title="Close; the question stays open" onClick={() => setClosed(true)}
          className="-my-1 -mr-1 grid h-8 w-8 place-items-center rounded-full text-slate-500 hover:bg-slate-900/5 hover:text-slate-800">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
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
