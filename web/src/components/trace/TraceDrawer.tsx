"use client";

// Trace drawer: which model did each stage of this session and how long it took. Opt-in and read-only;
// it fetches only while open (on open and after each turn), never polls.
import { useEffect, useRef, useState } from "react";
import { boardSession } from "@/lib/board-api";
import { CLIENT_STAGES, fetchTrace, labelerName, modelName, seconds, type SessionTrace } from "@/lib/trace";
import type { TutorTimeline } from "@/lib/tutor-turn";

interface Props { timing: TutorTimeline | null; onClose: () => void }

const SCALE_MS = 12_000;

function Bar({ ms, tone = "bg-sky-500" }: { ms: number | null | undefined; tone?: string }) {
  const width = ms == null ? 0 : Math.max(2, Math.min(100, (ms / SCALE_MS) * 100));
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80" aria-hidden="true">
      <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${width}%` }} />
    </span>
  );
}

function Row({ title, model, ms, detail, tone }: { title: string; model?: string; ms: number | null | undefined; detail?: string; tone?: string }) {
  return (
    <li className="grid gap-1 py-2">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="min-w-0 truncate font-semibold text-slate-800">{title}</span>
        <span className="shrink-0 tabular-nums text-slate-600">{seconds(ms)}</span>
      </div>
      <Bar ms={ms} tone={tone} />
      {(model || detail) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          {model && <span className="rounded-md bg-slate-900/[.06] px-1.5 py-px font-medium text-slate-700">{model}</span>}
          {detail && <span>{detail}</span>}
        </div>
      )}
    </li>
  );
}

export default function TraceDrawer({ timing, onClose }: Props) {
  const [trace, setTrace] = useState<SessionTrace | null>(null);
  const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void boardSession().then((id) => fetchTrace(id, controller.signal)).then(setTrace)
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? "The trace is unavailable right now." : ""); });
    return () => controller.abort();
  }, [timing]);

  useEffect(() => {
    panel.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const turns = [...(trace?.turns ?? [])].reverse();
  return (
    <aside ref={panel} tabIndex={-1} role="dialog" aria-label="Trace: models and latency"
      className="y-glass-strong pointer-events-auto fixed bottom-3 right-3 top-3 z-[95] flex w-[min(360px,calc(100vw-24px))] flex-col rounded-2xl outline-none">
      <header className="flex items-center justify-between gap-2 border-b border-slate-900/10 px-4 py-3">
        <div>
          <h2 className="text-[13px] font-bold text-slate-900">Trace</h2>
          <p className="text-[11px] text-slate-500">Which model did what, and how long each stage took</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close trace" className="grid h-9 w-9 place-items-center rounded-full text-lg text-slate-600 hover:bg-slate-900/5">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {timing && (
          <section aria-label="Latest turn in this browser" className="pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Latest turn, this browser (from Ask)</h3>
            <ul className="divide-y divide-slate-900/5">
              {CLIENT_STAGES.filter(([key]) => timing[key] != null).sort(([a], [b]) => timing[a] - timing[b]).map(([key, label]) => (
                <Row key={key} title={label} ms={timing[key]} tone="bg-emerald-500" />
              ))}
            </ul>
          </section>
        )}
        {error && <p className="pt-3 text-[12px] text-rose-700">{error}</p>}
        {!trace && !error && <p className="pt-3 text-[12px] text-slate-500">Loading…</p>}
        {trace && (
          <>
            <section aria-label="Tutor turns" className="pt-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tutor turns</h3>
              {!turns.length && <p className="py-2 text-[12px] text-slate-500">No turns yet. Ask a question.</p>}
              <ul className="divide-y divide-slate-900/5">
                {turns.map((t) => {
                  const points = t.points.length ? `${t.points.length} ring${t.points.length > 1 ? "s" : ""} (line ${t.points.map((p) => p.line).join(", ")}, ${t.points.map((p) => p.snap).join("/")})` : "";
                  const tokens = t.usage.input_tokens ? `${t.usage.input_tokens} in / ${t.usage.output_tokens ?? 0} out` : "";
                  const first = t.ms.first_move_ms != null ? `first move ${seconds(t.ms.first_move_ms)}` : "";
                  const detail = [first, tokens, points, t.dropped ? `${t.dropped} dropped` : "", t.repairs ? `${t.repairs} repaired` : "",
                    t.error ?? "", t.status].filter(Boolean).join(" · ");
                  return <Row key={t.seq} title={`#${t.seq} ${t.kind}${t.goal ? `: ${t.goal}` : ""}`} ms={t.ms.total_ms} detail={detail}
                    model={t.model_call ? modelName(t.tutor?.model, t.tutor?.effort) : "Stored check (no model)"} />;
                })}
              </ul>
            </section>
            {trace.hints.length > 0 && (
              <section aria-label="Hints" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hints</h3>
                <ul className="divide-y divide-slate-900/5">
                  {trace.hints.map((h) => <Row key={`${h.qid}-${h.level}`} title={h.level === 1 ? "Nudge" : "Worked step"} ms={h.ms}
                    model={modelName(h.tutor?.model, h.tutor?.effort)} tone="bg-violet-500" />)}
                </ul>
              </section>
            )}
            {trace.labels.length > 0 && (
              <section aria-label="Evidence labels" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Evidence labels (background)</h3>
                <ul className="divide-y divide-slate-900/5">
                  {trace.labels.map((l) => <Row key={l.qid} title={`Answer ${l.qid.split(".").pop()} · ${l.modality ?? "answer"}`} ms={l.ms.label_ms}
                    model={labelerName(l)} tone="bg-amber-500"
                    detail={[l.ms.provider_ms != null ? `call ${seconds(l.ms.provider_ms)}` : "", l.ms.queue_ms ? `queued ${seconds(l.ms.queue_ms)}` : "",
                      l.images ? `${l.images} ink crop${l.images > 1 ? "s" : ""}` : "", l.error ?? l.status].filter(Boolean).join(" · ")} />)}
                </ul>
              </section>
            )}
            {trace.close && (
              <section aria-label="Session close" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Session close</h3>
                <ul>
                  <Row title={`Sealed revision ${trace.close.revision ?? "—"}`} ms={trace.close.ms} model={modelName(trace.close.notes_model)} tone="bg-rose-500"
                    detail={trace.close.notes.error ? `notes failed: ${trace.close.notes.error}`
                      : [`${trace.close.sealed ?? 0} answers`, `${trace.close.notes.kept ?? 0} cited notes`,
                        trace.close.notes.named?.length ? `${trace.close.notes.named.length} named beliefs` : "",
                        trace.close.notes.links ? `${trace.close.notes.links} links` : ""].filter(Boolean).join(" · ")} />
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
