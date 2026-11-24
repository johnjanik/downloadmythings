// End-to-end smoke test: loads the built Chrome extension and drives its pages
// against a stand-in for claude.ai. No real account and no real network.
//
//   npm run build && npm run test:e2e
//
// Needs Playwright with a full Chromium (extensions do not load in the
// headless shell). Playwright is not a dependency of this project; install it
// where you run this: `npm install --no-save playwright && npx playwright install chromium`.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('Playwright is not installed. See the note at the top of tests/e2e/smoke.js.');
  process.exit(2);
}
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'chrome'));
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`No built extension at ${EXT}. Run "npm run build" first.`);
  process.exit(2);
}
const JSZip = require(path.join(EXT, 'vendor', 'jszip.min.js'));
const ORG = '11111111-1111-4111-8111-111111111111';
const IDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];

const list = [
  { uuid: IDS[0], name: 'Trip plan', model: 'claude-sonnet-4-6', project_uuid: 'p1', created_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-01T10:05:00Z' },
  { uuid: IDS[1], name: 'Trip plan', model: 'claude-opus-5-5', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-02T10:05:00Z' },
  { uuid: IDS[2], name: 'Budget: Q4/Q1?', model: null, created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:05:00Z' },
];
const full = (c, withArtifact) => ({
  ...c,
  current_leaf_message_uuid: 'm2',
  chat_messages: [
    { uuid: 'm1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: `Question in ${c.uuid}` }] },
    { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', content: [{ type: 'text', text: 'Answer. ' + (withArtifact ? '<antArtifact identifier="a" type="application/vnd.ant.code" language="python" title="script">print(1)</antArtifact>' : '') }] },
  ],
});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dmt-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let blockExtensionPages = false; // when true, direct calls from extension pages get HTTP 403
  const apiCalls = [];
  await context.route('https://claude.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let from = '';
    try { from = request.frame().url(); } catch (e) { /* service worker */ }
    if (!url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>stand-in</title></head><body>stand-in for claude.ai</body></html>' });
    }
    apiCalls.push({ path: url.pathname, from: from.startsWith('chrome-extension://') ? 'extension' : 'tab' });
    if (blockExtensionPages && from.startsWith('chrome-extension://')) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
    }
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/organizations') return json([{ uuid: 'api-org', capabilities: ['api'] }, { uuid: ORG, capabilities: ['chat'] }]);
    if (url.pathname === `/api/organizations/${ORG}/chat_conversations`) return json(list);
    if (url.pathname === `/api/organizations/${ORG}/projects`) return json([{ uuid: 'p1', name: 'Alpha project' }]);
    const m = url.pathname.match(/chat_conversations\/([a-f0-9-]+)$/);
    if (m) { const c = list.find((x) => x.uuid === m[1]); if (c) return json(full(c, c.uuid !== IDS[2])); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const pageErrors = [];
  const watch = (page, label) => {
    page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label} console: ${m.text()}`); });
  };
  const readDownload = async (download) => { const p = await download.path(); return { name: download.suggestedFilename(), data: fs.readFileSync(p) }; };

  // --- 1. Browse page with NO claude.ai tab open: direct calls
  const browse = await context.newPage(); watch(browse, 'browse');
  await browse.goto(`chrome-extension://${extId}/browse.html`);
  await browse.waitForSelector('#tableContent table tbody tr', { timeout: 15000 });
  const rows = await browse.locator('#tableContent tbody tr').count();
  check('browse page lists conversations without a claude.ai tab', rows === 3, `${rows} rows`);
  check('browse page title is rebranded', (await browse.title()).includes('DownloadMyThings'));
  const stats = await browse.locator('#stats').textContent();
  check('stats show all conversations as new', /Showing 3 of 3 conversations \(3 new\/updated\)/.test(stats), stats.trim());
  const tableText = await browse.locator('#tableContent').textContent();
  check('project name resolved from the projects call', tableText.includes('Alpha project'));
  check('calls came from the extension page itself', apiCalls.length > 0 && apiCalls.every((c) => c.from === 'extension'), `${apiCalls.length} calls`);

  // --- 2. Single export (JSON, default)
  const [d1] = await Promise.all([browse.waitForEvent('download'), browse.locator('.btn-export').first().click()]);
  const f1 = await readDownload(d1);
  const firstRowId = await browse.locator('#tableContent tbody tr').first().getAttribute('data-id');
  check('single export downloads a JSON file named after the chat', /\.json$/.test(f1.name), f1.name);
  check('single export contains the conversation', JSON.parse(f1.data.toString()).uuid === firstRowId);
  await browse.waitForFunction(() => /\(2 new\/updated\)/.test(document.getElementById('stats').textContent), null, { timeout: 5000 });
  check('exported chat is no longer marked new', true);

  // --- 3. Bulk export: Markdown + nested artifacts
  await browse.selectOption('#exportFormat', 'markdown');
  await browse.check('#extractArtifacts');
  const [d2] = await Promise.all([browse.waitForEvent('download'), browse.locator('#exportAllBtn').click()]);
  const f2 = await readDownload(d2);
  const zip = await JSZip.loadAsync(f2.data);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  console.log('      zip:', f2.name, JSON.stringify(names));
  check('bulk export ZIP uses the new brand in its filename', /^downloadmythings-export-\d{8}-\d{6}\.zip$/.test(f2.name), f2.name);
  check('same-titled chats get separate folders', names.includes('Trip plan/Trip plan.md') && names.includes('Trip plan (2)/Trip plan (2).md'));
  check('artifacts land in an artifacts/ subfolder', names.includes('Trip plan/artifacts/script.py'));
  check('unsafe title characters are replaced', names.includes('Budget_ Q4_Q1_/Budget_ Q4_Q1_.md'));
  const md = await zip.file('Trip plan/Trip plan.md').async('string');
  check('markdown transcript has the question', md.includes('Question in aaaaaaaa'));
  await browse.waitForFunction(() => /\(0 new\/updated\)/.test(document.getElementById('stats').textContent), null, { timeout: 5000 });
  check('all chats marked exported after bulk export', true);

  // --- 4. Chats off + flat artifacts: only chats with artifacts, artifacts-only filename
  await browse.uncheck('#extractArtifacts');
  await browse.check('#flattenArtifacts');
  await browse.uncheck('#includeChats');
  const [d3] = await Promise.all([browse.waitForEvent('download'), browse.locator('#exportAllBtn').click()]);
  const f3 = await readDownload(d3);
  const names3 = Object.keys((await JSZip.loadAsync(f3.data)).files).filter((n) => !n.endsWith('/')).sort();
  check('artifacts-only export', /^downloadmythings-artifacts-/.test(f3.name) && names3.join('|') === 'Artifacts/Trip plan (2)_script.py|Artifacts/Trip plan_script.py', `${f3.name} ${JSON.stringify(names3)}`);

  // --- 5. Relay fallback: extension-page calls are refused, a claude.ai tab is open
  const claude = await context.newPage(); watch(claude, 'claude tab');
  await claude.goto(`https://claude.ai/chat/${IDS[0]}`);
  blockExtensionPages = true; apiCalls.length = 0;
  await browse.reload();
  await browse.waitForSelector('#tableContent table tbody tr', { timeout: 15000 });
  check('browse page falls back to the claude.ai tab when direct calls fail',
    (await browse.locator('#tableContent tbody tr').count()) === 3 && apiCalls.some((c) => c.from === 'tab'),
    JSON.stringify(apiCalls.map((c) => c.from)));
  await browse.uncheck('#flattenArtifacts'); await browse.check('#includeChats');
  const [d4] = await Promise.all([browse.waitForEvent('download'), browse.locator('.btn-export').first().click()]);
  check('single export also works through the relay', /\.json$/.test((await readDownload(d4)).name));
  blockExtensionPages = false;

  // --- 6. Popup: export the conversation open in the claude.ai tab
  const popup = await context.newPage(); watch(popup, 'popup');
  await popup.addInitScript(() => {
    // The popup is opened as a tab here, so "the active tab" must point at the claude.ai tab
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => (q.active ? realQuery({ url: 'https://claude.ai/*' }, cb) : realQuery(q, cb));
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  check('popup shows name and version from the manifest',
    (await popup.locator('#header-title').textContent()) === 'DownloadMyThings' && /^v\d+\.\d+\.\d+$/.test(await popup.locator('#header-version').textContent()));
  await popup.selectOption('#format', 'text');
  const [d5] = await Promise.all([claude.waitForEvent('download'), popup.locator('#exportCurrent').click()]);
  const f5 = await readDownload(d5);
  check('popup exports the open conversation from the claude.ai tab', f5.name === 'Trip plan.txt' && f5.data.toString().includes('User: Question in'), f5.name);
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('exported successfully'), null, { timeout: 5000 });

  // Re-inject the content script (as after an update); exactly one copy must answer
  const tabId = await popup.evaluate(() => new Promise((r) => chrome.tabs.query({ url: 'https://claude.ai/*' }, (t) => r(t[0].id))));
  const injected = await popup.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ action: 'ensureContentScript', tabId: id }, r)), tabId);
  check('background re-injects the content script on request', injected && injected.success === true, JSON.stringify(injected));
  let downloads = 0; const count = () => { downloads++; }; claude.on('download', count);
  await popup.locator('#exportCurrent').click();
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('exported successfully'), null, { timeout: 5000 });
  await claude.waitForTimeout(800);
  check('after re-injection one export produces one download', downloads === 1, `${downloads} downloads`);
  claude.off('download', count);

  // Popup "Export All" with chats off and no artifact files: nothing to export, no network
  await popup.uncheck('#includeChats');
  apiCalls.length = 0;
  await popup.locator('#exportAll').click();
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('Nothing to export'), null, { timeout: 5000 });
  check('popup reports "nothing to export" without listing conversations first',
    !apiCalls.some((c) => c.path.endsWith('/chat_conversations')), JSON.stringify(apiCalls.map((c) => c.path)));

  // --- 7. Options page
  const options = await context.newPage(); watch(options, 'options');
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForFunction(() => document.getElementById('orgId').value.length > 0, null, { timeout: 5000 });
  check('options shows the auto-detected organization ID', (await options.inputValue('#orgId')) === ORG);
  await options.locator('#testBtn').click();
  await options.waitForFunction(() => /Found 3 conversations/.test(document.getElementById('testStatus').textContent), null, { timeout: 5000 });
  check('options "Test Connection" works', true);
  check('options links to our issue tracker, not upstream\'s email',
    (await options.locator('a[href="https://github.com/johnjanik/downloadmythings/issues"]').count()) === 1 && !(await options.content()).includes('mailto:'));

  // --- 8. Pages are not reachable from websites
  const probe = await claude.evaluate(async (id) => {
    try { const r = await fetch(`chrome-extension://${id}/browse.html`); return `fetched ${r.status}`; } catch (e) { return 'blocked'; }
  }, extId);
  check('a website cannot load browse.html', probe === 'blocked', probe);

  // Errors this test causes on purpose: refused direct calls (step 5) and the
  // blocked fetch of an extension page from a website (step 8).
  const expected = (e) => /403/.test(e) || /net::ERR_FAILED/.test(e);
  const unexpected = pageErrors.filter((e) => !expected(e));
  check('no unexpected page errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 600));

  await context.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
