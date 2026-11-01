"use client";

import { useRef } from "react";
import type { VoiceInput } from "@/hooks/useVoiceInput";

interface Props {
  voice: VoiceInput;
  disabled?: boolean;
  label: string;
  className?: string;
}

const HOLD_MS = 350;

/** Push-to-talk: hold and release to send, or tap to start and tap again to send. Escape cancels. */
export default function MicButton({ voice, disabled = false, label, className = "" }: Props) {
  const pressedAt = useRef(0);
  const recording = voice.state === "recording";
  const working = voice.state === "starting" || voice.state === "transcribing";
  const off = disabled || voice.blocked;
  const toggle = () => { if (recording) voice.stop(); else if (voice.state === "idle") voice.start(); };
  const title = voice.blocked ? "Microphone unavailable: type instead"
    : recording ? `Recording ${voice.seconds}s: release or tap to send` : working ? "Listening…" : label;

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      aria-pressed={recording}
      disabled={off || voice.state === "transcribing"}
      data-voice-state={voice.state}
      onPointerDown={(event) => {
        if (event.button !== 0 || off) return;
        event.preventDefault();
        pressedAt.current = recording ? 0 : performance.now();
        toggle();
      }}
      onPointerUp={() => {
        // A long press is hold-to-talk; a short tap leaves the recording running until the next tap.
        if (pressedAt.current && performance.now() - pressedAt.current >= HOLD_MS) voice.stop();
        pressedAt.current = 0;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (recording || working)) { event.preventDefault(); voice.cancel(); }
        else if ((event.key === "Enter" || event.key === " ") && !event.repeat) { event.preventDefault(); toggle(); }
      }}
      className={`grid min-h-10 min-w-10 shrink-0 place-items-center rounded-xl text-sm font-semibold transition disabled:opacity-40 ${recording
        ? "bg-rose-500 text-white shadow-[0_0_0_4px_rgba(244,63,94,.2)]" : "bg-slate-100 text-slate-700 hover:bg-slate-200"} ${className}`}
    >
      {voice.state === "transcribing" ? <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
        : recording ? <span className="tabular-nums">{voice.seconds}s</span>
          : (
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          )}
    </button>
  );
}
