/** Offline behavior checks for the directory-tree context menu. */

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pifm-context-menu-"));
const modulePath = (name) => pathToFileURL(join(temp, `${name}.mjs`)).href;

try {
  await build({
    entryPoints: ["file-context-menu", "tree-move"].map(name => join(here, `src/lib/${name}.ts`)),
    bundle: true,
    format: "esm",
    platform: "node",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
  });
  const { buildFileContextMenuEntries, withBuiltInBrowserEntry } = await import(modulePath("file-context-menu"));
  const { canMoveTo, movableEntry } = await import(modulePath("tree-move"));
  const labels = {
    newFile: "New File",
    newFolder: "New Folder",
    rename: "Rename",
    copyPath: "Copy Path",
    delete: "Delete",
    copyRelativePath: "Copy Relative Path",
    copyAbsolutePath: "Copy Absolute Path",
    openWithSubmenu: "Open With…",
    viewChanges: "View Changes",
    revealInFolder: "Reveal in Folder",
    refresh: "Refresh",
  };
  const names = (entries) =>
    entries.map((entry) => (entry.kind === "separator" ? "|" : entry.label));
  const openWithEntries = [{ kind: "item", label: "System Default", onPick() {} }];

  const openedInBrowser = [];
  const htmlOpenWith = withBuiltInBrowserEntry(
    { path: "src/INDEX.HTML", isDirectory: false },
    true,
    "Open in built-in browser",
    openWithEntries,
    (target) => openedInBrowser.push(target.path),
  );
  assert.deepEqual(names(htmlOpenWith), [
    "Open in built-in browser", "|", "System Default",
  ]);
  htmlOpenWith[0].onPick();
  assert.deepEqual(openedInBrowser, ["src/INDEX.HTML"]);
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/readme.md", isDirectory: false }, true, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/page.xhtml", isDirectory: false }, false, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );
  assert.deepEqual(
    withBuiltInBrowserEntry(
      { path: "src/page.html", isDirectory: true }, true, "Open in built-in browser", openWithEntries, () => {},
    ),
    openWithEntries,
  );

  const calls = [];
  const track = (key) => (arg) => calls.push([key, typeof arg === "string" ? arg : arg.path]);
  const options = {
    labels, openWithEntries,
    onNewFile: track("file"), onNewFolder: track("folder"), onRename: track("rename"), onDelete: track("delete"),
    onCopyRelativePath: track("relative"), onCopyAbsolutePath: track("absolute"),
    onViewChanges: track("changes"), onRevealInFolder: track("reveal"), onRefresh: track("refresh"),
  };
  const menu = (target, overrides) => buildFileContextMenuEntries({ ...options, target, ...overrides });
  const blank = menu(null);
  assert.deepEqual(names(blank), ["New File", "New Folder", "|", "Refresh"]);
  blank.filter(e => e.kind === "item").forEach(e => e.onPick());
  assert.deepEqual(calls.splice(0), [["file", ""], ["folder", ""], ["refresh", ""]]);

  const entry = (path, isDirectory = false) => ({ name: path.split("/").pop(), path, isDirectory });
  const file = { ...entry("src/index.html"), git: { status: "modified" } };
  const entries = menu(file);
  assert.deepEqual(names(entries), [
    "Open With…", "Reveal in Folder", "View Changes", "|", "Copy Path", "Rename", "|", "Delete",
  ]);
  assert.equal(entries[0].id, "openWith");
  assert.equal(entries[0].items, openWithEntries);
  const paths = entries.find(e => e.id === "copyPath").items;
  assert.deepEqual(names(paths), ["Copy Relative Path", "Copy Absolute Path"]);
  paths.forEach(e => e.onPick());
  entries.filter(e => e.kind === "item").forEach(e => e.onPick());
  assert.deepEqual(calls.splice(0), ["relative", "absolute", "reveal", "changes", "rename", "delete"].map(s => [s, file.path]));
  assert.equal(entries.at(-1).danger, true);
  assert(!names(menu({ ...file, git: null })).includes("View Changes"));

  const dir = entry("src/assets", true);
  const directory = menu(dir);
  assert.deepEqual(names(directory), ["New File", "New Folder", "|", "Open With…", "|", "Copy Path", "Rename", "|", "Delete"]);
  directory.slice(0, 2).forEach(e => e.onPick());
  assert.deepEqual(calls.splice(0), [["file", dir.path], ["folder", dir.path]]);
  assert(!names(menu(dir, { openWithEntries: [{ ...openWithEntries[0], disabled: true }] })).includes("Open With…"));
  for (const target of [file, dir]) {
    assert.deepEqual(names(menu(target, { readOnly: true })), ["Copy Relative Path", "Copy Absolute Path"]);
  }
  assert.deepEqual(names(menu(null, { readOnly: true })), ["Refresh"]);

  const src = entry("src", true);
  assert(canMoveTo(file, dir));
  assert(canMoveTo(file, null)); // nested file to project root
  assert(canMoveTo(dir, null));
  assert(canMoveTo(src, entry("src-other", true)));
  for (const [source, target] of [
    [src, null], [file, src], [src, src], [src, dir], [dir, file],
    [{ ...file, outside: true }, dir], [file, { ...dir, outside: true }],
    [{ ...file, isSymlink: true }, dir], [file, { ...dir, isSymlink: true }],
    [entry("node_modules/pkg"), dir], [file, entry("lib/node_modules/pkg", true)],
  ]) assert(!canMoveTo(source, target), `invalid move ${source.path} to ${target?.path ?? "root"}`);
  for (const path of ["", ".", "../sibling", "/outside", "D:drive", "src//file", "dir\\escape"]) {
    assert(!movableEntry(entry(path)), `invalid source: ${path}`);
  }
  console.log("Context menu actions, read-only applicability, and internal tree move destinations passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
