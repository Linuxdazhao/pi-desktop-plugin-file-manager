// Exercise the registered channels, Git runner and path guards together. No user projects or remotes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../main.js";

const tmp = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "fm-history-"));
try {
  for (const k of Object.keys(process.env)) if (/^GIT_/i.test(k)) delete process.env[k];
  process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = tmp;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trimEnd();
  git("init", "--template=", "-q", "-b", "main");
  git("config", "user.name", "History Tester");
  git("config", "user.email", "history@example.invalid");
  git("config", "core.autocrlf", "false");
  const nested = join(repo, "sub");
  const ws = { projectId: "fixture", path: repo, roots: [{ path: repo, primary: true }, { path: nested }] };
  globalThis.pi = { workspace: { get: async () => ws }, plugin: { getSettings: async () => ({}), getDataPath: async () => tmp } };
  await plugin.onLoad();
  const call = (channel, extra = {}) => plugin.onPanelInvoke(`fm.git.${channel}`, { workspacePath: ws.path, projectId: ws.projectId, rootPath: ws.path, ...extra });
  const history = async () => { const r = await call("history"); assert.ok(r.ok, JSON.stringify(r)); return r; };
  const detail = async (oid, path) => { const r = await call("commitDetail", { oid, path }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  assert.deepEqual((await history()).commits, []);
  const literal = "-file[1].txt";
  mkdirSync(nested);
  mkdirSync(join(repo, "under-link"));
  const put = (rel, text) => writeFileSync(join(repo, rel), text);
  put(literal, "one\n"); put(".env.test", "synthetic private marker\n"); put("sub/hidden.txt", "nested marker\n");
  put("under-link/old.txt", "old linked marker\n");
  put("flip", "old public bytes\n");
  put("huge", "x".repeat(100 * 1024)); put("binary", Buffer.from([0, 1, 2])); put("many-lines", "a\n".repeat(2500));
  git("add", "-A");
  const blob = git("rev-parse", `:${literal}`);
  git("update-index", "--add", "--cacheinfo", `120000,${blob},historical-link`);
  git("commit", "-qm", "Initial subject");
  const first = git("rev-parse", "HEAD");
  rmSync(join(repo, "under-link"), { recursive: true });
  const outside = join(tmp, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(repo, "under-link"), process.platform === "win32" ? "junction" : "dir");
  let r = await detail(first, literal);
  assert.equal(r.parent, null); assert.equal(r.commit.subject, "Initial subject"); assert.equal(r.commit.author, "History Tester");
  assert.equal(r.selectedPath, literal); assert.match(r.patch.text, /\+one/); assert.ok(r.omitted);
  for (const forbidden of [".env.test", "sub/hidden.txt", "under-link/old.txt", "historical-link", "synthetic private marker"]) {
    assert.ok(!JSON.stringify(r).includes(forbidden), forbidden);
    assert.equal((await call("commitDetail", { oid: first, path: forbidden })).code, "GIT_PATH");
  }
  assert.equal((await detail(first, "huge")).patch.kind, "limit");
  assert.equal((await detail(first, "binary")).patch.kind, "binary");
  const lines = (await detail(first, "many-lines")).patch;
  assert.ok(lines.truncated && lines.text.split("\n").length <= 1500);
  put(literal, "two\n"); git("add", "-u", "--", literal);
  rmSync(join(repo, "flip")); mkdirSync(join(repo, "flip")); put("flip/.env", "hidden descendant marker\n");
  git("add", "-A", "--", "flip"); git("commit", "-qm", "Second subject");
  rmSync(join(repo, "flip"), { recursive: true }); // deleted directory: worktree alone cannot guard against path expansion
  const second = git("rev-parse", "HEAD");
  // Failing diff drivers ensure modified blob comparisons do not delegate to repository or user commands.
  git("config", "diff.external", "false"); git("config", "diff.fixture.textconv", "false");
  put(".gitattributes", "* diff=fixture\n");
  r = await detail(second);
  assert.equal(r.parent, first); assert.equal(r.selectedPath, literal); assert.equal(r.patch.kind, "text");
  assert.match(r.patch.text, /-one\n\+two/);
  r = await detail(second, "flip");
  assert.match(r.patch.text, /-old public bytes/); assert.doesNotMatch(JSON.stringify(r), /hidden descendant|flip\/\.env/);
  assert.equal((await call("commitDetail", { oid: second, path: "flip/.env" })).code, "GIT_PATH");
  const tree = git("rev-parse", "HEAD^{tree}");
  const other = git("commit-tree", tree, "-p", first, "-m", "Side history"); git("branch", "side", other);
  for (const oid of [other, blob, tree, "HEAD", "-p", "a".repeat(40)]) assert.equal((await call("commitDetail", { oid })).code, "GIT_COMMIT");
  const merge = git("commit-tree", tree, "-p", second, "-p", other, "-m", "Merge fixture");
  git("update-ref", "refs/heads/main", merge, second);
  r = await detail(merge); assert.equal(r.parent, second); assert.deepEqual(r.files, []);
  git("update-ref", "refs/heads/main", second, merge);
  let tip = second;
  for (let i = 0; i < 50; i++) tip = git("commit-tree", tree, "-p", tip, "-m", `Follow-up ${i}`);
  git("update-ref", "refs/heads/main", tip, second);
  const list = await history();
  assert.equal(list.branch, "main"); assert.equal(list.commits.length, 50); assert.equal(list.commits[0].oid, tip);
  assert.equal(list.commits.at(-1).subject, "Follow-up 0");
  assert.deepEqual((await detail(tip)).files, []);
  assert.equal((await call("history", { rootPath: nested })).code, "GIT_STALE");
  assert.equal((await call("history", { external: true })).code, "GIT_STALE");
  assert.equal((await call("history", { projectId: "another" })).code, "GIT_STALE");
  const linked = join(tmp, "linked"); git("worktree", "add", "-q", "--detach", linked, other);
  ws.path = linked; ws.roots = [{ path: linked, primary: true }];
  assert.equal((await call("history")).code, "GIT_LAYOUT");
  ws.path = nested; ws.roots = [{ path: nested, primary: true }];
  assert.equal((await call("history")).code, "GIT_REPO_ROOT");
  console.log("Git history: bounds, branch reachability, ordinary repo, historical and live path guards, initial/modified blobs and literal filenames passed.");
} finally {
  await plugin.onUnload();
  rmSync(tmp, { recursive: true, force: true });
}
