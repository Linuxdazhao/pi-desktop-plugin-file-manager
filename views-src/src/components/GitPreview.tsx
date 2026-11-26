import { useEffect, useMemo, useState } from "react";
import { GitDiffView, type DiffViewState } from "./GitDiffView";
import { invoke } from "../lib/bridge";
import { channels, failureMessage, type Failure, type GitDiffResponse, type RepoContext } from "../lib/rpc";
import type { GitScope } from "../lib/gitWorkspace";
import type { T } from "../i18n";

/** Independent of fm.read: deleted files still have a patch. The scope selects
 * a section of the reply and never participates in the request key. */
export function GitPreview({ path, context, panel, scope, version, revision, pending, unchanged, unavailable, onBack, onRefresh, onScope, t }: {
  path: string; context: RepoContext; panel: boolean; scope: GitScope; version: number; revision?: string;
  pending: boolean; unchanged: boolean; unavailable?: string;
  onBack?: () => void; onRefresh: () => void; onScope: (scope: GitScope) => void; t: T;
}) {
  const request = useMemo(() => ({ path, context, panel, version, revision }), [path, context, panel, version, revision]);
  const [reply, setReply] = useState<{ request: typeof request; result: GitDiffResponse }>();
  useEffect(() => {
    if (pending || unchanged || unavailable || (request.panel && !request.revision)) return;
    let live = true;
    const finish = (result: GitDiffResponse) => { if (live) setReply({ request, result }); };
    void invoke<GitDiffResponse>(request.panel ? "fm.git.panelDiff" : channels.gitDiff, {
      ...request.context, path: request.path,
      ...(request.panel ? { revision: request.revision } : { expectedRoot: request.context.rootPath }),
    }).then(finish, cause => finish({ ok: false, code: "BRIDGE", message: String(cause) } satisfies Failure));
    return () => { live = false; };
  }, [request, pending, unchanged, unavailable]);

  const result = !pending && reply?.request === request ? reply.result : undefined;
  const state: DiffViewState = unavailable ? { status: "error", message: unavailable } : unchanged ? {
    status: "ready", response: { ok: true, kind: "none", path, untracked: false, addedLines: 0, deletedLines: 0, sections: [], truncated: false },
  } : result?.ok ? { status: "ready", response: result } : result ? {
    status: "error", message: result.code === "GIT_STALE" ? t("gitStale") : failureMessage(result, t),
  } : { status: "loading" };

  return <GitDiffView state={state} scope={scope} onScope={onScope} onBack={onBack} onRefresh={onRefresh} refreshing={pending} t={t} />;
}
