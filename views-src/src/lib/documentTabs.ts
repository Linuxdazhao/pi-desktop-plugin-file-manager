import { useReducer, useRef } from 'react';
import type { TabEditorSnapshot } from './editor';
import type { OpenFile } from './openFile';
import type { ViewerMode } from './viewers';

type Tab = { file: OpenFile; dirty: boolean; changed: boolean; mode?: ViewerMode; editor?: TabEditorSnapshot };
/** Ordered by first open, not by last activation. The active view is the only live editor. */
export function useDocumentTabs() {
  const store = useRef(new Map<string, Tab>());
  const key = useRef<string | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const api = useRef({
    get active() { return key.current === null ? undefined : store.current.get(key.current); },
    get tabs() { return [...store.current.values()]; },
    get(path: string) { return store.current.get(path); },
    clear() { store.current.clear(); key.current = null; redraw(); },
    load(file: OpenFile) {
      const old = store.current.get(file.path);
      store.current.set(file.path, { file, dirty: false, changed: false, mode: old?.mode }); key.current = file.path; redraw();
    },
    activate(path: string) { if (store.current.has(path)) { key.current = path; redraw(); } },
    patch(path: string, value: Partial<Tab>) { const tab = store.current.get(path); if (tab) { Object.assign(tab, value); redraw(); } },
    remove(path: string) {
      const paths = [...store.current.keys()]; const i = paths.indexOf(path);
      if (i < 0) return;
      store.current.delete(path);
      if (key.current === path) key.current = paths[i + 1] ?? paths[i - 1] ?? null;
      redraw();
    },
    move(from: string, to: string) {
      const remap = (p: string) => p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p;
      store.current = new Map([...store.current].map(([p, tab]) => {
        const next = remap(p); if (p !== next) tab.file = { ...tab.file, path: next };
        return [next, tab];
      }));
      if (key.current !== null) key.current = remap(key.current); redraw();
    },
    noteChanges(paths: string[], stale: boolean) {
      for (const [p, tab] of store.current) if (p !== key.current && !/^(?:[a-z]:[\\/]|[\\/])/i.test(p) && (stale || paths.includes(p))) tab.changed = true;
    },
  });
  return api.current;
}
