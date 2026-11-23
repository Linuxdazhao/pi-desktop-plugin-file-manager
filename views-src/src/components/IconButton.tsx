import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Native hover help plus visible keyboard help, even inside a scrolling list. */
export function IconButton({ children, label, onClick, disabled, active, small, className = "", description }: {
  children: ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean; small?: boolean; className?: string; description?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return <button type="button" className={`fm-icon-button ${className}`} data-small={small || undefined}
    title={description ?? label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}
    onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setAnchor(e.currentTarget.getBoundingClientRect()); }}
    onBlur={() => setAnchor(null)} onKeyDown={e => { if (e.key === 'Escape') setAnchor(null); }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    {anchor && !disabled && createPortal(<span className="fm-key-tip" aria-hidden="true" style={{
      left: Math.max(4, Math.min(anchor.left, window.innerWidth - 208)), top: anchor.bottom + 42 < window.innerHeight ? anchor.bottom + 3 : Math.max(2, anchor.top - 40),
    }}>{description ?? label}</span>, document.body)}
  </button>;
}
