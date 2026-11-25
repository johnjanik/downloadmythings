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
    {
      uuid: 'm1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: `Question in ${c.uuid}` }],
      // Only the first conversation carries uploads: the PDF from the stand-in project and some pasted text
      files: c.uuid === IDS[0] ? [{ file_uuid: 'f1', file_name: 'handbook.pdf', file_kind: 'document' }] : [],
      attachments: c.uuid === IDS[0] ? [{ file_name: 'pasted.txt', extracted_content: 'pasted words' }] : [],
    },
    { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', content: [{ type: 'text', text: 'Answer. ' + (withArtifact ? '<antArtifact identifier="a" type="application/vnd.ant.code" language="python" title="script">print(1)</antArtifact>' : HOSTILE_MARKDOWN) }] },
  ],
});

// Stand-in project: one file of each kind a real project tends to hold
const PDF_BYTES = Buffer.from('%PDF-1.7 stand-in handbook');
const WEBP_BYTES = Buffer.from('RIFF....WEBP stand-in preview');
const sha256 = (data) => require('crypto').createHash('sha256').update(data).digest('hex');
const projectList = [
  { uuid: 'p1', name: 'Alpha project', description: 'Launch work', created_at: '2026-01-05T09:00:00Z', updated_at: '2026-03-01T10:05:00Z' },
  { uuid: 'p2', name: 'Beta', created_at: '2026-02-05T09:00:00Z', updated_at: '2026-02-06T09:00:00Z' },
];
const projectDocs = [{ file_name: 'brief.md', content: '# Brief' }, { file_name: 'meeting-notes.docx', content: 'extracted words' }];
const projectFiles = [
  { file_uuid: 'f1', file_name: 'handbook.pdf' },      // served in full by the contents endpoint
  { file_uuid: 'f2', file_name: 'diagram.png' },       // only a WebP preview is served
  { file_uuid: 'f3', file_name: 'budget.xlsx' },       // nothing is served
  { file_uuid: 'f4', file_name: 'meeting-notes.docx' } // only its extracted text exists
];

// A reply that tries everything a transcript renderer must not fall for
const HOSTILE_MARKDOWN = [
  'Totals below.', '',
  '<script>window.__xss = 1</script> <img src="https://claude.ai/pixel.png" onerror="window.__xss = 1">', '',
  '![remote image](https://claude.ai/remote.png)', '',
  '[bad link](javascript:window.__xss=1) and [good link](https://example.com/report)', '',
  '| Quarter | Total |', '| --- | --- |', '| Q4 | 12 |', '',
  '```js', 'const x = "<b>not bold</b>";', '```',
].join('\n');

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

  // Headless Chromium has no print dialog: count the calls instead
  await context.addInitScript(() => { window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; }; });
  const pageRequests = []; // non-API requests to the stand-in, such as images a page tried to load

  let blockExtensionPages = false; // when true, direct calls from extension pages get HTTP 403
  const apiCalls = [];
  const writes = []; // every call that would change the account: "METHOD path"
  const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await context.route('https://claude.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let from = '';
    try { from = request.frame().url(); } catch (e) { /* service worker */ }
    if (!url.pathname.startsWith('/api/')) {
      pageRequests.push(url.pathname);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>stand-in</title></head><body>stand-in for claude.ai</body></html>' });
    }
    apiCalls.push({ path: url.pathname, from: from.startsWith('chrome-extension://') ? 'extension' : 'tab' });
    if (blockExtensionPages && from.startsWith('chrome-extension://')) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
    }
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/organizations') return json([{ uuid: 'api-org', capabilities: ['api'] }, { uuid: ORG, capabilities: ['chat'] }]);
    if (url.pathname === `/api/organizations/${ORG}/chat_conversations`) return json(list);
    const bin = (body, type) => route.fulfill({ status: 200, contentType: type, body });
    if (url.pathname === `/api/organizations/${ORG}/projects`) return json(projectList);
    if (url.pathname === `/api/organizations/${ORG}/memories`) return json([{ uuid: 'mem-1', content: 'Prefers short answers' }]);
    if (url.pathname === `/api/organizations/${ORG}/usage`) {
      return json({ five_hour: { utilization: 37.4, resets_at: hoursFromNow(2.5) }, seven_day: { utilization: 91, resets_at: hoursFromNow(70) }, seven_day_opus: null });
    }
    // The calls that change the account. This stand-in does not know the batch
    // move call, so the extension has to fall back to moving chats one by one.
    const method = request.method();
    if (method !== 'GET') {
      writes.push(`${method} ${url.pathname.replace(`/api/organizations/${ORG}`, '')}`);
      const target = url.pathname.match(/chat_conversations\/([a-f0-9-]+)$/);
      const conv = target && list.find((x) => x.uuid === target[1]);
      if (method === 'PUT' && conv) { Object.assign(conv, JSON.parse(request.postData() || '{}')); return json(conv); }
      if (method === 'DELETE' && conv) { list.splice(list.indexOf(conv), 1); return route.fulfill({ status: 204, body: '' }); }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname === `/api/organizations/${ORG}/projects/p1`) return json({ ...projectList[0], prompt_template: 'Always answer in French.' });
    if (url.pathname === `/api/organizations/${ORG}/projects/p2`) return json(projectList[1]);
    if (url.pathname === `/api/organizations/${ORG}/projects/p1/docs`) return json(projectDocs);
    if (url.pathname === `/api/organizations/${ORG}/projects/p1/files`) return json(projectFiles);
    if (/\/projects\/p2\/(docs|files)$/.test(url.pathname)) return json([]);
    if (url.pathname === `/api/organizations/${ORG}/files/f1/contents`) return bin(PDF_BYTES, 'application/pdf');
    if (url.pathname === `/api/${ORG}/files/f2/preview`) return bin(WEBP_BYTES, 'image/webp');
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
  await browse.locator('.view-tab[data-view="projects"]').click();
  const [d4p] = await Promise.all([browse.waitForEvent('download'), browse.locator('tr[data-id="p1"] .btn-export-project').click()]);
  const relayZip = await JSZip.loadAsync((await readDownload(d4p)).data);
  const relayedPdf = await relayZip.file('files/handbook.pdf').async('nodebuffer');
  check('file bytes survive the relay unchanged', sha256(relayedPdf) === sha256(PDF_BYTES));
  await browse.locator('.view-tab[data-view="conversations"]').click();
  blockExtensionPages = false;

  // --- 6. The panel, opened as a tab while a claude.ai conversation is the "active tab"
  const unzip = async (download) => {
    const file = await readDownload(download);
    const archive = await JSZip.loadAsync(file.data);
    return { name: file.name, archive, files: Object.keys(archive.files).filter((n) => !archive.files[n].dir).sort() };
  };
  const panel = await context.newPage(); watch(panel, 'panel');
  await panel.addInitScript(() => {
    // The panel is opened as a tab here, so "the active tab" must point at the claude.ai tab
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => (q.active ? realQuery({ url: 'https://claude.ai/*' }, cb) : realQuery(q, cb));
  });
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForFunction(() => /files/.test(document.getElementById('projectCounts').textContent) && !/Counting/.test(document.getElementById('projectCounts').textContent), null, { timeout: 15000 });
  check('panel shows its version and the open conversation',
    /^v\d+\.\d+\.\d+$/.test(await panel.locator('#versionLabel').textContent())
      && (await panel.locator('#chatCard').isVisible()) && (await panel.locator('#chatName').textContent()) === 'Trip plan');
  check('panel picks the open conversation\'s project and counts its files and chats',
    (await panel.locator('#projectName').textContent()) === 'Alpha project'
      && (await panel.locator('#projectCounts').textContent()) === '5 files · 1 chat',
    await panel.locator('#projectCounts').textContent());

  // Limits and sizes
  await panel.waitForFunction(() => document.querySelectorAll('#usageRows .meter').length === 2 && !document.getElementById('chatSize').hidden, null, { timeout: 15000 });
  const meters = await panel.evaluate(() => Array.from(document.querySelectorAll('#usageRows .meter')).map((meter) => ({
    text: meter.querySelector('.meter-row').textContent, hint: meter.querySelector('.hint').textContent,
    width: meter.querySelector('.progress-bar').style.width, high: meter.querySelector('.progress-bar').classList.contains('high'),
  })));
  check('the limits card shows the session and the week as claude.ai reports them',
    meters[0].text === 'Current session (5 hours)37%' && meters[0].width === '37%' && /^resets in 2 h (29|30) min$/.test(meters[0].hint) && !meters[0].high
      && meters[1].text === 'This week, all models91%' && meters[1].high && meters[1].hint === 'resets in 3 days',
    JSON.stringify(meters));
  check('the open conversation shows an estimate of its size',
    /^About \d+ tokens$/.test(await panel.locator('#chatSizeLabel').textContent()) && (await panel.locator('#chatSizePercent').textContent()) === '0% of a 200k window',
    await panel.locator('#chatSizeLabel').textContent());

  await panel.locator('#sizeBox summary').click();
  const sizes = await panel.evaluate(() => ({
    summary: document.getElementById('sizeSummary').textContent,
    rows: Array.from(document.querySelectorAll('#sizeList li')).map((row) => `${row.querySelector('.name').textContent}: ${row.querySelector('.meta').textContent}`),
  }));
  check('"What is filling this project" ranks the files by size and says which have none',
    sizes.summary === 'About 6 tokens of text in 5 files, largest first. claude.ai gives no size for 3 of them.'
      && sizes.rows[0] === 'meeting-notes.docx: About 4 tokens · 67% of the total' && sizes.rows[1] === 'brief.md: About 2 tokens · 33% of the total'
      && sizes.rows[2] === 'budget.xlsx: Size not reported',
    JSON.stringify(sizes));
  await panel.locator('#sizeList li', { hasText: 'brief.md' }).locator('input').check();
  await panel.locator('#sizeList li', { hasText: 'handbook.pdf' }).locator('input').check();
  const [pTicked] = await Promise.all([panel.waitForEvent('download'), panel.locator('#backupTicked', { hasText: 'Back up ticked files (2)' }).click()]);
  const tickedZip = await unzip(pTicked);
  check('"Back up ticked files" saves just those files',
    tickedZip.name === 'Alpha project_selected-files.zip' && JSON.stringify(tickedZip.files) === JSON.stringify(['files/brief.md', 'files/handbook.pdf', 'manifest.json']),
    `${tickedZip.name} ${JSON.stringify(tickedZip.files)}`);
  await panel.waitForFunction(() => document.getElementById('progressCard').hidden);
  await panel.locator('#sizeBox summary').click();

  // Dropdown lists are drawn by the browser: the control and its rows need solid, contrasting colours
  const dropdowns = await panel.evaluate(() => {
    const parse = (value) => { const m = value.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const luminance = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return Array.from(document.querySelectorAll('select')).filter((select) => select.options.length > 0).map((select) => {
      const row = select.options[0];
      const background = parse(getComputedStyle(row).backgroundColor);
      const text = parse(getComputedStyle(row).color);
      const [hi, lo] = [luminance(background), luminance(text)].sort((a, b) => b - a);
      return { id: select.id, rowOpaque: background.a === 1, controlOpaque: parse(getComputedStyle(select).backgroundColor).a === 1, contrast: (hi + 0.05) / (lo + 0.05) };
    });
  });
  check('every dropdown and its list rows have solid, readable colours',
    dropdowns.length >= 4 && dropdowns.every((d) => d.rowOpaque && d.controlOpaque && d.contrast >= 4.5),
    JSON.stringify(dropdowns.map((d) => [d.id, d.rowOpaque, d.controlOpaque, Math.round(d.contrast * 10) / 10])));

  const [p1] = await Promise.all([panel.waitForEvent('download'), panel.locator('#downloadChat').click()]);
  const chatFile = await readDownload(p1);
  check('"Download this chat" saves Markdown from the panel itself', chatFile.name === 'Trip plan.md' && chatFile.data.toString().includes('Question in'), chatFile.name);

  const [p2] = await Promise.all([panel.waitForEvent('download'), panel.locator('#downloadProject').click()]);
  const whole = await unzip(p2);
  check('"Download Entire Project" saves instructions, files, chats and a manifest',
    whole.name === 'Alpha project.zip' && ['instructions.md', 'files/brief.md', 'files/handbook.pdf', 'chats/Trip plan.md', 'manifest.json'].every((n) => whole.files.includes(n)),
    `${whole.name} ${JSON.stringify(whole.files)}`);
  await panel.waitForSelector('#recoveryCard:not([hidden])');
  const recovery = { text: await panel.locator('#recoveryText').textContent(), prompt: await panel.inputValue('#recoveryPrompt') };
  check('files not saved as originals come with a prompt that asks Claude for them',
    /^3 files could not be saved in the original format/.test(recovery.text)
      && ['- meeting-notes.docx', '- diagram.png', '- budget.xlsx'].every((line) => recovery.prompt.includes(line))
      && !recovery.prompt.includes('handbook.pdf') && !recovery.prompt.includes('brief.md'),
    recovery.text);

  // Hand-off to Claude Code
  const [pcc] = await Promise.all([panel.waitForEvent('download'), panel.locator('#moveToClaudeCode').click()]);
  const handoff = await unzip(pcc);
  await panel.waitForSelector('#handoffCard:not([hidden])', { timeout: 5000 });
  check('"Move to Claude Code" lays the project out as CLAUDE.md, docs/ and chats/, then offers a prompt',
    handoff.name === 'Alpha project_claude-code.zip'
      && ['CLAUDE.md', 'docs/brief.md', 'docs/handbook.pdf', 'chats/Trip plan.md', 'manifest.json'].every((n) => handoff.files.includes(n))
      && !handoff.files.includes('instructions.md')
      && (await handoff.archive.file('CLAUDE.md').async('string')).includes('Always answer in French.')
      && /Read CLAUDE\.md first/.test(await panel.inputValue('#handoffPrompt'))
      && (await panel.locator('#handoffText').textContent()) === 'Unzip Alpha project_claude-code.zip into an empty folder, start Claude Code there, and paste this prompt.',
    `${handoff.name} ${JSON.stringify(handoff.files)}`);

  // Export settings: a ZIP name and the Markdown file format
  await panel.locator('#settingsBox summary').click();
  await panel.fill('#zipName', 'backup');
  await panel.selectOption('#fileFormat', 'markdown');
  const [p3] = await Promise.all([panel.waitForEvent('download'), panel.locator('#downloadFiles').click()]);
  const filesOnly = await unzip(p3);
  check('"Download All Files" uses the chosen ZIP name and saves text as Markdown',
    filesOnly.name === 'backup_files.zip'
      && JSON.stringify(filesOnly.files) === JSON.stringify(['files/brief.md', 'files/diagram.webp', 'files/handbook.pdf', 'files/meeting-notes.docx.md', 'manifest.json']),
    `${filesOnly.name} ${JSON.stringify(filesOnly.files)}`);

  // A date range that leaves the project's only chat out
  await panel.fill('#dateFrom', '2027-01-01');
  const [p4] = await Promise.all([panel.waitForEvent('download'), panel.locator('#downloadChats').click()]);
  const chatsOnly = await unzip(p4);
  check('"Download All Chats" honours the date range', chatsOnly.name === 'backup_chats.zip' && JSON.stringify(chatsOnly.files) === JSON.stringify(['manifest.json']), JSON.stringify(chatsOnly.files));
  await panel.fill('#dateFrom', '');
  await panel.fill('#zipName', '');
  await panel.selectOption('#fileFormat', 'native');

  // Obsidian front matter on Markdown chats
  await panel.check('#frontMatter');
  const [pfm] = await Promise.all([panel.waitForEvent('download'), panel.locator('#downloadChat').click()]);
  const withFrontMatter = (await readDownload(pfm)).data.toString();
  check('front matter puts title, dates and link at the top of a Markdown chat',
    withFrontMatter.startsWith('---\ntitle: "Trip plan"\n') && withFrontMatter.includes(`source: "https://claude.ai/chat/${IDS[0]}"`) && withFrontMatter.includes('\n---\n\n# Trip plan'),
    withFrontMatter.slice(0, 80));
  await panel.uncheck('#frontMatter');

  // Files and Chats explorer
  await panel.locator('#filesBox summary').click();
  check('explorer lists the project\'s files and chats',
    (await panel.locator('#filesList li').count()) === 5 && (await panel.locator('#chatsList li').count()) === 1
      && (await panel.locator('#filesCount').textContent()) === '5');
  const [p5] = await Promise.all([panel.waitForEvent('download'), panel.locator('#filesList li', { hasText: 'brief.md' }).locator('button').click()]);
  check('a single file downloads from the explorer', (await readDownload(p5)).name === 'brief.md');

  // Export everything
  const [p6] = await Promise.all([panel.waitForEvent('download'), panel.locator('#everythingButton').click()]);
  const everything = await unzip(p6);
  const accountManifest = JSON.parse(await everything.archive.file('manifest.json').async('string'));
  check('"Export everything" saves every project and every other chat in one ZIP',
    /^downloadmythings-everything-\d{8}-\d{6}\.zip$/.test(everything.name)
      && ['Projects/Alpha project/instructions.md', 'Projects/Alpha project/chats/Trip plan.md', 'Projects/Beta/manifest.json', 'Chats/Trip plan.md', 'Chats/Budget_ Q4_Q1_.md', 'memory.json', 'manifest.json'].every((n) => everything.files.includes(n)),
    `${everything.name} ${JSON.stringify(everything.files)}`);
  check('the account manifest counts what was saved and names what was not',
    accountManifest.counts.projects === 2 && accountManifest.counts.otherChats === 2 && accountManifest.memory === 'memory.json'
      && accountManifest.notIncluded.some((item) => item.what === 'styles') && accountManifest.parts.length === 1,
    JSON.stringify(accountManifest.counts));
  await panel.waitForFunction(() => /Saved 2 projects and 2 other chats in 1 ZIP file/.test(document.getElementById('notice').textContent), null, { timeout: 5000 });

  // Sync to a folder. The folder picker cannot be driven from a test, so the
  // engine runs against the browser's private file system: the same file API.
  check('folder sync is offered in the tab view, waiting for a folder',
    (await panel.locator('#syncCard').isVisible()) && (await panel.locator('#chooseSyncFolder').isVisible()) && (await panel.locator('#syncNow').isDisabled()));
  const syncRun = () => panel.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const target = await root.getDirectoryHandle('sync-test', { create: true });
    const result = await syncAccountToFolder(state.orgId, target, state.projects, state.conversations, { format: 'markdown' }, {});
    const walk = async (handle, prefix) => {
      const found = [];
      for await (const [name, child] of handle.entries()) {
        if (child.kind === 'directory') found.push(...await walk(child, `${prefix}${name}/`));
        else found.push(`${prefix}${name}`);
      }
      return found;
    };
    const files = (await walk(target, '')).sort();
    const pdf = await (await (await (await (await (await target.getDirectoryHandle('Projects')).getDirectoryHandle('Alpha project')).getDirectoryHandle('files')).getFileHandle('handbook.pdf')).getFile()).arrayBuffer();
    return { counts: result.counts, failures: result.failures.map((f) => f.name), files, pdf: Array.from(new Uint8Array(pdf)) };
  });
  apiCalls.length = 0;
  const firstSync = await syncRun();
  check('first sync writes the account as ordinary files',
    JSON.stringify(firstSync.files) === JSON.stringify([
      '.downloadmythings/sync-index.json', 'Chats/Budget_ Q4_Q1_.md', 'Chats/Trip plan.md',
      'Projects/Alpha project/chats/Trip plan.md', 'Projects/Alpha project/files/brief.md', 'Projects/Alpha project/files/diagram.webp',
      'Projects/Alpha project/files/handbook.pdf', 'Projects/Alpha project/files/meeting-notes.docx.txt', 'Projects/Alpha project/instructions.md',
    ]) && firstSync.counts.written === 8 && JSON.stringify(firstSync.failures) === JSON.stringify(['budget.xlsx']),
    JSON.stringify([firstSync.counts, firstSync.failures, firstSync.files]));
  check('a synced file is byte-identical to what was served', sha256(Buffer.from(firstSync.pdf)) === sha256(PDF_BYTES));
  apiCalls.length = 0;
  const secondSync = await syncRun();
  check('a second sync reads no chat and writes nothing',
    secondSync.counts.written === 0 && secondSync.counts.unchanged === 8
      && apiCalls.filter((c) => /chat_conversations\/[0-9a-f-]+$/.test(c.path) || /\/files\/f1\/contents$/.test(c.path)).length === 0,
    JSON.stringify([secondSync.counts, apiCalls.length]));

  // Backups: chosen projects now, then the schedule, then a scheduled run
  await panel.selectOption('#backupScope', 'projects');
  await panel.waitForSelector('#backupProjects li');
  check('"Projects I choose" lists the projects and waits for a choice',
    (await panel.locator('#backupProjects li').count()) === 2 && (await panel.locator('#backupNow').isDisabled()));
  await panel.locator('#backupProjects li', { hasText: 'Alpha project' }).locator('input').check();
  await panel.waitForFunction(() => !document.getElementById('backupNow').disabled);
  const [pb] = await Promise.all([panel.waitForEvent('download'), panel.locator('#backupNow').click()]);
  const chosenBackup = await unzip(pb);
  check('"Back up now" saves the chosen projects in a dated ZIP, one folder each',
    /^downloadmythings-backup-\d{8}-\d{6}\.zip$/.test(chosenBackup.name)
      && chosenBackup.files.includes('Alpha project/instructions.md') && chosenBackup.files.includes('Alpha project/manifest.json')
      && !chosenBackup.files.some((n) => n.startsWith('Beta/')),
    `${chosenBackup.name} ${JSON.stringify(chosenBackup.files)}`);
  await panel.waitForFunction(() => /^Last backup .*: Saved downloadmythings-backup-/.test(document.getElementById('backupLast').textContent), null, { timeout: 5000 });
  check('the card records when the last backup ran and what it saved', true);

  const backupAlarm = () => sw.evaluate(() => chrome.alarms.get('dmt-backup'));
  await panel.selectOption('#backupSchedule', 'daily');
  let alarm = await backupAlarm();
  for (let i = 0; i < 20 && !alarm; i++) { await panel.waitForTimeout(100); alarm = await backupAlarm(); }
  check('a daily schedule sets a daily alarm', Boolean(alarm) && alarm.periodInMinutes === 1440, JSON.stringify(alarm));
  await panel.selectOption('#backupSchedule', 'off');
  for (let i = 0; i < 20 && alarm; i++) { await panel.waitForTimeout(100); alarm = await backupAlarm(); }
  check('switching the schedule off clears the alarm', !alarm, JSON.stringify(alarm));

  // What the alarm does: open the panel with #backup-run, which backs up and closes itself
  await panel.selectOption('#backupScope', 'everything');
  await panel.waitForFunction(() => document.getElementById('backupProjects').hidden);
  const scheduled = await context.newPage(); watch(scheduled, 'scheduled backup');
  const [ps] = await Promise.all([scheduled.waitForEvent('download', { timeout: 30000 }), scheduled.goto(`chrome-extension://${extId}/panel.html#backup-run`)]);
  const scheduledName = ps.suggestedFilename();
  const closed = await scheduled.waitForEvent('close', { timeout: 25000 }).then(() => true, () => false);
  const recorded = await panel.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['backup'], (r) => resolve(r.backup))));
  check('a scheduled run backs everything up without anyone clicking, records it, and closes its tab',
    /^downloadmythings-everything-/.test(scheduledName) && closed && /^Saved 2 projects and 2 other chats/.test(recorded.lastResult),
    `${scheduledName} closed=${closed} ${recorded.lastResult}`);

  // Library
  await panel.locator('.tab[data-tab="library"]').click();
  check('library lists every chat with its project', (await panel.locator('#libraryList li').count()) === 3
    && (await panel.locator('#libraryCount').textContent()) === '3 chats'
    && (await panel.locator(`#libraryList li[data-id="${IDS[0]}"] .meta`).textContent()) === 'Alpha project');
  await panel.fill('#librarySearch', 'budget');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 1);
  check('library search narrows the list', (await panel.locator('#libraryCount').textContent()) === '1 of 3 chats');
  await panel.fill('#librarySearch', '');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 3);
  // Search inside messages: opt in, let the index build, then find words that are in no title
  check('search inside messages is offered, not switched on by itself',
    (await panel.locator('#deepSearchOffer').isVisible()) && !(await panel.locator('#deepSearchStatus').isVisible()));
  apiCalls.length = 0;
  await panel.locator('#enableDeepSearch').click();
  await panel.waitForFunction(() => /Searching inside all 3 chats/.test(document.getElementById('deepSearchStatus').textContent), null, { timeout: 15000 });
  check('the index reads each chat once', apiCalls.filter((c) => /chat_conversations\/[0-9a-f-]+$/.test(c.path)).length === 3, `${apiCalls.length} calls`);
  await panel.fill('#librarySearch', 'totals below');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 1);
  check('a phrase from inside a message finds its chat and shows where',
    (await panel.locator('#libraryList li').getAttribute('data-id')) === IDS[2] && /Totals below/.test(await panel.locator('#libraryList .snippet').textContent()),
    await panel.locator('#libraryList .snippet').textContent());
  await panel.fill('#librarySearch', '"question in" trip');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 2);
  check('every term must match, across title and messages', true);
  await panel.fill('#librarySearch', 'totals trip');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 0);
  await panel.fill('#librarySearch', '');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 3);
  // Reopening the Library must not read the chats again
  apiCalls.length = 0;
  await panel.locator('.tab[data-tab="export"]').click();
  await panel.locator('.tab[data-tab="library"]').click();
  await panel.waitForTimeout(600);
  check('an up-to-date index is not rebuilt', apiCalls.filter((c) => /chat_conversations\/[0-9a-f-]+$/.test(c.path)).length === 0, JSON.stringify(apiCalls.map((c) => c.path)));

  await panel.check('#librarySelectAll');
  check('select all ticks every chat shown', (await panel.locator('#libraryExport').textContent()) === 'Export selected (3)');
  const [p7] = await Promise.all([panel.waitForEvent('download'), panel.locator('#libraryExport').click()]);
  const picked = await unzip(p7);
  check('library exports the selected chats as one ZIP',
    /^downloadmythings-export-/.test(picked.name) && JSON.stringify(picked.files) === JSON.stringify(['Budget_ Q4_Q1_.md', 'Trip plan (2).md', 'Trip plan.md']),
    JSON.stringify(picked.files));
  await panel.waitForFunction(() => document.getElementById('progressCard').hidden);

  // Folders: the user's own grouping, kept in the extension
  await panel.uncheck('#librarySelectAll');
  check('with nothing ticked there is no action menu, and no folder filter before a folder exists',
    !(await panel.locator('#libraryActions').isVisible()) && !(await panel.locator('#libraryFolder').isVisible()));
  await panel.locator('#manageFolders').click();
  await panel.fill('#newFolderName', '  Travel   plans ');
  await panel.locator('#addFolder').click();
  await panel.waitForSelector('#foldersList li');
  const folderOptions = () => panel.evaluate(() => Array.from(document.getElementById('libraryFolder').options).map((option) => option.textContent));
  check('a new folder appears in the list and in the filter, with a tidy name',
    (await panel.locator('#foldersList li .name').textContent()) === 'Travel plans'
      && JSON.stringify(await folderOptions()) === JSON.stringify(['All chats (3)', 'Travel plans (0)', 'Not in a folder (3)']),
    JSON.stringify(await folderOptions()));

  await panel.locator(`#libraryList li[data-id="${IDS[0]}"] input`).check();
  await panel.locator(`#libraryList li[data-id="${IDS[2]}"] input`).check();
  const actionLabels = await panel.evaluate(() => Array.from(document.getElementById('libraryAction').children).map((child) => (child.label || child.textContent)));
  check('ticked chats get one menu: folders, projects, delete',
    JSON.stringify(actionLabels) === JSON.stringify(['With the 2 ticked chats...', 'Put in a folder', 'Move to a project on claude.ai', 'Delete from claude.ai...']),
    JSON.stringify(actionLabels));
  await panel.selectOption('#libraryAction', { label: 'Travel plans' });
  await panel.waitForFunction(() => /Put 2 chats in "Travel plans"/.test(document.getElementById('notice').textContent));
  check('filing chats shows the folder on each row and counts it',
    (await panel.locator(`#libraryList li[data-id="${IDS[0]}"] .meta`).first().textContent()) === 'Alpha project · Folder: Travel plans'
      && (await panel.locator(`#libraryList li[data-id="${IDS[2]}"] .meta`).first().textContent()) === 'Folder: Travel plans'
      && (await folderOptions())[1] === 'Travel plans (2)' && writes.length === 0,
    JSON.stringify(await folderOptions()));
  await panel.selectOption('#libraryFolder', { label: 'Travel plans (2)' });
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 2);
  check('the filter shows one folder at a time', (await panel.locator('#libraryCount').textContent()) === '2 of 3 chats');
  await panel.selectOption('#libraryFolder', { label: 'Not in a folder (1)' });
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 1);
  check('and the chats in no folder', (await panel.locator('#libraryList li').getAttribute('data-id')) === IDS[1]);
  await panel.selectOption('#libraryFolder', '');
  await panel.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 3);

  // "New folder..." from the menu files the ticked chats into the folder once it is named
  await panel.locator(`#libraryList li[data-id="${IDS[2]}"] input`).uncheck();
  await panel.selectOption('#libraryAction', { label: 'New folder...' });
  await panel.fill('#newFolderName', 'Work');
  await panel.press('#newFolderName', 'Enter');
  await panel.waitForFunction(() => /Put 1 chat in "Work"/.test(document.getElementById('notice').textContent));
  check('a folder made from the menu receives the ticked chats',
    JSON.stringify(await folderOptions()) === JSON.stringify(['All chats (3)', 'Travel plans (1)', 'Work (1)', 'Not in a folder (1)']),
    JSON.stringify(await folderOptions()));

  // Rename, then delete a folder: the chats stay
  await panel.locator('#foldersList li', { hasText: 'Travel plans' }).locator('button[title^="Rename"]').click();
  await panel.locator('#foldersList input[type="text"]').fill('Trips');
  await panel.locator('#foldersList input[type="text"]').press('Enter');
  await panel.waitForFunction(() => Array.from(document.querySelectorAll('#foldersList .name')).some((el) => el.textContent === 'Trips'));
  await panel.locator('#foldersList li', { hasText: 'Trips' }).locator('button[title^="Delete the folder"]').click();
  check('deleting a folder asks first and says the chats stay',
    (await panel.locator('#confirmTitle').textContent()) === 'Delete the folder "Trips"?'
      && /^Its chats and projects stay exactly as they are on claude\.ai/.test(await panel.locator('#confirmText').textContent())
      && !(await panel.locator('#confirmCopyBox').isVisible()));
  await panel.locator('#confirmGo').click();
  await panel.waitForFunction(() => document.querySelectorAll('#foldersList li').length === 1);
  check('the folder is gone, its chat is unfiled, and claude.ai was never asked to change anything',
    JSON.stringify(await folderOptions()) === JSON.stringify(['All chats (3)', 'Work (1)', 'Not in a folder (2)'])
      && (await panel.locator('#libraryList li').count()) === 3 && writes.length === 0,
    JSON.stringify(await folderOptions()));

  // A project is filed from its card, and the picker then groups by folder
  await panel.locator('.tab[data-tab="export"]').click();
  await panel.selectOption('#projectFolder', { label: 'Work' });
  await panel.waitForFunction(() => document.querySelectorAll('#projectPicker optgroup').length === 2);
  const pickerGroups = await panel.evaluate(() => Array.from(document.querySelectorAll('#projectPicker optgroup')).map((group) => `${group.label}: ${Array.from(group.children).map((option) => option.textContent).join(', ')}`));
  check('the project picker groups projects by folder',
    JSON.stringify(pickerGroups) === JSON.stringify(['Work: Alpha project', 'Not in a folder: Beta']) && (await panel.inputValue('#projectPicker')) === 'p1',
    JSON.stringify(pickerGroups));
  const storedFolders = await panel.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['folders'], (r) => resolve(r.folders))));
  check('folders are kept in the extension\'s own storage',
    storedFolders.folders.length === 1 && storedFolders.folders[0].name === 'Work'
      && storedFolders.chats[IDS[0]] === storedFolders.folders[0].id && storedFolders.projects.p1 === storedFolders.folders[0].id,
    JSON.stringify(storedFolders));
  await panel.locator('.tab[data-tab="library"]').click();
  await panel.locator(`#libraryList li[data-id="${IDS[0]}"] input`).uncheck();

  // The panel on a tab that is not claude.ai: nothing is "open", so the user picks
  apiCalls.length = 0;
  const anywhere = await context.newPage(); watch(anywhere, 'panel on another tab');
  await anywhere.goto(`chrome-extension://${extId}/panel.html`);
  await anywhere.waitForFunction(() => document.getElementById('projectPicker').options.length === 3, null, { timeout: 15000 });
  check('away from claude.ai the panel shows a picker and never a dead end',
    !(await anywhere.locator('#chatCard').isVisible()) && (await anywhere.locator('#projectName').textContent()) === 'No project selected'
      && (await anywhere.locator('#downloadProject').isDisabled()) && !(await anywhere.locator('#everythingButton').isDisabled())
      && apiCalls.length > 0 && apiCalls.every((c) => c.from === 'extension'));
  await anywhere.selectOption('#projectPicker', 'p2');
  await anywhere.waitForFunction(() => document.getElementById('projectCounts').textContent === '0 files · 0 chats');
  check('picking a project enables its downloads', (await anywhere.locator('#projectName').textContent()) === 'Beta' && !(await anywhere.locator('#downloadProject').isDisabled()));

  // Side panel or popup: the toolbar button follows the stored choice
  const toolbarState = () => sw.evaluate(async () => ({
    popup: await chrome.action.getPopup({}),
    opensPanel: (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick,
  }));
  const before = await toolbarState();
  check('side panel is the default: the toolbar button has no popup and opens the panel', before.popup === '' && before.opensPanel === true, JSON.stringify(before));
  await anywhere.selectOption('#displayMode', 'popup');
  await anywhere.waitForFunction(() => /opens a popup/.test(document.getElementById('notice').textContent));
  let after = await toolbarState();
  for (let i = 0; i < 20 && after.opensPanel; i++) { await anywhere.waitForTimeout(100); after = await toolbarState(); }
  check('choosing "Popup" switches the toolbar button to the popup', /panel\.html$/.test(after.popup) && after.opensPanel === false, JSON.stringify(after));
  await anywhere.selectOption('#displayMode', 'sidepanel');
  await anywhere.close();

  // Re-inject the content scripts (as after an update); the tab must still answer
  const tabId = await panel.evaluate(() => new Promise((r) => chrome.tabs.query({ url: 'https://claude.ai/*' }, (t) => r(t[0].id))));
  const injected = await panel.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ action: 'ensureContentScript', tabId: id }, r)), tabId);
  const pong = await panel.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { action: 'ping' }, r)), tabId);
  check('background re-injects the content scripts on request and the tab still answers', injected && injected.success === true && pong && pong.success === true, JSON.stringify([injected, pong]));

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

  // --- 8. Projects view: export one project, then all
  await browse.bringToFront();
  await browse.reload();
  await browse.waitForSelector('#tableContent table tbody tr', { timeout: 15000 });
  await browse.selectOption('#exportFormat', 'markdown');
  await browse.check('#extractArtifacts');
  await browse.locator('.view-tab[data-view="projects"]').click();
  await browse.waitForSelector('tr[data-id="p1"]');
  check('projects view lists projects with their chat counts',
    (await browse.locator('#tableContent tbody tr').count()) === 2
      && (await browse.locator('tr[data-id="p1"] td').nth(1).textContent()).trim() === '1'
      && /Showing 2 of 2 projects/.test(await browse.locator('#stats').textContent()));
  check('project options appear only in the projects view', await browse.locator('#projectOptions').isVisible());

  const [d6] = await Promise.all([browse.waitForEvent('download'), browse.locator('tr[data-id="p1"] .btn-export-project').click()]);
  const f6 = await readDownload(d6);
  const pzip = await JSZip.loadAsync(f6.data);
  const pnames = Object.keys(pzip.files).filter((n) => !pzip.files[n].dir).sort();
  console.log('      zip:', f6.name, JSON.stringify(pnames));
  check('a single project is saved as "<Project name>.zip" without a top folder', f6.name === 'Alpha project.zip' && pnames.includes('manifest.json'));
  check('project ZIP holds instructions, knowledge files, chats and artifacts',
    ['instructions.md', 'files/brief.md', 'files/handbook.pdf', 'files/diagram.webp', 'files/meeting-notes.docx.txt', 'chats/Trip plan.md', 'artifacts/Trip plan/script.py']
      .every((n) => pnames.includes(n)), JSON.stringify(pnames));
  check('instructions are saved verbatim', (await pzip.file('instructions.md').async('string')) === 'Always answer in French.');
  check('the PDF is byte-identical to what was served', sha256(await pzip.file('files/handbook.pdf').async('nodebuffer')) === sha256(PDF_BYTES));
  const pm = JSON.parse(await pzip.file('manifest.json').async('string'));
  const fidelity = Object.fromEntries(pm.knowledge.map((r) => [r.name, r.fidelity]));
  check('manifest records how faithful each knowledge file is',
    JSON.stringify(fidelity) === JSON.stringify({ 'brief.md': 'original', 'meeting-notes.docx': 'extracted-text', 'handbook.pdf': 'original', 'diagram.png': 'preview', 'budget.xlsx': 'missing' }),
    JSON.stringify(fidelity));
  check('manifest hash matches the saved file', pm.knowledge.find((r) => r.name === 'handbook.pdf').sha256 === sha256(PDF_BYTES));
  check('the file claude.ai would not serve is reported, not silently dropped',
    !pnames.some((n) => n.includes('budget')) && /tried/i.test(pm.knowledge.find((r) => r.name === 'budget.xlsx').note || ''));
  const toast = (await browse.locator('#toast').textContent()).trim();
  check('the summary names each fidelity', toast === 'Exported 1 project: 5 knowledge files (2 original, 1 extracted-text, 1 preview, 1 missing), 1 chat', toast);

  const [d7] = await Promise.all([browse.waitForEvent('download'), browse.locator('#exportAllBtn').click()]);
  const f7 = await readDownload(d7);
  const names7 = Object.keys((await JSZip.loadAsync(f7.data)).files).filter((n) => !n.endsWith('/')).sort();
  check('several projects go into one ZIP with a folder each',
    /^downloadmythings-projects-\d{8}-\d{6}\.zip$/.test(f7.name) && names7.includes('Alpha project/instructions.md') && names7.includes('Beta/manifest.json') && !names7.includes('Beta/instructions.md'),
    `${f7.name} ${names7.length} files`);

  // Project export with attachments switched on
  await browse.check('#includeAttachments');
  const [d8] = await Promise.all([browse.waitForEvent('download'), browse.locator('tr[data-id="p1"] .btn-export-project').click()]);
  const azip = await JSZip.loadAsync((await readDownload(d8)).data);
  const am = JSON.parse(await azip.file('manifest.json').async('string'));
  check('project export saves chat attachments beside the chats',
    azip.file('attachments/Trip plan/handbook.pdf') !== null && azip.file('attachments/Trip plan/pasted.txt') !== null
      && am.chats[0].attachments.length === 2 && am.chats[0].attachments.every((r) => r.fidelity === 'original'),
    JSON.stringify(am.chats[0].attachments.map((r) => [r.path, r.fidelity])));

  await browse.locator('.view-tab[data-view="conversations"]').click();
  await browse.waitForSelector('tr[data-id="' + IDS[0] + '"]');

  // Conversations with attachments: one chat becomes a ZIP; a bulk export lists them in attachments.json
  await browse.uncheck('#extractArtifacts');
  const [d9] = await Promise.all([browse.waitForEvent('download'), browse.locator(`tr[data-id="${IDS[0]}"] .btn-export`).click()]);
  const f9 = await readDownload(d9);
  const names9 = Object.keys((await JSZip.loadAsync(f9.data)).files).filter((n) => !n.endsWith('/')).sort();
  check('one chat with attachments downloads as a ZIP with the uploads as files',
    f9.name === 'Trip plan.zip' && JSON.stringify(names9) === JSON.stringify(['Trip plan.md', 'attachments.json', 'attachments/handbook.pdf', 'attachments/pasted.txt']),
    `${f9.name} ${JSON.stringify(names9)}`);
  const [d10] = await Promise.all([browse.waitForEvent('download'), browse.locator('#exportAllBtn').click()]);
  const bzip = await JSZip.loadAsync((await readDownload(d10)).data);
  const names10 = Object.keys(bzip.files).filter((n) => !n.endsWith('/')).sort();
  check('bulk export files attachments per chat and lists them',
    // Newest first, so the older "Trip plan" (the one with uploads) is filed as "Trip plan (2)"
    names10.includes('attachments/Trip plan (2)/handbook.pdf') && names10.includes('attachments.json') && names10.includes('Trip plan.md')
      && !names10.some((n) => n.startsWith('attachments/Trip plan/'))
      && sha256(await bzip.file('attachments/Trip plan (2)/handbook.pdf').async('nodebuffer')) === sha256(PDF_BYTES),
    JSON.stringify(names10));
  await browse.uncheck('#includeAttachments');
  check('switching back shows conversations again', (await browse.locator('#tableContent tbody tr').count()) === 3 && !(await browse.locator('#projectOptions').isVisible()));

  // --- 9. PDF: the print page renders a transcript safely and opens the print dialog
  await browse.selectOption('#exportFormat', 'pdf');
  const [printPage] = await Promise.all([context.waitForEvent('page'), browse.locator(`tr[data-id="${IDS[2]}"] .btn-export`).click()]);
  watch(printPage, 'print');
  await printPage.waitForSelector('#printButton:not([disabled])', { timeout: 15000 });
  check('print page titles the document after the conversation and opens the print dialog once',
    (await printPage.title()) === 'Budget: Q4/Q1?' && (await printPage.evaluate(() => window.__printCalls)) === 1,
    `${await printPage.title()} / ${await printPage.evaluate(() => window.__printCalls)} print calls`);
  const rendered = await printPage.evaluate(() => {
    const main = document.getElementById('content');
    return {
      forbidden: main.querySelectorAll('script, img, iframe, style, [onerror], [onclick]').length,
      badLinks: Array.from(main.querySelectorAll('a')).filter((a) => !/^(https?:|mailto:|#)/.test(a.getAttribute('href') || '#')).length,
      goodLink: main.querySelector('a[href="https://example.com/report"]') !== null,
      table: main.querySelectorAll('table td').length,
      code: main.querySelector('pre code') ? main.querySelector('pre code').textContent : '',
      text: main.textContent,
      xss: window.__xss || 0,
    };
  });
  check('raw HTML in a message is shown as text and never becomes an element',
    rendered.forbidden === 0 && rendered.xss === 0 && rendered.text.includes('<script>window.__xss = 1</script>'), JSON.stringify({ forbidden: rendered.forbidden, xss: rendered.xss }));
  check('unsafe links lose their target; safe links keep it', rendered.badLinks === 0 && rendered.goodLink);
  check('tables and code blocks are rendered', rendered.table === 2 && rendered.code.includes('<b>not bold</b>'), `${rendered.table} cells`);
  check('the transcript loads no images from the network', !pageRequests.some((p) => /pixel\.png|remote\.png/.test(p)) && rendered.text.includes('[image: remote image]'), JSON.stringify(pageRequests.filter((p) => /png/.test(p))));
  await printPage.close();

  const [bulkPrint] = await Promise.all([context.waitForEvent('page'), browse.locator('#exportAllBtn').click()]);
  watch(bulkPrint, 'bulk print');
  await bulkPrint.waitForSelector('#printButton:not([disabled])', { timeout: 15000 });
  check('several conversations print as one document with a contents list',
    (await bulkPrint.locator('article').count()) === 3 && (await bulkPrint.locator('nav.contents li a').count()) === 3
      && (await bulkPrint.title()) === 'Conversations (3)' && (await bulkPrint.evaluate(() => window.__printCalls)) === 1);
  await bulkPrint.close();

  await browse.locator('.view-tab[data-view="projects"]').click();
  const pdfOption = await browse.evaluate(() => ({
    disabled: document.querySelector('#exportFormat option[value="pdf"]').disabled,
    selected: document.getElementById('exportFormat').value,
  }));
  check('PDF is not offered for project ZIPs', pdfOption.disabled && pdfOption.selected === 'markdown', JSON.stringify(pdfOption));
  await browse.locator('.view-tab[data-view="conversations"]').click();

  // --- 10. Pages are not reachable from websites
  const probe = await claude.evaluate(async (id) => {
    try { const r = await fetch(`chrome-extension://${id}/browse.html`); return `fetched ${r.status}`; } catch (e) { return 'blocked'; }
  }, extId);
  check('a website cannot load browse.html', probe === 'blocked', probe);

  // --- 11. Changing the account: move chats to a project, delete chats. Both ask first.
  const EXTRA = ['aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000b'];
  list.push(
    { uuid: EXTRA[0], name: 'Old notes', model: 'claude-sonnet-4-6', created_at: '2025-01-01T10:00:00Z', updated_at: '2025-01-02T10:00:00Z' },
    { uuid: EXTRA[1], name: 'Scratch', model: 'claude-sonnet-4-6', created_at: '2025-02-01T10:00:00Z', updated_at: '2025-02-02T10:00:00Z' },
  );
  const manage = await context.newPage(); watch(manage, 'manage');
  await manage.goto(`chrome-extension://${extId}/panel.html#library`);
  await manage.waitForFunction(() => document.querySelectorAll('#libraryList li').length === 5, null, { timeout: 15000 });
  const tickExtras = async () => { for (const id of EXTRA) await manage.locator(`#libraryList li[data-id="${id}"] input`).check(); };
  const noticeText = () => manage.locator('#notice').textContent();
  writes.length = 0;

  await tickExtras();
  await manage.selectOption('#libraryAction', { label: 'Beta' });
  check('moving chats asks first and states the count',
    (await manage.locator('#confirmTitle').textContent()) === 'Move 2 chats to "Beta"?' && (await manage.locator('#confirmGo').textContent()) === 'Move 2 chats'
      && !(await manage.locator('#confirmCopyBox').isVisible()) && writes.length === 0);
  await manage.locator('#confirmCancel').click();
  await manage.waitForTimeout(300);
  check('cancelling the question changes nothing', writes.length === 0 && !(await manage.locator('#confirmCard').isVisible()));

  await manage.selectOption('#libraryAction', { label: 'Beta' });
  await manage.locator('#confirmGo').click();
  await manage.waitForFunction(() => /^Moved/.test(document.getElementById('notice').textContent), null, { timeout: 15000 });
  check('confirmed, the chats move, and the result is read back from claude.ai',
    (await noticeText()) === 'Moved 2 chats to "Beta".'
      && JSON.stringify(writes) === JSON.stringify(['POST /chat_conversations/move_many', `PUT /chat_conversations/${EXTRA[0]}`, `PUT /chat_conversations/${EXTRA[1]}`])
      && list.filter((c) => c.project_uuid === 'p2').map((c) => c.uuid).join() === EXTRA.join()
      && (await manage.locator(`#libraryList li[data-id="${EXTRA[0]}"] .meta`).first().textContent()) === 'Beta',
    `${await noticeText()} ${JSON.stringify(writes)}`);

  writes.length = 0;
  await manage.selectOption('#libraryAction', { label: 'Delete from claude.ai...' });
  check('deleting asks first, states the count, says it is final, and offers a copy',
    (await manage.locator('#confirmTitle').textContent()) === 'Delete 2 chats from claude.ai?' && (await manage.locator('#confirmGo').textContent()) === 'Delete 2 chats'
      && /cannot be undone/.test(await manage.locator('#confirmText').textContent())
      && (await manage.locator('#confirmCopy').isChecked()) && (await manage.locator('#confirmGo').getAttribute('class')) === 'btn danger' && writes.length === 0);
  const [pCopy] = await Promise.all([manage.waitForEvent('download', { timeout: 20000 }), manage.locator('#confirmGo').click()]);
  const copyZip = await unzip(pCopy);
  await manage.waitForFunction(() => /^Deleted/.test(document.getElementById('notice').textContent), null, { timeout: 15000 });
  check('confirmed, a copy is saved first and only the ticked chats are deleted',
    JSON.stringify(copyZip.files) === JSON.stringify(['Old notes.md', 'Scratch.md'])
      && (await noticeText()) === `Deleted 2 chats from claude.ai. A copy is in ${copyZip.name}.`
      && JSON.stringify(writes.slice().sort()) === JSON.stringify([`DELETE /chat_conversations/${EXTRA[0]}`, `DELETE /chat_conversations/${EXTRA[1]}`])
      && list.length === 3 && list.every((c) => IDS.includes(c.uuid)),
    `${await noticeText()} ${JSON.stringify(writes)} ${JSON.stringify(copyZip.files)}`);
  check('the Library drops the deleted chats and their ticks',
    (await manage.locator('#libraryList li').count()) === 3 && (await manage.locator('#libraryExport').textContent()) === 'Export selected'
      && !(await manage.locator('#libraryActions').isVisible()));
  await manage.close();

  // Errors this test causes on purpose: refused direct calls (step 5), files
  // the stand-in does not serve (404), and the blocked fetch of an extension
  // page from a website (step 9).
  const expected = (e) => /403/.test(e) || /404 \(Not Found\)/.test(e) || /net::ERR_FAILED/.test(e);
  const unexpected = pageErrors.filter((e) => !expected(e));
  check('no unexpected page errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 600));

  await context.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
