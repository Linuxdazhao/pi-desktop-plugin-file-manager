const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electron = from(process.env.PDF_ELECTRON_DIR)('electron');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-tree-'));
  const project = path.join(temp, 'project');
  let app;
  try {
    await fs.mkdir(path.join(project, 'src', 'deep'), { recursive: true });
    await fs.mkdir(path.join(project, 'dest'));
    await fs.writeFile(path.join(project, 'src', 'deep', 'open.txt'), 'original');
    const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: project, encoding: 'utf8' });
    app = await _electron.launch({ executablePath: electron, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temp, 'profile'),
      PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const row = p => page.locator(`[role="treeitem"][data-path="${p}"]`);
    const button = name => page.getByRole('button', { name, exact: true });
    await row('src').waitFor();
    if (process.env.FM_COMPOSER_DRAG_TEST === '1') {
      const dependencies = path.join(project, 'node_modules');
      const symlink = path.join(project, 'linked.txt');
      await fs.mkdir(dependencies);
      await fs.writeFile(path.join(dependencies, 'dependency.txt'), 'dependency');
      await fs.symlink(path.join(project, 'src', 'deep', 'open.txt'), symlink, 'file');
      await row('src').click();
      await row('src/deep').click();
      await page.evaluate(() => {
        window.dragEffects = [];
        window.addEventListener('dragstart', event => window.dragEffects.push(event.dataTransfer.effectAllowed));
      });
      await row('src/deep/open.txt').dragTo(row('src/deep'));
      await row('src').dragTo(row('src/deep'));
      await row('node_modules').click();
      await row('node_modules/dependency.txt').dragTo(row('dest'));
      await row('linked.txt').waitFor();
      assert.equal(await row('linked.txt').getAttribute('draggable'), 'false');
      await row('linked.txt').dragTo(row('dest'));
      assert.deepEqual(await page.evaluate(() => window.dragEffects), ['copyMove', 'move', 'copy']);
      assert.deepEqual(await page.evaluate(() => window.pluginBridge.testComposerDrags()), [
        { workspace: project, path: path.join(project, 'src', 'deep', 'open.txt') },
        { workspace: project, path: path.join(dependencies, 'dependency.txt') },
      ]);
      assert.equal(await fs.readFile(path.join(project, 'src', 'deep', 'open.txt'), 'utf8'), 'original');
      assert.equal(await fs.readFile(path.join(dependencies, 'dependency.txt'), 'utf8'), 'dependency');
      await fs.unlink(symlink);
      await fs.unlink(path.join(dependencies, 'dependency.txt'));
      await fs.rmdir(dependencies);
      await button('Refresh').click();
      await row('src').click();
    }
    const gitTab = page.getByRole('tab', { name: 'Git changes', exact: true });
    await gitTab.click();
    await button('Initialize repository').click();
    await button('Stage all').click();
    await button('Unstage all').click();
    await panelReady();
    assert.equal(git('diff', '--cached', '--name-only').trim(), '');
    git('config', 'user.name', 'Explorer fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture baseline');
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    async function panelReady() { await page.getByRole('button', { name: 'Untracked (1)', exact: true }).waitFor(); }
    await button('Expand all').click();
    await row('src/deep/open.txt').waitFor();
    await button('Collapse all').click();
    await row('src/deep').waitFor({ state: 'detached' });
    await row('src').click();
    await row('src/deep').click();
    await fs.writeFile(path.join(project, 'src', 'deep', 'external.txt'), 'outside');
    await row('src/deep/external.txt').waitFor({ timeout: 5000 }).catch(async error => {
      console.error('Tree:', await page.locator('body').innerText(), 'watch:', await page.evaluate(async () => ({ hidden: document.hidden, events: await window.pluginBridge.invoke('fm.watch', { since: 0 }) })));
      throw error;
    });
    await fs.unlink(path.join(project, 'src', 'deep', 'external.txt'));
    await row('src/deep/external.txt').waitFor({ state: 'detached', timeout: 5000 });
    await row('src/deep/open.txt').click();
    const editor = page.locator('.cm-content');
    await editor.getByText('original', { exact: true }).waitFor();
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type('unsaved draft');
    await row('src/deep').dragTo(row('dest'));
    await row('dest/deep').waitFor({ timeout: 5000 });
    await row('src/deep').waitFor({ state: 'detached' });
    assert.equal(await fs.readFile(path.join(project, 'dest', 'deep', 'open.txt'), 'utf8'), 'original');
    assert.match(await editor.innerText(), /unsaved draft/);
    await button('Save').click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent === 'unsaved draft');
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await fs.readFile(path.join(project, 'dest', 'deep', 'open.txt'), 'utf8')) === 'unsaved draft') return;
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      assert.fail('editor did not save to the moved path');
    });
    await row('dest/deep').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /Move to/ }).count(), 0);
    await page.keyboard.press('Escape');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' — editor only');
    const draft = await editor.innerText();
    await page.getByRole('tab', { name: 'Git changes', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    const panel = page.locator('aside').getByRole('tabpanel', { name: 'Git changes' });
    const file = 'dest/deep/open.txt';
    const moved = panel.getByRole('listitem').filter({ has: page.getByRole('button', { name: file, exact: true }) });
    const preview = page.getByRole('tabpanel', { name: file, exact: true });
    await moved.getByRole('button', { name: file }).click();
    await preview.getByText('unsaved draft', { exact: true }).waitFor();
    assert.equal(await preview.evaluate(el => !!el.closest('aside')), false);
    await page.getByRole('tab', { name: 'open.txt •', exact: true }).click();
    assert.equal(await editor.innerText(), draft);
    await page.getByRole('tab', { name: /open.txt · Working tree/ }).click();
    await moved.getByRole('button', { name: 'Stage', exact: true }).click();
    await page.getByRole('tab', { name: /open.txt · Staged/ }).waitFor({ timeout: 8000 }).catch(async e => { console.error(await page.locator('body').innerText(), git('status', '--porcelain')); throw e; });
    await moved.getByRole('button', { name: 'Unstage', exact: true }).click();
    await moved.getByRole('button', { name: 'Stage', exact: true }).click();
    await moved.getByRole('button', { name: 'Unstage', exact: true }).waitFor();
    await fs.writeFile(path.join(project, file), 'disk only');
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    const group = name => panel.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) }).last();
    await group('Changes (2)').getByRole('button', { name: file, exact: true }).click();
    await preview.getByText('disk only', { exact: true }).waitFor();
    await group('Staged Changes (1)').getByRole('button', { name: file, exact: true }).click();
    await preview.getByText('unsaved draft', { exact: true }).waitFor();
    assert.equal(await preview.getByText('disk only', { exact: true }).count(), 0);
    // The source-control list stays visible while document tabs switch by keyboard.
    const stagedTab = page.getByRole('tab', { name: /open.txt · Staged/ });
    await stagedTab.focus(); await page.keyboard.press('Home');
    assert.equal(await editor.innerText(), draft);
    await page.keyboard.press('End'); await preview.getByText('unsaved draft', { exact: true }).waitFor();
    const evidence = process.env.PDF_EVIDENCE_DIR;
    if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, 'tabs-dark.png') }); }
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(550, 780); global.testAppearance = { base: 'light', locale: 'zh-CN' }; win.webContents.send('test:appearance:changed', global.testAppearance); });
    await page.getByRole('tab', { name: 'Git 改动' }).waitFor();
    await preview.getByText('unsaved draft', { exact: true }).waitFor();
    for (const strip of ['.fm-document-tabs', '.fm-list-switch']) assert.ok(await page.locator(strip).evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    if (evidence) await page.screenshot({ path: path.join(evidence, 'tabs-narrow-light.png') });
    await page.getByRole('button', { name: '远程同步操作' }).click();
    await page.getByRole('button', { name: '强制推送（带租约）…' }).waitFor();
    if (evidence) await page.screenshot({ path: path.join(evidence, 'git-sync-menu.png') });
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1250, 880); global.testAppearance = { base: 'dark', locale: 'en' }; win.webContents.send('test:appearance:changed', global.testAppearance); });
    await panel.getByLabel('Commit message').fill('Commit from explorer fixture');
    await panel.getByRole('button', { name: 'Commit staged changes (1)' }).click();
    await panel.getByText('Committed locally.', { exact: true }).waitFor();
    assert.equal(git('log', '-1', '--format=%s').trim(), 'Commit from explorer fixture');
    assert.equal(git('show', 'HEAD:dest/deep/open.txt'), 'unsaved draft');
    assert.equal(git('show', 'HEAD:src/deep/open.txt'), 'original'); // unstaged deletion excluded
    await panel.getByRole('tab', { name: 'History', exact: true }).click();
    await panel.getByRole('button', { name: /Commit from explorer fixture/ }).click();
    await page.getByRole('article', { name: 'Commit details' }).getByRole('heading', { name: 'Commit from explorer fixture' }).waitFor();
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await editor.waitFor();
    assert.equal(await editor.innerText(), draft);
    assert.deepEqual(errors, []);
    console.log('EXPLORER DESKTOP PASSED: expand/collapse, external create/delete, drag and save dirty file at moved path, Git diff/stage/unstage/commit');
  } finally {
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
