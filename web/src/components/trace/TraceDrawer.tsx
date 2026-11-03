"use client";

// Trace drawer: which model did each stage of this session and how long it took. Opt-in and read-only;
// it fetches only while open (on open and after each turn), never polls.
import { useEffect, useRef, useState } from "react";
import { PlaceHeader } from "@/components/places/PlaceSheet";
import { boardSession } from "@/lib/board-api";
import { CLIENT_STAGES, fetchTrace, labelerName, modelName, seconds, type SessionTrace } from "@/lib/trace";
import type { TutorTimeline } from "@/lib/tutor-turn";

interface Props { timing: TutorTimeline | null; onClose: () => void }

const SCALE_MS = 12_000;

/** One colour and letter per kind of stage, as in the timeline mockup. */
const STAGE = {
  browser: ["B", "#10b981"], turn: ["T", "#6366f1"], stored: ["R", "#64748b"], hint: ["H", "#a855f7"],
  label: ["L", "#f59e0b"], close: ["C", "#ef4444"],
} as const;
type Stage = keyof typeof STAGE;

function Row({ stage, title, model, ms, detail }: { stage: Stage; title: string; model?: string; ms: number | null | undefined; detail?: string }) {
  const [letter, color] = STAGE[stage];
  const width = ms == null ? 0 : Math.max(2, Math.min(100, (ms / SCALE_MS) * 100));
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 py-2">
      <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-[9px] text-[12px] font-extrabold text-white" style={{ background: color }}>{letter}</span>
      <span className="grid min-w-0 gap-1">
        <span className="flex items-baseline justify-between gap-2 text-[13px]">
          <b className="min-w-0 truncate font-semibold text-slate-900">{title}</b>
          <span className="shrink-0 tabular-nums text-slate-600">{seconds(ms)}</span>
        </span>
        <span className="block h-[5px] overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <span className="block h-full rounded-full" style={{ width: `${width}%`, background: color }} />
        </span>
        {(model || detail) && (
          <span className="text-[11px] text-slate-500">
            {model && <span className="font-medium text-slate-700">{model}</span>}{model && detail ? " · " : ""}{detail}
          </span>
        )}
      </span>
    </li>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-3 py-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-900">{value}</div>
    </div>
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
  const models = new Set([...(trace?.turns ?? []).filter((t) => t.model_call && t.tutor).map((t) => t.tutor!.model),
    ...(trace?.hints ?? []).map((h) => h.tutor?.model), ...(trace?.labels ?? []).map((l) => l.model ?? (l.labeler === "deterministic" ? null : l.labeler)),
    trace?.close?.notes_model].filter((m) => m && m !== "seed"));
  const firstMove = timing?.first_move_ms ?? turns[0]?.ms.first_move_ms;
  return (
    <aside ref={panel} tabIndex={-1} role="dialog" aria-label="Trace: models and latency"
      className="y-glass-strong pointer-events-auto fixed bottom-4 right-4 top-4 z-[95] flex w-[min(400px,calc(100vw-32px))] flex-col rounded-[28px] outline-none">
      <div className="px-5 pb-2 pt-5"><PlaceHeader title="Trace" subtitle="Which model did what, and how long it took" onClose={onClose} /></div>
      <div className="grid grid-cols-3 gap-2 px-5 pb-2">
        <Tile label="First move" value={seconds(firstMove)} />
        <Tile label="Voice starts" value={seconds(timing?.first_audio_ms)} />
        <Tile label="Models used" value={trace ? String(models.size) : "—"} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {timing && (
          <section aria-label="Latest turn in this browser" className="pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Latest turn, this browser (from Ask)</h3>
            <ul className="divide-y divide-slate-900/5">
              {CLIENT_STAGES.filter(([key]) => timing[key] != null).sort(([a], [b]) => timing[a] - timing[b]).map(([key, label]) => (
                <Row key={key} stage="browser" title={label} ms={timing[key]} />
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
                  return <Row key={t.seq} stage={t.model_call ? "turn" : "stored"} title={`#${t.seq} ${t.kind}${t.goal ? `: ${t.goal}` : ""}`} ms={t.ms.total_ms} detail={detail}
                    model={t.model_call ? modelName(t.tutor?.model, t.tutor?.effort) : t.seed ? "Seeded demo history (no model)" : "Stored check (no model)"} />;
                })}
              </ul>
            </section>
            {trace.hints.length > 0 && (
              <section aria-label="Hints" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hints</h3>
                <ul className="divide-y divide-slate-900/5">
                  {trace.hints.map((h) => <Row key={`${h.qid}-${h.level}`} stage="hint" title={h.level === 1 ? "Hint: nudge" : "Hint: worked step"} ms={h.ms}
                    model={modelName(h.tutor?.model, h.tutor?.effort)} />)}
                </ul>
              </section>
            )}
            {trace.labels.length > 0 && (
              <section aria-label="Evidence labels" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Evidence labels (background)</h3>
                <ul className="divide-y divide-slate-900/5">
                  {trace.labels.map((l) => <Row key={l.qid} stage="label" title={`Answer ${l.qid.split(".").pop()} · ${l.modality ?? "answer"}`} ms={l.ms.label_ms}
                    model={labelerName(l)}
                    detail={[l.ms.provider_ms != null ? `call ${seconds(l.ms.provider_ms)}` : "", l.ms.queue_ms ? `queued ${seconds(l.ms.queue_ms)}` : "",
                      l.images ? `${l.images} ink crop${l.images > 1 ? "s" : ""}` : "", l.error ?? l.status].filter(Boolean).join(" · ")} />)}
                </ul>
              </section>
            )}
            {trace.close && (
              <section aria-label="Session close" className="pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Session close</h3>
                <ul>
                  <Row stage="close" title={`Sealed revision ${trace.close.revision ?? "—"}`} ms={trace.close.ms} model={trace.close.seed ? "Seeded demo history (notes recorded earlier)" : modelName(trace.close.notes_model)}
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
