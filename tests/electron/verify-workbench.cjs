const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electron = from(process.env.PDF_ELECTRON_DIR)('electron');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function verify() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-workbench-'));
  const project = path.join(temp, 'project');
  const evidence = process.env.PDF_EVIDENCE_DIR;
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: project, encoding: 'utf8' }).trim();
  const write = (name, text) => fs.writeFile(path.join(project, name), `${text}\n`);
  let app;
  try {
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(temp, 'second-folder'));
    await fs.writeFile(path.join(temp, 'second-folder', 'other-root.txt'), 'Another registered folder\n');
    const note = 'src/pipeline.txt';
    const longLine = 'const stage = inspectPipeline(config, workers); '.repeat(6).trim();
    await write(note, `baseline pipeline\n${longLine}`);
    await write('README.md', '# Workbench fixture\n\nA synthetic project for the file manager.');
    await write('obsolete.txt', 'tracked file to delete');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Workbench Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial workbench fixture');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'topic/upstream');
    await write('upstream.txt', 'synthetic upstream');
    git('add', 'upstream.txt'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Upstream topic');
    const incoming = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    await write('local.txt', 'synthetic local work');
    git('add', 'local.txt'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Local workbench baseline');
    const local = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'https://example.invalid/workbench.git');
    git('remote', 'add', 'backup', 'https://backup.invalid/workbench.git');
    git('config', 'branch.main.remote', 'origin'); git('config', 'branch.main.merge', 'refs/heads/trunk');
    git('update-ref', 'refs/remotes/origin/trunk', incoming);
    await write(note, `indexed pipeline\n${longLine}`); git('add', note);
    await write(note, `working pipeline\n${longLine}`);
    await write('new-report.txt', 'new workbench report');
    await fs.unlink(path.join(project, 'obsolete.txt'));

    app = await _electron.launch({ executablePath: electron, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, FM_WORKBENCH_TEST: '1', PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temp, 'profile'),
      FM_SECOND_ROOT: path.join(temp, 'second-folder'), PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const button = name => page.getByRole('button', { name, exact: true });
    const row = name => page.locator(`[role="treeitem"][data-path="${name}"]`);
    const rail = page.getByRole('tablist', { name: 'Sidebar views' });
    const railTab = name => rail.getByRole('tab', { name, exact: true });
    const sidebar = page.locator('#fm-sidebar');
    const separator = page.getByRole('separator', { name: 'Resize the sidebar' });
    const strip = page.getByRole('tablist', { name: 'Open documents' });
    const doc = strip.getByRole('tab', { name: /^pipeline\.txt/ });
    const diffTab = name => strip.getByRole('tab', { name: `${name} · Changes`, exact: true });
    const diff = page.locator('.diff-pane');
    const diffText = text => diff.getByText(text, { exact: true });
    const editor = page.locator('.cm-content:visible');
    const status = page.locator('.fm-status');
    const scmTab = name => sidebar.getByRole('tab', { name, exact: true });
    const group = name => sidebar.getByRole('region', { name, exact: true });
    const stats = () => app.evaluate(() => global.workbenchCalls);
    const syncCalls = async () => (await stats()).filter(call => call.channel === 'fm.git.syncAction').map(call => call.payload);
    const diffCalls = async () => (await stats()).filter(call => call.channel === 'fm.git.panelDiff' && call.payload.path === note).length;
    const callsFor = async channel => (await stats()).filter(call => call.channel === channel).length;
    const holdReply = (channel, file = '') => app.evaluate((_, input) => global.loadingGate.hold(...input), [channel, file]);
    const releaseReply = key => app.evaluate((_, key) => global.loadingGate.release(key), key);
    const held = async key => {
      for (let i = 0; i < 120; i++) {
        if (await app.evaluate((_, key) => global.loadingGate.entered(key), key)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`No held reply for ${key}`);
    };
    const prefs = () => app.evaluate(async () => (await global.pi.plugin.getSettings()).fmPrefs);
    const record = async name => {
      if (!evidence) return;
      await fs.mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, `workbench-${name}.png`) });
    };
    const select = locator => locator.and(page.locator('[aria-selected="true"]')).waitFor();
    const focus = locator => locator.and(page.locator(':focus')).waitFor();
    const noHiddenContent = () => page.waitForFunction(() => [...document.querySelectorAll('.fm-view')].filter(el => el.getClientRects().length).length === 1);
    const viewport = async () => {
      const dimensions = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
        return { width: innerWidth, page: document.documentElement.scrollWidth, rail: rect('.fm-rail')?.width,
          sidebar: rect('#fm-sidebar')?.width, content: rect('.fm-content')?.width, right: rect('.fm-topbar-tools')?.right };
      });
      assert.equal(dimensions.rail, 46);
      assert.ok(dimensions.page <= dimensions.width + 1 && dimensions.right <= dimensions.width, JSON.stringify(dimensions));
      return dimensions;
    };

    await row('src').waitFor();
    await page.locator('.fm-topbar button.fm-rootchip').click();
    const folderMenu = page.getByRole('menu');
    await folderMenu.getByRole('menuitem', { name: 'second-folder' }).click();
    await row('other-root.txt').waitFor();
    await button('Push').waitFor({ state: 'detached' });
    await page.locator('.fm-topbar button.fm-rootchip').click();
    await folderMenu.getByRole('menuitem', { name: /Workbench fixture/ }).click();
    await row('src').waitFor();
    await status.getByText('↑1').waitFor(); await status.getByText('↓1').waitFor();
    await page.locator('.fm-rail-badge').getByText('3', { exact: true }).waitFor();
    const initialWidth = (await viewport()).sidebar;
    assert.equal(initialWidth, 300);
    await separator.press('ArrowRight');
    assert.equal(await separator.getAttribute('aria-valuenow'), '316');
    const handle = await separator.boundingBox();
    await page.mouse.move(handle.x + 2, handle.y + 35);
    await page.mouse.down(); await page.mouse.move(handle.x + 26, handle.y + 35, { steps: 4 }); await page.mouse.up();
    assert.equal(await separator.getAttribute('aria-valuenow'), '340');
    await row('src').click(); await row(note).click();
    await editor.getByText('working pipeline', { exact: true }).waitFor();
    await status.locator('.fm-status-position').getByText('Ln 1, Col 1').waitFor();
    await record('01-explorer-dark');
    const wrapState = expected => page.waitForFunction(value => {
      const source = document.querySelector('.cm-content');
      return source?.getClientRects().length && source.classList.contains('cm-lineWrapping') === value;
    }, expected);
    await wrapState(true);
    await button('Disable soft wrap').click(); await wrapState(false);
    await row('README.md').click(); await wrapState(false);
    await doc.click(); await wrapState(false);
    await page.reload();
    await row('src').waitFor();
    assert.equal(await separator.getAttribute('aria-valuenow'), '340');
    assert.equal((await prefs()).sidebarWidth, 340);
    assert.equal((await prefs()).wrapLines, false);
    await row('src').click(); await row(note).click(); await wrapState(false);
    const fileModes = page.getByRole('tablist', { name: 'View', exact: true });
    await fileModes.getByRole('tab', { name: 'Changes', exact: true }).click();
    await diffText('working pipeline').waitFor();
    await noHiddenContent();
    assert.equal(await status.locator('.fm-status-position').count(), 0);
    await diff.getByRole('button', { name: 'Back to the file' }).click();
    await editor.waitFor();
    await editor.click(); await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.insertText('Draft: ');
    await editor.getByText('Draft: working pipeline', { exact: true }).waitFor();

    await railTab('Explorer').press('ArrowDown'); await focus(railTab('Search')); await select(railTab('Search'));
    assert.equal(await sidebar.getByRole('tree').count(), 0);
    await page.keyboard.press(`${mod}+Shift+f`);
    const search = sidebar.getByRole('textbox', { name: 'Search files', exact: true });
    await focus(search); await search.fill('pipeline');
    await page.keyboard.press(`${mod}+b`); await sidebar.waitFor({ state: 'hidden' });
    await focus(railTab('Search'));
    await page.keyboard.press(`${mod}+b`); await search.waitFor(); await focus(railTab('Search'));
    await sidebar.getByRole('button', { name: /pipeline\.txt/ }).waitFor();
    await record('02-search-dark');
    await railTab('Search').press('End'); await select(railTab('Source Control')); await focus(railTab('Source Control'));
    assert.equal(await search.count(), 0);
    await scmTab('Changes').press('End'); await select(scmTab('Branches')); await focus(scmTab('Branches'));
    await sidebar.locator('.scm-branches [aria-current]').getByText('main', { exact: true }).waitFor();
    await sidebar.getByText('topic/upstream', { exact: true }).waitFor();
    await record('03-branches-dark');
    await scmTab('Branches').press('Home'); await select(scmTab('Changes'));
    await group('Staged Changes').getByRole('button', { name: note, exact: true }).click();
    await diffText('indexed pipeline').waitFor();
    const firstDiffCount = await diffCalls();
    assert.ok(firstDiffCount > 0);
    const scopes = diff.getByRole('tablist', { name: 'Diff scope' });
    const staged = scopes.getByRole('tab', { name: 'Staged', exact: true });
    const unstaged = scopes.getByRole('tab', { name: 'Unstaged', exact: true });
    await staged.press('ArrowRight'); await select(unstaged); await focus(unstaged);
    await diffText('working pipeline').waitFor();
    assert.equal(await diffCalls(), firstDiffCount);
    await group('Staged Changes').getByRole('button', { name: note, exact: true }).click();
    await diffText('indexed pipeline').waitFor();
    assert.equal(await diffCalls(), firstDiffCount);
    assert.equal(await diffTab(note).count(), 1);
    await record('04-diff-dark');
    // Review tabs cannot save the last editor behind them.
    const writes = await callsFor('fm.write');
    await diffTab(note).press(`${mod}+s`);
    await page.evaluate(() => window.pluginBridge.invoke('fm.hello'));
    assert.equal(await callsFor('fm.write'), writes);

    const refresh = page.locator('.fm-topbar').getByRole('button', { name: 'Refresh', exact: true });
    const holdDiff = await holdReply('fm.git.panelDiff', note);
    await write(note, `new staged pipeline\n${longLine}`); git('add', note);
    await fs.writeFile(path.join(project, note), Buffer.from([0, 1, 2]));
    await refresh.click(); await held(holdDiff);
    await diff.locator('[data-skeleton="diff"]').waitFor();
    assert.equal(await diffText('indexed pipeline').count(), 0, 'old revision must not appear ready');
    await releaseReply(holdDiff);
    await diffText('new staged pipeline').waitFor();
    await unstaged.click(); await diff.getByText(/this file is binary/i).waitFor();
    await staged.click(); await diffText('new staged pipeline').waitFor();
    await write(note, `indexed pipeline\n${longLine}`); git('add', note);
    await write(note, `working pipeline\n${longLine}`);
    await refresh.click(); await diffText('indexed pipeline').waitFor();

    // An Explorer-only diff has no SCM selection yet; do not mislabel its scope.
    await railTab('Explorer').click();
    await write('local.txt', 'staged local only'); git('add', 'local.txt');
    const stagedTreeBadge = row('local.txt').locator('.git-badge');
    for (let i = 0; i < 8 && !(await stagedTreeBadge.isVisible()); i++) {
      await refresh.click();
      await stagedTreeBadge.waitFor({ timeout: 450 }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
    }
    await stagedTreeBadge.waitFor();
    await row('local.txt').click(); await editor.getByText('staged local only', { exact: true }).waitFor();
    await fileModes.getByRole('tab', { name: 'Changes', exact: true }).click();
    await diff.getByText('HEAD → index', { exact: true }).waitFor();
    assert.equal(await diffTab('local.txt').getByText('Unstaged', { exact: true }).count(), 0);
    await diffTab('local.txt').press(`${mod}+w`);
    const localDocument = strip.getByRole('tab', { name: 'local.txt', exact: true });
    await localDocument.click(); await localDocument.press(`${mod}+w`);
    git('restore', '--staged', '--worktree', 'local.txt');
    await refresh.click();

    // Creating a file with watch disabled invalidates any previous SCM badge.
    await railTab('Source Control').click(); await group('Untracked').getByRole('button', { name: 'new-report.txt', exact: true }).waitFor();
    await page.locator('.fm-rail-badge').getByText('3', { exact: true }).waitFor();
    await railTab('Explorer').click(); await row('README.md').click(); await button('New file').click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('from-explorer.txt');
    await button('Create').click(); await row('from-explorer.txt').waitFor();
    await page.locator('.fm-rail-badge').getByText('4', { exact: true }).waitFor();
    await fs.unlink(path.join(project, 'from-explorer.txt'));
    await railTab('Source Control').click();
    await group('Changes').getByRole('button', { name: 'obsolete.txt', exact: true }).click();
    await diffText('tracked file to delete').waitFor();
    assert.equal(await diff.getByRole('button', { name: 'Back to the file' }).count(), 0);
    await group('Untracked').getByRole('button', { name: 'new-report.txt', exact: true }).click();
    await diffText('new workbench report').waitFor();
    await diffTab('new-report.txt').press('ArrowLeft');
    await focus(diffTab('obsolete.txt')); await diffText('tracked file to delete').waitFor();
    await page.keyboard.press(`${mod}+w`);
    await focus(diffTab('new-report.txt')); await diffText('new workbench report').waitFor();
    assert.equal(await diffTab('obsolete.txt').count(), 0);
    await diffTab(note).click(); await diffText('indexed pipeline').waitFor();

    const draft = sidebar.getByRole('textbox', { name: 'Commit message' });
    const message = 'Commit reviewed pipeline';
    await draft.fill(message);
    await railTab('Source Control').click();
    await sidebar.waitFor({ state: 'hidden' });
    assert.equal(await separator.count(), 0);
    assert.equal((await viewport()).sidebar, 0);
    await record('05-collapsed-dark');
    // A terminal-only ref update is picked up on focus with no Git sidebar.
    git('update-ref', 'refs/remotes/origin/trunk', base);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await status.getByText('↓1').waitFor({ state: 'detached' });
    await status.getByText('↑1').waitFor();

    const syncVersion = await callsFor('fm.git.syncInfo');
    const holdProbe = await holdReply('fm.git.syncInfo');
    await refresh.click(); await held(holdProbe);
    for (let i = 0; i < 3; i++) await refresh.click();
    assert.equal(await callsFor('fm.git.syncInfo'), syncVersion + 1, 'one metadata probe in flight');
    await releaseReply(holdProbe);
    await page.waitForFunction(() => document.querySelector('[data-sync="push"]')?.disabled === false);
    assert.equal(await callsFor('fm.git.syncInfo'), syncVersion + 2, 'only the latest queued probe runs');

    const confirmAction = async (family, label, action, options = {}) => {
      const before = (await syncCalls()).length;
      await button(family).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      if (!options.immediate) {
        const dialog = page.getByRole('dialog', { name: label, exact: true });
        await dialog.waitFor();
        assert.equal((await syncCalls()).length, before, 'do not send before confirmation');
        const bounds = await dialog.boundingBox();
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height);
        if (options.remote) await dialog.getByRole('combobox', { name: 'Remote' }).selectOption(options.remote);
        if (options.watchEdit) {
          const beforeProbe = await callsFor('fm.git.syncInfo');
          await write('external-during-confirm.txt', 'synthetic worktree event');
          // The updated badge proves the watch event was applied behind the dialog.
          await page.locator('.fm-rail-badge').getByText('4', { exact: true }).waitFor();
          assert.equal(await callsFor('fm.git.syncInfo'), beforeProbe);
          assert.equal(await dialog.getByRole('combobox').inputValue(), options.remote);
          await fs.unlink(path.join(project, 'external-during-confirm.txt'));
        }
        if (options.lease) {
          await dialog.getByText(`origin/trunk @ ${base.slice(0, 12)}`, { exact: true }).waitFor();
          await record('06-lease-dark');
        }
        if (options.cancel) {
          await page.keyboard.press('Escape'); await focus(button(family));
          await dialog.waitFor({ state: 'detached' });
          assert.equal((await syncCalls()).length, before);
          return;
        }
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
      }
      await page.getByRole('menu').waitFor({ state: 'detached' });
      await page.waitForFunction(() => !document.querySelector('[data-sync="push"]')?.disabled);
      const calls = await syncCalls();
      assert.equal(calls.length, before + 1);
      const { leaseToken, ...payload } = calls.at(-1);
      assert.deepEqual(payload, { workspacePath: project, rootPath: project, projectId: 'workbench-fixture',
        branch: 'main', action, confirm: true, ...(options.remote ? { remote: options.remote } : {}) });
      if (options.lease) assert.match(leaseToken, /^[a-f0-9]{64}$/); else assert.equal(leaseToken, undefined);
    };
    await confirmAction('Pull', 'Pull', 'pull', { cancel: true });
    await confirmAction('Pull', 'Pull', 'pull');
    await confirmAction('Pull', 'Pull (Rebase)', 'pullRebase');
    await confirmAction('Push', 'Push', 'push');
    await button('Auto-refresh off — use the refresh buttons').click();
    await status.getByText(/●\s*Watching/).waitFor();
    await confirmAction('Push', 'Push To…', 'push', { remote: 'backup', watchEdit: true });
    await button('Auto-refresh when files change on disk').click();
    await confirmAction('Fetch', 'Fetch', 'fetch', { immediate: true });
    await confirmAction('Fetch', 'Fetch From…', 'fetch', { remote: 'backup' });
    await confirmAction('Push', 'Force Push (with lease)…', 'forcePush', { lease: true });
    await button('Push').click(); await page.keyboard.press('Escape'); await focus(button('Push'));
    await railTab('Source Control').click(); await draft.waitFor();
    assert.equal(await draft.inputValue(), message);

    const hold = await holdReply('fm.git.commit');
    await sidebar.getByRole('button', { name: 'Commit staged changes (1)' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.scm-compose button')?.disabled);
    await draft.press(`${mod}+Enter`);
    await railTab('Search').click();
    await held(hold);
    assert.equal(git('show', `HEAD:${note}`).split('\n')[0], 'indexed pipeline');
    assert.equal(git('log', '-1', '--format=%s'), message);
    await releaseReply(hold);
    await status.getByText('↑2').waitFor();
    await railTab('Source Control').click();
    await sidebar.getByText('Committed locally.', { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), '');
    await scmTab('History').click();
    const detail = page.getByRole('article', { name: 'Commit details' });
    await sidebar.getByRole('button', { name: /Commit reviewed pipeline/ }).click();
    await detail.getByRole('heading', { name: message }).waitFor();

    // Git history depends on refs, not on the worktree watcher generations.
    await button('Auto-refresh off — use the refresh buttons').click();
    await status.getByText(/●\s*Watching/).waitFor();
    const historyCalls = await callsFor('fm.git.history');
    const externalFiles = ['external-history-a.txt', 'external-history-b.txt'];
    for (const [index, file] of externalFiles.entries()) {
      await write(file, 'synthetic history watch event');
      await page.locator('.fm-rail-badge').getByText(String(4 + index), { exact: true }).waitFor();
      assert.equal(await callsFor('fm.git.history'), historyCalls);
    }
    await Promise.all(externalFiles.map(file => fs.unlink(path.join(project, file))));
    await page.locator('.fm-rail-badge').getByText('3', { exact: true }).waitFor();
    assert.equal(await callsFor('fm.git.history'), historyCalls);
    await button('Auto-refresh when files change on disk').click();
    const firstCommit = strip.getByRole('tab', { name: `${git('rev-parse', '--short=7', 'HEAD')} · Commit details`, exact: true });
    await sidebar.getByRole('button', { name: /Local workbench baseline/ }).click();
    await detail.getByRole('heading', { name: 'Local workbench baseline' }).waitFor();
    const secondCommit = strip.getByRole('tab', { name: `${local.slice(0, 7)} · Commit details`, exact: true });
    await record('07-history-dark');
    await secondCommit.press('ArrowLeft'); await focus(firstCommit);
    await detail.getByRole('heading', { name: message }).waitFor();
    await doc.click();
    await editor.getByText('Draft: working pipeline', { exact: true }).waitFor();
    await wrapState(false);
    await editor.press(`${mod}+z`);
    await editor.getByText('working pipeline', { exact: true }).waitFor();
    assert.equal((await fs.readFile(path.join(project, note), 'utf8')).split('\n')[0], 'working pipeline');

    await button('Switch to the light palette').click();
    await page.locator('html[data-base="light"]').waitFor();
    await record('08-editor-light');
    await Promise.all(Array.from({ length: 101 }, (_, index) => write(`fixture-${index}.txt`, 'synthetic extra change')));
    await refresh.click();
    await page.locator('.scm-segments .fm-seg-detail').getByText('104', { exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(480, 650);
      global.testAppearance = { base: 'light', locale: 'zh-CN' };
      window.webContents.send('test:appearance:changed', global.testAppearance);
    });
    await page.getByRole('tab', { name: '源代码管理', exact: true }).waitFor();
    const narrow = await viewport();
    assert.equal(narrow.width, 480);
    assert.ok(narrow.sidebar < 220 && narrow.content > 200, JSON.stringify(narrow));
    assert.equal((await prefs()).sidebarWidth, 340, 'clamping does not overwrite the preference');
    assert.ok(await page.locator('.scm-segments button > span:not(.fm-seg-detail)').evaluateAll(labels =>
      labels.length === 3 && labels.every(label => label.clientWidth > 0 && label.scrollWidth <= label.clientWidth)), 'SCM labels must fit without ellipsis');
    await page.getByRole('tablist', { name: '视图', exact: true }).getByRole('tab', { name: '变更', exact: true }).click();
    await diffText('working pipeline').waitFor();
    await noHiddenContent();
    await record('09-diff-narrow-light');
    await button('推送').click(); await page.getByRole('menuitem', { name: '推送到…', exact: true }).click();
    await page.getByRole('dialog', { name: '推送到…', exact: true }).waitFor();
    await record('10-sync-narrow-light');
    await page.keyboard.press('Escape'); await focus(button('推送'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1250, 880));
    await page.waitForFunction(() => document.querySelector('#fm-sidebar').getBoundingClientRect().width === 340);
    assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => global.blockedPdfRequests), []);
    console.log('WORKBENCH DESKTOP PASSED: root switch, rail/search, viewport and persisted preferences, review tabs and scoped diffs, seven sync paths, delayed commit, dark/light screenshots.');
  } finally {
    try { await app?.close(); } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
