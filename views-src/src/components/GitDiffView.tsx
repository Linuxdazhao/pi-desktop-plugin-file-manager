/**
 * 变更内容（0.7.0）：把主进程解析好的 unified diff 渲染成带行号的对照视图。
 *
 * 这一层是纯展示：数据是 fm.git.diff 的响应（行类型 + 行号都由 main.js 算好），
 * 这里不再解析任何 diff 文本。暂存区和工作树都有改动时，从同一份响应里切换显示。
 */

import { Skeleton } from "./Skeleton";
import type { T } from "../i18n";
import type { DiffSection, GitDiffResponse } from "../lib/rpc";
import { formatSize } from "../lib/format";
import { Segmented, segmentId } from "./Workbench";
import { GitIcon } from "./GitIcons";

/** 差异视图的加载态，由 GitPreview 持有。 */
export type DiffViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; response: Extract<GitDiffResponse, { ok: true }> };

type Props = {
  state: DiffViewState;
  t: T;
  onBack?: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /**
   * Which half of a two-sided change is on screen. The response always carries
   * every section that exists; picking one is a view decision, not a fetch — a
   * file staged *and* edited afterwards has both, and flipping between them
   * must not hit the host again.
   */
  scope: "worktree" | "staged";
  onScope: (scope: "worktree" | "staged") => void;
};

export function GitDiffView({ state, t, onBack, onRefresh, refreshing, scope, onScope }: Props) {
  const response = state.status === "ready" ? state.response : null;
  // Distinct scopes present in this response, in the order the host produced them.
  // A file that was staged and then edited again has both, and picking one must
  // never trigger a refetch: the response already carries both.
  const scopes = response ? [...new Set(response.sections.map((section) => section.scope))] : [];
  const activeScope = scopes.includes(scope) ? scope : scopes[0];
  const switchable = scopes.length > 1;
  const scopePanel = "fm-diff-scope";
  const sections = response ? response.sections.filter((section) => section.scope === activeScope) : [];
  const counts = countLines(sections);
  return (
    <div className="diff-pane">
      <div className="diff-bar">
        {switchable && <Segmented className="scm-seg" label={t("diffScope")} panelId={scopePanel}
          value={activeScope} onChange={onScope}
          options={scopes.map(value => ({ value, label: t(value === "staged" ? "diffScopeStaged" : "diffScopeWorktree") }))} />}
        {response ? (
          <>
            <span className="tabular-nums" style={{ color: "var(--git-added)" }}>+{counts.added}</span>
            <span className="tabular-nums" style={{ color: "var(--git-deleted)" }}>−{counts.deleted}</span>
            {activeScope && <span className="diff-base">{t(activeScope === "staged" ? "diffAgainstHead" : "diffAgainstIndex")}</span>}
            {response.untracked ? <span style={{ color: "var(--muted)" }}>{t("gitUntracked")}</span> : null}
            {response.truncated ? <span style={{ color: "var(--muted)" }}>{t("gitDiffTruncated")}</span> : null}
          </>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-1">
          <button type="button" title={t("refresh")} aria-label={t("refresh")} onClick={onRefresh}
            disabled={refreshing} className="diff-action"><GitIcon name="refresh" size={14} /></button>
          {onBack && <button type="button" title={t("backToEditor")} aria-label={t("backToEditor")} onClick={onBack} className="diff-action">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 19-7-7 7-7M19 12H5" />
            </svg>
          </button>}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto" id={switchable ? scopePanel : undefined}
        role={switchable ? "tabpanel" : undefined} aria-labelledby={switchable ? segmentId(scopePanel, activeScope) : undefined}
        aria-busy={refreshing || state.status === "loading"}>
        {state.status === "loading" ? <Skeleton kind="diff" label={t("loading")} /> : null}
        {state.status === "error" ? (
          <p className="px-3 py-2 text-[11.5px]" role="alert" style={{ color: "var(--danger)" }}>{state.message}</p>
        ) : null}
        {state.status === "ready" ? <DiffBody response={state.response} sections={sections} t={t} /> : null}
      </div>
    </div>
  );
}

function countLines(sections: DiffSection[]) {
  let added = 0;
  let deleted = 0;
  for (const section of sections) for (const hunk of section.hunks) for (const line of hunk.lines) {
    if (line.type === "add") added += 1;
    else if (line.type === "del") deleted += 1;
  }
  return { added, deleted };
}

function DiffBody({ response, sections, t }: { response: Extract<GitDiffResponse, { ok: true }>; sections: DiffSection[]; t: T }) {
  if (response.kind === "none") {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitNoChanges")}
      </p>
    );
  }
  if (response.kind === "tooLarge") {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffTooLarge", {
          size: formatSize(response.size ?? 0),
          limit: formatSize(response.limit ?? 0),
        })}
      </p>
    );
  }
  if (!sections.length && response.kind === "binary") {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffBinary")}
      </p>
    );
  }

  if (!sections.length) {
    return <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>{t("gitNoChanges")}</p>;
  }

  return (
    <>
      {sections.map((section, index) => (
        <DiffSectionView key={`${section.scope}:${index}`} section={section} t={t} />
      ))}
    </>
  );
}

function DiffSectionView({ section, t }: { section: DiffSection; t: T }) {
  if (section.binary) {
    return (
      <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        {t("gitDiffBinary")}
      </p>
    );
  }
  return (
    <section className="border-b py-1" style={{ borderColor: "var(--border)" }}>
      <div
        className="sticky top-0 flex items-center gap-2 px-2.5 py-1 text-[10.5px]"
        style={{ background: "var(--surface)", color: "var(--muted)" }}
      >
        <span className="font-medium">
          {section.scope === "staged" ? t("gitScopeStaged") : t("gitScopeWorktree")}
        </span>
        {section.meta
          .filter((line) => line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("rename"))
          .map((line) => (
            <span key={line} className="truncate">
              {line}
            </span>
          ))}
        {section.truncated ? <span>{t("gitDiffTruncated")}</span> : null}
      </div>
      {section.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}:${hunkIndex}`} className="diff-hunk">
          <div className="diff-hunk-head" title={hunk.header}>
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`diff-line diff-line-${line.type}`}>
              <span className="diff-num">{line.oldLine ?? ""}</span>
              <span className="diff-num">{line.newLine ?? ""}</span>
              <span className="diff-sign" aria-hidden="true">
                {line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "note" ? "\\" : " "}
              </span>
              <span className="diff-text">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
