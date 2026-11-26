import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { T } from "../i18n";
import { GitIcon } from "./GitIcons";

export type SidebarView = "files" | "search" | "git";
export const segmentId = (panelId: string, value: string) => `${panelId}-${value}`;

export function nextTab(event: KeyboardEvent<HTMLButtonElement>, vertical = false) {
  const before = vertical ? "ArrowUp" : "ArrowLeft";
  const after = vertical ? "ArrowDown" : "ArrowRight";
  if (event.altKey || event.ctrlKey || event.metaKey || ![before, after, "Home", "End"].includes(event.key)) return;
  const list = event.currentTarget.closest('[role="tablist"]');
  const tabs = Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? []);
  if (!tabs.length) return;
  const index = tabs.indexOf(event.currentTarget);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (index + (event.key === after ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  return tabs[next];
}

export function ActivityRail({ view, onView, labels, badge, hidden, children, label = labels.files }: {
  view: SidebarView; onView: (view: SidebarView, toggle: boolean) => void;
  labels: Record<SidebarView, string>; badge: number; hidden: boolean; label?: string; children?: ReactNode;
}) {
  return <div className="fm-rail">
    <nav className="fm-rail-views" role="tablist" aria-label={label} aria-orientation="vertical">
      {(["files", "search", "git"] as const).map(id => <button key={id} type="button" role="tab" className="fm-rail-btn"
        id={segmentId("fm-sidebar", id)} data-view={id} aria-controls="fm-sidebar" aria-selected={!hidden && view === id}
        aria-label={labels[id]} title={labels[id]} tabIndex={view === id ? 0 : -1} onClick={() => onView(id, true)}
        onKeyDown={event => {
          const tab = nextTab(event, true);
          if (tab) onView(tab.dataset.view as SidebarView, false);
        }}>
        {id === "git" ? <GitIcon name="branch" size={20} /> :
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {id === "files" ? <path d="M3 6h6l2 2h10v12H3z" /> : <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>}
          </svg>}
        {id === "git" && badge > 0 && <span className="fm-rail-badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</span>}
      </button>)}
    </nav>
    <span className="fm-rail-spacer" />
    {children}
  </div>;
}

type Position = { line: number; column: number } | null;
const noCursor = () => null;
const noSubscription = () => () => {};

/** Caret motion should update the footer, not a large tree and the tab strip. */
export function createCaretStore() {
  let value: Position = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: Position) => {
      if (value?.line === next?.line && value?.column === next?.column) return;
      value = next;
      listeners.forEach(listener => listener());
    },
  };
}

export function StatusBar({ branch, upstream, ahead, behind, watching, watchLabel, position, cursor, kind, t }: {
  branch: string | null; upstream: string | null; ahead: number | null; behind: number | null;
  watching: boolean | null; watchLabel: string; position?: string | null;
  cursor?: ReturnType<typeof createCaretStore>; kind: string | null; t: T;
}) {
  const caret = useSyncExternalStore(cursor?.subscribe ?? noSubscription, cursor?.get ?? noCursor, noCursor);
  const location = caret ? t("statusPosition", caret) : position;
  return <footer className="fm-status">
    {branch && <span className="fm-status-item fm-status-branch" title={`${t("statusBranch")}: ${branch}`}>
      <GitIcon name="branch" size={12} /><span>{branch}</span>
    </span>}
    {upstream && <span className="fm-status-item fm-status-mono fm-status-upstream" title={upstream}>{upstream}</span>}
    {(!!ahead || !!behind) && <span className="fm-status-item fm-status-mono">
      {!!ahead && <span title={t("syncAhead", { count: ahead })} style={{ color: "var(--git-added)" }}>↑{ahead}</span>}
      {!!behind && <span title={t("syncBehind", { count: behind })} style={{ color: "var(--git-deleted)" }}>↓{behind}</span>}
    </span>}
    {watching !== null && <span className="fm-status-item fm-status-watch" title={watchLabel}>
      <span aria-hidden="true" style={{ color: watching ? "var(--git-added)" : "var(--muted)" }}>●</span> {watchLabel}
    </span>}
    <span className="fm-rail-spacer" />
    {location && <span className="fm-status-item fm-status-mono fm-status-position">{location}</span>}
    {kind && <span className="fm-status-item fm-status-kind">{kind}</span>}
  </footer>;
}

export function ContentBar({ children }: { children?: ReactNode }) {
  return <div className="fm-content-bar">{children}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label, panelId, className = "fm-seg" }: {
  value: T; options: { value: T; label: string; detail?: string | null; title?: string; icon?: ReactNode }[];
  onChange: (value: T) => void; label: string; panelId?: string; className?: string;
}) {
  return <div className={className} role="tablist" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" role="tab" aria-selected={value === option.value}
      aria-controls={panelId} id={panelId ? segmentId(panelId, option.value) : undefined} tabIndex={value === option.value ? 0 : -1}
      aria-label={option.label} aria-description={option.detail ?? undefined}
      title={option.title ?? option.label} onClick={() => { if (value !== option.value) onChange(option.value); }}
      onKeyDown={event => nextTab(event)?.click()}>
      {option.icon}<span>{option.label}</span>
      {option.detail && <span className="fm-seg-detail" aria-hidden="true">{option.detail}</span>}
    </button>)}
  </div>;
}
