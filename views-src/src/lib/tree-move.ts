import type { FileEntry } from "./rpc";

/** The OS and the main process still decide writability and collisions on disk. */
export function movableEntry(entry: FileEntry): boolean {
  if (entry.outside || entry.isSymlink || /^[a-z]:/i.test(entry.path) || /[\\\0]/.test(entry.path)) return false;
  const parts = entry.path.split("/");
  return parts[parts.length - 1] === entry.name && parts.every((part) =>
    Boolean(part) && part !== "." && part !== ".." && part !== "node_modules" && part !== ".git",
  );
}

/** null denotes the root drop zone, never a file or an unrecognized target. */
export function canMoveTo(source: FileEntry, target: FileEntry | null): boolean {
  if (!movableEntry(source) || (target && (!target.isDirectory || !movableEntry(target)))) return false;
  const directory = target?.path ?? "";
  const parent = source.path.split("/").slice(0, -1).join("/");
  return directory !== parent && directory !== source.path && !directory.startsWith(`${source.path}/`);
}
