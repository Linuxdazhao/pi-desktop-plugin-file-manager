import { useEffect, useState } from "react";
import { makeT, type Locale } from "../i18n";
import { invoke } from "../lib/bridge";
import type { Failure } from "../lib/rpc";
import { IconButton } from "./IconButton";
import { Skeleton } from './Skeleton';

export type HistoryCommit = { oid: string; subject: string; author: string; date: string };
type Scope = { workspacePath: string; rootPath: string; projectId?: string; locale: Locale };
type HistoryProps = Scope & { onInspect: (commit: HistoryCommit) => void };
type DetailProps = Scope & { oid: string };
type History = { ok: true; branch: string; commits: HistoryCommit[] };
type Patch = { kind: "text"; text: string; truncated: boolean } | { kind: "limit" | "binary" | "mode" | "unavailable" };
type Detail = { ok: true; commit: HistoryCommit; parent: string | null; files: { path: string; status: string }[];
  omitted: boolean; selectedPath?: string; patch?: Patch };

function useHistoryRequest<T extends { ok: true }>(channel: string, payload: object) {
  const key = JSON.stringify(payload);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; version: number; data?: T; error?: Failure }>();
  useEffect(() => {
    let current = true;
    invoke<T | Failure>(channel, JSON.parse(key)).then(r => {
      if (current) setResult(r.ok ? { key, version, data: r } : { key, version, error: r });
    }).catch(() => { if (current) setResult({ key, version, error: { ok: false, code: "BRIDGE", message: "" } }); });
    return () => { current = false; };
  }, [channel, key, version]);
  return { ...(result?.key === key && (result.data || result.version === version) ? result : {}), refresh: () => setVersion(v => v + 1) };
}
function failure(error: Failure, locale: Locale) {
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

export function GitHistory({ workspacePath, rootPath, projectId, locale, onInspect }: HistoryProps) {
  const zh = locale === "zh";
  const t = makeT(locale);
  const { data, error, refresh } = useHistoryRequest<History>("fm.git.history", { workspacePath, rootPath, projectId });
  return <section className="scm-pane" aria-label={zh ? "提交历史" : "Commit history"}>
    <div className="scm-controls"><header>
      <strong title={data?.branch}>{data?.branch || (zh ? "提交历史" : "Commit history")}</strong>
      <IconButton small label={t("refresh")} onClick={refresh}><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" /></IconButton>
    </header></div>
    <div className="scm-list scm-group">
      {error ? <p role="alert">{failure(error, locale)}</p> : !data ? <Skeleton kind="list" label={t('loading')} /> : !data.commits.length ?
        <p>{zh ? "此分支还没有提交。" : "This branch has no commits yet."}</p> : <ul>{data.commits.map(c =>
          <li className="scm-row" key={c.oid}><button type="button" className="scm-file" title={`${c.subject}\n${c.author} · ${dateLabel(c.date, locale)}\n${c.oid}`}
            onClick={() => onInspect(c)}><small>{c.oid.slice(0, 7)}</small><span className="scm-name">{c.subject || (zh ? "（无标题）" : "(no subject)")}</span></button></li>)}</ul>}
    </div>
    <footer>{zh ? "当前分支 · 最近 50 条提交" : "Current branch · latest 50 commits"}</footer>
  </section>;
}

export function GitCommitDetail(props: DetailProps) {
  return <Commit key={JSON.stringify([props.workspacePath, props.rootPath, props.projectId, props.oid])} {...props} />;
}
function Commit({ workspacePath, rootPath, projectId, locale, oid }: DetailProps) {
  const [path, selectPath] = useState<string>();
  const zh = locale === "zh";
  const t = makeT(locale);
  const { data, error, refresh } = useHistoryRequest<Detail>("fm.git.commitDetail", { workspacePath, rootPath, projectId, oid, path });
  if (error) return <div className="scm-guide"><p role="alert">{failure(error, locale)}</p><button type="button" onClick={refresh}>{t("refresh")}</button></div>;
  if (!data) return <Skeleton kind="diff" label={t('loading')} />;
  const { commit, files, omitted, selectedPath, patch } = data;
  return <article className="h-full min-h-0 overflow-auto p-3 text-xs" aria-label={zh ? "提交详情" : "Commit details"}>
    <h2 className="break-words text-sm font-semibold">{commit.subject || (zh ? "（无标题）" : "(no subject)")}</h2>
    <p className="break-all">{commit.author} · <time dateTime={commit.date}>{dateLabel(commit.date, locale)}</time></p>
    <code className="break-all">{oid}</code>
    <p>{data.parent ? `${zh ? "对比父提交" : "Compared with parent"} ${data.parent.slice(0, 7)}` : (zh ? "首次提交" : "Initial commit")}</p>
    {omitted && <p>{zh ? "部分受保护、不支持或超过数量限制的路径已省略。" : "Protected, unsupported or excess paths are omitted."}</p>}
    {files.length ? <label className="mt-2 block">{zh ? "已更改文件" : "Changed file"}
      <select className="block w-full" style={{ color: "var(--fg)", background: "var(--surface)" }} value={selectedPath} onChange={e => selectPath(e.target.value)}>
        {files.map(f => <option key={f.path} value={f.path}>{f.status} · {f.path}</option>)}
      </select></label> : <p>{zh ? "没有可预览的文件变更。" : "No file changes available for preview."}</p>}
    {patch?.kind === "text" ? <><pre className="mt-3 overflow-auto" tabIndex={0} aria-label={zh ? "文件差异" : "File diff"}>{patch.text}</pre>
      {patch.truncated && <p>{zh ? "差异预览已截断。" : "Diff preview truncated."}</p>}</> : patch && <p>{({
        binary: zh ? "二进制文件无法显示文本差异。" : "Binary file; no text diff available.",
        limit: zh ? "文件超过差异预览上限。" : "File exceeds the diff preview limit.",
        mode: zh ? "仅文件模式发生变化。" : "Only the file mode changed.",
        unavailable: zh ? "没有可用的文本差异。" : "No text diff available.",
      })[patch.kind]}</p>}
  </article>;
}
