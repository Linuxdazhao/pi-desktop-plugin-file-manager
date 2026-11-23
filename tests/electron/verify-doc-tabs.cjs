const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electron = from(process.env.PDF_ELECTRON_DIR)('electron');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-doc-tabs-'));
  const project = path.join(temp, 'project');
  const left = 'left/shared.txt', right = 'right/shared.txt', md = 'notes.md';
  const disk = file => fs.readFile(path.join(project, file), 'utf8');
  let app;
  try {
    for (const dir of ['left', 'right']) await fs.mkdir(path.join(project, dir), { recursive: true });
    await fs.writeFile(path.join(project, left), 'left original');
    await fs.writeFile(path.join(project, right), 'right original');
    await fs.writeFile(path.join(project, md), '# Synthetic notes');
    app = await _electron.launch({ executablePath: electron, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temp, 'profile'),
      PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const strip = page.locator('.fm-document-tabs');
    const tab = p => strip.locator(`[role="tab"][title="${p}"]`);
    const row = p => page.locator(`[role="treeitem"][data-path="${p}"]`);
    const close = p => tab(p).locator('..').getByRole('button', { name: `Close ${p}`, exact: true }).click();
    const mode = name => page.getByRole('tab', { name, exact: true });
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
    const choose = async name => {
      await dialog.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    };
    const expectText = text => page.waitForFunction(expected => {
      const editors = [...document.querySelectorAll('.cm-content')].filter(el => el.getClientRects().length);
      return editors.length === 1 && editors[0].innerText === expected;
    }, text);
    async function edit(before, after) {
      await expectText(before);
      const editor = page.locator('.cm-content:visible');
      await editor.click();
      await editor.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.insertText(after);
      await expectText(after);
    }
    const expectActive = async (p, focused = false) => {
      await strip.locator(`[role="tab"][title="${p}"][aria-selected="true"]${focused ? ':focus' : ''}`).waitFor();
      assert.equal(await strip.getByRole('tab', { selected: true }).count(), 1);
    };

    await row('left').click(); await row(left).click();
    await edit('left original', 'left draft');
    await row('right').click(); await row(right).click();
    await edit('right original', 'right draft');
    // Reopen the inactive path through the tree; basename alone cannot identify it.
    await row(left).click(); await expectActive(left); await expectText('left draft');
    await tab(right).click(); await expectText('right draft');
    assert.equal(await strip.getByRole('tab').count(), 2);
    for (const p of [left, right]) await tab(p).locator('.fm-dirty-dot').waitFor();
    if (process.env.PDF_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PDF_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PDF_EVIDENCE_DIR, 'document-tabs-dirty.png') });
    }
    await tab(left).click(); await expectText('left draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await tab(left).locator('.fm-dirty-dot').waitFor({ state: 'detached' });
    assert.equal(await disk(left), 'left draft');
    assert.equal(await disk(right), 'right original');
    await edit('left draft', 'left final');

    await tab(right).click(); await expectText('right draft');
    await row(md).click(); await expectActive(md);
    await mode('Edit').click(); await expectText('# Synthetic notes');
    await mode('Preview').click();
    const heading = page.locator('.md-body').getByRole('heading', { name: 'Synthetic notes', exact: true });
    await heading.waitFor();
    await tab(right).click(); await expectText('right draft');
    await tab(md).click(); await heading.waitFor();
    await mode('Edit').click(); await expectText('# Synthetic notes');
    await close(md); await tab(md).waitFor({ state: 'detached' });
    await expectActive(right, true); await expectText('right draft');
    assert.equal(await dialog.count(), 0);

    await close(right); await choose('Cancel');
    await expectActive(right); await expectText('right draft');
    assert.equal(await strip.getByRole('tab').count(), 2);
    assert.equal(await disk(right), 'right original');
    await close(right); await choose('Discard');
    await tab(right).waitFor({ state: 'detached' });
    await expectActive(left, true); await expectText('left final');
    assert.equal(await disk(right), 'right original');
    assert.equal(await disk(left), 'left draft');
    await close(left); await choose('Save');
    await tab(left).waitFor({ state: 'detached' });
    assert.equal(await strip.getByRole('tab').count(), 0);
    assert.equal(await disk(left), 'left final');
    assert.equal(await disk(right), 'right original');
    assert.equal(await disk(md), '# Synthetic notes');
    // Saving a background tab from its close prompt must not read the active editor.
    await row(left).click(); await edit('left final', 'background save');
    await row(right).click(); await edit('right original', 'active draft');
    await close(left); await choose('Save');
    await tab(left).waitFor({ state: 'detached' });
    await expectActive(right); await expectText('active draft');
    assert.equal(await disk(left), 'background save');
    assert.equal(await disk(right), 'right original');
    await close(right); await choose('Discard');
    assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => global.blockedPdfRequests), []);
    console.log('DOCUMENT TABS PASSED: independent drafts, duplicate open, path-specific save, Markdown modes, dirty/clean close and neighbor focus');
  } finally {
    try { await app?.close(); } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
