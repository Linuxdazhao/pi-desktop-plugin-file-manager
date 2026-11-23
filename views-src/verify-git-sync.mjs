// Isolated contract tests: actual Git for all local work, transport replaced
// BEFORE spawn. No network, local transport, user profile or existing repository.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import backend from "../git-sync.js";
import main from "../main.js";

const temp = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "fm-sync-"));
try {
  const root = path.join(temp, "project"); await fs.mkdir(root);
  const payload = { workspacePath: root, projectId: "fixture", rootPath: root };
  globalThis.pi = { workspace: { get: async () => ({ path: root, projectId: "fixture" }) } };
  const rpc = (channel, extra = {}) => main.onPanelInvoke(`fm.git.${channel}`, { ...payload, ...extra });
  assert.equal((await rpc("syncInfo")).state, "plain");
  assert.equal((await rpc("syncAction", { action: "init", projectId: "stale" })).ok, false);
  const inner = path.join(root, "folder"); await fs.mkdir(inner); await fs.mkdir(path.join(inner, ".git"));
  assert.equal((await rpc("syncAction", { action: "init" })).code, "GIT_LAYOUT"); await fs.rm(inner, { recursive: true });
  assert.deepEqual(await rpc("syncAction", { action: "init", branch: "main" }), { ok: true });
  assert.deepEqual(await rpc("syncInfo"), { ok: true, state: "repository", branch: "main", remotes: [] });
  const run = await backend.runner(root), git = (...args) => run(["-C", root, ...args]);
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  const net = []; let context = "fixture", afterFetch, missing = false;
  const hooks = backend.createGitSync({ gitContext: async () => ({ root, nested: [], key: context }), gitBusy: new Set(), invalidateGitSnapshots() {}, audit() {}, isDenied: f => f.split("/").includes(".env"), makeRunner: async () => {
    if (missing) throw Object.assign(new Error("missing"), { code: "GIT_UNAVAILABLE" });
    return async (args, opts) => {
      if (args.includes("fetch") || args.includes("push")) {
        assert.equal(opts?.network, true); net.push(args.slice(2));
        if (args.includes("fetch")) await afterFetch?.(); return "";
      }
      assert.ok(!opts?.network); return run(args, opts);
    };
  } });
  const info = () => hooks["fm.git.syncInfo"](payload);
  const action = (a, extra) => hooks["fm.git.syncAction"]({ ...payload, action: a, ...extra });
  const denied = (promise, code) => assert.rejects(promise, { code });
  missing = true; assert.equal((await info()).state, "missing"); missing = false;
  await denied(action("arbitrary"), "INVALID_ARGUMENT"); await denied(action("fetch"), "GIT_REMOTE");
  const commit = async (name, text) => { await fs.writeFile(path.join(root, name), text); await git("add", "--", name); await git("commit", "--quiet", "-m", "fixture"); return (await git("rev-parse", "HEAD")).trim(); };
  const first = await commit("hello.txt", "first");
  await git("remote", "add", "other", "git@other.invalid:tests/fixture.git");
  await git("remote", "add", "origin", "https://example.invalid/tests/fixture.git");
  await git("config", "branch.main.remote", "origin"); await git("config", "branch.main.merge", "refs/heads/trunk");
  await git("update-ref", "refs/remotes/origin/trunk", first);
  const snapshot = await info();
  assert.deepEqual(snapshot.remotes, ["origin", "other"]); assert.equal(snapshot.upstream, "origin/trunk");
  assert.equal(snapshot.forceLease.expectedOid, first); assert.equal(snapshot.forceLease.branch, "trunk");
  await denied(action("fetch", { remote: "https://test.invalid/a" }), "INVALID_ARGUMENT");
  await denied(action("push", { remote: "absent" }), "GIT_REMOTE");
  await denied(action("fetch", { branch: "old" }), "GIT_STALE");
  await action("fetch", { remote: "other" }); assert.deepEqual(net.at(-1).slice(-2), ["other", "+refs/heads/*:refs/remotes/other/*"]);
  await action("push", { remote: "other" }); assert.deepEqual(net.at(-1).slice(-2), ["other", `${first}:refs/heads/main`]);
  await action("push"); assert.deepEqual(net.at(-1).slice(-2), ["origin", `${first}:refs/heads/trunk`]);
  const reviewed = { branch: "main", confirm: true, leaseToken: snapshot.forceLease.token };
  await denied(action("forcePush", { ...reviewed, confirm: false }), "GIT_LEASE");
  await denied(action("forcePush", { ...reviewed, leaseToken: "invented" }), "GIT_LEASE");
  await action("forcePush", reviewed); assert.ok(net.at(-1).includes(`--force-with-lease=refs/heads/trunk:${first}`));
  // Synthetic incoming commit. Stub fetch only updates the known tracking ref.
  await git("checkout", "-q", "-b", "incoming"); const incoming = await commit("remote.txt", "incoming"); await git("checkout", "-q", "main");
  afterFetch = () => git("update-ref", "refs/remotes/origin/trunk", incoming);
  await action("fetch"); await denied(action("forcePush", reviewed), "GIT_LEASE");
  afterFetch = () => { context = "changed"; }; await denied(action("pull"), "GIT_STALE"); assert.equal((await git("rev-parse", "HEAD")).trim(), first);
  afterFetch = undefined; await action("pull"); assert.equal((await git("rev-parse", "HEAD")).trim(), incoming);
  await git("checkout", "-q", "incoming"); const next = await commit("upstream.txt", "next"); await git("checkout", "-q", "main");
  await commit("local.txt", "local"); await git("update-ref", "refs/remotes/origin/trunk", next);
  await action("pullRebase"); assert.equal((await git("rev-parse", "HEAD^")).trim(), next); assert.equal(await fs.readFile(path.join(root, "local.txt"), "utf8"), "local");
  for (const [key, val] of [["core.sshCommand", "untrusted"], ["credential.helper", "untrusted"], ["include.path", "other"], ["url.file:///tmp/.insteadOf", "https://"], ["remote.origin.pushurl", "file:///tmp/local"], ["remote.origin.vcs", "helper"], ["remote.origin.pushurl", "ext::helper"], ["remote.origin.pushurl", "https://secret@example.invalid/fixture"]]) {
    const n = net.length; await git("config", "--file", path.join(root, ".git/config"), key, val);
    await denied(action("push"), "GIT_CONFIG"); assert.equal(net.length, n);
    await git("config", "--file", path.join(root, ".git/config"), "--unset", key);
  }
  await commit(".env", "dummy fixture"); await git("rm", "--", ".env"); await git("commit", "-m", "remove fixture");
  const n = net.length; await denied(action("push"), "GIT_PROTECTED"); assert.equal(net.length, n);
  const below = path.join(root, "below"); await fs.mkdir(below); globalThis.pi.workspace.get = async () => ({ path: below, projectId: "fixture" });
  assert.equal((await rpc("syncAction", { workspacePath: below, rootPath: below, action: "init" })).code, "GIT_LAYOUT");
  console.log("Git sync: isolated init, preflight, all action plans, real pull/rebase and lease regressions passed; no remote contacted.");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
