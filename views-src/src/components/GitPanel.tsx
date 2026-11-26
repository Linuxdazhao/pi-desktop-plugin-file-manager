import { useMemo, useState } from "react";
import type { Locale, T } from "../i18n";
import type { GitChange, GitSelection, GitWorkspace } from "../lib/gitWorkspace";
import { isStaged } from "../lib/gitWorkspace";
import type { Failure, GitStatusKind, RepoContext } from "../lib/rpc";
import { gitColor } from "../lib/git";
import { baseNameOf, parentOf } from "../lib/format";
import { FileIcon } from "../lib/fileIcons";
import { GitHistoryList, type HistoryCommit } from "./GitHistory";
import { GitIcon, GitIconPath } from "./GitIcons";
import { IconButton } from "./IconButton";
import { Segmented, segmentId } from "./Workbench";
import { Skeleton } from "./Skeleton";

export type GitSegment = "changes" | "history" | "branches";
const segmentPanel = "fm-scm-segment";
const entryColor: Record<string, GitStatusKind> = { A: "added", M: "modified", D: "deleted", R: "renamed", "?": "added" };

export function gitOperationError(failure: Failure, t: T) {
  switch (failure.code) {
    case "GIT_REPO_ROOT": return t("gitRootRequired");
    case "GIT_CONFIG": return t("gitRemoteConfig");
    case "GIT_UNAVAILABLE": return t("gitMissingHelp");
    case "GIT_STALE": case "WORKSPACE_CHANGED": return t("gitStale");
    case "GIT_INDEX_BLOCKED": return t("indexBlocked");
    case "GIT_FILTER": return t("gitFilter");
    case "GIT_LAYOUT": return t("gitLayout");
    case "GIT_MESSAGE": return t("gitMessageLimit");
    case "GIT_BRANCH": return t("gitBranchRequired");
    case "GIT_IN_PROGRESS": return t("gitInProgress");
    case "GIT_BUSY": return t("gitBusy");
    case "GIT_EMPTY": return t("gitNothingToStage");
    case "GIT_LIMIT": return t("gitPanelLimit");
    default: return failure.message || failure.code;
  }
}

export function GitPanel({ git, context, segment, onSegment, selection, onSelect, onInspect, inspected, locale, t }: {
  git: GitWorkspace; context: RepoContext; segment: GitSegment; onSegment: (segment: GitSegment) => void;
  selection: GitSelection | null; onSelect: (selection: GitSelection) => void;
  onInspect: (commit: HistoryCommit) => void; inspected: HistoryCommit | null; locale: Locale; t: T;
}) {
  const { info, infoError, snapshot, changesError, operation, outcome } = git;
  const groups = useMemo(() => {
    const staged: GitChange[] = [], worktree: GitChange[] = [], untracked: GitChange[] = [];
    for (const entry of snapshot?.entries ?? []) {
      if (isStaged(entry)) staged.push(entry);
      if (entry.worktree !== " ") (entry.index === "?" ? untracked : worktree).push(entry);
    }
    return { staged, worktree, untracked };
  }, [snapshot]);
  const repository = info?.state === "repository" || !!snapshot;
  const refreshing = !!operation || !git.infoReady || (repository && !git.changesReady);
  const branch = snapshot?.branch ?? (info?.branch || "HEAD");
  const failure = outcome?.operation !== "sync" && outcome?.error ? outcome.error : changesError ?? infoError;

  if (!repository) {
    if (refreshing && !info && !failure) return <Skeleton kind="list" label={t("loading")} />;
    const plain = info?.state === "plain";
    return <div className="scm-guide">
      <strong>{plain ? t("startTracking") : info?.state === "missing" ? t("gitMissing") : t("sourceControl")}</strong>
      {plain && <p>{t("initializeHelp")}</p>}
      {info?.state === "missing" && <p>{t("gitMissingHelp")}</p>}
      {failure && <p role="alert">{gitOperationError(failure, t)}</p>}
      {plain && <button type="button" disabled={refreshing} className="scm-primary" title={context.rootPath} onClick={git.initialize}>{t("initializeRepo")}</button>}
    </div>;
  }

  return <section className="scm-pane">
    <Segmented<GitSegment> className="scm-segments" panelId={segmentPanel} label={t("sourceControl")}
      value={segment} onChange={onSegment} options={[
        { value: "changes", label: t("changes"), detail: snapshot && String(snapshot.entries.length), icon: <GitIcon name="changes" /> },
        { value: "history", label: t("commitHistory"), icon: <GitIcon name="history" /> },
        { value: "branches", label: t("gitBranches"), icon: <GitIcon name="branch" /> },
      ]} />
    {failure && <p className="scm-note scm-error" role="alert">{gitOperationError(failure, t)}</p>}
    <div className="scm-list" id={segmentPanel} role="tabpanel" aria-labelledby={segmentId(segmentPanel, segment)}>
      {segment === "history" ? <GitHistoryList {...context} locale={locale} onInspect={onInspect} inspected={inspected} version={git.refsVersion} /> :
        segment === "branches" ? <Branches branch={branch} snapshot={snapshot} loading={refreshing} t={t} /> : <>
          <p role="status" className="empty:hidden">{operation ? t("gitBusyStatus") : outcome?.operation === "commit" && !outcome.error ? t("committedLocally") : ""}</p>
          {!snapshot && refreshing && <Skeleton kind="list" label={t("loading")} />}
          {snapshot && <>
            <div className="scm-actions" role="group" aria-label={t("gitBatchActions")}>
              <span>{t("workingTab")}</span>
              <IconButton small label={t("stageAllTitle")} disabled={refreshing || ![...groups.worktree, ...groups.untracked].some(e => e.status !== "conflicted")} onClick={() => git.index("stageAll")}><GitIconPath name="stageAll" /></IconButton>
              <IconButton small label={t("unstageAllTitle")} disabled={refreshing || !groups.staged.some(e => e.status !== "conflicted")} onClick={() => git.index("unstageAll")}><GitIconPath name="unstageAll" /></IconButton>
            </div>
            {snapshot.blocked && <p role="alert">{t("indexBlocked")}</p>}
            {snapshot.hidden && <p>{t("hiddenPaths")}</p>}
            {!snapshot.hidden && !snapshot.entries.length && <p>{t("workingTreeClean")}</p>}
            <ChangeGroup title={t("stagedChanges")} rows={groups.staged} scope="staged" {...{ git, selection, onSelect, refreshing, t }} />
            <ChangeGroup title={t("workingTreeChanges")} rows={groups.worktree} scope="worktree" {...{ git, selection, onSelect, refreshing, t }} />
            <ChangeGroup title={t("untrackedFiles")} rows={groups.untracked} scope="worktree" {...{ git, selection, onSelect, refreshing, t }} />
          </>}
        </>}
    </div>
    {segment === "changes" && snapshot && <CommitComposer git={git} count={groups.staged.length} branch={branch} disabled={refreshing} t={t} />}
  </section>;
}

function Branches({ branch, snapshot, loading, t }: { branch: string; snapshot: GitWorkspace["snapshot"]; loading: boolean; t: T }) {
  if (!snapshot && loading) return <Skeleton kind="list" label={t("loading")} />;
  const names = snapshot?.branches ?? [];
  const branches = branch !== "HEAD" ? [branch, ...names.filter(name => name !== branch)] : names;
  return <>
    {branches.length ? <ul className="scm-branches">{branches.map(name => <li key={name} aria-current={name === branch ? "true" : undefined}>
      <GitIcon name="branch" size={13} /><span className="scm-name" title={name}>{name}</span>{name === branch && <small>{t("currentBranch")}</small>}
    </li>)}</ul> : <p>{t("branchesEmpty")}</p>}
    {snapshot?.branchesTruncated && <p>{t("gitBranchesTruncated")}</p>}
    <p>{t("gitBranchInTerminal")}</p>
  </>;
}

function ChangeGroup({ title, rows, scope, git, selection, onSelect, refreshing, t }: {
  title: string; rows: GitChange[]; scope: GitSelection["scope"]; git: GitWorkspace;
  selection: GitSelection | null; onSelect: (item: GitSelection) => void; refreshing: boolean; t: T;
}) {
  const [open, setOpen] = useState(true);
  if (!rows.length) return null;
  const staged = scope === "staged";
  const action = staged ? "unstage" : "stage";
  const actionLabel = t(action);
  return <section className="scm-group" aria-label={title}>
    <h3><button className="scm-group-toggle" type="button" aria-expanded={open}
      aria-label={`${title} (${rows.length})`} onClick={() => setOpen(!open)}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <span>{title}</span><span className="scm-count">{rows.length}</span>
    </button></h3>
    {open && <ul>{rows.map(entry => {
      const name = baseNameOf(entry.path);
      const code = staged ? entry.index : entry.worktree;
      const conflicted = entry.status === "conflicted";
      return <li key={entry.path} className="scm-row" data-selected={selection?.path === entry.path && selection.scope === scope}
        style={{ "--scm-file-color": gitColor(entryColor[code] ?? entry.status) } as React.CSSProperties}>
        <button className="scm-file" type="button" title={entry.path} aria-label={entry.path}
          onClick={() => onSelect({ path: entry.path, scope })}>
          <FileIcon name={name} isDirectory={false} size={14} />
          <span className="scm-name">{name}</span><small>{parentOf(entry.path)}</small>
        </button>
        <IconButton small className="scm-row-action" label={actionLabel} description={`${actionLabel} · ${entry.path}`}
          disabled={refreshing || conflicted} onClick={() => git.index(action, entry.path)}><GitIconPath name={action} /></IconButton>
        <span className="scm-status" title={code === "?" ? t("gitUntracked") : code}>{code}</span>
      </li>;
    })}</ul>}
  </section>;
}

function CommitComposer({ git, count, branch, disabled, t }: { git: GitWorkspace; count: number; branch: string; disabled: boolean; t: T }) {
  const withinLimit = new TextEncoder().encode(git.draft).length <= 4096;
  const canCommit = !disabled && count > 0 && !git.snapshot?.blocked && branch !== "HEAD" && withinLimit && !!git.draft.trim();
  const label = t("gitCommitStaged", { count });
  return <footer className="scm-controls">
    <div className="scm-compose">
      <textarea aria-label={t("commitMessage")} placeholder={t("commitMessageHint")} rows={2} value={git.draft} maxLength={4096}
        aria-invalid={!withinLimit || undefined} disabled={!!git.operation} onChange={e => git.setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (canCommit) git.index("commit");
        }} />
      <div className="scm-compose-bar">
        <span className="scm-compose-hint" title={branch}>{withinLimit ? t("commitOnBranch", { branch, count }) : t("gitMessageLimit")}</span>
        <button type="button" className="scm-primary" aria-label={label} title={`${label} · Ctrl/⌘+Enter`} disabled={!canCommit}
          onClick={() => git.index("commit")}><GitIcon name="commit" size={13} /> {t("gitCommit")} <span>{count}</span></button>
      </div>
    </div>
  </footer>;
}
