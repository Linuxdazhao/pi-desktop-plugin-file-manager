import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "./bridge";
import type { DiffSection, Failure, GitStatusKind, RepoContext } from "./rpc";

export type GitScope = DiffSection["scope"];
export type GitSelection = { path: string; scope: GitScope };
export type GitChange = { path: string; index: string; worktree: string; status: GitStatusKind };
export type GitSnapshot = {
  ok: true; entries: GitChange[]; branch: string; revision: string; blocked: boolean; hidden: boolean;
  branches: string[]; branchesTruncated: boolean;
};
export type SyncInfo = {
  ok: true; state: "missing" | "plain" | "repository"; branch: string; remotes: string[];
  hasHead?: boolean; upstream?: string; defaultRemote?: string; pushRemote?: string;
  forceLease?: { remote: string; branch: string; expectedOid: string; token: string };
  ahead?: number; behind?: number;
};
export type SyncAction = "fetch" | "pull" | "pullRebase" | "push" | "forcePush";
export type SyncRequest = { action: SyncAction; branch?: string; remote?: string; leaseToken?: string };
type IndexAction = "stage" | "unstage" | "stageAll" | "unstageAll" | "commit";
type Operation = "init" | "sync" | IndexAction;

type ReadResult<T> = { context: RepoContext; version: number; result: T | Failure };
const bridgeFailure = (cause: unknown): Failure => ({
  ok: false, code: "BRIDGE", message: cause instanceof Error ? cause.message : String(cause),
});
export const isStaged = (entry: GitChange) => entry.index !== " " && entry.index !== "?";
export function scopeFor(entry: GitChange | undefined, preferred: GitScope): GitScope {
  if (!entry) return preferred;
  if (preferred === "staged" && isStaged(entry)) return preferred;
  return entry.worktree !== " " ? "worktree" : "staged";
}

/** At most one read per repository and channel is in flight. A newer version
 * waits for it, and only the last live effect requests the newest version. */
function useGitRead<T extends { ok: true }>(context: RepoContext | null, enabled: boolean, version: number, channel: string) {
  const [reply, setReply] = useState<ReadResult<T>>();
  const inFlight = useRef(new WeakMap<RepoContext, { version: number; promise: Promise<T | Failure> }>());
  useEffect(() => {
    if (!context || !enabled || (reply?.context === context && reply.version === version)) return;
    let live = true;
    const pending = inFlight.current;
    void (async () => {
      let read = pending.get(context);
      while (read && read.version !== version) {
        await read.promise;
        if (!live) return;
        read = pending.get(context);
      }
      if (!read) {
        const promise = invoke<T | Failure>(channel, context).catch(bridgeFailure).finally(() => pending.delete(context));
        read = { version, promise };
        pending.set(context, read);
      }
      const result = await read.promise;
      if (live) setReply({ context, version, result });
    })();
    return () => { live = false; };
  }, [context, enabled, version, channel, reply]);
  return reply?.context === context ? reply : undefined;
}
/** A workspace owns requests, not the currently visible sidebar. Writes finish
 * across view switches; replies from a previous folder never change this UI. */
export function useGitWorkspace(context: RepoContext | null, needChanges: boolean, onChanged: (operation: Operation) => void) {
  const [version, setVersion] = useState(0);
  const [refsVersion, setRefsVersion] = useState(0);
  const [draft, setDraft] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [outcome, setOutcome] = useState<{ operation: Operation; error?: Failure } | null>(null);
  const current = useRef(context);
  const task = useRef<symbol | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useLayoutEffect(() => {
    current.current = context;
    setDraft(""); setOperation(null); setOutcome(null);
    return () => { current.current = null; task.current = null; };
  }, [context]);

  const probe = useGitRead<SyncInfo>(context, !operation, refsVersion, "fm.git.syncInfo");
  const infoResult = probe?.result;
  const info = infoResult?.ok ? infoResult : null;
  const infoError = infoResult && !infoResult.ok ? infoResult : null;
  const infoReady = probe?.version === refsVersion;
  // An unsupported remote configuration does not take away ordinary local Git actions.
  const mayReadChanges = info?.state === "repository" || infoError?.code === "GIT_CONFIG" || infoError?.code === "GIT_LAYOUT";
  const changes = useGitRead<GitSnapshot>(context, needChanges && infoReady && mayReadChanges && !operation, version, "fm.git.changes");
  const changesResult = mayReadChanges ? changes?.result : undefined;
  const snapshot = changesResult?.ok ? changesResult : null;
  const changesReady = mayReadChanges && changes?.version === version;
  const changesError = changesReady && changesResult && !changesResult.ok ? changesResult : null;
  const refreshChanges = useCallback(() => setVersion(n => n + 1), []);
  const refresh = useCallback(() => { setRefsVersion(n => n + 1); refreshChanges(); }, [refreshChanges]);
  // Only refs/network operations affect upstream state, not edits or staging.
  const invalidateOperation = (kind: Operation) => {
    if (kind === "init" || kind === "sync" || kind === "commit") refresh();
    else refreshChanges();
  };

  // A terminal can change refs/config without a worktree event. Re-probe on
  // return to the panel, even when Explorer (or no sidebar) is selected.
  useEffect(() => {
    if (!context) return;
    const resume = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [context, refresh]);

  async function run(kind: Operation, channel: string, payload: object) {
    if (!context || current.current !== context || task.current) return;
    const id = Symbol();
    task.current = id;
    setOperation(kind); setOutcome(null);
    const stillCurrent = () => current.current === context && task.current === id;
    try {
      const result = await invoke<{ ok: true } | Failure>(channel, { ...context, ...payload });
      if (!stillCurrent()) return;
      if (!result.ok) {
        setOutcome({ operation: kind, error: result });
        return;
      }
      if (kind === "commit") setDraft("");
      setOutcome({ operation: kind });
      changed.current(kind);
    } catch (cause) {
      if (stillCurrent()) setOutcome({ operation: kind, error: bridgeFailure(cause) });
    } finally {
      if (stillCurrent()) {
        task.current = null;
        invalidateOperation(kind);
        setOperation(null);
      }
    }
  }
  function index(action: IndexAction, path?: string) {
    if (!snapshot || !changesReady) return;
    const batch = action === "stageAll" || action === "unstageAll";
    void run(action, batch ? "fm.git.batch" : `fm.git.${action}`, {
      revision: snapshot.revision,
      ...(path ? { path } : {}),
      ...(action === "commit" ? { message: draft } : {}),
      ...(batch ? { action: action === "stageAll" ? "stage" : "unstage" } : {}),
    });
  }
  return {
    info, infoError, snapshot, changesError, infoReady, changesReady, changesSupported: mayReadChanges, version, refsVersion, operation, outcome,
    draft, setDraft, refresh, refreshChanges, index,
    initialize: () => { if (infoReady && info?.state === "plain") void run("init", "fm.git.syncAction", { action: "init", confirm: true }); },
    sync: (request: SyncRequest) => { if (infoReady && info?.state === "repository") void run("sync", "fm.git.syncAction", { ...request, confirm: true }); },
  };
}
export type GitWorkspace = ReturnType<typeof useGitWorkspace>;
