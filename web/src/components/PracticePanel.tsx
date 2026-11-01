"use client";

import { useRef, useState } from "react";
import type { WhiteboardHandle } from "./Whiteboard";
import { boardRequest, type BoardAttempt } from "@/lib/board-api";
import {
  assessAnswer, captureAnswer, createPracticeSession, ensureLearningIdentity,
  fetchPracticeCatalog, fetchPracticeSession, LearningError,
  type CapturedAnswer, type CaptureInput, type PracticePack,
} from "@/lib/learning-api";

const SESSION_KEY = "y_practice_session_v1";

function originalCropHashes(packet: BoardAttempt["packet"]) {
  const hashes = packet.crops
    ? packet.crops.filter(crop => crop.purpose === "initial").map(crop => crop.asset_hash)
    : packet.source.crop_hashes;
  // A re-read can reuse identical pixels; receipts retain both references.
  return [...new Set(hashes)].slice(0, 2);
}

function observationText(observation: NonNullable<CapturedAnswer["assessment"]>["observations"][number]) {
  if (observation.reasons.some(reason => reason.startsWith("provider_"))) return "Assessment unavailable — your answer has not been judged";
  if (observation.reasons.includes("solution_already_revealed")) return "The solution was already visible — no independent assessment";
  if (observation.reasons.includes("requires_numeric_answer")) return "Enter only a number for this calculation check";
  if (observation.reasons.includes("source_integrity_failed")) return "The answer source could not be verified";
  if (observation.status === "pending_review") return "Needs review — provisional assessment";
  if (observation.status === "abstained") return "Not enough evidence to assess reliably";
  return observation.label === "supported" ? "Numerical answer checks out" : "Numerical answer needs another look";
}

export default function PracticePanel({ board }: { board?: WhiteboardHandle | null }) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<PracticePack[]>([]);
  const [taskId, setTaskId] = useState("");
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<CapturedAnswer[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [pending, setPending] = useState<CaptureInput | null>(null);
  const inFlight = useRef(false);
  const [boardHistory, setBoardHistory] = useState<BoardAttempt[]>([]);
  const [correction, setCorrection] = useState("");
  const tasks = packs.flatMap(pack => pack.tasks);
  const selected = tasks.find(task => task.task_id === taskId);

  function remember(answer: CapturedAnswer) {
    setHistory(current => [...current.filter(item => item.attempt_id !== answer.attempt_id), answer]);
  }

  async function initialize() {
    if (board === null) { setError("Wait until your board has restored."); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      await ensureLearningIdentity();
      const catalog = await fetchPracticeCatalog();
      let id = board?.board?.session || window.sessionStorage.getItem(SESSION_KEY) || crypto.randomUUID();
      try { await createPracticeSession(id); }
      catch (cause) {
        if (!(cause instanceof LearningError) || cause.status !== 404) throw cause;
        id = crypto.randomUUID(); // Expired identity cannot access the old owner's session.
        await createPracticeSession(id);
      }
      window.sessionStorage.setItem(SESSION_KEY, id);
      const restored = await fetchPracticeSession(id);
      setSessionId(id);
      setPacks(catalog.packs);
      setTaskId(current => current || catalog.packs[0]?.tasks[0]?.task_id || "");
      setHistory(restored.attempts);
      if (board?.board) setBoardHistory(await boardRequest<BoardAttempt[]>(`sessions/${id}/board/attempts`));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Practice could not load."); }
    finally { setBusy(false); inFlight.current = false; }
  }

  async function submit() {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    // Preserve the same ID and payload across transport failures, including a lost response after save.
    const input = pending ?? {
      attempt_id: crypto.randomUUID(), task_id: taskId, text,
      assistance: { self_reported_help: help, solution_revealed: revealed },
    };
    setPending(input);
    try {
      const saved = await captureAnswer(sessionId, input);
      remember(saved);
      const assessed = await assessAnswer(saved.attempt_id);
      remember(assessed);
      setPending(null);
      setText("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check failed. Your answer is retained."); }
    finally { setBusy(false); inFlight.current = false; }
  }

  async function retry(answer: CapturedAnswer) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { remember(await assessAnswer(answer.attempt_id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Assessment could not complete."); }
    finally { setBusy(false); inFlight.current = false; }
  }

  async function boardWork(start = false, attemptId?: string) {
    if (!board?.board || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (start) { await board.board.startTask(taskId); return; }
      const currentRegion = board.board.state.regions.find(r => r.region_id === board.board?.state.active_region);
      if (!attemptId && currentRegion?.task_id !== taskId) throw new Error("Choose Answer on board to create an area for this task first.");
      const prepared = attemptId ? null : await board.board.prepare({ self_reported_help: help, solution_revealed: revealed });
      const id = attemptId ?? prepared!.request.request_id;
      const saved = await boardRequest<BoardAttempt>(`board-attempts/${id}`);
      setBoardHistory(current => [...current.filter(a => a.attempt_id !== id), saved]);
      const assessed = await boardRequest<BoardAttempt>(`board-attempts/${id}/assess`, {});
      setBoardHistory(current => [...current.filter(a => a.attempt_id !== id), assessed]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Board check failed. Saved work can be retried."); }
    finally { setBusy(false); inFlight.current = false; }
  }

  return (
    <aside className="pointer-events-auto fixed right-3 top-36 z-[65] max-w-[calc(100vw-24px)] sm:top-24" aria-label="Practice and evidence">
      <button type="button" aria-expanded={open} aria-controls="practice-panel" onClick={() => {
        setOpen(!open);
        if (!open && !sessionId) void initialize();
      }} className="float-right rounded-full border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-950 shadow-sm">
        {open ? "Close practice" : "Practice"}
      </button>
      {open && <section id="practice-panel" className="clear-both mt-12 max-h-[65dvh] w-[370px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl">
        <h2 className="text-lg font-semibold">Show your understanding</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Your exact answer is saved before feedback. These checks do not yet update your learning profile.</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        {!sessionId && !busy && <button type="button" onClick={() => void initialize()} className="mt-3 underline">Retry connection</button>}
        {packs.length > 0 && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="mt-4 block text-xs font-semibold">Practice question
            <select aria-label="Practice question" disabled={busy || Boolean(pending)} value={taskId} onChange={event => { setTaskId(event.target.value); setText(""); setHelp(false); setRevealed(false); }} className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm">
              {packs.map(pack => <optgroup key={pack.pack_id} label={pack.title}>{pack.tasks.map((task, i) => <option key={task.task_id} value={task.task_id}>{pack.title} · {i + 1}</option>)}</optgroup>)}
            </select>
          </label>
          <p className="my-3 text-sm leading-6">{selected?.prompt}</p>
          {board?.board && <div className="mb-3 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void boardWork(true)} className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-800 disabled:opacity-50">Answer on board</button>
            <button type="button" disabled={busy} onClick={() => void boardWork()} className="rounded-lg bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Check board work</button>
          </div>}
          <label className="block text-xs font-semibold">Your answer
            <textarea value={text} maxLength={8000} disabled={busy || Boolean(pending)} onChange={event => setText(event.target.value)} rows={4} className="mt-1 w-full resize-y rounded-lg border border-slate-300 p-2 text-sm" />
          </label>
          <label className="mt-2 flex gap-2 text-xs"><input type="checkbox" checked={help} disabled={busy || Boolean(pending)} onChange={event => setHelp(event.target.checked)} />I used hints or outside help</label>
          <label className="mt-2 flex gap-2 text-xs"><input type="checkbox" checked={revealed} disabled={busy || Boolean(pending)} onChange={event => setRevealed(event.target.checked)} />I already saw the solution</label>
          <button type="submit" disabled={busy || !text.trim()} className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving and checking…" : pending ? "Retry saved answer" : "Save and check"}</button>
          {pending && !busy && <button type="button" onClick={() => { setPending(null); setError(""); }} className="mt-2 text-xs underline">Write a new attempt</button>}
        </form>}
        <div aria-live="polite" aria-busy={busy}>
          {[...boardHistory].reverse().map(answer => <article key={answer.attempt_id} className="mt-3 rounded-xl border border-indigo-100 p-3 text-xs">
            <p className="font-semibold">Board answer · revision {answer.packet.source.revision}</p>
            <p className="mt-1">{answer.result?.status.replaceAll("_", " ") || "Saved; awaiting assessment"}</p>
            {answer.result?.provider_error && <p className="mt-1 text-amber-800">Assessment unavailable. Your original work is saved.</p>}
            {answer.result?.observations.map((o, i) => <p key={i}>{o.dimension}: {o.label} · {o.status}</p>)}
            <details className="mt-2"><summary>How Y read this</summary>
              {answer.packet.focused.filter(f => f.text).map(f => <p key={f.id} className="mt-1 whitespace-pre-wrap">{f.text} · {f.creator}{f.mixed ? " / mixed" : ""}</p>)}
              {answer.result?.interpretation?.items.map((item, i) => <p key={i} className="mt-1 whitespace-pre-wrap">{item.text || "Unreadable marks"} · {item.status}</p>)}
              <p className="mt-2 break-all">Source: {answer.packet.source.content_hash}</p>
              {originalCropHashes(answer.packet).map(hash => <a key={hash} className="mr-2 underline" target="_blank" rel="noreferrer" href={`/api/learning/sessions/${sessionId}/board/assets/${hash}`}>View original crop</a>)}
              <label className="mt-2 block">Clarify the reading<input value={correction} maxLength={8000} onChange={e => setCorrection(e.target.value)} className="mt-1 w-full rounded border p-1" /></label>
              <button type="button" disabled={!correction.trim() || busy} className="mt-1 underline" onClick={() => {
                void boardRequest<BoardAttempt>(`board-attempts/${answer.attempt_id}/corrections`, { correction_id: crypto.randomUUID(), text: correction }).then(updated => { setBoardHistory(current => current.map(a => a.attempt_id === updated.attempt_id ? updated : a)); setCorrection(""); }).catch(() => setError("Could not save that clarification. Retry."));
              }}>Save clarification</button>
              {answer.corrections.map((c, i) => <p key={i}>Learner clarification: {c.text}</p>)}
            </details>
            {(!answer.result || answer.result.provider_error) && <button type="button" disabled={busy} className="mt-2 underline" onClick={() => void boardWork(false, answer.attempt_id)}>Retry board assessment</button>}
          </article>)}
          {busy && !packs.length && <p className="mt-3 text-sm">Loading your practice session…</p>}
          {history.length > 0 && <h3 className="mt-5 text-sm font-semibold">Saved attempts</h3>}
          {[...history].reverse().map(answer => <article key={answer.attempt_id} className="mt-3 rounded-xl bg-slate-50 p-3 text-xs">
            <p className="font-medium">{tasks.find(task => task.task_id === answer.task_id)?.prompt}</p>
            <p className="mt-2 whitespace-pre-wrap break-words">{answer.text || "Empty answer"}</p>
            {answer.assessment?.observations.map(observation => <p key={observation.dimension} className="mt-2"><strong>{observation.dimension}:</strong> {observationText(observation)}{observation.reasons.includes("assisted_attempt") ? " · with help" : ""}</p>)}
            {answer.assessment?.provider_error && <p className="mt-2 text-amber-800">Assessment unavailable. Your answer is saved.</p>}
            {answer.state !== "assessed" && (answer.retry_allowed
              ? <button type="button" disabled={busy} onClick={() => void retry(answer)} className="mt-2 underline">Retry assessment</button>
              : <p className="mt-2 text-slate-500">Retry limit reached. This answer remains saved for review.</p>)}
            <details className="mt-2 text-slate-500"><summary>Evidence receipt</summary><p className="mt-1 break-all">Attempt: {answer.attempt_id}<br />Source: {answer.source.event_id}<br />SHA-256: {answer.source.content_hash}</p></details>
          </article>)}
        </div>
      </section>}
    </aside>
  );
}
