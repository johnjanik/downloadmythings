import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import sync from '../src/lib/sync.js';

const { syncAccountToFolder, describeSync, DMT_SYNC_INDEX_PATH } = sync;
const ORG = 'org-1';

// An in-memory stand-in for a FileSystemDirectoryHandle. `writes` records
// every path written, so a test can tell "rewritten" from "left alone".
function memoryFolder() {
  const root = { dirs: new Map(), files: new Map() };
  const writes = [];
  const notFound = () => Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
  const handle = (node, prefix) => ({
    kind: 'directory',
    async getDirectoryHandle(name, options = {}) {
      if (!node.dirs.has(name)) {
        if (!options.create) throw notFound();
        node.dirs.set(name, { dirs: new Map(), files: new Map() });
      }
      return handle(node.dirs.get(name), `${prefix}${name}/`);
    },
    async getFileHandle(name, options = {}) {
      if (!node.files.has(name)) {
        if (!options.create) throw notFound();
        node.files.set(name, '');
      }
      return {
        async createWritable() {
          let pending = '';
          return {
            async write(content) { pending = content; },
            async close() {
              node.files.set(name, typeof pending === 'string' ? pending : await pending.text());
              writes.push(`${prefix}${name}`);
            },
          };
        },
        async getFile() { return { text: async () => node.files.get(name) }; },
      };
    },
    async removeEntry(name) {
      if (!node.files.delete(name) && !node.dirs.delete(name)) throw notFound();
    },
  });
  const list = (node = root, prefix = '') => [
    ...[...node.files.keys()].map((name) => `${prefix}${name}`),
    ...[...node.dirs.entries()].flatMap(([name, child]) => list(child, `${prefix}${name}/`)),
  ].sort();
  const read = (path) => path.split('/').reduce((node, part, i, parts) => (i === parts.length - 1 ? node.files.get(part) : node.dirs.get(part)), root);
  return { dir: handle(root, ''), list, read, writes, visible: () => list().filter((path) => !path.startsWith('.downloadmythings/')) };
}

// A stand-in for claude.ai whose data the test can change between runs
function account() {
  const state = {
    projects: [{ uuid: 'p-1', name: 'Alpha' }],
    instructions: 'Always answer in French.',
    docs: [{ file_name: 'brief.md', content: '# Brief' }],
    files: [{ file_uuid: 'f-1', file_name: 'handbook.pdf' }],
    conversations: [
      { uuid: 'c-1', name: 'Kickoff', project_uuid: 'p-1', updated_at: '2026-02-01T00:00:00Z' },
      { uuid: 'c-2', name: 'Loose ends', updated_at: '2026-03-01T00:00:00Z' },
    ],
    replies: { 'c-1': 'first answer', 'c-2': 'second answer' },
    broken: new Set(),
  };
  const requested = [];
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const { pathname } = new URL(url);
    requested.push(pathname);
    if (pathname === '/api/organizations/org-1/projects/p-1') return json({ ...state.projects[0], prompt_template: state.instructions });
    if (pathname === '/api/organizations/org-1/projects/p-1/docs') return json(state.docs);
    if (pathname === '/api/organizations/org-1/projects/p-1/files') return json(state.files);
    if (pathname === '/api/organizations/org-1/files/f-1/contents') return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
    const chat = pathname.match(/chat_conversations\/(c-\d)$/);
    if (chat && !state.broken.has(chat[1])) {
      const conv = state.conversations.find((item) => item.uuid === chat[1]);
      return json({
        ...conv,
        model: 'claude-sonnet-4-6',
        created_at: conv.updated_at,
        current_leaf_message_uuid: 'm-1',
        chat_messages: [{ uuid: 'm-1', parent_message_uuid: 'root', sender: 'assistant', content: [{ type: 'text', text: state.replies[conv.uuid] }] }],
      });
    }
    return new Response('{}', { status: 404 });
  }));
  const run = (folder, options, hooks) => {
    requested.length = 0;
    folder.writes.length = 0;
    return syncAccountToFolder(ORG, folder.dir, state.projects, state.conversations, { format: 'markdown', ...options }, hooks);
  };
  const chatReads = () => requested.filter((path) => /chat_conversations\/c-/.test(path));
  return { state, requested, run, chatReads };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] }); // skip the pause between batches
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Run a sync to completion while fake timers are active
async function finish(promise) {
  let settled = false;
  promise.finally(() => { settled = true; });
  while (!settled) await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

describe('syncAccountToFolder', () => {
  it('writes the whole account as ordinary files on the first run', async () => {
    const claude = account();
    const folder = memoryFolder();
    const result = await finish(claude.run(folder));

    expect(result).toMatchObject({ cancelled: false, counts: { written: 5, unchanged: 0, renamed: 0, failed: 0 } });
    expect(folder.visible()).toEqual([
      'Chats/Loose ends.md',
      'Projects/Alpha/chats/Kickoff.md',
      'Projects/Alpha/files/brief.md',
      'Projects/Alpha/files/handbook.pdf',
      'Projects/Alpha/instructions.md',
    ]);
    expect(folder.read('Projects/Alpha/instructions.md')).toBe('Always answer in French.');
    expect(folder.read('Chats/Loose ends.md')).toContain('second answer');
    expect(folder.list()).toContain(DMT_SYNC_INDEX_PATH);
  });

  it('reads no conversation and writes no file when nothing changed', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));
    const result = await finish(claude.run(folder));

    expect(result.counts).toEqual({ written: 0, unchanged: 5, renamed: 0, failed: 0 });
    expect(claude.chatReads()).toEqual([]);
    expect(claude.requested).not.toContain('/api/organizations/org-1/files/f-1/contents'); // the upload is not fetched twice
    expect(folder.writes).toEqual([DMT_SYNC_INDEX_PATH]);
  });

  it('rewrites only the conversation that changed', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));

    claude.state.conversations[1].updated_at = '2026-04-04T00:00:00Z';
    claude.state.replies['c-2'] = 'a newer answer';
    const result = await finish(claude.run(folder));

    expect(result.counts).toMatchObject({ written: 1, unchanged: 4 });
    expect(claude.chatReads()).toEqual(['/api/organizations/org-1/chat_conversations/c-2']);
    expect(folder.read('Chats/Loose ends.md')).toContain('a newer answer');
  });

  it('follows a renamed conversation and removes the copy under the old name', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));

    claude.state.conversations[1].name = 'Tidied up';
    claude.state.conversations[1].updated_at = '2026-04-04T00:00:00Z';
    const result = await finish(claude.run(folder));

    expect(result.counts).toMatchObject({ written: 1, renamed: 1 });
    expect(folder.visible()).toContain('Chats/Tidied up.md');
    expect(folder.visible()).not.toContain('Chats/Loose ends.md');
  });

  it('rewrites transcripts when the chat format changes, without leaving the old files behind', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));
    const result = await finish(claude.run(folder, { format: 'json' }));

    expect(result.counts).toMatchObject({ written: 2, unchanged: 3, renamed: 0 });
    expect(folder.visible().filter((path) => path.includes('hats/'))).toEqual(['Chats/Loose ends.json', 'Projects/Alpha/chats/Kickoff.json']);
  });

  it('rewrites a knowledge document when its text changes, by hash', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));

    claude.state.docs[0].content = '# Brief, second edition';
    const result = await finish(claude.run(folder));

    expect(result.counts).toMatchObject({ written: 1, unchanged: 4 });
    expect(folder.writes).toContain('Projects/Alpha/files/brief.md');
    expect(folder.read('Projects/Alpha/files/brief.md')).toBe('# Brief, second edition');
  });

  it('writes a file again if it was deleted from the folder', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));

    const chats = await folder.dir.getDirectoryHandle('Chats');
    await chats.removeEntry('Loose ends.md');
    const result = await finish(claude.run(folder));

    expect(result.counts).toMatchObject({ written: 1, unchanged: 4 });
    expect(folder.visible()).toContain('Chats/Loose ends.md');
  });

  it('records a conversation it could not read and picks it up on the next run', async () => {
    const claude = account();
    const folder = memoryFolder();
    claude.state.broken.add('c-2');
    const first = await finish(claude.run(folder));
    expect(first.counts).toMatchObject({ written: 4, failed: 1 });
    expect(first.failures).toEqual([{ what: 'chat', name: 'Loose ends', message: 'claude.ai returned HTTP 404' }]);

    claude.state.broken.clear();
    const second = await finish(claude.run(folder));
    expect(second.counts).toMatchObject({ written: 1, unchanged: 4, failed: 0 });
  });

  it('keeps same-titled conversations apart and stable across runs', async () => {
    const claude = account();
    claude.state.conversations.push({ uuid: 'c-3', name: 'Loose ends', updated_at: '2026-03-02T00:00:00Z' });
    claude.state.replies['c-3'] = 'third answer';
    const folder = memoryFolder();
    await finish(claude.run(folder));
    expect(folder.visible().filter((path) => path.startsWith('Chats/'))).toEqual(['Chats/Loose ends (2).md', 'Chats/Loose ends.md']);

    claude.state.conversations[2].updated_at = '2026-05-05T00:00:00Z'; // c-3 changes; it must keep its "(2)" name
    await finish(claude.run(folder));
    expect(folder.visible().filter((path) => path.startsWith('Chats/'))).toEqual(['Chats/Loose ends (2).md', 'Chats/Loose ends.md']);
    expect(folder.writes).toContain('Chats/Loose ends (2).md');
  });

  it('never deletes a file because its conversation is gone from claude.ai', async () => {
    const claude = account();
    const folder = memoryFolder();
    await finish(claude.run(folder));

    claude.state.conversations.pop(); // "Loose ends" was deleted on claude.ai
    await finish(claude.run(folder));
    expect(folder.visible()).toContain('Chats/Loose ends.md');
  });

  it('stops when cancelled and still saves what it knows', async () => {
    const claude = account();
    const folder = memoryFolder();
    const result = await finish(claude.run(folder, {}, { isCancelled: () => true }));
    expect(result.cancelled).toBe(true);
    expect(folder.visible()).toEqual([]);
    expect(folder.list()).toEqual([DMT_SYNC_INDEX_PATH]);
  });
});

describe('describeSync', () => {
  it('reads as a short summary', () => {
    expect(describeSync({ written: 12, unchanged: 1043, renamed: 0, failed: 0 })).toBe('12 written, 1043 unchanged');
    expect(describeSync({ written: 1, unchanged: 2, renamed: 1, failed: 3 })).toBe('1 written, 2 unchanged, 1 renamed, 3 failed');
  });
});
