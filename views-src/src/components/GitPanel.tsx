import { useEffect, useRef, useState } from "react";
import { makeT, type Locale } from "../i18n";
import { invoke } from "../lib/bridge";
import type { Failure, GitStatusKind } from "../lib/rpc";
import { FileIcon } from "../lib/fileIcons";
import { baseNameOf, parentOf } from "../lib/format";
import { IconButton } from "./IconButton";
import { Skeleton } from './Skeleton';
import { gitColor } from "../lib/git";
import { GitSync, type SyncInfo } from './GitSync';
import { GitHistory, type HistoryCommit } from './GitHistory';

export type GitSelection = { path: string; scope: "staged" | "worktree" };
type Props = { onInspect: (commit: HistoryCommit) => void; locale: Locale; workspacePath: string; rootPath: string; projectId?: string; active: boolean; refreshKey: number;
  selection: GitSelection | null; onSelect: (item: GitSelection, revision: string) => void;
  onSnapshot: (entries: Entry[], revision: string) => void; onChanged: () => void };
type Entry = { path: string; index: string; worktree: string; status: GitStatusKind };
type Snapshot = { ok: true; entries: Entry[]; branch: string; revision: string; blocked: boolean; hidden: boolean };

// A new folder gets a new component, not a new set of props on an old commit form.
export function GitPanel(props: Props) {
  return <Changes key={JSON.stringify([props.workspacePath, props.rootPath, props.projectId])} {...props} />;
}

function Changes({ locale, rootPath, workspacePath, projectId, active, refreshKey, selection, onSelect, onSnapshot, onChanged, onInspect }: Props) {
  const t = makeT(locale);
  const text = (en: string, zh: string) => locale === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const current = useRef(0);
  const previousRefresh = useRef(refreshKey);
  const context = { rootPath, workspacePath, projectId };
  function explain(e: unknown) {
    const f = e as Partial<Failure>;
    switch (f?.code) {
      case "GIT_REPO_ROOT": return text("Open the repository root to manage changes.", "请选择 Git 仓库根目录以管理变更。");
      case "GIT_UNAVAILABLE": return text("Git is unavailable. Install Git and refresh.", "Git 不可用。请安装 Git 后刷新。");
      case "GIT_STALE": case "WORKSPACE_CHANGED": return text("The project, branch or index changed. Refresh and review again.", "项目、分支或暂存区已变化。请刷新并重新检查。");
      case "GIT_INDEX_BLOCKED": return text("The index includes protected or unsupported changes. Review and unstage them in Git first.", "暂存区包含受保护或不支持的变更。请先在 Git 中检查并取消暂存。");
      case "GIT_FILTER": return text("Stage files that use custom filters in Git directly.", "请使用 Git 暂存使用自定义过滤器的文件。");
      case "GIT_LAYOUT": return text("Manage this linked worktree or submodule in Git directly.", "请直接使用 Git 管理关联工作树或子模块。");
      case "GIT_MESSAGE": return text("Enter a message of up to 4096 bytes.", "请输入不超过 4096 字节的提交说明。");
      case "GIT_BRANCH": return text("Check out a local branch before committing.", "请先切换到本地分支再提交。");
      case "GIT_IN_PROGRESS": return text("Finish the ongoing Git operation before committing here.", "请先完成进行中的 Git 操作再提交。");
      case "GIT_BUSY": return text("A Git operation is running. Refresh and retry.", "Git 操作正在进行，请稍后刷新重试。");
      case "GIT_EMPTY": return text("Stage a file first.", "请先暂存文件。");
      case "GIT_PATH": return text("Refresh and select a changed regular file.", "请刷新并选择有变更的普通文件。");
      case "GIT_LIMIT": return text("This repository exceeds the panel limits. Use Git directly.", "此仓库超过面板限制，请直接使用 Git。");
      default: return f?.message || String(e);
    }
  }
  async function refresh() {
    const id = ++current.current;
    setBusy(true); setError("");
    try {
      const probe = await invoke<SyncInfo | Failure>('fm.git.syncInfo', context);
      if (id !== current.current) return;
      if (probe.ok) {
        setInfo(probe);
        if (probe.state !== 'repository') { setSnapshot(null); setTab('changes'); onSnapshot([], ''); return; }
      } else if (probe.code === 'GIT_CONFIG' || probe.code === 'GIT_LAYOUT') {
        // An unsupported transport config must not disable ordinary local changes.
        setInfo(null); setError(explain(probe));
      } else { setInfo(null); throw probe; }
      const r = await invoke<Snapshot | Failure>("fm.git.changes", context);
      if (id !== current.current) return;
      if (!r.ok) throw r;
      setSnapshot(r);
      if (!probe.ok) setInfo({ ok: true, state: 'repository', remotes: [], branch: r.branch });
      onSnapshot(r.entries, r.revision);
    } catch (e) { if (id === current.current) { setSnapshot(null); setError(explain(e)); } }
    finally { if (id === current.current) setBusy(false); }
  }
  useEffect(() => {
    const requested = previousRefresh.current !== refreshKey;
    previousRefresh.current = refreshKey;
    if ((active || requested) && !busy) void refresh();
  }, [active, refreshKey]);
  useEffect(() => () => { ++current.current; }, []);
  async function initialize() {
    if (busy || info?.state !== 'plain') return;
    const id = ++current.current; setBusy(true); setError('');
    try {
      const r = await invoke<{ok:true} | Failure>('fm.git.syncAction', { ...context, action: 'init', confirm: true });
      if (id !== current.current) return;
      if (!r.ok) throw r;
      onChanged(); await refresh();
    } catch (e) { if (id === current.current) setError(explain(e)); }
    finally { if (id === current.current) setBusy(false); }
  }
  async function mutate(action: "stage" | "unstage" | "commit" | "stageAll" | "unstageAll", path?: string) {
    if (!snapshot || busy) return;
    const id = ++current.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const batch = action === 'stageAll' || action === 'unstageAll';
      const r = await invoke<{ ok: true } | Failure>(batch ? 'fm.git.batch' : `fm.git.${action}`, { ...context, revision: snapshot.revision, path, message, ...(batch ? { action: action === 'stageAll' ? 'stage' : 'unstage' } : {}) });
      if (id !== current.current) return;
      if (!r.ok) throw r;
      if (action === "commit") { setMessage(""); setNotice(text("Committed locally.", "已提交到本地仓库。")); }
      onChanged?.();
      await refresh();
    } catch (e) { if (id === current.current) setError(explain(e)); }
    finally { if (id === current.current) setBusy(false); }
  }
  const staged = snapshot?.entries.filter(e => !["?", " "].includes(e.index)) || [];
  const unstaged = snapshot?.entries.filter(e => e.worktree !== " ") || [];
  const canCommit = !!snapshot && !busy && !!message.trim() && staged.length > 0 && !snapshot.blocked;
  const commitLabel = `${text("Commit staged changes", "提交已暂存的更改")} (${staged.length})`;
  const group = (isStaged: boolean, rows: Entry[], untracked = false) => {
    if (!rows.length) return null;
    const scope = isStaged ? "staged" : "worktree";
    const key = untracked ? 'untracked' : scope;
    const title = untracked ? text('Untracked', '未跟踪') : isStaged ? text("Staged Changes", "已暂存的更改") : text("Changes", "更改");
    return <section className="scm-group" aria-label={title}>
      <h3><button className="scm-group-toggle" type="button" aria-expanded={!folded[key]}
        aria-label={`${title} (${rows.length})`} onClick={() => setFolded(prev => ({ ...prev, [key]: !prev[key] }))}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        <span>{title}</span><span className="scm-count">{rows.length}</span>
      </button></h3>
      {!folded[key] && <ul>{rows.map(e => {
        const code = isStaged ? e.index : e.worktree;
        const actionLabel = isStaged ? text("Unstage", "取消暂存") : text("Stage", "暂存");
        return <li key={e.path} className="scm-row" data-selected={selection?.path === e.path && selection.scope === scope}>
          <button className="scm-file" type="button" title={e.path} aria-label={e.path} disabled={busy}
            onClick={() => snapshot && onSelect({ path: e.path, scope }, snapshot.revision)}>
            <FileIcon name={baseNameOf(e.path)} isDirectory={false} size={14} />
            <span className="scm-name">{baseNameOf(e.path)}</span><small>{parentOf(e.path)}</small>
          </button>
          <IconButton small className="scm-row-action" label={actionLabel} description={`${actionLabel} · ${e.path}`} disabled={busy || syncing || e.status === "conflicted"}
            onClick={() => void mutate(isStaged ? "unstage" : "stage", e.path)}><path d="M5 12h14" />{!isStaged && <path d="M12 5v14" />}</IconButton>
          <span className="scm-status" style={{ color: gitColor(({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', '?': 'added' } as Record<string, GitStatusKind>)[code] ?? e.status) }} title={code === '?' ? t('gitUntracked') : code}>{code}</span>
        </li>;
      })}</ul>}
    </section>;
  };
  if (!info && !error && active) return <Skeleton kind="list" label={t('loading')} />;
  if (info?.state !== 'repository') return <div className="scm-guide">
    <strong>{info?.state === 'plain' ? text('Start tracking this folder', '开始跟踪此文件夹') : info?.state === 'missing' ? text('Git is not installed', '未检测到 Git') : 'Git'}</strong>
    <p>{info?.state === 'plain' ? text('Initialize a local repository here. No files will be staged, committed or uploaded.', '在此创建本地仓库，不会自动暂存、提交或上传文件。') : info?.state === 'missing' ? text('Install Git for your system, restart Desktop, then refresh.', '请安装适用于本机的 Git，重启桌面端后再刷新。') : busy ? t('loading') : ''}</p>
    {info?.state === 'plain' && <button type="button" disabled={busy} className="scm-primary" title={rootPath} onClick={() => void initialize()}>{text('Initialize repository', '初始化仓库')}</button>}
    {error && <p role="alert">{error}</p>}
    <IconButton label={t('refresh')} disabled={busy} onClick={() => void refresh()}><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></IconButton>
  </div>;
  return <section className="scm-pane" aria-label={text('Source control', '源代码管理')}>
    <div className="scm-tabs" role="tablist" aria-label="Git">
      <button type="button" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>{text('Changes', '更改')} <small>{snapshot?.entries.length ?? '…'}</small></button>
      <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>{text('History', '历史')}</button>
    </div>
    {tab === 'changes' && snapshot && <div className="scm-actions" role="group" aria-label={text('Changes actions', '更改操作')}>
      <span>{text('Working tree', '工作区')}</span>
      <IconButton small label={text('Stage all', '全部暂存')} disabled={busy || syncing || !unstaged.length} onClick={() => void mutate('stageAll')}><path d="M4 12h11m-5.5-5.5v11M17 5h4m-4 5h4m-4 5h4"/></IconButton>
      <IconButton small label={text('Unstage all', '全部取消暂存')} disabled={busy || syncing || !staged.length} onClick={() => void mutate('unstageAll')}><path d="M4 12h11M17 5h4m-4 5h4m-4 5h4"/></IconButton>
    </div>}
    <div className="scm-list" role="tabpanel">
      {error && <p role="alert">{error}</p>}
      {tab === 'changes' && !snapshot && busy && !error ? <Skeleton kind="list" label={t('loading')} /> : <p role="status" className="empty:hidden">{busy || syncing ? t('loading') : notice}</p>}
      {tab === 'history' && active && <GitHistory {...context} locale={locale} onInspect={onInspect} />}
      {tab === 'changes' && snapshot && <>
        {snapshot.blocked && <p role="alert">{explain({ code: 'GIT_INDEX_BLOCKED' })}</p>}
        {snapshot.hidden && <p>{text('Protected or unsupported paths are not shown.', '受保护或不支持的路径不会显示。')}</p>}
        {!snapshot.hidden && !snapshot.entries.length && <p>{text('Working tree clean.', '工作区干净。')}</p>}
        {group(true, staged)}{group(false, unstaged.filter(e => e.index !== '?'))}{group(false, unstaged.filter(e => e.index === '?'), true)}
      </>}
    </div>
    <div className="scm-controls">
      <header><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="4" r="1.6"/><path d="M4 5v6m0-1c5 0 8-1 8-4"/></svg>
        <strong title={info.branch}>{info.branch || snapshot?.branch || 'HEAD'}</strong>
        <IconButton small label={t('refresh')} disabled={busy || syncing} onClick={() => void refresh()}><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></IconButton>
        <GitSync context={context} info={info} zh={locale === 'zh'} disabled={busy || syncing} onBusy={setSyncing} onError={setError}
          onDone={() => { setNotice(text('Git operation completed.', 'Git 操作已完成。')); onChanged(); void refresh(); }} />
      </header>
      {snapshot && tab === 'changes' && <div className="scm-compose">
        <textarea aria-label={text('Commit message', '提交说明')} placeholder={text('Enter commit message', '输入提交说明')} rows={3} value={message} maxLength={4096} disabled={busy || syncing}
          onChange={e => setMessage(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit && !syncing) { e.preventDefault(); void mutate('commit'); } }} />
        <IconButton small label={commitLabel} description={`${commitLabel} · Ctrl/⌘+Enter`} disabled={!canCommit || syncing} onClick={() => void mutate('commit')}><path d="m4 12 5 5L20 6" /></IconButton>
      </div>}
    </div>
  </section>;
}
