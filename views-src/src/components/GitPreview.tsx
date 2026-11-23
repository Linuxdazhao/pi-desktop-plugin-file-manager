import { useEffect, useState } from "react";
import type { GitSelection } from "./GitPanel";
import { GitDiffView, type DiffViewState } from "./GitDiffView";
import { invoke } from "../lib/bridge";
import { failureMessage, type GitDiffResponse } from "../lib/rpc";
import type { T } from "../i18n";

export type PreviewTab = GitSelection & { revision: string };

/** Independent of fm.read: a deleted file has a diff but no editor document. */
export function GitPreview({ tab, rootPath, workspacePath, projectId, onClose, onRefresh, t }: {
  tab: PreviewTab; rootPath: string; workspacePath: string; projectId?: string;
  onClose: () => void; onRefresh: () => void; t: T;
}) {
  const [state, setState] = useState<DiffViewState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState(prev => prev.status === 'ready' ? prev : { status: 'loading' });
    void invoke<GitDiffResponse>("fm.git.panelDiff", { path: tab.path, revision: tab.revision, rootPath, workspacePath, projectId }).then(r => {
      if (cancelled) return;
      if (!r.ok) { setState({ status: "error", message: failureMessage(r, t) }); return; }
      const sections = r.sections.filter(s => s.scope === tab.scope);
      let addedLines = 0, deletedLines = 0;
      for (const section of sections) for (const hunk of section.hunks) for (const line of hunk.lines) {
        if (line.type === "add") addedLines++; else if (line.type === "del") deletedLines++;
      }
      setState({ status: "ready", response: { ...r, sections, addedLines, deletedLines } });
    }).catch(e => { if (!cancelled) setState({ status: "error", message: String(e) }); });
    return () => { cancelled = true; };
  }, [tab, rootPath, workspacePath, projectId, t]);
  return <GitDiffView state={state} t={t} onClose={onClose} onRefresh={onRefresh} />;
}
