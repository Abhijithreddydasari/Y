"use client";

// The one frame every place opened from the arc shares (Canvases, Review, Settings): the same backdrop,
// reading glass, header, close button and Escape, so the places read as one product.
import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  /** Extra header controls (search, filters) between the title and the close button. */
  actions?: ReactNode;
  width?: string;
  onClose: () => void;
  children: ReactNode;
}

export function PlaceHeader({ title, subtitle, actions, onClose }: Pick<Props, "title" | "subtitle" | "actions" | "onClose">) {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div className="mr-auto">
        <h2 className="text-xl font-bold text-slate-950">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions}
      <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}
        className="grid h-10 w-10 place-items-center rounded-full bg-slate-900/5 text-lg text-slate-600 hover:bg-slate-900/10">×</button>
    </header>
  );
}

export default function PlaceSheet({ title, subtitle, actions, width = "w-[min(560px,100%)]", onClose, children }: Props) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-[90] grid place-items-center bg-slate-950/25 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}
        className={`y-glass-strong flex max-h-[84dvh] ${width} flex-col gap-4 rounded-[28px] p-5`}>
        <PlaceHeader title={title} subtitle={subtitle} actions={actions} onClose={onClose} />
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}
