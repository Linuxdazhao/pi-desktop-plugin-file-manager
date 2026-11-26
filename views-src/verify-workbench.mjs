#!/usr/bin/env node
/**
 * The workbench shell: activity rail + one swappable sidebar + tabbed content.
 *
 * Static render checks for the real workbench primitives. Keyboard behavior,
 * view mounting and Git operation lifecycles are covered in Electron.
 *
 * Run: node verify-workbench.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-file-workbench-"));
const output = join(temp, "workbench.cjs");

try {
  await build({
    stdin: {
      contents: `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRail, StatusBar, ContentBar, Segmented } from ${JSON.stringify(join(here, "src/components/Workbench.tsx"))};
import { makeT, COPY_TABLES } from ${JSON.stringify(join(here, "src/i18n.ts"))};
export { COPY_TABLES };
const t = makeT("en");
export function rail(props) {
  return renderToStaticMarkup(React.createElement(ActivityRail, {
    view: "files", onView() {}, hidden: false, badge: 7,
    labels: { files: t("viewFiles"), search: t("viewSearch"), git: t("viewGit") },
    ...props,
  }));
}
export function status(props) {
  return renderToStaticMarkup(React.createElement(StatusBar, {
    branch: "main", upstream: "origin/main", ahead: 2, behind: 0,
    watching: true, watchLabel: t("statusWatching"), position: "12:5", kind: "TS", t, ...props,
  }));
}
export function bar(children) {
  return renderToStaticMarkup(React.createElement(ContentBar, null, children));
}
export function segmented(props) {
  return renderToStaticMarkup(React.createElement(Segmented, {
    label: t("viewMode"), value: "source",
    options: [{ value: "source", label: t("editMode") }, { value: "markdown", label: t("previewMode") }],
    onChange() {}, ...props,
  }));
}
export { t };
`,
      resolveDir: here,
    },
    platform: "node",
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    outfile: output,
  });
  const api = createRequire(import.meta.url)(output);

  // ── 1. 活动栏：三个视图 + 一条可折叠侧栏 ────────────────────────────────
  const rail = api.rail();
  const views = [...rail.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(views, ["files", "search", "git"], "the rail must offer exactly explorer/search/source-control");
  assert.match(rail, /role="tablist"/, "the rail is a tablist so arrow keys have a home");
  assert.match(rail, /aria-orientation="vertical"/, "it stacks vertically");
  assert.match(rail, /aria-selected="true"[^>]*data-view="files"|data-view="files"[^>]*aria-selected="true"/,
    "the current view must be the selected tab");
  assert.equal((rail.match(/aria-selected="true"/g) ?? []).length, 1, "only one tab may be selected");
  assert.match(rail, /class="fm-rail-badge"[^>]*>7</, "the source-control entry carries the dirty count");
  // Collapsed: nothing selected (the sidebar is not showing a view), badge stays.
  const collapsed = api.rail({ hidden: true });
  assert.equal((collapsed.match(/aria-selected="true"/g) ?? []).length, 0, "a collapsed sidebar selects no rail entry");
  assert.match(collapsed, /fm-rail-badge/, "the badge keeps reporting dirty files while collapsed");
  // A zero count must not render a badge at all.
  assert.doesNotMatch(api.rail({ badge: 0 }), /fm-rail-badge/, "no badge when the tree is clean");
  // Huge counts are capped so the pip cannot spill out of the 40px button.
  assert.match(api.rail({ badge: 1234 }), />99\+</, "counts above 99 are shown as 99+");

  // ── 2. 状态栏：只在有值时出现，并且是可读的事实 ──────────────────────────
  const status = api.status();
  assert.match(status, />main</, "the branch is shown");
  assert.match(status, />origin\/main</, "the upstream is shown next to it");
  assert.match(status, /↑2/, "ahead count comes from the same place as the branch");
  assert.match(status, /Watching/, "the watch state is visible without opening a menu");
  assert.match(status, />12:5</, "the caret position is on the right");
  assert.doesNotMatch(api.status({ branch: null }), /current branch/i, "no empty branch chip");
  assert.doesNotMatch(api.status({ ahead: 0, behind: 0 }), /↑|↓/, "in sync: no arrow noise");
  assert.doesNotMatch(api.status({ watching: null }), /Watching|Not watching/, "a remote read-only workspace reports no watch state");

  // ── 3. 内容区顶栏 + 分段控件 ────────────────────────────────────────────
  const segmented = api.segmented();
  assert.match(segmented, /role="tablist"/, "the view switch is a tablist");
  assert.equal((segmented.match(/role="tab"/g) ?? []).length, 2, "one tab per available view");
  assert.match(segmented, /aria-selected="true"[^>]*>\s*<span>Edit</,
    "the active view is marked, so a diff cannot look active at the same time");
  // Switching views must be a single select: exactly one aria-selected="true".
  assert.equal((api.segmented({ value: "markdown" }).match(/aria-selected="true"/g) ?? []).length, 1,
    "exactly one view is selected at a time");
  assert.match(api.bar("<b>x</b>"), /class="fm-content-bar"[^>]*>&lt;b&gt;x&lt;\/b&gt;/,
    "the bar hosts whatever toolbar the tab supplies");

  // ── 4. 文案：新界面用到的键中英都有 ──────────────────────────────────────
  const { COPY_TABLES } = api;
  assert.deepEqual(Object.keys(COPY_TABLES.zh).sort(), Object.keys(COPY_TABLES.en).sort());
  for (const [locale, copy] of Object.entries(COPY_TABLES)) {
    for (const [key, value] of Object.entries(copy)) assert.ok(value, `missing ${locale} copy for ${key}`);
  }

  console.log("WORKBENCH VERIFY PASSED: rail/status/bar wiring, single selected view, badge caps and bilingual copy");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
