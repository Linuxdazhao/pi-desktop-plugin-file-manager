import { useEffect, useState } from "react";
import { makeT, type Locale } from "../i18n";
import { invoke } from "../lib/bridge";
import type { Failure, RepoContext } from "../lib/rpc";
import { IconButton } from "./IconButton";
import { Skeleton } from './Skeleton';
import { GitIconPath, HistoryMark } from "./GitIcons";
import { copyText } from "../lib/clipboard";

export type HistoryCommit = { oid: string; subject: string; author: string; date: string };
type Scope = RepoContext & { locale: Locale };
type HistoryProps = Scope & { onInspect: (commit: HistoryCommit) => void; inspected: HistoryCommit | null; version: number };
type DetailProps = Scope & { oid: string };
type History = { ok: true; branch: string; commits: HistoryCommit[] };
type Patch = { kind: "text"; text: string; truncated: boolean } | { kind: "limit" | "binary" | "mode" | "unavailable" };
type Detail = { ok: true; commit: HistoryCommit; parent: string | null; files: { path: string; status: string }[];
  omitted: boolean; selectedPath?: string; patch?: Patch };

function useHistoryRequest<T extends { ok: true }>(channel: string, payload: object, version = 0) {
  const key = JSON.stringify(payload);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; version: number; data?: T; error?: Failure }>();
  const current = version + tick;
  useEffect(() => {
    let live = true;
    invoke<T | Failure>(channel, JSON.parse(key)).then(r => {
      if (live) setResult(r.ok ? { key, version: current, data: r } : { key, version: current, error: r });
    }).catch(() => { if (live) setResult({ key, version: current, error: { ok: false, code: "BRIDGE", message: "" } }); });
    return () => { live = false; };
  }, [channel, key, current]);
  return { ...(result?.key === key && (result.data || result.version === current) ? result : {}), refresh: () => setTick(n => n + 1) };
}

export function historyFailure(error: Failure, locale: Locale): string {
  const zh = locale === "zh";
  switch (error.code) {
    case "GIT_REPO_ROOT": case "GIT_LAYOUT": return zh ? "请选择本地普通 Git 仓库的根目录。" : "Select the root of an ordinary local Git repository.";
    case "GIT_BRANCH": return zh ? "请先切换到本地分支。" : "Check out a local branch to view its history.";
    case "GIT_LIMIT": return zh ? "仓库超过预览限制，请直接使用 Git 查看。" : "History exceeds the preview limits. Inspect it in Git.";
    case "GIT_COMMIT": case "GIT_STALE": case "WORKSPACE_CHANGED": return zh ? "项目或分支已变化；请刷新并重新选择提交。" : "The folder or branch changed. Refresh and select a commit again.";
    default: return zh ? "无法读取 Git 历史记录，请刷新或直接使用 Git 查看。" : "Git history could not be read. Refresh or inspect the repository in Git.";
  }
}

function dateLabel(date: string, locale: Locale) {
  const value = new Date(date);
  return Number.isFinite(value.getTime()) ? value.toLocaleString(locale === "zh" ? "zh-CN" : "en") : date;
}

/**
 * History as a sidebar list: one row per commit, newest first, with the short
 * SHA in monospace so a user can match a commit against a terminal log. The
 * row only *selects* a commit; the diff itself opens as a content tab, where
 * there is room for it.
 */
export function GitHistoryList({ workspacePath, rootPath, projectId, locale, onInspect, inspected, version }: HistoryProps) {
  const t = makeT(locale);
  const zh = locale === "zh";
  const { data, error, refresh } = useHistoryRequest<History>("fm.git.history", { workspacePath, rootPath, projectId }, version);
  return <>
    <div className="scm-actions">
      <span title={data?.branch}>{data?.branch || t("commitHistory")}</span>
      <IconButton small label={t("refresh")} onClick={refresh}><GitIconPath name="refresh" /></IconButton>
    </div>
    {error ? <p role="alert">{historyFailure(error, locale)}</p> : !data ? <Skeleton kind="list" label={t('loading')} /> : !data.commits.length ? <p>{t("historyEmpty")}</p> :
      <ul className="scm-commits">{data.commits.map(c => (
        <li key={c.oid}>
          <button type="button" className="scm-commit" data-selected={inspected?.oid === c.oid}
            title={`${c.subject || (zh ? "（无标题）" : "(no subject)")}\n${c.author} · ${dateLabel(c.date, locale)}\n${c.oid}`}
            onClick={() => onInspect(c)}>
            <span className="scm-commit-pip" aria-hidden="true"><HistoryMark name="commitDot" /></span>
            <span className="scm-commit-text">
              <span className="scm-commit-subject">{c.subject || (zh ? "（无标题）" : "(no subject)")}</span>
              <span className="scm-commit-meta"><code>{c.oid.slice(0, 7)}</code><span>{c.author}</span><span>{dateLabel(c.date, locale)}</span></span>
            </span>
          </button>
        </li>
      ))}</ul>}
    {data && <p className="scm-footnote">{t("historyFooter")}</p>}
  </>;
}

/**
 * A commit opened as a content tab. Layout answers the question a commit view
 * is opened for: "what changed" — so the file list is a fixed column on the
 * left and the patch takes the rest, rather than stacking a select box above
 * the diff.
 */
export function GitCommitDetail(props: DetailProps) {
  return <Commit key={JSON.stringify([props.workspacePath, props.rootPath, props.projectId, props.oid])} {...props} />;
}

function Commit({ workspacePath, rootPath, projectId, locale, oid }: DetailProps) {
  const [path, selectPath] = useState<string>();
  const [copied, setCopied] = useState(false);
  const zh = locale === "zh";
  const t = makeT(locale);
  const { data, error, refresh } = useHistoryRequest<Detail>("fm.git.commitDetail", { workspacePath, rootPath, projectId, oid, path });
  if (error) return <div className="scm-guide"><p role="alert">{historyFailure(error, locale)}</p><button type="button" className="scm-primary" onClick={refresh}>{t("refresh")}</button></div>;
  if (!data) return <Skeleton kind="diff" label={t('loading')} />;
  const { commit, files, omitted, selectedPath, patch } = data;
  const copySha = async () => {
    if (await copyText(oid)) { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  };
  return <article className="scm-commit-view" aria-label={t("commitDetail")}>
    <header className="scm-commit-head">
      <div className="scm-commit-title">
        <h2>{commit.subject || (zh ? "（无标题）" : "(no subject)")}</h2>
        <span className="scm-commit-meta">
          <span>{commit.author}</span>
          <time dateTime={commit.date}>{dateLabel(commit.date, locale)}</time>
          <code title={oid}>{oid.slice(0, 8)}</code>
          {data.parent ? <span>{t("compareWithParent", { parent: data.parent.slice(0, 7) })}</span> : <span>{t("initialCommit")}</span>}
        </span>
      </div>
      <button type="button" className="fm-tbtn" onClick={() => void copySha()} title={oid}>{copied ? "✓" : t("copySha")}</button>
    </header>
    {omitted && <p role="status" className="scm-note">{t("diffOmitted")}</p>}
    <div className="scm-commit-body">
      <nav className="scm-commit-files" aria-label={t("commitFilesTitle")}>
        <p className="scm-group-caption">{t("commitFilesTitle")}<span className="scm-count">{files.length}</span></p>
        {files.length ? <ul>{files.map(f => (
          <li key={f.path}>
            <button type="button" data-selected={(selectedPath ?? files[0].path) === f.path} title={f.path} onClick={() => selectPath(f.path)}>
              <span className="scm-commit-status">{f.status}</span>
              <span className="scm-name">{f.path.split("/").pop()}</span>
              <small>{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</small>
            </button>
          </li>
        ))}</ul> : <p className="scm-note">{t("noFileChanges")}</p>}
      </nav>
      <div className="scm-commit-patch">
        {patch?.kind === "text" ? <>
          <pre tabIndex={0} aria-label={zh ? "文件差异" : "File diff"}>{patch.text}</pre>
          {patch.truncated && <p className="scm-note">{t("diffPreviewTruncated")}</p>}
        </> : patch ? <p className="scm-note">{({
          binary: t("binaryNoDiff"),
          limit: t("fileOverDiffLimit"),
          mode: t("modeOnlyChange"),
          unavailable: t("noTextDiff"),
        })[patch.kind]}</p> : null}
      </div>
    </div>
  </article>;
}
