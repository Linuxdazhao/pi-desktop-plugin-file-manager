import { useEffect, useRef } from "react";
import { invoke } from "./bridge";
import { channels, type WatchResponse, type Failure } from "./rpc";
import { decideWatchAction, WATCH_MAX_DIR_REFRESH } from "./watch";

/** Pull native events without overlapping requests. Reconcile visible folders on
 * first attach/resume too: some volumes don't deliver reliable rename events. */
export function useTreeWatch(root: string | null, callbacks: {
  visible: () => string[];
  refresh: (directory: string) => Promise<unknown>;
  document: () => { openPath: string | null; dirty: boolean };
  onDocument: (path: string, warn: boolean) => void;
  onAvailable: (available: boolean) => void;
  onPaths?: (paths: string[], stale: boolean) => void;
}) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  useEffect(() => {
    if (!root) return;
    let stopped = false, busy = false, cursor = 0, reconcileAt = 0;
    const pending = new Set<string>();
    const tick = async () => {
      if (stopped || busy || document.hidden) return;
      busy = true;
      try {
        const result = await invoke<WatchResponse | Failure>(channels.watch, { since: cursor }).catch(() => null);
        if (stopped) return;
        const api = latest.current;
        const available = !!result?.ok && result.available;
        api.onAvailable(available);
        const full = Date.now() >= reconcileAt;
        const visible = new Set(api.visible());
        if (full || (result?.ok && (result.stale || result.changed.includes("")))) {
          for (const dir of visible) pending.add(dir);
          reconcileAt = Date.now() + (available ? 30000 : 2000);
        }
        if (result?.ok) {
          cursor = result.revision;
          if (result.stale || result.changed.length) api.onPaths?.(result.changed, result.stale);
          const doc = api.document();
          const decision = decideWatchAction({ ...doc, changed: result.changed, stale: result.stale });
          for (const dir of decision.refreshDirs) if (visible.has(dir)) pending.add(dir);
          // A platform can report the directory itself rather than its new child.
          for (const path of result.changed) if (visible.has(path)) pending.add(path);
          if (doc.openPath && (decision.warn || decision.reload)) api.onDocument(doc.openPath, decision.warn);
        }
        const batch = [...pending].slice(0, WATCH_MAX_DIR_REFRESH);
        for (const dir of batch) pending.delete(dir);
        await Promise.all(batch.filter(dir => visible.has(dir)).map(dir => api.refresh(dir)));
      } finally { busy = false; }
    };
    const resume = () => { if (!document.hidden) { reconcileAt = 0; void tick(); } };
    const timer = window.setInterval(() => void tick(), 400);
    document.addEventListener("visibilitychange", resume);
    void tick();
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [root]);
}
