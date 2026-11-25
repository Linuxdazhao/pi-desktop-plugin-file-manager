import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./lib/bridge";
import { watchAppearance, type Base, type Locale as HostLocale } from "./lib/appearance";
import { watchWorkspace, workspaceKey, type Workspace } from "./lib/workspace";
import { channels, failureMessage, isConflict, type DeleteResponse, type EditorOption, type EditorsResponse, type Failure, type FileEntry, type GitDiffResponse, type GitSummary, type HelloResponse, type ListResponse, type Prefs, type PrefsResponse, type ReadRequest, type ReadResponse, type SearchHit, type SearchResponse, type WatchResponse, type WriteRequest, type WriteResponse } from "./lib/rpc";
import { gitSummaryText, lookupGit } from "./lib/git";
import { useTreeWatch } from "./lib/useTreeWatch";
import { baseNameOf, parentOf } from "./lib/format";
import { absoluteFullPath, findRootForPath, hostActionPath, normalizeRoots, primaryRootOf, projectKeyOf, rememberProjectRoot, resolveSelectedRoot, samePath, type WorkspaceRoot } from "./lib/roots";

import { makeT, type T } from "./i18n";
import { resolveViewer, type ViewerMode } from "./lib/viewers";
import { toOpenFile, withSavedContent, type OpenFile } from "./lib/openFile";
import { openInBuiltInBrowser, openWithDefaultApp, openWithEditor, revealInFileManager } from "./lib/hostActions";
import { editorsFor } from "./lib/editors";
import { buildFileContextMenuEntries, withBuiltInBrowserEntry } from "./lib/file-context-menu";
import { copyText } from "./lib/clipboard";
import { isExternalPath, watchHostOpenRequests, type HostOpenRequest } from "./lib/hostOpen";
import type { DiffViewState } from "./components/GitDiffView";
import { Tree, type DirState } from "./components/Tree";
import { Skeleton } from './components/Skeleton';
import { FileIcon } from "./lib/fileIcons";
import { IconButton } from "./components/IconButton";
import { GitPanel } from "./components/GitPanel";
import { GitCommitDetail, type HistoryCommit } from "./components/GitHistory";
import { GitPreview, type PreviewTab } from "./components/GitPreview";
import { EditorPane } from "./components/EditorPane";
import { ConfirmDialog, PromptDialog } from "./components/Dialogs";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import type { EditorHandle } from "./lib/editor";
import { useDocumentTabs } from "./lib/documentTabs";

type SearchState = { hits: SearchHit[]; running: boolean; done: boolean };

type Guard = { body: string; paths: string[] } | null;
type Prompt =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; entry: FileEntry }
  | null;
type Conflict = { path: string; mtimeMs: number; size: number } | null;
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

/** `a/b/c.txt` → ["a", "a/b"]：打开文件前要逐级展开并加载的祖先目录。 */
function ancestorPaths(relPath: string): string[] {
  const segments = relPath.split("/");
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

const SEARCH_PAGE = 60;


export default function App() {
  const [hostLocale, setHostLocale] = useState<HostLocale>("en");
  const [base, setBase] = useState<Base>(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const t: T = useMemo(() => makeT(hostLocale), [hostLocale]);

  const [root, setRoot] = useState<Workspace | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const remoteReadOnly = root?.path.startsWith("remote-project:") === true;
  const [directories, setDirectories] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandToken = useRef(0);
  const [expanding, setExpanding] = useState(false);
  const directoryRequests = useRef(new Map<string, symbol>());
  const [selected, setSelected] = useState<string | null>(null);
  const documents = useDocumentTabs();
  const openFile = documents.active?.file ?? null;
  const dirty = documents.active?.dirty ?? false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    splitRatio: 0.32,
    treeCollapsed: false,
    showIgnored: false,
    watchFiles: true,
    mdPreview: false,
    csvTable: true,
    jsonTree: false,
    tablePageSize: 1000,
    projectRoots: {},
  });
  /** 整个工作区的 git 概览（分支 + 各状态计数），跟着最近一次列表刷新。 */
  const [gitSummary, setGitSummary] = useState<GitSummary | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [inspectedCommit, setInspectedCommit] = useState<HistoryCommit | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [gitRefresh, setGitRefresh] = useState(0);
  /** 差异视图：path + 加载态。null = 右侧仍是编辑器。 */
  const [diff, setDiff] = useState<(DiffViewState & { path: string }) | null>(null);
  /** 这个运行时能不能监听（0.8.0）；不能就把「自动刷新」开关显示成不可用。 */
  const [watchAvailable, setWatchAvailable] = useState(true);
  const [openHtmlInBrowserAvailable, setOpenHtmlInBrowserAvailable] = useState(false);
  /**
   * 打开的文件在外部被改了、而缓冲里还有未保存的改动。
   * 这时**不自动装载**——静默丢掉用户刚敲的字是最糟的一种「自动」；只提示一句，
   * 由用户点「重新加载」（或走原来的未保存确认框）来决定。
   */
  const externalChange = documents.active?.changed ?? false;
  const [ignoreActive, setIgnoreActive] = useState(false);
  const [guard, setGuard] = useState<Guard>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [query, setQuery] = useState("");
  /** 删除前的确认框（删除不可撤销，必须明确确认）。 */
  const [confirmDelete, setConfirmDelete] = useState<{ entry: FileEntry } | null>(null);
  const [search, setSearch] = useState<SearchState>({ hits: [], running: false, done: true });
  /** 头部左上角切换器的菜单锚点（null = 没打开）。 */
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * 组信息与偏好（含 root 记忆）都到手了。在那之前宿主请求要先排队 —— 不知道
   * 主根是谁就判断不了「相对路径其实指主根」，也不知道基点该不该切。
   */
  const [ready, setReady] = useState(false);
  /** Local editor candidates are cached by the plugin and refreshed after workspace switches. */
  const [editors, setEditors] = useState<EditorOption[] | null>(null);

  const handleRef = useRef<EditorHandle | null>(null);
  const dirsRef = useRef(directories);
  const revisionRef = useRef(0);
  const openTokenRef = useRef(0);
  const watchReadToken = useRef(0);
  const searchTokenRef = useRef(0);
  /** 差异请求的守卫：连点「刷新」时只有最后一次的结果算数。 */
  const diffTokenRef = useRef(0);
  /** 当前差异视图对应哪个文件；保存 / 重新加载后据此决定要不要重取。 */
  const diffPathRef = useRef<string | null>(null);
  /** loadDiff 经 ref 转发：openEntry 定义在它之前，却要在读完之后回调它。 */
  const loadDiffRef = useRef<(path: string) => void>(() => {});
  // 每次「从磁盘装载」递增，写进 OpenFile.loadToken：编辑器据此区分
  // 「换文件 / 重新加载」与「保存后更新 mtime」。见 lib/openFile.ts。
  const loadTokenRef = useRef(0);
  const saveRef = useRef<(override?: { mtimeMs: number; size: number }) => Promise<boolean>>(
    async () => false,
  );
  /** 正在进行的保存（含目标路径）。同一个文件的重复请求复用它，不发出第二次写。 */
  const inFlightRef = useRef<{ path: string; promise: Promise<boolean> } | null>(null);
  /** 保存是异步的：回来时用户可能已经切走，元数据与脏标记不能落到新文件上。 */
  const openPathRef = useRef<string | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const loadRef = useRef<(path: string, force?: boolean) => Promise<FileEntry[] | undefined>>(async () => undefined);
  /** 宿主请求（入口查询串 / view:open 推送）统一走它。 */
  const hostOpenRef = useRef<(request: HostOpenRequest) => void>(() => {});
  /** 宿主请求在 ready 之前到达时先排队，见下面 ready 的 flush effect。 */
  const pendingHostOpenRef = useRef<HostOpenRequest | null>(null);
  /** 组已经到过，但偏好还没到手：那一份先压着，由 hello 放出去。 */
  const pendingWorkspaceRef = useRef<Workspace | null | undefined>(undefined);
  /** hello 回来过（偏好与 root 记忆都知道了）。 */
  const prefsLoadedRef = useRef(false);
  /** 组走完第一轮 applyWorkspace 之前，宿主请求先排队（见 ready 的 flush effect）。 */
  const readyRef = useRef(false);
  /**
   * 已经应用过的组身份，用来吃掉首次的重复投递（workspace.get 与 hello 并发）。
   * 初值刻意是 undefined 而不是 null：null 是「没有打开项目」这个合法身份。
   */
  const appliedKeyRef = useRef<string | null | undefined>(undefined);
  const applyRef = useRef<(workspace: Workspace | null) => void>(() => {});
  /** 最新的一份偏好（含 root 记忆）；跨 await 的回调要读到最新值。 */
  const prefsRef = useRef(prefs);
  const rootRef = useRef<Workspace | null>(root);
  /** 当前基点；宿主请求要先拿它比对「要不要切」。 */
  const activeRootRef = useRef<WorkspaceRoot | null>(null);
  /** 头部切换器的按钮节点：菜单关掉后把焦点还给它。 */
  const rootButtonRef = useRef<HTMLButtonElement | null>(null);
  /** 切换器按钮按下时菜单是否已经开着（见 openRootMenu）。 */
  const armedRef = useRef(false);

  // 让回调读到最新值而不必重订阅。
  const dirtyRef = useRef(dirty);
  const currentNameRef = useRef("");
  const tRef = useRef(t);

  dirsRef.current = directories;
  dirtyRef.current = dirty;
  openPathRef.current = openFile ? openFile.path : null;
  currentNameRef.current = openFile ? baseNameOf(openFile.path) : t("projectFiles");
  tRef.current = t;
  prefsRef.current = prefs;
  rootRef.current = root;
  // 跨 await 的回调（保存成功后）要读到差异视图当前对应哪个文件。
  diffPathRef.current = diff ? diff.path : null;

  // 组里全部 folder root（宿主没给 roots 时只有一个，就是主根）。
  const roots = useMemo(() => (root ? normalizeRoots(root) : []), [root]);
  /**
   * 当前浏览的那个 root：记忆里的路径必须命中组里的 roots，否则退回主根。
   * 选择不额外存一份 state —— prefs.projectRoots 是唯一真相（main.js 也按它
   * 推导包含基点），视图只是把它翻译成名字与路径。
   */
  const activeRoot = useMemo(
    () => (root ? resolveSelectedRoot(roots, prefs.projectRoots[projectKeyOf(root)]) : null),
    [prefs.projectRoots, root, roots],
  );
  /** 头部的名字：看到哪个 folder 就显示哪个。 */
  const headerName = activeRoot?.name ?? root?.name ?? t("title");
  const rootCount = roots.length;

  // 当前基点写给工具回调（宿主请求要先比对「要不要切」）。
  activeRootRef.current = activeRoot;
  /**
   * 组里多于一个 folder 才有切换器；只有一个 root（或老宿主）时头部就是静态标签。
   * ready 之前偏好与 root 记忆都还没到手：这时候切换等于拿一份空记忆去落盘，
   * 而且随后返回的那份旧偏好会把刚选的基点盖回去（视图与主进程的基点就此分叉）。
   * 所以先只显示静态名字——ready 一到它就是开关。
   */
  const switchable = ready && rootCount > 1 && Boolean(activeRoot);

  /**
   * 换项目 / 换基点共用的一段：树、展开、选中、搜索、打开的文件全部重来。
   * revision 递增让还在飞的目录列表结果作废（见 loadDirectory 的守卫）。
   */
  const resetExplorer = useCallback(() => {
    revisionRef.current += 1;
    openTokenRef.current += 1;
    setOpeningPath(null);
    setDirectories(new Map());
    setExpanded(new Set());
    setSelected(null);
    documents.clear();
    setConflict(null);
    pendingRef.current = null;
    setGuard(null);
    setError(null);
    setQuery("");
    setSearch({ hits: [], running: false, done: true });
    // 概览与徽标都是「上一个 root 的」，换项目 / 换文件夹必须一起清掉。
    setGitSummary(null);
    setGitOpen(false);
    setInspectedCommit(null);
    setPreviewTab(null);
    setShowPreview(false);
    setDiff(null);
    expandToken.current++;
    directoryRequests.current.clear();
    setExpanding(false);
    setMenu(null);
  }, []);

  /**
   * 应用一个项目组（workspace.get / hello 的结果）。同一个组重复投递只应用一次：
   * 轮询与 hello 是两条并发的异步，谁先回来都可能；重复应用会把刚由宿主打开的
   * 文件又清掉。
   */
  const applyWorkspace = useCallback(
    (workspace: Workspace | null) => {
      const key = workspaceKey(workspace);
      if (key === appliedKeyRef.current) return;
      appliedKeyRef.current = key;
      workspaceRef.current = workspace;
      setRoot(workspace);
      resetExplorer();
      if (workspace) void loadRef.current("", true);
    },
    [resetExplorer],
  );

  applyRef.current = applyWorkspace;

  // ── 外观 ─────────────────────────────────────────────────────────────────

  useEffect(
    () =>
      watchAppearance((_appearance, nextBase, nextLocale) => {
        setBase(nextBase);
        setHostLocale(nextLocale);
      }),
    [],
  );

  // ── 工作区切换 ───────────────────────────────────────────────────────────

  useEffect(() => {
    // 订阅工作区变化：组一变就整体重载（宿主没有给 workpanel 的工作区事件，
    // 只能靠 workspace.get 的轮询；判断键含组 id 与全部 root，见 lib/workspace.ts）。
    // 有未保存内容时先走守卫。
    // 依赖保持为空：watchWorkspace 订阅时会立刻发一次首次结果，若把 t 放进
    // 依赖，切换语言就会重订阅并再次触发「工作区变化」，把树和文件全清掉。
    return watchWorkspace((workspace) => {
      // 偏好（含 root 记忆）还没到手就先压着：基点是由记忆决定的，拿着空记忆
      // 去恢复会加载错目录、还会把用户的选择冲掉。hello 回来后由它放出去。
      if (!prefsLoadedRef.current) {
        pendingWorkspaceRef.current = workspace;
        return;
      }
      // 与 0.4.0 一致：换项目时若有未保存的改动，先问一句（换基点走的是另一个
      // 入口，它自己带守卫，见 switchRoot / applyHostOpen）。
      const apply = () => applyRef.current(workspace);
      const paths = documents.tabs.filter(tab => tab.dirty).map(tab => tab.file.path);
      if (paths.length) {
        pendingRef.current = apply;
        setGuard({ body: tRef.current("dirtyPromptBody", { name: paths.join(", ") }), paths });
        return;
      }
      apply();
    });
  }, []);

  useEffect(
    () =>
      watchHostOpenRequests((request) => {
        // 组与偏好还没到手：先排队。此时既不知道主根是谁，也判不出「组内绝对
        // 路径该落在哪个 root」——把它当项目外路径放行会绕过根内包含校验。
        // 放行在下面 ready 的 effect 里。
        if (!readyRef.current) {
          pendingHostOpenRef.current = request;
          return;
        }
        hostOpenRef.current(request);
      }),
    [],
  );

  // 首次加载：拿偏好、root 记忆与项目组。
  // 这一步必须是「应用项目组」的唯一发令枪之一（另一处是上面的轮询回调）：
  // 两条异步（workspace.get 与 fm.hello）谁先回来都可能，统一在这里收口。
  useEffect(() => {
    void (async () => {
      let workspace: Workspace | null = null;
      try {
        const hello = await invoke<HelloResponse>(channels.hello);
        if (hello?.ok) {
          setPrefs(hello.prefs);
          workspace = hello.root;
        }
      } catch {
        /* 偏好拿不到就按默认值继续：不能把视图卡在「没加载」上 */
      }
      prefsLoadedRef.current = true;

      const queued = pendingWorkspaceRef.current;
      pendingWorkspaceRef.current = undefined;
      // 轮询先回来的那份更权威（它就是 workspace.get 的原始结果）；它缺席时
      // 才用 hello 自己带的（组 + 主根 + 选中的 root 记忆）。
      const first = queued ?? workspace;
      applyRef.current(first);
      readyRef.current = true;
      setReady(true);
    })();
  }, []);

  /** Restore local capabilities after a remote startup; discard probes from an old workspace. */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const key = workspaceKey(root);
    const current = () => !cancelled && workspaceKey(workspaceRef.current) === key;
    setEditors(null);
    setWatchAvailable(false);
    setOpenHtmlInBrowserAvailable(false);
    if (!root || remoteReadOnly) return;
    void invoke<HelloResponse>(channels.hello).then((response) => {
      if (!current() || !response?.ok) return;
      setWatchAvailable(response.watch?.available === true);
      setOpenHtmlInBrowserAvailable(response.capabilities?.openHtmlInBrowser === true);
    }).catch(() => { /* Optional host capabilities remain unavailable. */ });
    void invoke<EditorsResponse>(channels.editors).then((response) => {
      if (current() && response?.ok) setEditors(response.editors);
    }).catch(() => { /* The default application remains available without detected editors. */ });
    return () => { cancelled = true; };
  }, [ready, root, remoteReadOnly]);

  // ready 之后才放行排队的宿主请求：这个 effect 在应用完项目组的那次渲染之后
  // 才跑，所以 applyHostOpen 读到的组、基点与偏好都是最新的。
  useEffect(() => {
    if (!ready) return;
    const pending = pendingHostOpenRef.current;
    pendingHostOpenRef.current = null;
    if (pending) hostOpenRef.current(pending);
  }, [ready]);

  // ── 目录操作 ─────────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string, force = false) => {
      const revision = revisionRef.current;
      const existing = dirsRef.current.get(path);
      if (!force && existing?.entries && !existing.loading) return existing.entries;
      const token = Symbol();
      directoryRequests.current.set(path, token);
      const current = () => revision === revisionRef.current && directoryRequests.current.get(path) === token;

      const setDir = (state: DirState) =>
        setDirectories((prev) => {
          const next = new Map(prev);
          next.set(path, state);
          return next;
        });

      if (!existing?.entries) setDir({ loading: true });
      try {
        const response = await invoke<ListResponse | Failure>(channels.list, { path, workspacePath: workspaceRef.current?.path });
        if (!current()) return revision === revisionRef.current && response.ok ? response.entries : undefined;
        if (!response.ok) {
          setDir({ error: failureMessage(response, t) });
          return;
        }
        setDir({ entries: response.entries });
        // 「项目里有没有忽略规则」只有根目录那次列表能回答，用来提示用户
        // 树里为什么少了一些条目（工具栏的眼睛按钮可以切回显示）。
        if (path === "") setIgnoreActive(response.ignoreActive);
        // 概览是整个工作区的（与列的是哪个目录无关），所以任何一次列表刷新都拿
        // 最新的一份回来；徽标已经随每条 entry 一起进来了。
        setGitSummary(response.git ?? null);
        return response.entries;
      } catch (cause) {
        if (!current()) return;
        setDir({ error: String((cause as Error).message) });
      }
    },
    [t],
  );

  // 工作区切换的回调在 effect 里注册一次，通过 ref 拿到最新的加载函数。
  loadRef.current = loadDirectory;

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!expanded.has(path)) void loadDirectory(path, true);
    },
    [expanded, loadDirectory],
  );

  const refreshTree = useCallback(() => {
    const revision = revisionRef.current;
    const open = [...expanded];
    void (async () => {
      await loadDirectory("", true);
      for (const path of open) {
        if (revision !== revisionRef.current) return;
        await loadDirectory(path, true);
      }
    })();
  }, [expanded, loadDirectory]);

  const collapseAll = () => {
    expandToken.current++;
    setExpanding(false);
    setExpanded(new Set());
  };
  const expandAll = async () => {
    const token = ++expandToken.current;
    setExpanding(true);
    const queue = [""];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length && token === expandToken.current;) {
      const batch = queue.slice(index, index + 4);
      index += batch.length;
      const listings = await Promise.all(batch.map(path => loadDirectory(path, true)));
      if (token !== expandToken.current) return;
      const children: string[] = [];
      for (const entries of listings) for (const e of entries ?? []) {
        if (!e.isDirectory || e.isSymlink || (!prefsRef.current.showIgnored && e.ignored) || seen.has(e.path)) continue;
        seen.add(e.path);
        children.push(e.path);
        queue.push(e.path);
      }
      if (children.length) setExpanded(prev => new Set([...prev, ...children]));
    }
    if (token === expandToken.current) setExpanding(false);
  };

  // ── 打开 / 保存 ──────────────────────────────────────────────────────────

  // ── git 差异（0.7.0） ────────────────────────────────────────────────────

  /**
   * 取一个文件的变更内容。差异是「现算」的：主进程那边有 2s 的快照缓存，所以
   * 连点两次刷新不会把 git 跑两遍；这里只负责把加载态与失败文案接上。
   *
   * 失败不弹全局错误横幅——它只影响右侧这一块，树与编辑器都还能用。
   */
  const loadDiff = useCallback(
    async (path: string) => {
      const token = ++diffTokenRef.current;
      setDiff(prev => prev?.path === path && prev.status === 'ready' ? prev : { path, status: 'loading' });
      try {
        const response = await invoke<GitDiffResponse>(channels.gitDiff, { path });
        if (token !== diffTokenRef.current) return;
        if (!response.ok) {
          setDiff({ path, status: "error", message: failureMessage(response, t) });
          return;
        }
        setDiff({ path, status: "ready", response });
      } catch (cause) {
        if (token !== diffTokenRef.current) return;
        setDiff({ path, status: "error", message: String((cause as Error).message) });
      }
    },
    [t],
  );

  loadDiffRef.current = loadDiff;

  /** 打开某个文件的变更视图（工具栏的「变更」按钮 / 右键的「查看变更」）。 */
  const openDiff = useCallback(
    (path: string) => {
      // 项目外文件（宿主请求打开的会话临时文件 / 附件）不在任何仓库里，没有变更。
      if (!path || isExternalPath(path)) return;
      void loadDiff(path);
    },
    [loadDiff],
  );

  const closeDiff = useCallback(() => {
    diffTokenRef.current += 1;
    setDiff(null);
  }, []);

  /**
   * 打开一个路径。只要 path：宿主请求打开的可能是项目之外的绝对路径（会话
   * 临时目录 / 附件），它没有对应的树条目。
   */
  const captureTab = useCallback(() => {
    const tab = documents.active;
    if (tab?.file.kind === 'text' && handleRef.current) tab.editor = handleRef.current.capture();
  }, [documents]);

  const openEntry = useCallback(
    async (entry: { path: string }, fromWatch = false, reload = false) => {
      if (!fromWatch) { setShowPreview(false); setInspectedCommit(null); }
      const token = fromWatch ? openTokenRef.current : ++openTokenRef.current;
      const readToken = ++watchReadToken.current;
      const current = () => token === openTokenRef.current && (!fromWatch || (readToken === watchReadToken.current && documents.active?.file.path === entry.path));
      // 项目外路径不在树里：选中态置空，免得高亮到一条无关的行。
      const external = isExternalPath(entry.path);
      if (!fromWatch) { setSelected(external ? null : entry.path); setError(null); }
      const cached = documents.get(entry.path);
      if (!fromWatch) setOpeningPath(!cached ? entry.path : null);
      if (!fromWatch && !reload && cached) {
        if (documents.active !== cached) { captureTab(); documents.activate(entry.path); closeDiff(); }
        const disk = dirsRef.current.get(parentOf(entry.path))?.entries?.find(e => e.path === entry.path);
        if (disk && disk.mtimeMs > cached.file.mtimeMs + 0.5) documents.patch(entry.path, { changed: true });
        if (!cached.changed || cached.dirty) return;
      }
      try {
        const request: ReadRequest = external
          ? { path: entry.path, external: true }
          : { path: entry.path };
        const response = await invoke<ReadResponse | Failure>(channels.read, { ...request, workspacePath: workspaceRef.current?.path });
        if (!current()) return;
        if ((fromWatch || cached?.changed) && !reload && documents.get(entry.path)?.dirty) { documents.patch(entry.path, { changed: true }); return; }
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        loadTokenRef.current += 1;
        if (documents.active?.file.path !== entry.path) captureTab();
        const file = toOpenFile(response, loadTokenRef.current);
        documents.load(file);
        const mode = resolveViewer(file.path, prefsRef.current)?.mode;
        if (mode && !documents.active?.mode) documents.patch(file.path, { mode });
        // 换文件就收起上一个文件的差异视图（它占着整个右侧）；重新加载同一个文件
        // 则要按新内容重取——它此刻多半正开着。
        if (diffPathRef.current === entry.path) {
          loadDiffRef.current(entry.path);
        } else {
          setDiff(null);
        }
      } catch (cause) {
        if (!current()) return;
        setError(String((cause as Error).message));
      } finally {
        if (!fromWatch && current()) setOpeningPath(null);
      }
    },
    [captureTab, closeDiff, documents, t],
  );


  useTreeWatch(!remoteReadOnly && prefs.watchFiles ? activeRoot?.path ?? null : null, {
    visible: () => prefs.treeCollapsed ? [] : ["", ...[...expanded].filter(dir => ancestorPaths(dir).every(parent => expanded.has(parent)))],
    refresh: dir => loadDirectory(dir, true),
    onPaths: (paths, stale) => documents.noteChanges(paths, stale),
    document: () => ({ openPath: openPathRef.current, dirty: dirtyRef.current }),
    onDocument: (path, warn) => {
      if (isExternalPath(path)) return;
      documents.patch(path, { changed: true });
      if (!warn) void openEntry({ path }, true);
    },
    onAvailable: setWatchAvailable,
  });

  const withGuard = useCallback(
    (action: () => void, all = false) => {
      const targets = all ? documents.tabs.filter(tab => tab.dirty) : documents.active?.dirty ? [documents.active] : [];
      if (!targets.length) {
        action();
        return;
      }
      pendingRef.current = action;
      const paths = targets.map(tab => tab.file.path);
      setGuard({ body: t("dirtyPromptBody", { name: paths.join(', ') }), paths });
    },
    [documents, t],
  );

  const requestOpen = useCallback(
    (entry: FileEntry) => { void openEntry(entry); },
    [openEntry],
  );

  const closeTab = (path: string) => {
    const tab = documents.get(path);
    if (!tab || saving) return;
    const close = () => {
      const wasActive = documents.active === tab;
      ++openTokenRef.current;
      setOpeningPath(null);
      documents.remove(path);
      if (wasActive) {
        closeDiff(); setError(null);
        const next = documents.active?.file.path;
        setSelected(next && !isExternalPath(next) ? next : null);
        if (next && documents.active?.changed && !documents.active.dirty) void openEntry({ path: next });
      }
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.fm-document-tabs [aria-selected="true"]')?.focus({ preventScroll: true }));
    };
    if (!tab.dirty) { close(); return; }
    pendingRef.current = close;
    setGuard({ body: t('closeDirtyFile', { name: path }), paths: [path] });
  };

  const persistPrefs = useCallback((partial: Partial<Prefs>) => {
    setPrefs((prev) => ({ ...prev, ...partial }));
    void invoke(channels.prefsSet, { partial }).catch(() => {});
  }, []);

  // ── 项目组：切换正在浏览的 folder root ───────────────────────────────────

  /**
   * 换基点。落盘必须**等它写完**再往下走：包含基点是从 prefs.projectRoots 推导出
   * 来的（main.js 的 selectedRootOf），写没到，下一个通道请求就会按旧基点解析。
   * 落盘失败就什么都不换——宁可让这次切换失败，也不能让树和包含基点各说各话。
   */
  const activateRoot = useCallback(
    async (target: WorkspaceRoot): Promise<boolean> => {
      const workspace = rootRef.current;
      if (!workspace) return false;
      const revision = revisionRef.current;
      const memory = rememberProjectRoot(
        prefsRef.current.projectRoots,
        projectKeyOf(workspace),
        target.path,
      );
      const response = await invoke<PrefsResponse>(channels.prefsSet, {
        partial: { projectRoots: memory },
      }).catch(() => null);
      if (revision !== revisionRef.current) return false;
      if (!response || !response.ok) {
        setError(tRef.current("switchFailed"));
        return false;
      }
      setPrefs((prev) => ({ ...prev, projectRoots: memory }));
      resetExplorer();
      await loadRef.current("", true);
      return true;
    },
    [resetExplorer],
  );

  /** 切换器里点了一个 folder：照旧先过脏缓冲守卫，取消就什么都不改。 */
  const switchRoot = (target: WorkspaceRoot) => {
    if (!activeRoot || samePath(activeRoot.path, target.path)) return;
    withGuard(() => void activateRoot(target), true);
  };

  /** 菜单锚在控件下方；ContextMenu 自己会按视口夹取，靠边也不会跑出去。 */
  const openRootMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (armedRef.current) {
      armedRef.current = false;
      setRootMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setRootMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  /** 关菜单，并把手柄交回按钮——Escape 之后键盘还能接着用。 */
  const closeRootMenu = () => {
    armedRef.current = false;
    setRootMenu(null);
    rootButtonRef.current?.focus();
  };

  /** 组的文件夹列表：主根标出「主文件夹」，当前在看的那个打勾。 */
  const rootMenuEntries = (): MenuEntry[] =>
    roots.map((entry) => ({
      kind: "item",
      label: entry.name,
      hint: entry.primary ? t("primaryRoot") : undefined,
      icon: activeRoot && samePath(entry.path, activeRoot.path) ? <CheckGlyph /> : undefined,
      onPick: () => switchRoot(entry),
    }));

  /**
   * 宿主要求打开的文件：两条投递路径（入口查询串 / view:open 推送）最终都落到
   * 这里。三种路径形态各有各的基准（0.5.0）：
   *   项目内相对路径 → 基准是**主根**；当前看的不是主根就先切回主根再打开。
   *   组内绝对路径   → 切到包含它的那个 root，再按「相对那个 root」打开（祖先
   *                    目录照旧展开、行照旧高亮，与点击搜索结果一致）。
   *   组外绝对路径   → 0.4.0 的外部行为：不进树、不高亮、基点不动。
   * 换基点必须先落盘（见 activateRoot）——包含基点由 prefs.projectRoots 推导。
   * 视觉结果与在树里点这个文件一致，因此复用 openEntry 与它的脏缓冲守卫；宿主
   * 请求一律把左侧列表收起并持久化，用户之后重新展开会一直保持到下一次宿主请求。
   */
  const applyHostOpen = useCallback(
    (request: HostOpenRequest) => {
      const requestedWorkspace = workspaceKey(workspaceRef.current);
      setGitOpen(false);
      setInspectedCommit(null);
      setShowPreview(false);
      const rawPath = request.path;
      const absolute = isExternalPath(rawPath);
      // 组的 root 列表还没到手时（ready 之前）这个请求会被排队，见下面 ready 的 effect。
      const contained = absolute ? findRootForPath(roots, rawPath) : null;
      const base = contained ? contained.root : absolute ? null : primaryRootOf(roots);
      const relPath = contained ? contained.rel : rawPath;

      persistPrefs({ treeCollapsed: true });

      const show = () => {
        if (workspaceKey(workspaceRef.current) !== requestedWorkspace) return;
        const revision = revisionRef.current;
        // 已经是这个文件：不重装文档，也就不必为脏缓冲再问一遍。
        if (relPath === openPathRef.current) return;
        // 组外的绝对路径不在树里：不展开、也不高亮（openEntry 会把选中态置空）。
        if (!contained && absolute) {
          void openEntry({ path: relPath });
          return;
        }
        // 项目内路径：展开并加载祖先目录，与搜索命中的跳转是同一套做法。
        const parents = ancestorPaths(relPath);
        setSelected(relPath);
        setExpanded((prev) => new Set([...prev, ...parents]));
        void (async () => {
          for (const parent of parents) {
            if (revision !== revisionRef.current) return;
            await loadDirectory(parent);
          }
          if (revision !== revisionRef.current) return;
          await openEntry({ path: relPath });
        })();
      };

      // 基点没变（也包括「没有项目」与组外路径）：直接开，脏缓冲守卫照旧。
      if (!base || samePath(activeRootRef.current?.path ?? "", base.path)) {
        show();
        return;
      }
      // 要先换基点：换成功再打开；守卫被取消的话基点也不动。
      withGuard(() => {
        void activateRoot(base).then((ok) => {
          if (ok) show();
        });
      }, true);
    },
    [activateRoot, loadDirectory, openEntry, persistPrefs, roots, withGuard],
  );

  hostOpenRef.current = applyHostOpen;

  const save = useCallback(
    async (override?: { mtimeMs: number; size: number }, path = documents.active?.file.path): Promise<boolean> => {
      const tab = path ? documents.get(path) : undefined;
      if (!tab || tab.file.kind !== 'text' || tab.file.readOnly) return false;
      // 没有改动就不写盘：Ctrl+S 是习惯动作，不该白抬一次 mtime、白记一行审计，
      // 更不该因为文件在别处被改过而弹出一个「冲突」。带 override 的是冲突框里的
      // 「覆盖」，那是显式意图，照写。
      if (!override && !tab.dirty) return false;
      if (inFlightRef.current) return inFlightRef.current.path === path ? inFlightRef.current.promise : false;
      const target = tab.file, revision = revisionRef.current;
      const tabText = () => documents.active === tab ? handleRef.current?.text() ?? target.text : tab.editor?.state.doc.toString() ?? target.text;
      const text = tabText();

      const run = (async (): Promise<boolean> => {
        setSaving(true);
        setError(null);
        try {
          const external = isExternalPath(target.path);
          const request: WriteRequest = {
            path: target.path,
            text,
            expectedMtimeMs: override?.mtimeMs ?? target.mtimeMs,
            expectedSize: override?.size ?? target.size,
            eol: target.eol,
            bom: target.bom,
            // 宿主请求打开的项目外文件：显式声明，主进程只查黑名单，不再要求
            // 路径落在项目根内。
            ...(external ? { external: true } : {}),
          };
          const response = await invoke<WriteResponse>(channels.write, { ...request, workspacePath: workspaceRef.current?.path, expectedRoot: activeRootRef.current?.path });

          // 写是成功了，但用户可能已经切走——那就只认这次写的成功，别把
          // 元数据、脏标记、冲突框落到另一个文件上。
          if (revisionRef.current !== revision || documents.get(target.path) !== tab) return false;

          if (response.ok) {
            // 只更新元数据（下一次乐观锁的期望值）与文本，loadToken 不动：
            // 编辑器里的文档就是刚存下去的那份，不该被重装。
            documents.patch(target.path, { file: withSavedContent(target, response, text), dirty: tabText() !== text, changed: false });
            // 项目外的文件没有对应的树目录要刷新。
            if (!external) void loadDirectory(parentOf(target.path), true);
            // 差异视图正开着这个文件时跟着重取：刚存下的内容就是最新的变更。
            if (diffPathRef.current === target.path) loadDiffRef.current(target.path);
            return !tab.dirty;
          }
          if (isConflict(response)) {
            setConflict({ path: target.path, mtimeMs: response.mtimeMs, size: response.size });
            return false;
          }
          setError(failureMessage(response, t));
          return false;
        } catch (cause) {
          if (openPathRef.current === target.path) setError(String((cause as Error).message));
          return false;
        } finally {
          setSaving(false);
        }
      })();

      inFlightRef.current = { path: target.path, promise: run };
      try {
        return await run;
      } finally {
        if (inFlightRef.current?.promise === run) inFlightRef.current = null;
      }
    },
    [loadDirectory, documents, t],
  );

  saveRef.current = save;

  // Ctrl/Cmd+S 在编辑器之外也得能用：点了工具栏按钮、或正停在预览 / 表格 / 树
  // 视图时，焦点不在 CodeMirror 里，编辑器自己的键位收不到这个键。编辑器内部的
  // 绑定保留——它先跑并 preventDefault，这里据此跳过，不会保存两次。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reloadFromDisk = useCallback(() => {
    if (!openFile) return;
    withGuard(() => void openEntry({ path: openFile.path }, false, true));
  }, [openEntry, openFile, withGuard]);

  // ── 搜索 ─────────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (needle: string) => {
    const token = ++searchTokenRef.current;
    if (!needle.trim()) {
      setSearch({ hits: [], running: false, done: true });
      return;
    }
    setSearch({ hits: [], running: true, done: false });

    let cursor: string | null = null;
    for (let round = 0; round < 60; round += 1) {
      let response: SearchResponse | Failure;
      try {
        response = await invoke<SearchResponse>(channels.search, {
          query: needle,
          cursor,
          limit: SEARCH_PAGE,
        });
      } catch {
        if (token !== searchTokenRef.current) return;
        setSearch({ hits: [], running: false, done: true });
        return;
      }
      if (token !== searchTokenRef.current) return;
      if (!response.ok) {
        setSearch({ hits: [], running: false, done: true });
        return;
      }
      cursor = response.nextCursor;
      const matches = response.matches;
      setSearch((prev) => ({
        hits: [...prev.hits, ...matches],
        running: !response.done,
        done: response.done,
      }));
      if (response.done) return;
    }
    setSearch((prev) => ({ ...prev, running: false, done: true }));
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      searchTokenRef.current += 1;
      setSearch({ hits: [], running: false, done: true });
      return;
    }
    searchTokenRef.current++;
    setSearch({ hits: [], running: true, done: false });
    const timer = window.setTimeout(() => void runSearch(query), 220);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  // ── 分割条 ───────────────────────────────────────────────────────────────

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const container = bodyRef.current;
    if (!container) return;
    let latest = prefs.splitRatio;

    const onMove = (move: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      latest = Math.min(Math.max((move.clientX - rect.left) / rect.width, 0.15), 0.7);
      setPrefs((prev) => ({ ...prev, splitRatio: latest }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistPrefs({ splitRatio: latest });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── 新建 / 重命名 / 移动 ─────────────────────────────────────────────────

  const onPromptSubmit = async (value: string) => {
    const active = prompt;
    setPrompt(null);
    if (!active) return;
    try {
      if (active.kind === "newFile" || active.kind === "newFolder") {
        const response = await invoke<{ ok: true } | Failure>(channels.create, {
          parent: active.parent,
          name: value,
          isDirectory: active.kind === "newFolder",
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        await loadDirectory(active.parent, true);
        if (active.parent) setExpanded((prev) => new Set(prev).add(active.parent));
      } else if (active.kind === "rename") {
        const response = await invoke<{ ok: true; entry: FileEntry } | Failure>(channels.rename, {
          path: active.entry.path,
          newName: value,
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        documents.move(active.entry.path, response.entry.path);
        await loadDirectory(parentOf(active.entry.path), true);
        setSelected((prev) => (prev === active.entry.path ? null : prev));
      }
    } catch (cause) {
      setError(String((cause as Error).message));
    }
  };
  const runDelete = useCallback(
    async (entry: FileEntry) => {
      const external = isExternalPath(entry.path);
      try {
        const response = await invoke<DeleteResponse | Failure>(channels.delete, {
          path: entry.path,
          // 项目外路径要显式声明：主进程只查黑名单，不再要求落在项目根内。
          ...(external ? { external: true } : {}),
        });
        if (!response.ok) {
          setError(failureMessage(response, t));
          return;
        }
        // 项目外路径没有树目录可刷新，也不参与选中态。
        if (!external) await loadDirectory(parentOf(entry.path), true);
        setSelected((prev) => (prev === entry.path ? null : prev));
        // 删的正是当前打开的文件：编辑器里那份内容已经没有对应的磁盘文件了。
        const within = (p: string) => p === entry.path || p.startsWith(entry.path + '/');
        for (const tab of documents.tabs) if (within(tab.file.path)) documents.remove(tab.file.path);
        if (diffPathRef.current && within(diffPathRef.current)) closeDiff();
      } catch (cause) {
        setError(String((cause as Error).message));
      }
    },
    [loadDirectory, t],
  );

  const moveEntry = async (entry: FileEntry, toDir: string) => {
    if (remoteReadOnly || inFlightRef.current) return;
    const revision = revisionRef.current;
    try {
      const result = await invoke<{ ok: true; entry: FileEntry | null } | Failure>(channels.move, {
        from: entry.path, toDir, workspacePath: workspaceRef.current?.path, expectedRoot: activeRoot?.path,
      });
      if (revision !== revisionRef.current) return;
      if (!result.ok) { setError(failureMessage(result, t)); return; }
      if (!result.entry) return;
      const dest = result.entry.path;
      const within = (path: string) => path === entry.path || path.startsWith(entry.path + "/");
      documents.move(entry.path, dest);
      if (diffPathRef.current && within(diffPathRef.current)) closeDiff();
      setSelected(dest);
      expandToken.current++;
      setExpanding(false);
      setExpanded(prev => new Set([...prev].filter(path => !within(path)).concat(ancestorPaths(dest))));
      setDirectories(prev => new Map([...prev].filter(([path]) => !within(path))));
      await Promise.all([loadDirectory(parentOf(entry.path), true), loadDirectory(toDir, true)]);
    } catch (cause) { if (revision === revisionRef.current) setError(String((cause as Error).message)); }
  };

  const openMenu = (event: React.MouseEvent, entry: FileEntry | null) => {
    if (entry) setSelected(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  /** 链接不导航：视图一旦离开插件页面就回不来了，而本插件也没申报
   *  shell.openExternal。所以点击的语义是把地址告诉用户。 */
  const onLink = useCallback(
    (url: string) => {
      void invoke("ui.showToast", { message: tRef.current("linkHint", { url }) }).catch(() => {});
    },
    [],
  );

  /**
   * 默认应用、内置 Browser 与文件夹显示由宿主执行，受 manifest.fs.read 范围约束。
   * 失败走 toast 而不是插件的错误横幅——这些动作与当前打开的文件无关。
   */
  const runHostAction = useCallback((action: "open" | "browser" | "reveal", path: string) => {
    const run = action === "open"
      ? openWithDefaultApp
      : action === "browser"
        ? openInBuiltInBrowser
        : revealInFileManager;
    void run(path).catch(() => {
      void invoke("ui.showToast", {
        message: tRef.current(
          action === "open" ? "openError" : action === "browser" ? "openInBuiltInBrowserError" : "revealError",
        ),
      }).catch(() => {});
    });
  }, []);

  /**
   * 复制一段路径到剪贴板。成功与失败都给 toast：这是「点了应该有反应」的动作，
   * 静默失败会让人以为系统剪贴板坏了。文案里带上复制的内容，方便自证。
   */
  const copyPath = useCallback(async (value: string) => {
    const ok = await copyText(value);
    void invoke("ui.showToast", {
      message: ok
        ? tRef.current("pathCopied", { path: value })
        : tRef.current("copyFailed"),
    }).catch(() => {});
  }, []);

  /**
   * 「通过…打开」：路径与编辑器 id 一起交给插件主进程，它按同一套根内包含与凭据
   * 黑名单解析路径，并且只认自己探测出来的编辑器 id。
   */
  const runOpenWith = useCallback((path: string, id: string) => {
    void openWithEditor(path, id).catch(() => {
      void invoke("ui.showToast", { message: tRef.current("openWithFailed") }).catch(() => {});
    });
  }, []);

  /**
   * 「通过…打开」二级菜单的内容。
   *
   * HTML、HTM、XHTML 且宿主支持时，内置 Browser 项排在最前并与外部程序分隔；
   * 后面固定是系统默认应用（走宿主的 fs.openDefault）和主进程探测到的程序，按
   * 条目过滤（lib/editors.ts）：编辑器什么都能打开，外部浏览器只对网页文件出现。
   * 拿 Chrome 打开 App.tsx 只会看到一个纯文本加载页，那是把噪音摆进菜单。
   *
   * 过滤后一个都不剩（例如 .ts 文件上只装了浏览器）时只留默认应用那一项，不摆点了
   * 没反应的条目。目录允许交给编辑器（编辑器自己决定是打开目录还是文件），但
   * 内置 Browser 与「系统默认应用」都只接受文件。
   */
  const openWithEntries = (target: FileEntry | null): MenuEntry[] => {
    if (!target) {
      return [{ kind: "item", label: t("openWithEmpty"), disabled: true, onPick: () => {} }];
    }
    const absolute = absoluteFullPath(target.path, activeRootRef.current);
    const items: MenuEntry[] = [
      {
        kind: "item",
        label: t("openWithDefault"),
        disabled: target.isDirectory,
        onPick: () => runHostAction("open", hostActionPath(target.path, activeRootRef.current)),
      },
    ];
    const applicable = editorsFor(editors, target);
    for (const editor of applicable) {
      items.push({
        kind: "item",
        label: editor.label,
        onPick: () => runOpenWith(absolute, editor.id),
      });
    }
    // 探到一个程序都没有 vs 探到了但对这个文件不适用：前者值得说一句「没找到」，
    // 后者只是这个文件没有额外选项，默认应用已经够用，不再多摆一行。
    if ((editors ?? []).length === 0) {
      items.push({ kind: "item", label: t("openWithEmpty"), disabled: true, onPick: () => {} });
    }
    return withBuiltInBrowserEntry(
      target,
      openHtmlInBrowserAvailable,
      t("openInBuiltInBrowser"),
      items,
      (entry) => runHostAction("browser", hostActionPath(entry.path, activeRootRef.current)),
    );
  };

  // 结构化视图（Markdown 预览 / 表格 / 树）只对文本文件成立；具体有哪几种、
  // 默认落在哪一侧，全部由 lib/viewers.ts 一处判定，偏好决定默认值。
  const viewer = openFile && openFile.kind === "text" ? resolveViewer(openFile.path, prefs) : null;
  if (viewer && documents.active?.mode && viewer.modes.includes(documents.active.mode)) viewer.mode = documents.active.mode;
  /**
   * 当前打开文件的 git 状态。fm.read 打开那一刻就带回来了（左侧列表收起时也只有
   * 这一条路）；打开之后才发生的改动——用户自己刚存过一次——由树里的徽标补上，
   * 否则「保存之后右侧的『变更』按钮凭空消失」。
   */
  const listedOpenFile = openFile && directories.get(parentOf(openFile.path))?.entries?.find(e => e.path === openFile.path);
  const openFileGit = listedOpenFile ? listedOpenFile.git ?? null : openFile ? (openFile.git ?? lookupGit(directories, openFile.path)) : null;

  const changeViewerMode = (mode: ViewerMode) => {
    if (!viewer) return;
    if (openFile) documents.patch(openFile.path, { mode });
    if (viewer.modes.includes("markdown")) persistPrefs({ mdPreview: mode === "markdown" });
    else if (viewer.modes.includes("table")) persistPrefs({ csvTable: mode === "table" });
    else if (viewer.modes.includes("tree")) persistPrefs({ jsonTree: mode === "tree" });
  };

  const menuEntries = (): MenuEntry[] => {
    const target = menu?.entry ?? null;
    return buildFileContextMenuEntries({
      readOnly: remoteReadOnly,
      target,
      labels: {
        newFile: t("newFile"),
        newFolder: t("newFolder"),
        rename: t("rename"),
        delete: t("delete"),
        copyPath: t("copyPath"),
        copyRelativePath: t("copyRelativePath"),
        copyAbsolutePath: t("copyAbsolutePath"),
        openWithSubmenu: t("openWithSubmenu"),
        viewChanges: t("viewChanges"),
        revealInFolder: t("revealInFolder"),
        refresh: t("refresh"),
      },
      openWithEntries: target ? openWithEntries(target) : [],
      onNewFile: (parent) => setPrompt({ kind: "newFile", parent }),
      onNewFolder: (parent) => setPrompt({ kind: "newFolder", parent }),
      onRename: (entry) => setPrompt({ kind: "rename", entry }),
      onDelete: (entry) => {
        setSelected(entry.path);
        setConfirmDelete({ entry });
      },
      onCopyRelativePath: (entry) => void copyPath(entry.path),
      onCopyAbsolutePath: (entry) =>
        void copyPath(absoluteFullPath(entry.path, root?.remote && activeRootRef.current
          ? { ...activeRootRef.current, path: root.remote.path } : activeRootRef.current)),
      onViewChanges: (entry) => {
        setMenu(null);
        void openEntry(entry).then(() => { if (documents.active?.file.path === entry.path) openDiff(entry.path); });
      },
      onRevealInFolder: (entry) =>
        runHostAction("reveal", hostActionPath(entry.path, activeRootRef.current)),
      onRefresh: (directory) => void loadDirectory(directory, true),
    });
  };

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  const searchActive = query.trim().length > 0;
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selectedTab = stripRef.current?.querySelector('[role="tab"][aria-selected="true"]');
    selectedTab?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [openFile?.path, showPreview, previewTab?.path]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <header
        className="flex min-h-[38px] flex-none flex-wrap items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        {/* 显示 / 隐藏文件列表：收起状态下这是重新展开的唯一入口，所以常驻 header 最左侧。 */}
        <IconButton
          label={prefs.treeCollapsed ? t("showTree") : t("hideTree")}
          active={!prefs.treeCollapsed}
          onClick={() => persistPrefs({ treeCollapsed: !prefs.treeCollapsed })}
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          {prefs.treeCollapsed ? <path d="m13 9 3 3-3 3" /> : <path d="m16 9-3 3 3 3" />}
        </IconButton>
        <span className="flex min-w-0 items-center gap-1.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--icon-folder)" }} aria-hidden="true">
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          {switchable ? (
            /* 组的文件夹多于一个：这个名字本身就是切换器。菜单复用 ContextMenu
               （Escape 与点到外面都会关、↑↓ / Home / End 可用），按钮自己提供
               aria-haspopup / aria-expanded 与可读名字。长名字靠 min-w-0 + truncate
               截断，右侧那几个工具按钮因此不会被挤走。
               只有一个 root（或老宿主不给组信息）时下面这条静态标签原样保留。 */
            <button
              ref={rootButtonRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={rootMenu !== null}
              aria-label={t("switchFolderNamed", { name: headerName, count: rootCount })}
              title={t("switchFolder")}
              onMouseDown={() => {
                // ContextMenu 把「按下」当点到外面，会先把菜单关掉；这里记下按之前
                // 的状态，好在随后那一下 click 里分清「开」与「再点一次要关」。
                armedRef.current = rootMenu !== null;
              }}
              onClick={openRootMenu}
              className="-mx-1 flex min-w-0 max-w-[18rem] items-center gap-1 rounded-lg border-0 bg-transparent px-1 py-0.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            >
              <span className="min-w-0 truncate">{headerName}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" style={{ color: "var(--faint)" }} aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          ) : (
            <span className="min-w-0 truncate text-[12.5px] font-medium">
              {root?.name ?? t("title")}
            </span>
          )}
        </span>

        {remoteReadOnly ? <span role="status" className="text-[10px]" style={{ color: "var(--muted)" }}>{t("remoteReadOnly")}</span> : null}

        <span className="ml-auto flex max-w-full flex-wrap items-center gap-1">
          <IconButton label={t("refresh")} onClick={() => { refreshTree(); if (gitOpen) setGitRefresh(n => n + 1); }}>
            <path d="M20 11a8 8 0 0 0-14.9-3.9L3 9" />
            <path d="M3 4v5h5" />
            <path d="M4 13a8 8 0 0 0 14.9 3.9L21 15" />
            <path d="M21 20v-5h-5" />
          </IconButton>
          <IconButton
            label={prefs.showIgnored ? t("hideIgnored") : t("showIgnored")}
            active={prefs.showIgnored}
            disabled={remoteReadOnly}
            onClick={() => persistPrefs({ showIgnored: !prefs.showIgnored })}
          >
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </IconButton>
          <IconButton
            label={remoteReadOnly ? t("remoteReadOnly") : !watchAvailable && prefs.watchFiles ? t("watchFallback") : prefs.watchFiles ? t("watchOn") : t("watchOff")}
            active={prefs.watchFiles && !remoteReadOnly}
            disabled={remoteReadOnly}
            onClick={() => persistPrefs({ watchFiles: !prefs.watchFiles })}
          >
            <path d="M4.5 11a7.5 7.5 0 1 1 1.8 6M4 6v5h5M12 8v4l3 2" />
          </IconButton>
        </span>
      </header>

      <div ref={bodyRef} className="flex min-h-0 flex-1">
            <aside
              className={prefs.treeCollapsed ? "hidden" : "flex min-h-0 min-w-0 flex-col"}
              style={{ width: `${prefs.splitRatio * 100}%`, background: "var(--surface)" }}
            >
              {root && activeRoot && <div className={gitOpen ? "min-h-0 flex-1" : "hidden"} role="tabpanel" aria-label={t("gitChangesPanel")}>
                {remoteReadOnly ? <p className="scm-guide">{t("remoteReadOnly")}</p> : <>
                <GitPanel locale={hostLocale} workspacePath={root.path} rootPath={activeRoot.path} projectId={root.projectId}
                  active={gitOpen && !prefs.treeCollapsed} refreshKey={gitRefresh} selection={previewTab}
                  onInspect={commit => { setInspectedCommit(commit); setPreviewTab(null); }}
                  onSelect={(item, revision) => { setInspectedCommit(null); setPreviewTab({ ...item, revision }); setShowPreview(true); }}
                  onSnapshot={(entries, revision) => setPreviewTab(prev => {
                    if (!prev) return null;
                    const e = entries.find(e => e.path === prev.path);
                    if (!e) return null;
                    const staged = e.index !== "?" && e.index !== " ";
                    const scope = (prev.scope === "staged" && staged) || e.worktree === " " ? "staged" : "worktree";
                    return { path: prev.path, scope, revision };
                  })} onChanged={() => { refreshTree(); if (diff) void loadDiff(diff.path); }} />
                </>}
              </div>}
              <div className={gitOpen ? "hidden" : "flex min-h-0 flex-1 flex-col"} role="tabpanel" aria-label={t("treeSection")}>
              <div className="flex flex-none items-center gap-1.5 px-2.5 pb-1.5 pt-2">
                <div className="relative flex min-w-0 flex-1 items-center">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--faint)", position: "absolute", left: 7 }} aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    value={query}
                    disabled={remoteReadOnly}
                    title={remoteReadOnly ? t("remoteReadOnly") : undefined}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("searchPlaceholder")}
                    aria-label={t("search")}
                    className="w-full rounded-md border py-1 pl-6 pr-6 text-[11.5px] outline-none"
                    style={{ borderColor: "var(--border-strong)", background: "var(--bg)", color: "var(--fg)" }}
                  />
                  {query ? (
                    <button
                      type="button"
                      aria-label={t("clear")}
                      onClick={() => setQuery("")}
                      className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent"
                      style={{ color: "var(--faint)" }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <IconButton label={t("expandAll")} small disabled={searchActive || expanding} onClick={() => void expandAll()}>
                  <path d="m8 8 4-4 4 4M8 16l4 4 4-4" />
                </IconButton>
                <IconButton label={t("collapseAll")} small disabled={searchActive || (!expanding && !expanded.size)} onClick={collapseAll}>
                  <path d="m8 4 4 4 4-4M8 20l4-4 4 4" />
                </IconButton>
              </div>

              {/* 搜索时这行是命中数；平时是 git 概览（分支 + 各类变化的文件数），
                  也就是「这个工作区现在脏不脏、脏在哪」的一句话。 */}
              <div className="flex flex-none items-center justify-between gap-2 px-3 pb-1 text-[10.5px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                <span className="min-w-0 truncate normal-case">
                  {searchActive ? t("search") : (gitSummaryText(gitSummary, t) ?? t("treeSection"))}
                </span>
                <span className="tabular-nums" style={{ color: "var(--faint)" }}>
                  {searchActive
                    ? search.running
                      ? t("searchScanning")
                      : String(search.hits.length)
                    : ""}
                </span>
              </div>

              {searchActive ? (
                <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4" role="listbox" aria-label={t("search")}>
                  {search.running && !search.hits.length && <Skeleton kind="list" label={t('searchScanning')} />}
                  {search.hits.length === 0 && !search.running ? (
                    <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
                      {t("searchEmpty")}
                    </div>
                  ) : null}
                  {search.hits.map((hit) => (
                    <button
                      key={hit.path}
                      type="button"
                      role="option"
                      aria-selected={selected === hit.path}
                      title={hit.path}
                      onClick={() => {
                        const path = hit.path;
                          setQuery("");
                          const segments = path.split("/");
                          const parents: string[] = [];
                          for (let index = 1; index < segments.length; index += 1) {
                            parents.push(segments.slice(0, index).join("/"));
                          }
                          setExpanded((prev) => new Set([...prev, ...parents]));
                          if (hit.isDirectory) {
                            void loadDirectory(path, true).then(() => setSelected(path));
                            void (async () => {
                              for (const parent of parents) await loadDirectory(parent);
                            })();
                          } else {
                            setSelected(path);
                            void (async () => {
                              for (const parent of parents) await loadDirectory(parent);
                              await openEntry({ path, name: hit.name, isDirectory: false } as FileEntry);
                            })();
                          }
                      }}
                      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 px-2 py-[3px] text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
                      style={{ color: "var(--secondary)", minHeight: 24 }}
                    >
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {hit.name}
                      </span>
                      <span className="flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[10px]" style={{ color: "var(--faint)", maxWidth: "45%" }} dir="rtl">
                        {parentOf(hit.path)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Tree
                  key={activeRoot?.path}
                  onMove={remoteReadOnly || saving ? undefined : moveEntry}
                  onComposerFileDrag={!remoteReadOnly && root && activeRoot && window.pluginBridge?.startComposerFileDrag
                    ? (entry) => window.pluginBridge?.startComposerFileDrag?.({
                      workspace: root.path,
                      path: absoluteFullPath(entry.path, activeRoot),
                    }) ?? false
                    : undefined}
                  directories={directories}
                  expanded={expanded}
                  selected={selected}
                  showIgnored={prefs.showIgnored}
                  t={t}
                  onToggle={toggleDirectory}
                  onOpen={requestOpen}
                  onRefreshDir={(path) => void loadDirectory(path, true)}
                  onContextMenu={openMenu}
                />
              )}

              {prefs.showIgnored || !ignoreActive ? null : (
                <div className="flex-none px-3 pb-2 text-[10.5px]" style={{ color: "var(--faint)" }}>
                  {t("ignoredHidden")}
                </div>
              )}
              </div>
            </aside>

            {!prefs.treeCollapsed && <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize"
              onMouseDown={startResize}
              className="w-[3px] flex-none cursor-col-resize transition-colors hover:bg-[var(--surface-hover)]"
              style={{ background: "var(--border)" }}
            />}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {(openFile || previewTab || inspectedCommit) && <div ref={stripRef} role="tablist" aria-label={t('openDocuments')} className="fm-document-tabs">
            {documents.tabs.map(({ file, dirty: modified }) => {
              const name = baseNameOf(file.path);
              const duplicate = documents.tabs.some(other => other.file.path !== file.path && baseNameOf(other.file.path) === name);
              const label = duplicate ? `${name} — ${parentOf(file.path) || '.'}` : name;
              const active = file.path === openFile?.path && !inspectedCommit && !(previewTab && showPreview);
              return <div className="fm-file-tab" key={file.path} data-active={active}>
                <PaneTab label={label} title={file.path} accessible={label + (modified ? ' •' : '')} dirty={modified}
                  icon={<FileIcon name={name} isDirectory={false} size={13} />} active={active} onClick={() => void openEntry({ path: file.path })} />
                <button type="button" className="fm-tab-close" title={`${t('close')} ${file.path}`} aria-label={`${t('close')} ${file.path}`} disabled={saving} onClick={() => closeTab(file.path)}>×</button>
              </div>;
            })}
            {previewTab && <div className="fm-preview-tab" data-active={showPreview || !openFile}>
              <PaneTab label={baseNameOf(previewTab.path)} title={`${previewTab.path} · ${t(previewTab.scope === "staged" ? "gitScopeStaged" : "gitScopeWorktree")}`}
                accessible={`${baseNameOf(previewTab.path)} · ${t(previewTab.scope === "staged" ? "gitScopeStaged" : "gitScopeWorktree")}`}
                detail={t(previewTab.scope === "staged" ? "indexTab" : "workingTab")} active={showPreview || !openFile} onClick={() => setShowPreview(true)} />
              <button type="button" className="fm-tab-close" title={t("closeChanges")} aria-label={t("closeChanges")} onClick={() => setPreviewTab(null)}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>}
          </div>}
          {inspectedCommit && root && activeRoot && <section className="flex min-h-0 flex-1 flex-col" aria-label={inspectedCommit.subject}>
            <header className="scm-actions"><span title={inspectedCommit.oid}>{inspectedCommit.oid.slice(0, 8)} · {inspectedCommit.subject}</span><IconButton small label={t('close')} onClick={() => setInspectedCommit(null)}><path d="m6 6 12 12M18 6 6 18" /></IconButton></header>
            <div className="min-h-0 flex-1"><GitCommitDetail oid={inspectedCommit.oid} locale={hostLocale} workspacePath={root.path} projectId={root.projectId} rootPath={activeRoot.path} /></div>
          </section>}
          {previewTab && (showPreview || !openFile) && root && activeRoot && <div role="tabpanel" aria-label={previewTab.path} className="min-h-0 flex-1">
            <GitPreview key={JSON.stringify([activeRoot.path, previewTab.path, previewTab.scope])} tab={previewTab} workspacePath={root.path} rootPath={activeRoot.path} projectId={root.projectId} t={t}
              onClose={() => setPreviewTab(null)} onRefresh={() => setGitRefresh(n => n + 1)} />
          </div>}
          {openingPath && !inspectedCommit && !showPreview && <section aria-busy="true" aria-label={openingPath} className="min-h-0 flex-1 overflow-hidden">
            <Skeleton kind={/\.pdf$/i.test(openingPath) ? 'page' : /\.(?:csv|tsv|xlsx|db|sqlite)$/i.test(openingPath) ? 'table' : 'lines'} label={`${t('loading')} ${baseNameOf(openingPath)}`} />
          </section>}
          <div className={openingPath || inspectedCommit || (previewTab && (showPreview || !openFile)) ? "hidden" : "flex min-h-0 flex-1"}>
        <EditorPane
          file={openFile}
          base={base}
          locale={hostLocale}
          dirty={dirty}
          saving={saving}
          error={error}
          activeRoot={root?.remote && activeRoot ? { ...activeRoot, path: root.remote.path } : activeRoot}
          workspacePath={root?.path}
          git={openFileGit}
          viewer={viewer}
          tablePageSize={prefs.tablePageSize}
          t={t}
          handleRef={handleRef}
          restore={documents.active?.editor}
          onDirty={() => { if (openFile && !documents.get(openFile.path)?.dirty) documents.patch(openFile.path, { dirty: true }); }}
          onSave={() => void save()}
          onReload={reloadFromDisk}
          onViewerMode={changeViewerMode}
          onTablePageSize={(size) => persistPrefs({ tablePageSize: size })}
          onLink={onLink}
          // 有未保存改动时，监听只提示不覆盖（见 applyWatchChanges 的注释）。
          externalChange={externalChange}
          diff={diff}
          onOpenDiff={() => openFile && openDiff(openFile.path)}
          onCloseDiff={closeDiff}
          onRefreshDiff={() => diff && loadDiffRef.current(diff.path)}
        />
          </div>
        </div>
      </div>
      <div role="tablist" aria-label={t("projectFiles")} className="fm-activity-bar fm-list-switch">
        <PaneTab label="" accessible={t("treeSection")} title={t("treeSection")} active={!gitOpen} icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h6l2 2h10v12H3z"/><path d="M5 4h6l2 2h6"/></svg>}
          onClick={() => { setGitOpen(false); setShowPreview(false); setInspectedCommit(null); persistPrefs({ treeCollapsed: false }); }} />
        <PaneTab label="" accessible={t("gitChangesPanel")} title={t("gitChangesPanel")} active={gitOpen} icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="4" r="1.6"/><path d="M4 5v6m0-1c5 0 8-1 8-4"/></svg>}
          onClick={() => { setGitOpen(true); persistPrefs({ treeCollapsed: false }); }} />
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />
      ) : null}

      {/* 组的文件夹菜单：只有一个 root（或老宿主不给组信息）时它根本不会被打开。 */}
      {rootMenu ? (
        <ContextMenu
          x={rootMenu.x}
          y={rootMenu.y}
          entries={rootMenuEntries()}
          onClose={closeRootMenu}
        />
      ) : null}

      {ready && !root ? (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "var(--bg)" }}>
          <div className="max-w-[32ch] text-center">
            <div className="mb-1 text-[15px] font-medium" style={{ color: "var(--fg)" }}>
              {t("noWorkspaceTitle")}
            </div>
            <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {t("noWorkspaceCopy")}
            </div>
          </div>
        </div>
      ) : null}

      {guard ? (
        <ConfirmDialog
          title={t("dirtyPromptTitle")}
          body={guard.body}
          actions={[
            {
              label: t("cancel"),
              onPick: () => {
                pendingRef.current = null;
                setGuard(null);
              },
            },
            {
              label: t("discardAndSwitch"),
              variant: "danger",
              onPick: () => {
                const next = pendingRef.current;
                pendingRef.current = null;
                setGuard(null);
                // Discard only as part of the requested close, reload or workspace reset.
                next?.();
              },
            },
            {
              label: t("saveAndSwitch"),
              variant: "primary",
              onPick: () => {
                const next = pendingRef.current;
                pendingRef.current = null;
                const paths = guard.paths;
                void (async () => {
                  for (const path of paths) if (documents.get(path)?.dirty && !await save(undefined, path)) { setGuard(null); return; }
                  setGuard(null); next?.();
                })();
              },
            },
          ]}
        />
      ) : null}

      {conflict ? (
        <ConfirmDialog
          title={t("conflictTitle")}
          body={t("conflictBody", { name: conflict.path })}
          actions={[
            { label: t("cancel"), onPick: () => setConflict(null) },
            {
              label: t("discardAndSwitch"),
              variant: "danger",
              onPick: () => {
                setConflict(null);
                void openEntry({ path: conflict.path }, false, true);
              },
            },
            {
              label: t("overwrite"),
              variant: "primary",
              onPick: () => {
                const current = conflict;
                setConflict(null);
                void save({ mtimeMs: current.mtimeMs, size: current.size }, current.path);
              },
            },
          ]}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteTitle")}
          body={t(confirmDelete.entry.isDirectory ? "deleteBodyDir" : "deleteBodyFile", {
            name: confirmDelete.entry.name,
          })}
          actions={[
            { label: t("cancel"), onPick: () => setConfirmDelete(null) },
            {
              label: t("delete"),
              variant: "danger",
              onPick: () => {
                // 先把状态摘出来再清空：onPick 里 confirmDelete 已经是闭包里的旧值。
                const current = confirmDelete.entry;
                setConfirmDelete(null);
                void runDelete(current);
              },
            },
          ]}
        />
      ) : null}

      {prompt ? (
        <PromptDialog
          title={t(prompt.kind === "rename" ? "renameTitle" : prompt.kind === "newFile" ? "newFileTitle" : "newFolderTitle")}
          hint={prompt.kind === "rename" ? t("renameFrom", { path: prompt.entry.path }) : t("createIn", { path: prompt.parent || "." })}
          label={t("nameLabel")}
          initialValue={prompt.kind === "rename" ? prompt.entry.name : ""}
          confirmLabel={t(prompt.kind === "rename" ? "confirm" : "create")}
          t={t}
          onCancel={() => setPrompt(null)}
          onSubmit={(value) => void onPromptSubmit(value)}
        />
      ) : null}
    </div>
  );
}

function PaneTab({ label, title, active, onClick, accessible, detail, dirty, icon }: {
  label: string; title?: string; active: boolean; onClick: () => void; accessible?: string;
  detail?: string; dirty?: boolean; icon?: React.ReactNode;
}) {
  return <button type="button" role="tab" aria-selected={active} aria-label={accessible ?? label} tabIndex={active ? 0 : -1}
    title={title ?? label} className="fm-tab" onClick={onClick} onKeyDown={event => {
      const list = event.currentTarget.closest('[role="tablist"]');
      if (!list || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index = tabs.indexOf(event.currentTarget);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); tabs[next].focus(); tabs[next].click();
    }}>
    {icon}<span className="fm-tab-name">{label}</span>{dirty && <span className="fm-dirty-dot" aria-hidden="true" />}
    {detail && <span className="fm-tab-detail">{detail}</span>}
  </button>;
}


/** 菜单里的「当前就在看这个」：与树里的展开箭头同一套线条风格。 */
function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}
