const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

// Main-process only. Hold *all* matching replies, including competing directory
// requests. Playwright controls this object; the renderer gets no test channels.
function createGate() {
  const gates = new Map();
  function hold(channel, file = '') {
    const key = JSON.stringify([channel, file]);
    assert.ok(!gates.has(key), `already holding ${key}`);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    gates.set(key, { pending, release, entered: false });
    return key;
  }
  hold('fm.list'); // Before the file:// view is loaded.
  return {
    hold, entered: key => gates.get(key)?.entered === true,
    async beforeReply(channel, file = '') {
      const gate = gates.get(JSON.stringify([channel, file]));
      if (!gate) return;
      gate.entered = true;
      const failure = await gate.pending;
      if (failure) throw new Error(failure);
    },
    release(key, failure) {
      const gate = gates.get(key);
      assert.ok(gate?.entered, `no pending reply at ${key}`);
      gates.delete(key);
      gate.release(failure);
    },
  };
}
exports.createGate = createGate;

async function verify() {
  const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
  const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
  const electron = from(process.env.PDF_ELECTRON_DIR)('electron');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-loading-'));
  const project = path.join(temp, 'project'), name = 'note.txt';
  const file = path.join(project, name);
  let app;
  try {
    await fs.mkdir(project);
    await fs.writeFile(file, 'initial text');
    app = await _electron.launch({ executablePath: electron, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, FM_LOADING_TEST: '1', PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temp, 'profile'),
      PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const hold = (channel, file = '') => app.evaluate((_, args) => global.loadingGate.hold(...args), [channel, file]);
    const release = (key, error) => app.evaluate((_, args) => global.loadingGate.release(...args), [key, error || '']);
    async function pending(key) {
      const until = Date.now() + 10000;
      do {
        if (await app.evaluate((_, key) => global.loadingGate.entered(key), key)) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      } while (Date.now() < until);
      assert.fail(`no bridge reply held for ${key}`);
    }
    const skeleton = kind => page.locator(`[data-skeleton="${kind}"][role="status"]`);
    const button = label => page.getByRole('button', { name: label, exact: true });
    const row = filename => page.locator(`[role="treeitem"][data-path="${filename}"]`);
    const editor = page.locator('.cm-content:visible');
    const text = value => editor.getByText(value, { exact: true }).waitFor();
    async function stable(value) {
      assert.ok(await row(name).isVisible(), 'refresh cleared existing tree rows');
      assert.ok(await editor.isVisible(), 'refresh hid existing editor');
      assert.equal(await editor.innerText(), value, 'refresh replaced the editor before the read resolved');
      assert.equal(await page.locator('[data-skeleton]:visible').count(), 0, 'unexpected full loading skeleton');
    }
    async function screenshot(filename) {
      if (!process.env.PDF_EVIDENCE_DIR) return;
      await fs.mkdir(process.env.PDF_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PDF_EVIDENCE_DIR, filename) });
    }
    const list = skeleton('list'), lines = skeleton('lines');
    const rootKey = JSON.stringify(['fm.list', '']);
    await pending(rootKey);
    await list.waitFor();
    assert.match(await list.getAttribute('aria-label') || '', /load/i);
    assert.equal(await row(name).count(), 0);
    const motion = async () => list.evaluate(async el => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Chromium includes animations on pseudo-elements in the subtree list.
      return el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').map(a => ({
        css: a instanceof CSSAnimation,
        properties: [...new Set(a.effect.getKeyframes().flatMap(Object.keys))]
          .filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)),
      }));
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const effects = await motion();
    assert.ok(effects.length > 0, 'expected decorative loading motion');
    assert.ok(effects.every(a => a.css), 'expected CSS animations, not scripted animation loops');
    assert.ok(effects.every(a => a.properties.every(p => p === 'opacity')) ||
      (effects.length === 1 && effects[0].properties.every(p => /^(transform|translate|opacity|backgroundPosition[XY]?)$/.test(p))),
    `expected a single overlay or opacity motion: ${JSON.stringify(effects)}`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await motion(), [], 'decorative animation still running under reduced motion');
    assert.ok(await list.isVisible());
    await screenshot('loading-tree.png');
    await release(rootKey, 'Synthetic directory error');
    await page.getByText(/Synthetic directory error/).waitFor();
    await list.waitFor({ state: 'detached' });
    let tree = await hold('fm.list');
    await button('Retry').click();
    await pending(tree);
    await list.waitFor();
    await release(tree);
    await row(name).waitFor();
    await list.waitFor({ state: 'detached' });

    // Keep the stale tree entry, but make the file unavailable to the real reader.
    await fs.unlink(file);
    let read = await hold('fm.read', name);
    await row(name).click();
    await pending(read);
    await lines.waitFor();
    assert.match(await lines.getAttribute('aria-label') || '', /load/i);
    await release(read);
    await page.getByRole('alert').waitFor();
    await lines.waitFor({ state: 'detached' });
    await fs.writeFile(file, 'initial text');
    read = await hold('fm.read', name);
    await row(name).click();
    await pending(read);
    await lines.waitFor();
    await app.evaluate(() => { global.testAppearance.locale = 'zh-CN'; });
    await page.waitForFunction(() => /加载|读取/.test(document.querySelector('[data-skeleton="lines"]')?.getAttribute('aria-label')));
    await screenshot('loading-document.png');
    await app.evaluate(() => { global.testAppearance.locale = 'en'; });
    await button('Refresh').waitFor();
    await release(read);
    await text('initial text');
    await lines.waitFor({ state: 'detached' });

    // Manual refresh while watch is off: prove both requests updated real data.
    tree = await hold('fm.list');
    read = await hold('fm.read', name);
    await fs.writeFile(path.join(project, 'manual.txt'), 'new row');
    await fs.writeFile(file, 'manual update');
    await button('Refresh').click();
    await button('Reload from disk').click();
    await Promise.all([pending(tree), pending(read)]);
    await stable('initial text');
    await release(tree); await release(read);
    await row('manual.txt').waitFor(); await text('manual update');

    // Changing a clean document on disk triggers both reads, without UI clicks.
    // Wait for its initial directory reconciliation before intercepting the next list.
    await fs.writeFile(path.join(project, 'watch-ready.txt'), 'startup marker');
    await button('Auto-refresh off — use the refresh buttons').click().catch(async e => {
      console.error('Toolbar at failure:', await page.locator('header button[aria-pressed]').evaluateAll(nodes => nodes.map(n => [n.getAttribute('aria-label'), n.getAttribute('aria-pressed')])));
      console.error('Fixture watch preference:', await app.evaluate(async () => (await global.pi.plugin.getSettings()).fmPrefs.watchFiles));
      throw e;
    });
    await button('Auto-refresh when files change on disk').waitFor();
    await row('watch-ready.txt').waitFor();
    read = await hold('fm.read', name);
    tree = await hold('fm.list');
    await fs.writeFile(file, 'watch update');
    await Promise.all([pending(read), pending(tree)]);
    await stable('manual update');
    await release(tree); await release(read);
    await text('watch update');
    await stable('watch update');
    assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => global.blockedPdfRequests), []);
    console.log('LOADING PASSED: deferred tree/document loads, localized status, motion preferences, failure recovery and retained data during manual/watch refresh');
  } finally {
    try { await app?.close(); } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}
if (require.main === module) verify().catch(error => { console.error(error); process.exitCode = 1; });
