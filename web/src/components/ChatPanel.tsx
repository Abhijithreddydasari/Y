"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { transcribeAudio } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { startWavRecording, type WavRecording } from "@/lib/wav-recorder";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  disabled?: boolean;
  sttAvailable: boolean;
  sttModel?: string;
  onSend: (text: string) => void;
  onClear: () => void;
  onCancel: () => void;
}

const MAX_RECORDING_MS = 60_000;

function ChatIcon({ open }: { open: boolean }) {
  return open ? (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 17.2 3.8 20v-5.1A8 8 0 1 1 7 17.2Z" strokeLinejoin="round" />
      <path d="M8 9.4h8M8 13h5" strokeLinecap="round" />
    </svg>
  );
}

export default function ChatPanel({
  messages,
  busy,
  disabled = false,
  sttAvailable,
  sttModel,
  onSend,
  onClear,
  onCancel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState("");
  const [readCount, setReadCount] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<WavRecording | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, open]);

  useEffect(() => () => {
    transcriptAbortRef.current?.abort();
    void recorderRef.current?.cancel();
    if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || disabled || transcribing) return;
    setDraft("");
    onSend(text);
  };

  const stopRecording = () => {
    if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
    recordTimerRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    setRecording(false);
    setTranscribing(true);
    void recorder.stop().then(async (blob) => {
      if (!blob.size) {
        setMicError("No audio was captured.");
        return;
      }
      const controller = new AbortController();
      transcriptAbortRef.current = controller;
      try {
        const text = await transcribeAudio(blob, controller.signal);
        if (text) onSend(text);
        else setMicError("No speech was detected.");
      } catch (error) {
        if (!controller.signal.aborted) setMicError((error as Error).message);
      } finally {
        if (transcriptAbortRef.current === controller) transcriptAbortRef.current = null;
      }
    }).catch((error) => setMicError((error as Error).message)).finally(() => {
      setTranscribing(false);
    });
  };

  const startRecording = async () => {
    if (!sttAvailable || recording || transcribing || busy || disabled) return;
    setMicError("");
    try {
      const recorder = await startWavRecording();
      recorderRef.current = recorder;
      setRecording(true);
      recordTimerRef.current = setTimeout(stopRecording, MAX_RECORDING_MS);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission was denied."
        : "The microphone is unavailable.";
      setMicError(message);
    }
  };

  const unread = Math.max(0, messages.length - readCount);
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) setReadCount(messages.length);
  };

  return (
    <div className="pointer-events-none fixed bottom-20 right-5 z-50 flex flex-col items-end gap-3 sm:bottom-20 sm:right-6">
      {open && (
        <section
          id="lesson-chat-panel"
          aria-label="Lesson chat"
          className="chat-panel-enter pointer-events-auto flex h-[min(680px,calc(100dvh-132px))] w-[min(430px,calc(100vw-24px))] flex-col overflow-hidden rounded-[26px] border border-slate-200/80 bg-white/95 shadow-[0_24px_80px_rgba(15,23,42,.24)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/94"
        >
          <header className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3 dark:border-white/10">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400 via-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20">
                <ChatIcon open={false} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">Talk through the lesson</h2>
                <p className="truncate text-[11px] text-slate-500 dark:text-zinc-400">Whiteboard transcript · Markdown · local speech input</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button type="button" onClick={onClear} className="rounded-lg px-2 py-1 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-white">Clear</button>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label="Close chat" className="grid h-8 w-8 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 dark:hover:bg-white/10">
                <ChatIcon open />
              </button>
            </div>
          </header>

          <div ref={scrollerRef} className="chat-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
            {messages.length === 0 ? (
              <div className="mx-auto mt-10 max-w-[290px] text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-3xl bg-gradient-to-br from-cyan-50 to-indigo-100 text-indigo-600 ring-1 ring-indigo-100 dark:from-cyan-950 dark:to-indigo-950 dark:text-cyan-300 dark:ring-white/10">
                  <ChatIcon open={false} />
                </div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-zinc-100">Your lesson, in readable form</h3>
                <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-zinc-400">Press Solve and the board explanation will appear here as Markdown. Ask a follow-up by typing or speaking.</p>
              </div>
            ) : messages.map((message) => (
              <article key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={message.role === "user"
                  ? "max-w-[86%] rounded-2xl rounded-br-md bg-slate-900 px-3.5 py-2.5 text-sm text-white shadow-sm dark:bg-white dark:text-zinc-950"
                  : `max-w-[94%] rounded-2xl rounded-bl-md border px-3.5 py-3 text-sm shadow-sm ${message.error ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200" : "border-slate-200/80 bg-slate-50/90 text-slate-800 dark:border-white/10 dark:bg-white/[.055] dark:text-zinc-100"}`
                }>
                  {message.role === "assistant" && message.source && (
                    <div className="mb-2 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[.16em] text-slate-400 dark:text-zinc-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {message.source === "chat" ? "Tutor" : message.source === "assessment" ? "Assessment" : "Whiteboard"}
                    </div>
                  )}
                  {message.pending && !message.content ? (
                    <div className="flex gap-1 py-1" aria-label="Tutor is thinking">
                      <span className="chat-thinking-dot" /><span className="chat-thinking-dot" /><span className="chat-thinking-dot" />
                    </div>
                  ) : (
                    <div className="chat-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{message.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>

          <footer className="border-t border-slate-200/70 bg-white/75 p-3 dark:border-white/10 dark:bg-zinc-950/70">
            {micError && <p role="alert" className="mb-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/60 dark:text-rose-200">{micError}</p>}
            <form onSubmit={submit} className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-inner focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:border-white/10 dark:bg-white/[.055] dark:focus-within:ring-blue-900/40">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                maxLength={4000}
                placeholder={recording ? "Listening…" : transcribing ? "Transcribing locally…" : disabled ? "Lesson is still being drawn…" : "Ask a follow-up…"}
                disabled={recording || transcribing || disabled}
                className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60 dark:text-white"
                aria-label="Chat message"
              />
              <button
                type="button"
                onClick={() => recording ? stopRecording() : void startRecording()}
                disabled={!sttAvailable || transcribing || busy || disabled}
                aria-label={recording ? "Stop recording" : "Speak message"}
                title={sttAvailable ? `Speak with local ${sttModel ?? "Moonshine STT"}` : "Install local STT with: uv sync --extra stt"}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl transition ${recording ? "animate-pulse bg-rose-500 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-white/10 dark:hover:text-cyan-300"}`}
              >
                {transcribing ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" /> : recording ? <span className="h-3.5 w-3.5 rounded-sm bg-current" /> : (
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" strokeLinecap="round" /></svg>
                )}
              </button>
              {busy ? (
                <button type="button" onClick={onCancel} aria-label="Stop chat response" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500 text-white transition hover:bg-rose-600"><span className="h-3.5 w-3.5 rounded-sm bg-current" /></button>
              ) : (
                <button type="submit" disabled={!draft.trim() || transcribing || disabled} aria-label="Send message" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/20 transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-35">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 14-7-4 14-3-6-7-1Z" strokeLinejoin="round" /></svg>
                </button>
              )}
            </form>
            <p className="mt-1.5 px-1 text-[9px] text-slate-400 dark:text-zinc-600">Enter to send · Shift+Enter for a new line · microphone stays local</p>
          </footer>
        </section>
      )}

      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls="lesson-chat-panel"
        aria-label={open ? "Close lesson chat" : "Open lesson chat"}
        className="chat-orb pointer-events-auto relative grid h-16 w-16 place-items-center rounded-full border border-white/70 bg-gradient-to-br from-cyan-400 via-blue-500 to-indigo-700 text-white shadow-[0_14px_36px_rgba(37,99,235,.38)] transition duration-300 hover:-translate-y-1 hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-300/60 active:scale-95"
      >
        <span className="absolute inset-[5px] rounded-full border border-white/30" />
        <ChatIcon open={open} />
        {!open && unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white">{Math.min(unread, 9)}</span>}
        {!open && busy && <span className="absolute bottom-1 right-0 h-3.5 w-3.5 animate-pulse rounded-full bg-amber-300 ring-2 ring-blue-600" />}
      </button>
    </div>
  );
}
