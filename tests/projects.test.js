import { describe, it, expect, vi, afterEach } from 'vitest';
import projects from '../src/lib/projects.js';
import files from '../src/lib/files.js';
import api from '../src/lib/api.js';

const {
  projectIdOf,
  mergeProjectKnowledge,
  collectProject,
  summarizeProjectManifests,
  describeProjectExport,
  projectZipFilename,
} = projects;
const { splitExtension, isBinaryFilename, sha256Hex, fidelityFilename, fetchFileItem, listConversationAttachments } = files;
const knowledgeFilename = fidelityFilename;
const fetchKnowledgeItem = (orgId, item, usedNames) => fetchFileItem(orgId, item, usedNames, 'files/');
const { fileDownloadCandidates, apiGetBlob } = api;

const ORG = 'org-1';

afterEach(() => {
  vi.unstubAllGlobals();
});

// A stand-in for claude.ai: `routes` maps a path (without query) to a Response
// factory. Anything else answers 404. Returns the list of requested paths.
function stubClaude(routes) {
  const requested = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const { pathname, origin } = new URL(url);
    requested.push(origin === 'https://claude.ai' ? pathname : url);
    const make = routes[pathname];
    return make ? make() : new Response('{}', { status: 404 });
  }));
  return requested;
}
const json = (body) => () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const bytes = (body, type) => () => new Response(body, { headers: { 'content-type': type } });

describe('filename helpers', () => {
  it('splits the extension off a filename', () => {
    expect(splitExtension('report.final.PDF')).toEqual({ base: 'report.final', ext: 'PDF' });
    expect(splitExtension('Makefile')).toEqual({ base: 'Makefile', ext: '' });
    expect(splitExtension('.gitignore')).toEqual({ base: '.gitignore', ext: '' });
  });

  it('knows which names are binary formats', () => {
    expect(isBinaryFilename('notes.docx')).toBe(true);
    expect(isBinaryFilename('Budget.XLSX')).toBe(true);
    expect(isBinaryFilename('readme.md')).toBe(false);
    expect(isBinaryFilename('clean_data.py')).toBe(false);
  });

  it('reads the project ID from a conversation', () => {
    expect(projectIdOf({ project_uuid: 'p-1' })).toBe('p-1');
    expect(projectIdOf({})).toBeNull();
  });
});

describe('fileDownloadCandidates', () => {
  it('tries the original first, then renditions, previews and thumbnails', () => {
    const candidates = fileDownloadCandidates(ORG, {
      file_uuid: 'f-1',
      file_name: 'handbook.pdf',
      document_asset: { url: '/api/org-1/files/f-1/document_pdf/handbook.pdf' },
      preview_url: '/api/org-1/files/f-1/preview',
      thumbnail_url: '/api/org-1/files/f-1/thumbnail',
    });
    expect(candidates.map((c) => `${c.fidelity} ${c.url}`)).toEqual([
      'original /api/organizations/org-1/files/f-1/contents',
      'pdf-rendition /api/org-1/files/f-1/document_pdf/handbook.pdf',
      'pdf-rendition /api/org-1/files/f-1/document_pdf',
      'preview /api/org-1/files/f-1/preview',
      'thumbnail /api/org-1/files/f-1/thumbnail',
    ]);
  });

  it('only offers the PDF endpoint for PDFs, and accepts `uuid` in place of `file_uuid`', () => {
    const candidates = fileDownloadCandidates(ORG, { uuid: 'f-2', file_name: 'diagram.png' });
    expect(candidates.map((c) => c.source)).toEqual(['contents', 'preview', 'thumbnail']);
  });

  it('offers nothing when the entry has no ID and no URLs', () => {
    expect(fileDownloadCandidates(ORG, { file_name: 'ghost.png' })).toEqual([]);
  });
});

describe('apiGetBlob', () => {
  it('refuses any address that is not claude.ai, without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiGetBlob('https://evil.example/steal')).rejects.toMatchObject({ status: -1 });
    await expect(apiGetBlob('//evil.example/steal')).rejects.toMatchObject({ status: -1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a web page served in place of a file', async () => {
    stubClaude({ '/api/x': bytes('<html>sign in</html>', 'text/html; charset=utf-8') });
    await expect(apiGetBlob('/api/x')).rejects.toThrow(/web page/);
  });

  it('returns the bytes with their media type', async () => {
    stubClaude({ '/api/x': bytes('%PDF-1.7', 'application/pdf') });
    const blob = await apiGetBlob('/api/x');
    expect(blob.type).toBe('application/pdf');
    expect(await blob.text()).toBe('%PDF-1.7');
  });
});

describe('mergeProjectKnowledge', () => {
  it('joins a file with its extracted text when the names match', () => {
    const items = mergeProjectKnowledge(
      [{ file_name: 'Notes.docx', content: 'extracted words' }, { file_name: 'brief.md', content: '# Brief' }],
      [{ file_uuid: 'f-1', file_name: 'notes.docx' }, { file_uuid: 'f-2', file_name: 'diagram.png' }]
    );
    expect(items.map((i) => [i.name, i.text, i.file && i.file.file_uuid])).toEqual([
      ['Notes.docx', 'extracted words', 'f-1'],
      ['brief.md', '# Brief', null],
      ['diagram.png', null, 'f-2'],
    ]);
  });

  it('keeps two uploads with the same name as two items', () => {
    const items = mergeProjectKnowledge([], [{ file_uuid: 'a', file_name: 'x.pdf' }, { file_uuid: 'b', file_name: 'x.pdf' }]);
    expect(items).toHaveLength(2);
  });

  it('tolerates missing lists', () => {
    expect(mergeProjectKnowledge(undefined, null)).toEqual([]);
  });
});

describe('knowledgeFilename', () => {
  it('keeps the name of an original', () => {
    expect(knowledgeFilename('handbook.pdf', 'original', 'application/pdf', new Set())).toBe('handbook.pdf');
  });

  it('marks extracted text as .txt while keeping the original name visible', () => {
    expect(knowledgeFilename('meeting-notes.docx', 'extracted-text', null, new Set())).toBe('meeting-notes.docx.txt');
  });

  it('renames a preview to the format that was actually served', () => {
    expect(knowledgeFilename('diagram.png', 'preview', 'image/webp', new Set())).toBe('diagram.webp');
    expect(knowledgeFilename('photo.jpeg', 'preview', 'image/jpeg', new Set())).toBe('photo.jpeg');
  });

  it('adds .pdf to a PDF rendition of another format', () => {
    expect(knowledgeFilename('slides.pptx', 'pdf-rendition', 'application/pdf', new Set())).toBe('slides.pptx.pdf');
  });

  it('keeps same-named files apart', () => {
    const used = new Set();
    expect(knowledgeFilename('x.pdf', 'original', null, used)).toBe('x.pdf');
    expect(knowledgeFilename('x.pdf', 'original', null, used)).toBe('x (2).pdf');
  });
});

describe('sha256Hex', () => {
  it('hashes text and blobs the same way', async () => {
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await sha256Hex('abc')).toBe(abc);
    expect(await sha256Hex(new Blob(['abc']))).toBe(abc);
  });
});

describe('fetchKnowledgeItem', () => {
  const file = { file_uuid: 'f-1', file_name: 'diagram.png' };

  it('saves the original when the contents endpoint serves it', async () => {
    stubClaude({ '/api/organizations/org-1/files/f-1/contents': bytes('PNGDATA', 'image/png') });
    const { content, record } = await fetchKnowledgeItem(ORG, { name: 'diagram.png', text: null, file }, new Set());
    expect(await content.text()).toBe('PNGDATA');
    expect(record).toMatchObject({ path: 'files/diagram.png', fidelity: 'original', source: 'contents', bytes: 7, mediaType: 'image/png' });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to a preview and says so', async () => {
    const requested = stubClaude({ '/api/org-1/files/f-1/preview': bytes('WEBP', 'image/webp') });
    const { record } = await fetchKnowledgeItem(ORG, { name: 'diagram.png', text: null, file }, new Set());
    expect(record).toMatchObject({ path: 'files/diagram.webp', fidelity: 'preview', source: 'preview' });
    expect(requested[0]).toBe('/api/organizations/org-1/files/f-1/contents'); // the original was tried first
  });

  it('falls back to extracted text for a binary file with no downloadable bytes', async () => {
    stubClaude({});
    const item = { name: 'notes.docx', text: 'the words', file: { file_uuid: 'f-9', file_name: 'notes.docx' } };
    const { content, record } = await fetchKnowledgeItem(ORG, item, new Set());
    expect(content).toBe('the words');
    expect(record).toMatchObject({ path: 'files/notes.docx.txt', fidelity: 'extracted-text', source: 'docs' });
  });

  it('treats the text of a text file as the original', async () => {
    stubClaude({});
    const { record } = await fetchKnowledgeItem(ORG, { name: 'brief.md', text: '# Brief', file: null }, new Set());
    expect(record).toMatchObject({ path: 'files/brief.md', fidelity: 'original', source: 'docs', bytes: 7 });
  });

  it('records a missing file with what was tried', async () => {
    stubClaude({});
    const { content, record } = await fetchKnowledgeItem(ORG, { name: 'budget.xlsx', text: null, file: { file_uuid: 'f-3', file_name: 'budget.xlsx' } }, new Set());
    expect(content).toBeNull();
    expect(record).toMatchObject({ path: null, fidelity: 'missing' });
    expect(record.note).toMatch(/contents: claude\.ai returned HTTP 404/);
  });

  it('never follows a file URL that points away from claude.ai', async () => {
    const requested = stubClaude({});
    const hostile = { file_name: 'x.png', preview_url: 'https://evil.example/x.png' };
    const { record } = await fetchKnowledgeItem(ORG, { name: 'x.png', text: null, file: hostile }, new Set());
    expect(record.fidelity).toBe('missing');
    expect(requested).toEqual([]);
  });
});

describe('collectProject', () => {
  const project = { uuid: 'p-1', name: 'Alpha', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' };
  const conversations = [
    { uuid: 'c-1', name: 'Kickoff', project_uuid: 'p-1', updated_at: '2026-02-01T00:00:00Z' },
    { uuid: 'c-2', name: 'Elsewhere', project_uuid: 'p-2' },
    { uuid: 'c-3', name: 'No project' },
  ];
  const chat = {
    uuid: 'c-1',
    name: 'Kickoff',
    model: 'claude-sonnet-4-6',
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    current_leaf_message_uuid: 'm-2',
    chat_messages: [
      { uuid: 'm-1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: 'Plan?' }] },
      { uuid: 'm-2', parent_message_uuid: 'm-1', sender: 'assistant', content: [{ type: 'text', text: 'Here. <antArtifact identifier="a" type="application/vnd.ant.code" language="python" title="plan">print(1)</antArtifact>' }] },
    ],
  };
  const routes = () => ({
    '/api/organizations/org-1/projects/p-1': json({ ...project, description: 'Launch work', prompt_template: 'Always answer in French.' }),
    '/api/organizations/org-1/projects/p-1/docs': json([{ file_name: 'brief.md', content: '# Brief' }]),
    '/api/organizations/org-1/projects/p-1/files': json([{ file_uuid: 'f-1', file_name: 'handbook.pdf' }, { file_uuid: 'f-2', file_name: 'budget.xlsx' }]),
    '/api/organizations/org-1/files/f-1/contents': bytes('%PDF-1.7', 'application/pdf'),
    '/api/organizations/org-1/chat_conversations/c-1': json(chat),
  });
  const paths = (entries) => entries.map((entry) => entry.path).sort();

  it('collects instructions, knowledge files, the project\'s own chats and a manifest', async () => {
    const requested = stubClaude(routes());
    const { entries, manifest, exportedChatIds } = await collectProject(ORG, project, conversations, { format: 'markdown', extractArtifacts: true }, 'Alpha/');

    expect(paths(entries)).toEqual([
      'Alpha/artifacts/Kickoff/plan.py',
      'Alpha/chats/Kickoff.md',
      'Alpha/files/brief.md',
      'Alpha/files/handbook.pdf',
      'Alpha/instructions.md',
      'Alpha/manifest.json',
    ]);
    expect(entries.find((e) => e.path === 'Alpha/instructions.md').content).toBe('Always answer in French.');
    expect(exportedChatIds).toEqual(['c-1']);
    expect(requested).not.toContain('/api/organizations/org-1/chat_conversations/c-2'); // other projects' chats are left alone

    expect(manifest.project).toMatchObject({ uuid: 'p-1', name: 'Alpha', description: 'Launch work' });
    expect(manifest.instructions).toMatchObject({ path: 'instructions.md', bytes: 24 });
    expect(manifest.knowledge.map((r) => [r.name, r.fidelity, r.path])).toEqual([
      ['brief.md', 'original', 'files/brief.md'],
      ['handbook.pdf', 'original', 'files/handbook.pdf'],
      ['budget.xlsx', 'missing', null],
    ]);
    expect(manifest.chats).toEqual([{ uuid: 'c-1', name: 'Kickoff', path: 'chats/Kickoff.md', updatedAt: '2026-02-01T00:00:00Z', artifacts: 1 }]);
    expect(manifest.failures).toEqual([]);

    const saved = JSON.parse(entries.find((e) => e.path === 'Alpha/manifest.json').content);
    expect(saved.knowledge).toHaveLength(3);
    expect(saved.fidelityLegend.missing).toBeTruthy();
  });

  it('saves chat attachments beside the chats when asked', async () => {
    const withUpload = routes();
    const chatWithUpload = { ...chat, chat_messages: [{ ...chat.chat_messages[0], files: [{ file_uuid: 'f-9', file_name: 'photo.png' }] }, chat.chat_messages[1]] };
    withUpload['/api/organizations/org-1/chat_conversations/c-1'] = json(chatWithUpload);
    withUpload['/api/organizations/org-1/files/f-9/contents'] = bytes('PNGDATA', 'image/png');
    stubClaude(withUpload);

    const { entries, manifest } = await collectProject(ORG, project, conversations, { includeKnowledge: false, includeInstructions: false, includeAttachments: true }, '');
    expect(paths(entries)).toEqual(['attachments/Kickoff/photo.png', 'chats/Kickoff.json', 'manifest.json']);
    expect(manifest.chats[0].attachments.map((r) => [r.path, r.fidelity])).toEqual([['attachments/Kickoff/photo.png', 'original']]);
    expect(describeProjectExport(summarizeProjectManifests([manifest]))).toBe('1 project: 1 chat, 1 attachment');
  });

  it('lays a project out for Claude Code: CLAUDE.md, docs/ and Markdown chats', async () => {
    stubClaude(routes());
    const { entries, manifest } = await collectProject(ORG, project, conversations, { format: 'json', layout: 'claude-code' }, '');
    expect(paths(entries)).toEqual(['CLAUDE.md', 'chats/Kickoff.md', 'docs/brief.md', 'docs/handbook.pdf', 'manifest.json']);

    const claudeMd = entries.find((e) => e.path === 'CLAUDE.md').content;
    expect(claudeMd.startsWith('# Alpha\n\nAlways answer in French.\n')).toBe(true);
    expect(claudeMd).toContain('`docs/` holds the project\'s knowledge files');
    expect(claudeMd).toContain('`chats/` holds earlier conversations');
    expect(manifest.instructions.path).toBe('CLAUDE.md');
    expect(manifest.knowledge.map((r) => r.path)).toEqual(['docs/brief.md', 'docs/handbook.pdf', null]);
  });

  it('writes CLAUDE.md for Claude Code even when the project has no instructions', async () => {
    const bare = routes();
    bare['/api/organizations/org-1/projects/p-1'] = json(project);
    stubClaude(bare);
    const { entries } = await collectProject(ORG, project, [], { layout: 'claude-code', includeKnowledge: false }, '');
    expect(paths(entries)).toEqual(['CLAUDE.md', 'manifest.json']);
    expect(entries.find((e) => e.path === 'CLAUDE.md').content).not.toContain('docs/');
  });

  it('honours the per-part switches', async () => {
    const requested = stubClaude(routes());
    const { entries } = await collectProject(ORG, project, conversations, { includeKnowledge: false, includeProjectChats: false }, '');
    expect(paths(entries)).toEqual(['instructions.md', 'manifest.json']);
    expect(requested).toEqual(['/api/organizations/org-1/projects/p-1']);
  });

  it('carries on and records the problem when part of the project cannot be read', async () => {
    const partial = routes();
    delete partial['/api/organizations/org-1/projects/p-1'];
    delete partial['/api/organizations/org-1/chat_conversations/c-1'];
    stubClaude(partial);
    const { entries, manifest } = await collectProject(ORG, project, conversations, {}, '');
    expect(paths(entries)).toEqual(['files/brief.md', 'files/handbook.pdf', 'manifest.json']);
    expect(manifest.instructions).toBeNull();
    expect(manifest.failures.map((f) => f.what)).toEqual(['project details', 'chat']);
  });
});

describe('conversation attachments', () => {
  const data = {
    chat_messages: [
      {
        uuid: 'm-1',
        files: [{ file_uuid: 'f-1', file_name: 'photo.png', file_kind: 'image' }],
        files_v2: [{ file_uuid: 'f-1', file_name: 'photo.png', file_kind: 'image' }], // the same upload, listed twice
        attachments: [{ file_name: 'notes.txt', extracted_content: 'pasted words' }, { file_name: '', extracted_content: 'more words' }],
      },
      { uuid: 'm-2', files: [{ file_uuid: 'f-2', file_name: 'report.pdf', file_kind: 'document' }], attachments: [{ file_name: 'empty.txt', extracted_content: '' }] },
      { uuid: 'm-3' },
    ],
  };

  it('lists each upload once and names unnamed pasted text', () => {
    expect(listConversationAttachments(data).map((i) => [i.name, Boolean(i.file), i.text])).toEqual([
      ['photo.png', true, null],
      ['notes.txt', false, 'pasted words'],
      ['pasted-2.txt', false, 'more words'],
      ['report.pdf', true, null],
    ]);
  });

  it('tolerates a conversation with no messages', () => {
    expect(listConversationAttachments({})).toEqual([]);
    expect(listConversationAttachments(null)).toEqual([]);
  });

  it('downloads uploads and saves pasted text, recording what could not be fetched', async () => {
    stubClaude({ '/api/organizations/org-1/files/f-1/contents': bytes('PNGDATA', 'image/png') });
    const { entries, records } = await files.collectAttachmentEntries(ORG, data, 'attachments/');
    expect(entries.map((e) => e.path)).toEqual(['attachments/photo.png', 'attachments/notes.txt', 'attachments/pasted-2.txt']);
    expect(records.map((r) => [r.name, r.fidelity, r.source])).toEqual([
      ['photo.png', 'original', 'contents'],
      ['notes.txt', 'original', 'attachment'],
      ['pasted-2.txt', 'original', 'attachment'],
      ['report.pdf', 'missing', null],
    ]);
  });
});

describe('summary line', () => {
  const manifests = [
    { instructions: {}, chats: [{}, {}], failures: [], knowledge: [{ fidelity: 'original' }, { fidelity: 'original' }, { fidelity: 'extracted-text' }] },
    { instructions: null, chats: [{}], failures: [{}], knowledge: [{ fidelity: 'missing' }] },
  ];

  it('counts files by fidelity across projects', () => {
    expect(summarizeProjectManifests(manifests)).toEqual({
      projects: 2,
      knowledge: 4,
      byFidelity: { 'original': 2, 'extracted-text': 1, 'missing': 1 },
      chats: 3,
      attachments: 0,
      attachmentsMissing: 0,
      failures: 1,
      hasInstructions: 1,
    });
  });

  it('reads as a sentence', () => {
    expect(describeProjectExport(summarizeProjectManifests(manifests))).toBe(
      '2 projects: 4 knowledge files (2 original, 1 extracted-text, 1 missing), 3 chats, 1 problem, see manifest.json'
    );
    expect(describeProjectExport(summarizeProjectManifests([{ instructions: null, chats: [], failures: [], knowledge: [] }])))
      .toBe('1 project: nothing to save');
  });

  it('names a single-project ZIP after the project', () => {
    const when = new Date(2026, 10, 24, 9, 5, 7);
    expect(projectZipFilename([{ name: 'Alpha: v2' }], when)).toBe('Alpha_ v2.zip');
    expect(projectZipFilename([{ name: 'A' }, { name: 'B' }], when)).toBe('downloadmythings-projects-20261124-090507.zip');
  });
});
