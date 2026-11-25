import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import account from '../src/lib/account.js';
import api from '../src/lib/api.js';
import exporter from '../src/lib/exporter.js';
import files from '../src/lib/files.js';
import projectsLib from '../src/lib/projects.js';

const JSZip = createRequire(import.meta.url)('../src/vendor/jszip.min.js');
const { createPartWriter, describeAccountExport, exportEverything } = account;
const { filterConversationsByUpdated } = exporter;
const { markdownFilename, fetchFileItem } = files;
const { exportProjectsToZip } = projectsLib;
const { fetchWithRetry, apiGet, dmtRetry } = api;

const ORG = 'org-1';
let saved; // [{ name, blob }] for every file the code under test "downloaded"

// A stand-in for claude.ai: `routes` maps a path to a Response factory; anything else is 404
function stubClaude(routes) {
  const requested = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const { pathname } = new URL(url);
    requested.push(pathname);
    const make = routes[pathname];
    return make ? make() : new Response('{}', { status: 404 });
  }));
  return requested;
}
const json = (body) => () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function entriesOf(file) {
  const archive = await JSZip.loadAsync(await file.blob.arrayBuffer());
  return { archive, names: Object.keys(archive.files).filter((n) => !archive.files[n].dir).sort() };
}

beforeEach(() => {
  saved = [];
  vi.stubGlobal('JSZip', JSZip);
  vi.stubGlobal('downloadFile', vi.fn((blob, name) => { saved.push({ name, blob }); }));
  // Extension storage, as far as recordExportTimestamps needs it
  const store = {};
  vi.stubGlobal('chrome', {
    storage: { local: { get: (keys, cb) => cb({ ...store }), set: (items, cb) => { Object.assign(store, items); if (cb) cb(); } } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('filterConversationsByUpdated', () => {
  const chats = [
    { uuid: 'a', updated_at: '2026-03-10T12:00:00' },
    { uuid: 'b', updated_at: '2026-06-01T08:00:00' },
    { uuid: 'c', updated_at: '2026-11-20T23:30:00' },
    { uuid: 'd' }, // no date at all
  ];
  const ids = (list) => list.map((chat) => chat.uuid);

  it('returns everything when no range is given', () => {
    expect(filterConversationsByUpdated(chats, '', '')).toBe(chats);
  });

  it('keeps chats inside the range, both days included', () => {
    expect(ids(filterConversationsByUpdated(chats, '2026-06-01', '2026-11-20'))).toEqual(['b', 'c', 'd']);
  });

  it('accepts an open-ended range', () => {
    expect(ids(filterConversationsByUpdated(chats, '2026-06-02', ''))).toEqual(['c', 'd']);
    expect(ids(filterConversationsByUpdated(chats, '', '2026-03-10'))).toEqual(['a', 'd']);
  });

  it('keeps a chat with no usable date rather than dropping it silently', () => {
    expect(ids(filterConversationsByUpdated(chats, '2027-01-01', ''))).toEqual(['d']);
  });
});

describe('Markdown file format', () => {
  it('names text and document files as .md and leaves code and data alone', () => {
    expect(markdownFilename('notes.txt', new Set())).toBe('notes.md');
    expect(markdownFilename('brief.md', new Set())).toBe('brief.md');
    expect(markdownFilename('meeting-notes.docx', new Set())).toBe('meeting-notes.docx.md');
    expect(markdownFilename('clean_data.py', new Set())).toBeNull();
    expect(markdownFilename('table.csv', new Set())).toBeNull();
  });

  it('saves the text claude.ai holds instead of downloading the file', async () => {
    const requested = stubClaude({});
    const item = { name: 'handbook.pdf', text: 'extracted handbook text', file: { file_uuid: 'f-1', file_name: 'handbook.pdf' }, preferText: true };
    const { content, record } = await fetchFileItem(ORG, item, new Set(), 'files/');
    expect(content).toBe('extracted handbook text');
    expect(record).toMatchObject({ path: 'files/handbook.pdf.md', fidelity: 'extracted-text' });
    expect(requested).toEqual([]);
  });

  it('still downloads a file that has no text', async () => {
    stubClaude({ '/api/organizations/org-1/files/f-2/contents': () => new Response('PNGDATA', { headers: { 'content-type': 'image/png' } }) });
    const item = { name: 'diagram.png', text: null, file: { file_uuid: 'f-2', file_name: 'diagram.png' }, preferText: true };
    const { record } = await fetchFileItem(ORG, item, new Set(), 'files/');
    expect(record).toMatchObject({ path: 'files/diagram.png', fidelity: 'original' });
  });
});

describe('retry on rate limits', () => {
  const realBase = dmtRetry.baseMs;
  beforeEach(() => { dmtRetry.baseMs = 1; });
  afterEach(() => { dmtRetry.baseMs = realBase; });

  it('waits and tries again after a 429', async () => {
    const answers = [new Response('', { status: 429 }), new Response('', { status: 503 }), new Response('{"ok":true}', { status: 200 })];
    const fetchMock = vi.fn(async () => answers.shift());
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiGet('/api/organizations')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after a few attempts and reports the status', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiGet('/api/organizations')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(dmtRetry.attempts + 1);
  });

  it('does not retry an ordinary error', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchWithRetry('https://claude.ai/api/x', {});
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createPartWriter', () => {
  it('names a single ZIP plainly', async () => {
    const writer = createPartWriter('everything', 1000);
    await writer.add([{ path: 'a.txt', content: 'aaa' }]);
    expect(writer.finalName()).toBe('everything.zip');
    expect(await writer.finish([{ path: 'manifest.json', content: '{}' }])).toEqual(['everything.zip']);
    expect((await entriesOf(saved[0])).names).toEqual(['a.txt', 'manifest.json']);
  });

  it('starts a new part once the limit is passed and numbers every part', async () => {
    const writer = createPartWriter('everything', 5);
    await writer.add([{ path: 'a.txt', content: 'aaaaaa' }]); // 6 bytes: over the limit, part 1 is written
    await writer.add([{ path: 'b.txt', content: 'bb' }]);
    expect(writer.finalName()).toBe('everything-part2.zip');
    expect(await writer.finish([{ path: 'manifest.json', content: '{}' }])).toEqual(['everything-part1.zip', 'everything-part2.zip']);
    expect((await entriesOf(saved[0])).names).toEqual(['a.txt']);
    expect((await entriesOf(saved[1])).names).toEqual(['b.txt', 'manifest.json']);
  });
});

describe('exportEverything', () => {
  const projects = [{ uuid: 'p-1', name: 'Alpha' }, { uuid: 'p-2', name: 'Beta' }];
  const conversations = [
    { uuid: 'c-1', name: 'Kickoff', project_uuid: 'p-1', updated_at: '2026-02-01T00:00:00Z' },
    { uuid: 'c-2', name: 'Loose ends', updated_at: '2026-03-01T00:00:00Z' },
    { uuid: 'c-3', name: 'From a deleted project', project_uuid: 'p-gone', updated_at: '2026-04-01T00:00:00Z' },
  ];
  const chat = (conv) => json({
    ...conv,
    model: 'claude-sonnet-4-6',
    created_at: conv.updated_at,
    current_leaf_message_uuid: 'm-1',
    chat_messages: [{ uuid: 'm-1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: `Hello from ${conv.name}` }] }],
  });
  const routes = () => ({
    '/api/organizations/org-1/projects/p-1': json({ ...projects[0], prompt_template: 'Be brief.' }),
    '/api/organizations/org-1/projects/p-2': json(projects[1]),
    '/api/organizations/org-1/projects/p-1/docs': json([{ file_name: 'brief.md', content: '# Brief' }]),
    '/api/organizations/org-1/projects/p-1/files': json([]),
    '/api/organizations/org-1/projects/p-2/docs': json([]),
    '/api/organizations/org-1/projects/p-2/files': json([]),
    '/api/organizations/org-1/chat_conversations/c-1': chat(conversations[0]),
    '/api/organizations/org-1/chat_conversations/c-2': chat(conversations[1]),
    '/api/organizations/org-1/chat_conversations/c-3': chat(conversations[2]),
  });

  it('saves every project and every chat outside them, with an account manifest', async () => {
    stubClaude(routes());
    const result = await exportEverything(ORG, projects, conversations, { format: 'markdown' });

    expect(result.cancelled).toBe(false);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatch(/^downloadmythings-everything-\d{8}-\d{6}\.zip$/);
    expect(result.counts).toEqual({ projects: 2, projectChats: 1, knowledgeFiles: 1, otherChats: 2, problems: 0 });

    const { archive, names } = await entriesOf(saved[0]);
    expect(names).toEqual([
      'Chats/From a deleted project.md',
      'Chats/Loose ends.md',
      'Projects/Alpha/chats/Kickoff.md',
      'Projects/Alpha/files/brief.md',
      'Projects/Alpha/instructions.md',
      'Projects/Alpha/manifest.json',
      'Projects/Beta/manifest.json',
      'manifest.json',
    ]);

    const manifest = JSON.parse(await archive.file('manifest.json').async('string'));
    expect(manifest.parts).toEqual(result.parts);
    expect(manifest.projects.map((p) => [p.name, p.path, p.chats])).toEqual([['Alpha', 'Projects/Alpha/', 1], ['Beta', 'Projects/Beta/', 0]]);
    expect(manifest.otherChats.map((c) => c.name)).toEqual(['Loose ends', 'From a deleted project']);
    // The stand-in has no memory endpoint: that is recorded, not treated as a failure
    expect(manifest.memory).toBeNull();
    expect(manifest.notIncluded.map((item) => item.what)).toEqual(['memory', 'styles']);
    expect(manifest.failures).toEqual([]);
  });

  it('includes memory when claude.ai returns it', async () => {
    stubClaude({ ...routes(), '/api/organizations/org-1/memories': json([{ content: 'Prefers short answers' }]) });
    await exportEverything(ORG, [], [], {});
    const { archive, names } = await entriesOf(saved[0]);
    expect(names).toEqual(['manifest.json', 'memory.json']);
    expect(JSON.parse(await archive.file('manifest.json').async('string')).memory).toBe('memory.json');
  });

  it('splits a large account into numbered parts and lists them in the manifest', async () => {
    stubClaude(routes());
    const result = await exportEverything(ORG, projects, conversations, { format: 'markdown', partLimitBytes: 1 });
    expect(result.parts.length).toBeGreaterThan(1);
    expect(saved.map((file) => file.name)).toEqual(result.parts);
    result.parts.forEach((name, index) => expect(name).toMatch(new RegExp(`-part${index + 1}\\.zip$`)));

    const last = await entriesOf(saved[saved.length - 1]);
    expect(last.names).toContain('manifest.json');
    expect(JSON.parse(await last.archive.file('manifest.json').async('string')).parts).toEqual(result.parts);
  });

  it('records a chat that could not be read and carries on', async () => {
    const partial = routes();
    delete partial['/api/organizations/org-1/chat_conversations/c-2'];
    stubClaude(partial);
    const result = await exportEverything(ORG, [], conversations.slice(1), { format: 'markdown' });
    expect(result.counts).toMatchObject({ otherChats: 1, problems: 1 });
    expect((await entriesOf(saved[0])).names).toEqual(['Chats/From a deleted project.md', 'manifest.json']);
  });

  it('stops without saving anything when cancelled at the start', async () => {
    const requested = stubClaude(routes());
    const result = await exportEverything(ORG, projects, conversations, {}, { isCancelled: () => true });
    expect(result).toEqual({ cancelled: true, parts: [], counts: null });
    expect(saved).toEqual([]);
    expect(requested).toEqual([]);
  });
});

describe('describeAccountExport', () => {
  it('reads as a sentence', () => {
    expect(describeAccountExport({ projects: 12, otherChats: 840, problems: 0 }, 2)).toBe('12 projects and 840 other chats in 2 ZIP files');
    expect(describeAccountExport({ projects: 1, otherChats: 1, problems: 3 }, 1)).toBe('1 project and 1 other chat in 1 ZIP file; 3 problems, see manifest.json');
  });
});

describe('exportProjectsToZip', () => {
  const twoProjects = [{ uuid: 'p-1', name: 'Alpha' }, { uuid: 'p-2', name: 'Beta' }];
  const stubTwoProjects = () => stubClaude(Object.fromEntries(twoProjects.flatMap((project) => [
    [`/api/organizations/org-1/projects/${project.uuid}`, json({ ...project, prompt_template: `Instructions for ${project.name}` })],
    [`/api/organizations/org-1/projects/${project.uuid}/docs`, json([{ file_name: 'notes.md', content: `# ${project.name}` }])],
    [`/api/organizations/org-1/projects/${project.uuid}/files`, json([])],
  ])));

  it('saves one project without a top-level folder, named after the project', async () => {
    stubTwoProjects();
    const result = await exportProjectsToZip(ORG, [twoProjects[0]], [], {});
    expect(result).toMatchObject({ cancelled: false, filename: 'Alpha.zip', parts: ['Alpha.zip'] });
    expect((await entriesOf(saved[0])).names).toEqual(['files/notes.md', 'instructions.md', 'manifest.json']);
  });

  it('gives one project its folder when asked, so backups always look the same', async () => {
    stubTwoProjects();
    await exportProjectsToZip(ORG, [twoProjects[0]], [], { projectFolders: true, zipFilename: 'backup' });
    expect(saved[0].name).toBe('backup.zip');
    expect((await entriesOf(saved[0])).names).toEqual(['Alpha/files/notes.md', 'Alpha/instructions.md', 'Alpha/manifest.json']);
  });

  it('keeps several projects in one ZIP while they fit', async () => {
    stubTwoProjects();
    const result = await exportProjectsToZip(ORG, twoProjects, [], { zipFilename: 'both' });
    expect(result.parts).toEqual(['both.zip']);
    expect((await entriesOf(saved[0])).names.filter((name) => name.endsWith('instructions.md'))).toEqual(['Alpha/instructions.md', 'Beta/instructions.md']);
  });

  it('starts a new ZIP part once the content passes the limit', async () => {
    stubTwoProjects();
    // The limit is passed when Alpha's manifest is added, so Alpha fills part 1 exactly
    const result = await exportProjectsToZip(ORG, twoProjects, [], { zipFilename: 'both', partLimitBytes: 200 });
    expect(result).toMatchObject({ cancelled: false, filename: 'both-part2.zip', parts: ['both-part1.zip', 'both-part2.zip'] });
    expect((await entriesOf(saved[0])).names.every((name) => name.startsWith('Alpha/'))).toBe(true);
    expect((await entriesOf(saved[1])).names.every((name) => name.startsWith('Beta/'))).toBe(true);
    expect(result.summary.projects).toBe(2);
  });

  it('splits one very large project across parts instead of holding it in memory', async () => {
    stubTwoProjects();
    const result = await exportProjectsToZip(ORG, [twoProjects[0]], [], { partLimitBytes: 1 });
    expect(result.parts).toEqual(['Alpha-part1.zip', 'Alpha-part2.zip', 'Alpha-part3.zip']);
    expect((await entriesOf(saved[0])).names).toEqual(['instructions.md']);
    expect((await entriesOf(saved[1])).names).toEqual(['files/notes.md']);
    expect((await entriesOf(saved[2])).names).toEqual(['manifest.json']); // the manifest closes the last part
  });

  it('saves nothing when cancelled while the ZIP is being built', async () => {
    stubTwoProjects();
    let building = false;
    const result = await exportProjectsToZip(ORG, [twoProjects[0]], [], {}, {
      onProgress: ({ label }) => { if (label === 'Creating ZIP file...') building = true; },
      isCancelled: () => building,
    });
    expect(result).toMatchObject({ cancelled: true, filename: null, parts: [] });
    expect(saved).toEqual([]);
  });
});
