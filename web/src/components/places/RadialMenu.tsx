"use client";

// A Pencil-style arc: a round button fans its items along a circle. Positions are computed once per item;
// hover and focus lift an item outward with CSS only (no re-render), and reduced motion ends transitions at once.
import { useEffect, type CSSProperties, type ReactNode } from "react";

export interface ArcItem { id: string; label: string; hint?: string; icon: string; badge?: string | number; disabled?: boolean;
  onSelect: () => void; onIntent?: () => void }

interface Props {
  items: ArcItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Arc span in degrees, 0 = right, -90 = up (screen coordinates). */
  from: number;
  to: number;
  radius?: number;
  label: string;
  button: ReactNode;
  className?: string;
}

export function arcPoint(index: number, count: number, from: number, to: number, radius: number) {
  const angle = ((from + ((to - from) * index) / Math.max(1, count - 1)) * Math.PI) / 180;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const clean = (n: number) => n || 0; // no "-0" in styles
  return { x: clean(Math.round(ux * radius)), y: clean(Math.round(uy * radius)), ux: clean(Number(ux.toFixed(3))), uy: clean(Number(uy.toFixed(3))) };
}

export default function RadialMenu({ items, open, onOpenChange, from, to, radius = 128, label, button, className = "" }: Props) {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onOpenChange, open]);

  return (
    <>
      {/* While open, a click anywhere else closes the arc instead of drawing on the board. */}
      {open && <div className="pointer-events-auto fixed inset-0 z-[58]" aria-hidden="true" onPointerDown={() => onOpenChange(false)} />}
      <div className={`y-arc pointer-events-auto z-[60] ${className}`} data-open={open}>
        <div role="menu" aria-label={label} aria-hidden={!open}>
          {items.map((item, index) => {
            const p = arcPoint(index, items.length, from, to, radius);
            const style = { "--x": `${p.x}px`, "--y": `${p.y}px`, "--ux": p.ux, "--uy": p.uy, "--i": index } as CSSProperties;
            return (
              <button key={item.id} type="button" role="menuitem" tabIndex={open ? 0 : -1} disabled={item.disabled} style={style}
                aria-label={item.hint ? `${item.label}: ${item.hint}` : item.label} className="y-arc-item y-glass"
                onPointerEnter={item.onIntent} onFocus={item.onIntent} onClick={() => { onOpenChange(false); item.onSelect(); }}>
                <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7"
                  strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg>
                {item.badge ? <span className="y-arc-badge">{item.badge}</span> : null}
                <span className="y-arc-label y-glass-strong" aria-hidden="true">
                  <b>{item.label}</b>{item.hint && <span className="font-normal text-slate-500"> · {item.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" aria-label={label} aria-expanded={open} onClick={() => onOpenChange(!open)} className="y-arc-trigger y-glass">
          {button}
        </button>
      </div>
    </>
  );
}
