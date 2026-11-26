import type { ReactNode } from "react";

/** Shared 24×24 line icons for the source-control workspace. */
export type GitIconName =
  | "branch"
  | "changes"
  | "history"
  | "refresh"
  | "stage"
  | "unstage"
  | "stageAll"
  | "unstageAll"
  | "commit"
  | "sync"
  | "fetch"
  | "pull"
  | "push"
  | "forcePush";

/**
 * Commit / branch markers for the history list. They have to survive at 8–10px,
 * so they are solid pips rather than line art: a filled dot for an ordinary
 * commit, an outline pip beside it for a merge.
 */
export type HistoryMarkName = "commitDot" | "mergeDot";

const paths: Record<GitIconName, ReactNode> = {
  branch: <><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 6v12M18 8c0 5-4 6-12 6" /></>,
  changes: <><path d="M4 6h10M4 12h7M4 18h10M18 9v6M15 12h6" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5A7 7 0 0 0 18.4 15" /></>,
  stage: <path d="M12 5v14M5 12h14" />,
  unstage: <path d="M5 12h14" />,
  stageAll: <><path d="M4 7h8M4 12h8M4 17h8M18 9v8M14 13h8" /></>,
  unstageAll: <><path d="M4 7h8M4 12h8M4 17h8M14 13h8" /></>,
  commit: <><circle cx="12" cy="12" r="3" /><path d="M12 3v6M12 15v6" /></>,
  sync: <><path d="M4 8h15M16 5l3 3-3 3M20 16H5M8 13l-3 3 3 3" /></>,
  fetch: <><path d="M12 3v10M8 9l4 4 4-4M5 17v3h14v-3" /></>,
  pull: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M16 4v12M12 12l4 4 4-4" /></>,
  push: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M16 20V8M12 12l4-4 4 4" /></>,
  forcePush: <><path d="M12 20V4M7 9l5-5 5 5M7 16h10" /></>,
};

const marks: Record<HistoryMarkName, ReactNode> = {
  commitDot: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  mergeDot: <><circle cx="8" cy="12" r="5" fill="none" strokeWidth="3" /><circle cx="16" cy="12" r="5" fill="currentColor" stroke="none" /></>,
};

/** Use inside IconButton's SVG. */
export function GitIconPath({ name }: { name: GitIconName }) { return <>{paths[name]}</>; }

/** Standalone icon for labels, tabs and menus. */
export function GitIcon({ name, size = 15 }: { name: GitIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><GitIconPath name={name} /></svg>;
}

/** Commit / merge pip for the history list (decorative: the row carries the text). */
export function HistoryMark({ name, size = 9 }: { name: HistoryMarkName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">{marks[name]}</svg>;
}
