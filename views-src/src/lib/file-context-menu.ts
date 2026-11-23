import type { MenuEntry } from "../components/ContextMenu";

export type FileContextMenuTarget = {
  path: string;
  isDirectory: boolean;
  git?: object | null;
};

const BUILT_IN_BROWSER_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/** Add the host's bundled Browser action only when both the host and file support it. */
export function withBuiltInBrowserEntry<T extends FileContextMenuTarget>(
  target: T,
  available: boolean,
  label: string,
  entries: MenuEntry[],
  onOpen: (target: T) => void,
): MenuEntry[] {
  if (!available || target.isDirectory) return entries;
  const basename = target.path.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || !BUILT_IN_BROWSER_EXTENSIONS.has(basename.slice(dot).toLowerCase())) {
    return entries;
  }
  return [
    { kind: "item", label, onPick: () => onOpen(target) },
    { kind: "separator" },
    ...entries,
  ];
}

export type FileContextMenuLabels = {
  newFile: string;
  newFolder: string;
  rename: string;
  copyPath: string;
  delete: string;
  copyRelativePath: string;
  copyAbsolutePath: string;
  openWithSubmenu: string;
  viewChanges: string;
  revealInFolder: string;
  refresh: string;
};

export type FileContextMenuOptions<T extends FileContextMenuTarget> = {
  readOnly?: boolean;
  target: T | null;
  labels: FileContextMenuLabels;
  openWithEntries: MenuEntry[];
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRename: (target: T) => void;
  onDelete: (target: T) => void;
  onCopyRelativePath: (target: T) => void;
  onCopyAbsolutePath: (target: T) => void;
  onViewChanges: (target: T) => void;
  onRevealInFolder: (target: T) => void;
  onRefresh: (directory: string) => void;
};

/** Create in the clicked folder (or root); keep item menus focused on the item. */
export function buildFileContextMenuEntries<T extends FileContextMenuTarget>(
  options: FileContextMenuOptions<T>,
): MenuEntry[] {
  const { target, labels, readOnly, openWithEntries } = options;
  const sections: MenuEntry[][] = [];
  if (!readOnly && (!target || target.isDirectory)) {
    const parent = target?.path ?? "";
    sections.push([
      { kind: "item", label: labels.newFile, onPick: () => options.onNewFile(parent) },
      { kind: "item", label: labels.newFolder, onPick: () => options.onNewFolder(parent) },
    ]);
  }
  if (!target) {
    sections.push([{ kind: "item", label: labels.refresh, onPick: () => options.onRefresh("") }]);
  } else {
    const paths: MenuEntry[] = [
      { kind: "item", label: labels.copyRelativePath, onPick: () => options.onCopyRelativePath(target) },
      { kind: "item", label: labels.copyAbsolutePath, onPick: () => options.onCopyAbsolutePath(target) },
    ];
    // On SSH these are the only two actions; no need to make users open a submenu.
    if (readOnly) return paths;

    const open: MenuEntry[] = [];
    if (openWithEntries.some((entry) => entry.kind !== "separator" && !entry.disabled)) {
      open.push({ kind: "submenu", id: "openWith", label: labels.openWithSubmenu, items: openWithEntries });
    }
    if (!target.isDirectory) {
      open.push({ kind: "item", label: labels.revealInFolder, onPick: () => options.onRevealInFolder(target) });
      if (target.git) open.push({ kind: "item", label: labels.viewChanges, onPick: () => options.onViewChanges(target) });
    }
    if (open.length) sections.push(open);
    sections.push([
      { kind: "submenu", id: "copyPath", label: labels.copyPath, items: paths },
      { kind: "item", label: labels.rename, onPick: () => options.onRename(target) },
    ], [
      { kind: "item", label: labels.delete, danger: true, onPick: () => options.onDelete(target) },
    ]);
  }
  return sections.flatMap((section, index) =>
    index === 0 ? section : [{ kind: "separator" as const }, ...section],
  );
}
