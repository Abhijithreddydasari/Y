"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { useState } from "react";
import type { StepperSpec } from "./widget-spec";

/** Text with `$...$` math: words stay React text; only KaTeX's own output is injected (trust off, errors inline). */
export function StepText({ text }: { text: string }) {
  const parts = text.split(/(\$[^$]+\$)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => part.startsWith("$") && part.endsWith("$") && part.length > 2
        ? <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(1, -1), { throwOnError: false, trust: false, strict: "ignore" }) }} />
        : <span key={i}>{part}</span>)}
    </>
  );
}

export default function StepperWidget({ spec }: { spec: StepperSpec }) {
  const [step, setStep] = useState(0);
  const last = spec.steps.length - 1;
  return (
    <div className="flex h-full w-full flex-col gap-2 p-3 text-slate-800">
      <div className="flex-1 space-y-1.5 overflow-hidden text-[15px] leading-relaxed">
        {spec.steps.slice(Math.max(0, step - 2), step + 1).map((text, i, shown) => (
          <p key={step - shown.length + 1 + i} className={i === shown.length - 1 ? "" : "text-slate-400"}><StepText text={text} /></p>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
          className="rounded-lg border border-slate-200 px-3 py-1 text-sm disabled:opacity-40">Back</button>
        <span className="text-xs text-slate-500" data-testid="step-count">Step {step + 1} of {last + 1}</span>
        <button type="button" onClick={() => setStep((s) => Math.min(last, s + 1))} disabled={step === last}
          className="rounded-lg bg-violet-700 px-3 py-1 text-sm text-white disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}
