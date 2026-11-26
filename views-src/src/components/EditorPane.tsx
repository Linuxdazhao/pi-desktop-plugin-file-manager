import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createEditor, type EditorHandle, type TabEditorSnapshot } from "../lib/editor";
import type { Base } from "../lib/appearance";
import type { T } from "../i18n";
import { baseNameOf, formatSize, formatTime } from "../lib/format";
import { MarkdownPreview } from "../lib/markdown";
import { csvDelimiterOf, type ViewerView } from "../lib/viewers";
import { contentKind } from "../lib/pane";
import { isDocumentLoaded, type OpenFile } from "../lib/openFile";
import { invoke } from "../lib/bridge";
import { absoluteFullPath, type WorkspaceRoot } from "../lib/roots";
import { CsvTable } from "./CsvTable";
import { ImageView } from "./ImageView";
import { JsonTree } from "./JsonTree";
import { MediaPlayer } from "./MediaPlayer";
import { PdfView } from "./PdfView";
import { SqliteView } from "./SqliteView";
import { ContextMenu } from "./ContextMenu";
import { isExternalPath } from "../lib/hostOpen";
import { appendFileLineClipboard, readFileLineSelection, type FileLineReference } from "../lib/file-line-selection";

type Props = {
  file: OpenFile | null;
  visible: boolean;
  restore?: TabEditorSnapshot;
  base: Base;
  locale: "en" | "zh";
  dirty: boolean;
  saving: boolean;
  /** 当前文件可用的视图模式（源码 / Markdown / 表格 / 树）；纯文本为 null。 */
  viewer: ViewerView | null;
  /** 表格每页行数（偏好里记着）。 */
  tablePageSize: number;
  /**
   * 打开的文件在外部被改动、而缓冲里还有未保存的改动（0.8.0）。
   * 这种情况下**不自动装载**（会丢掉用户刚敲的字），只亮一条提示。
   */
  externalChange: boolean;
  activeRoot: WorkspaceRoot | null;
  workspacePath?: string;
  t: T;
  handleRef: React.MutableRefObject<EditorHandle | null>;
  /** Caret line/column of the active document, for the status bar. */
  onPosition?: (position: { line: number; column: number } | null) => void;
  /** Soft-wrap long lines. A view preference, persisted with the other prefs. */
  wrap?: boolean;
  onDirty: () => void;
  onSave: () => void;
  onReload: () => void;
  onTablePageSize: (size: number) => void;
  onLink: (url: string) => void;
};


export function EditorPane({
  file,
  visible,
  restore,
  base,
  activeRoot,
  workspacePath,
  locale,
  dirty,
  saving,
  viewer,
  tablePageSize,
  externalChange,
  t,
  handleRef,
  onPosition,
  wrap = true,
  onDirty,
  onSave,
  onReload,
  onTablePageSize,
  onLink,
}: Props) {
  // 光标位置只回传给状态栏：放在 ref 里，免得每次键入都重建编辑器扩展。
  const positionRef = useRef(onPosition);
  positionRef.current = onPosition;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 编辑器里装的是哪一次「从磁盘读进来」的内容；null = 还没装。
  const [loadedToken, setLoadedToken] = useState<number | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    loadToken: number;
    reference: FileLineReference;
  } | null>(null);

  // 编辑器只在挂载时创建一次，所以回调必须经 ref 转发，
  // 否则 Ctrl+S 会一直调用「首帧那次渲染」闭包里的 onSave（那时还没有打开文件）。
  const handlersRef = useRef({ onDirty, onSave });
  handlersRef.current = { onDirty, onSave };
  const reportCursor = useCallback(() => {
    const view = handleRef.current?.view;
    if (!view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    positionRef.current?.({ line: line.number, column: head - line.from + 1 });
  }, [handleRef]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createEditor(host, {
      base,
      onDocChanged: () => handlersRef.current.onDirty(),
      onSave: () => handlersRef.current.onSave(),
      onCursor: reportCursor,
      wrap,
    });
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    handleRef.current?.setBase(base);
  }, [base, handleRef]);

  // Wrapping is reconfigured in place: rebuilding the editor would drop the
  // undo history and the caret, and the toggle is meant to be cheap.
  useLayoutEffect(() => {
    handleRef.current?.setWrap(wrap);
  }, [wrap, handleRef]);

  // 切换页签或从磁盘重新装载时才替换文档。保存后的元数据更新不改
  // loadToken，不能用 file.text 或之前的快照覆盖当前草稿。
  useLayoutEffect(() => {
    if (!file) {
      // 换文件夹（或关闭文件）之后，编辑器里不能还留着上一个文件夹的那份文档：
      // 面板上已经是空态，缓冲区却还在——切回同一相对路径的文件、或者误按
      // Ctrl+S 都会撞见别人的内容。只有装过文档（loadToken 非空）才需要清一次；
      // setDocument 只替换整个状态，不会触发脏标记。
      if (loadedToken !== null) {
        handleRef.current?.setDocument("", "", true);
        setLoadedToken(null);
      }
      return;
    }
    if (loadedToken === file.loadToken) return;
    setSelectionMenu(null);
    handleRef.current?.setDocument(file.text, file.path, file.kind !== "text" || file.readOnly === true, restore);
    setLoadedToken(file.loadToken);
  }, [file, restore, loadedToken, handleRef]);

  const mode = viewer?.mode ?? "source";
  const imageSrc = file?.kind === "image" ? file.dataUri : undefined;
  const mediaSrc = file?.kind === "media" ? file.dataUri : undefined;
  const pdfSrc = file?.kind === "pdf" ? file.dataUri : undefined;
  const sqlite = file?.kind === "sqlite" ? file.sqlite : undefined;
  // Keep CodeMirror and its undo history mounted; other viewers can clean up.
  const content = visible && file ? contentKind({ fileKind: file.kind, viewerMode: mode, diffOpen: false }) : "empty";
  const editorHidden = content !== "editor";
  const matchesSavedFile = !dirty && !saving && !externalChange;
  const sourceSelection = (target: EventTarget | null) => {
    const view = handleRef.current?.view;
    if (!view || !(target instanceof Node) || !view.contentDOM.contains(target) ||
        editorHidden || !workspacePath || !activeRoot || file?.kind !== "text" ||
        !isDocumentLoaded(file, loadedToken) || isExternalPath(file.path)) {
      return null;
    }
    return readFileLineSelection(
      view.state, workspacePath, absoluteFullPath(file.path, activeRoot), matchesSavedFile ? file.text : null,
    );
  };
  // 内容区只有一种整块视图在场上（见 lib/pane.ts 的 contentKind）。「编辑 / 预览 /
  // 差异」这个切换器现在住在内容区顶栏（Workbench 的 ContentBar），所以这里只算
  // 「该渲染哪一种」。
  // Only structured previews need a string. Source-tab switches retain the
  // immutable CodeMirror document, even before the layout effect restores it.
  const structuredText = content === "markdown" || content === "table" || content === "tree"
    ? (isDocumentLoaded(file, loadedToken) ? handleRef.current?.text() : restore?.state.doc.toString()) ?? file?.text ?? ""
    : "";

  useLayoutEffect(() => {
    if (editorHidden) {
      setSelectionMenu(null);
      positionRef.current?.(null);
      return;
    }
    handleRef.current?.view.requestMeasure();
    reportCursor();
  }, [editorHidden, loadedToken, handleRef, reportCursor]);

  // 图片与音视频是「查看」而不是「编辑」，不再挂只读横幅——换成查看器本身。
  const readOnlyReason =
    file && file.kind !== "text"
      ? file.kind === "binary"
        ? t("binary")
        : file.kind === "tooLarge"
          ? t("tooLarge")
          : null
      : null;

  // 工作簿（xlsx）预览读不全时的提示：主进程只回标志与上限数字，文案在这里按
  // 界面语言渲染——主进程不知道用户说的是哪种语言，它拼出来的只会是中文。
  const workbook = file?.workbook;
  const workbookNotices = workbook
    ? [
        workbook.incomplete ? t("xlsxIncomplete") : null,
        workbook.truncated
          ? t("xlsxTruncated", {
              sheets: workbook.limits?.sheets ?? 0,
              rows: workbook.limits?.rows ?? 0,
              cols: workbook.limits?.cols ?? 0,
            })
          : null,
      ].filter((line): line is string => Boolean(line))
    : [];

  return (
    <section className="fm-editor-pane" aria-label={t("title")}>
      {/* 外部改动提示（0.8.0）：只有「有未保存改动」时才会出现——没改动的文件早
          就自动重新读取了，这里无事可提示。按钮走的是既有的「重新加载」，它内部
          已经带未保存确认框（保存 / 放弃 / 取消），所以这条横幅不重复造逻辑。 */}
      {externalChange && file ? (
        <div
          className="flex flex-none items-center gap-2 px-3 py-2 text-[11.5px]"
          role="status"
          style={{
            background: "color-mix(in oklab, var(--git-modified) 14%, transparent)",
            color: "var(--fg)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>{t("externalChanged")}</span>
          <button
            type="button"
            onClick={onReload}
            className="rounded border-0 bg-transparent px-1 text-[11px] underline underline-offset-2"
            style={{ color: "var(--secondary)" }}
          >
            {t("reload")}
          </button>
        </div>
      ) : null}

      {/* 工作簿预览读不全（截断 / 部件缺失）：一条状态提示，不打断表格本身。 */}
      {workbookNotices.length > 0 ? (
        <div
          className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]"
          role="status"
          style={{
            background: "color-mix(in oklab, var(--git-modified) 14%, transparent)",
            color: "var(--fg)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {workbookNotices.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}

      {readOnlyReason ? (
        <div
          className="flex flex-none items-center gap-2 px-3 py-2 text-[11.5px]"
          style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}
        >
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--surface-hover)", color: "var(--secondary)" }}
          >
            {t("readOnly")}
          </span>
          <span>{readOnlyReason}</span>
          {typeof file?.limit === "number" ? (
            <span style={{ color: "var(--faint)" }}>
              {t("limitHint", { limit: formatSize(file.limit) })}
            </span>
          ) : null}
          {file ? (
            <span className="ml-auto" style={{ color: "var(--faint)" }}>
              {formatTime(file.mtimeMs, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      {!matchesSavedFile && !editorHidden && file?.kind === "text" &&
        window.pluginBridge?.capabilities?.composerFileLines === true ? (
        <p role="status" className="px-3 py-1 text-xs" style={{ color: "var(--muted)" }}>
          {t("saveForLineReference")}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={hostRef}
          className="h-full"
          hidden={editorHidden}
          onCopy={(event) => {
            // CodeMirror writes the plain text and maintains its linewise copy state.
            if (!event.nativeEvent.isTrusted) return;
            const reference = sourceSelection(event.target);
            if (reference && !appendFileLineClipboard(event.clipboardData, reference, event.defaultPrevented)) {
              void invoke("ui.showToast", { message: t("fileLineCopyFallback"), level: "error" }).catch(() => {});
            }
          }}
          onContextMenu={(event) => {
            if (!file || !event.nativeEvent.isTrusted ||
                window.pluginBridge?.capabilities?.composerFileLines !== true) return;
            const reference = sourceSelection(event.target);
            if (!reference) return;
            event.preventDefault();
            setSelectionMenu({
              x: event.clientX,
              y: event.clientY,
              loadToken: file.loadToken,
              reference,
            });
          }}
        />
        {selectionMenu && matchesSavedFile && !editorHidden && selectionMenu.loadToken === file?.loadToken &&
          selectionMenu.reference.workspace === workspacePath ? (
          <ContextMenu
            x={selectionMenu.x}
            y={selectionMenu.y}
            onClose={(reason) => {
              setSelectionMenu(null);
              if (reason === "escape") handleRef.current?.view.focus();
            }}
            entries={[
              {
                kind: "item",
                label: t("addSelectionToChat"),
                onPick: () => {
                  void invoke("composer.addFileLines", selectionMenu.reference).catch((cause: unknown) =>
                    invoke("ui.showToast", {
                      message: `${t("addSelectionFailed")} ${cause instanceof Error ? cause.message : String(cause)}`,
                      level: "error",
                    }).catch(() => {}));
                },
              },
              {
                kind: "item",
                label: t("copySelection"),
                onPick: () => {
                  handleRef.current?.view.focus();
                  if (!document.execCommand("copy")) {
                    void invoke("ui.showToast", { message: t("copySelectionFailed"), level: "error" }).catch(() => {});
                  }
                },
              },
            ]}
          />
        ) : null}

        {/* 整块视图只有一个在场上：content 是单值（见 lib/pane.ts），所以这里不可能
            出现「预览与差异叠在一起」。编辑器由 editorHidden 藏起来。 */}
        {content === "markdown" && file ? (
          <div className="md-scroll">
            <div className="md-body">
              <MarkdownPreview text={structuredText} base={base} onLink={onLink}
                key={`${activeRoot?.path}:${file.loadToken}`}
                filePath={file.path} workspacePath={workspacePath} />
            </div>
          </div>
        ) : null}

        {content === "table" && file ? (
          <CsvTable
            text={structuredText}
            delimiter={csvDelimiterOf(file.path) ?? ","}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {content === "tree" && file ? <JsonTree text={structuredText} t={t} /> : null}

        {content === "image" && file && imageSrc ? (
          <ImageView key={file.path} src={imageSrc} name={baseNameOf(file.path)} size={file.size} t={t} />
        ) : null}

        {content === "media" && file && mediaSrc ? (
          <MediaPlayer
            key={file.path}
            src={mediaSrc}
            mime={file.mime ?? ""}
            name={baseNameOf(file.path)}
            size={file.size}
            t={t}
          />
        ) : null}

        {content === "pdf" && file && pdfSrc ? (
          <PdfView key={`${file.path}#${file.loadToken}`} src={pdfSrc} name={baseNameOf(file.path)} size={file.size} locale={locale} t={t} />
        ) : null}

        {content === "sqlite" && file && sqlite ? (
          <SqliteView
            // 带上 loadToken：工具栏的「重新加载」会重新读一次头部，key 一变就重挂载，
            // schema 与当前页数据跟着刷新（数据库不能被编辑，所以只有这一种变化来源）
            key={`${file.path}#${file.loadToken}`}
            path={file.path}
            info={sqlite.info}
            available={sqlite.available}
            pageSize={tablePageSize}
            onPageSize={onTablePageSize}
            t={t}
          />
        ) : null}

        {/* The empty state belongs to the workbench (it offers a way back to the
            explorer), so the pane renders nothing rather than a stray hint. */}
      </div>
    </section>
  );
}
