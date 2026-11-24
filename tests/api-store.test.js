import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import api from '../src/lib/api.js';
import store from '../src/lib/store.js';

const { pickChatOrgId, conversationPath, projectsPath, apiGet, directOrRelay } = api;
const { mergeModelSnapshots } = store;

afterEach(() => {
  vi.unstubAllGlobals();
});

// directOrRelay remembers a successful relay; a failed relay (no tab) clears it.
async function forgetRelayPreference() {
  vi.stubGlobal('chrome', { runtime: {}, tabs: { query: (query, callback) => callback([]) } });
  await directOrRelay(async () => 'reset', 'x', {}, (r) => r);
  vi.unstubAllGlobals();
}

describe('pickChatOrgId', () => {
  it('prefers the organization with the chat capability', () => {
    const orgs = [
      { uuid: 'api-org', capabilities: ['api'] },
      { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] },
    ];
    expect(pickChatOrgId(orgs)).toBe('chat-org');
  });

  it('falls back to the first organization', () => {
    expect(pickChatOrgId([{ uuid: 'only-org' }, { uuid: 'other' }])).toBe('only-org');
  });

  it('returns null when there is nothing to pick', () => {
    expect(pickChatOrgId([])).toBeNull();
    expect(pickChatOrgId(undefined)).toBeNull();
  });
});

describe('API paths', () => {
  it('asks for the full message tree of a conversation', () => {
    expect(conversationPath('org-1', 'conv-1')).toBe(
      '/api/organizations/org-1/chat_conversations/conv-1?tree=True&rendering_mode=messages&render_all_tools=true'
    );
  });

  it('lists projects under the organization', () => {
    expect(projectsPath('org-1')).toBe('/api/organizations/org-1/projects');
  });
});

describe('apiGet', () => {
  it('calls claude.ai with the signed-in session and returns JSON', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiGet('/api/organizations')).resolves.toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledWith('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  });

  it('throws an error that carries the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    await expect(apiGet('/api/organizations')).rejects.toMatchObject({ status: 403, message: 'claude.ai returned HTTP 403' });
  });

  it('reports a network failure with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(apiGet('/api/organizations')).rejects.toMatchObject({ status: 0 });
  });
});

describe('directOrRelay', () => {
  beforeEach(forgetRelayPreference);

  // A stand-in for chrome.tabs / chrome.runtime as an extension page sees them
  function stubChrome({ tabs = [{ id: 7 }], response = { success: true, value: 'via tab' } } = {}) {
    const sendMessage = vi.fn((tabId, message, callback) => callback(response));
    vi.stubGlobal('chrome', {
      runtime: {},
      tabs: { query: (query, callback) => callback(tabs), sendMessage },
    });
    return sendMessage;
  }

  it('uses the direct call when it works and never touches a tab', async () => {
    const sendMessage = stubChrome();
    const result = await directOrRelay(async () => 'direct', 'someAction', {}, (r) => r.value);
    expect(result).toBe('direct');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('relays through a claude.ai tab when the direct call fails', async () => {
    const sendMessage = stubChrome();
    const result = await directOrRelay(
      async () => { throw Object.assign(new Error('claude.ai returned HTTP 403'), { status: 403 }); },
      'loadProjects',
      { orgId: 'org-1' },
      (r) => r.value
    );
    expect(result).toBe('via tab');
    expect(sendMessage).toHaveBeenCalledWith(7, { action: 'loadProjects', orgId: 'org-1' }, expect.any(Function));
  });

  it('explains what to do when both routes fail', async () => {
    stubChrome({ tabs: [] });
    const failing = Object.assign(new Error('claude.ai returned HTTP 401'), { status: 401 });
    await expect(directOrRelay(async () => { throw failing; }, 'x', {}, (r) => r))
      .rejects.toMatchObject({ status: 401, message: expect.stringMatching(/HTTP 401.*Sign in to claude\.ai/) });
  });

  it('does not relay errors a tab could not fix, such as a missing conversation', async () => {
    const sendMessage = stubChrome();
    const missing = Object.assign(new Error('claude.ai returned HTTP 404'), { status: 404 });
    await expect(directOrRelay(async () => { throw missing; }, 'x', {}, (r) => r)).rejects.toBe(missing);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('goes straight to the tab once a relay has succeeded, and back to direct if the tab goes away', async () => {
    const refused = Object.assign(new Error('claude.ai returned HTTP 403'), { status: 403 });
    const direct = vi.fn(async () => { throw refused; });
    stubChrome();
    await directOrRelay(direct, 'x', {}, (r) => r.value);
    await directOrRelay(direct, 'x', {}, (r) => r.value);
    expect(direct).toHaveBeenCalledTimes(1);

    stubChrome({ tabs: [] }); // the claude.ai tab was closed
    const directNowWorks = vi.fn(async () => 'direct again');
    await expect(directOrRelay(directNowWorks, 'x', {}, (r) => r.value)).resolves.toBe('direct again');
    expect(directNowWorks).toHaveBeenCalledTimes(1);
  });

  it('rethrows the direct error where there are no tabs to relay through (content script)', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const failing = new Error('claude.ai returned HTTP 500');
    await expect(directOrRelay(async () => { throw failing; }, 'x', {}, (r) => r)).rejects.toBe(failing);
  });
});

describe('mergeModelSnapshots', () => {
  const now = '2026-11-24T12:00:00.000Z';
  const conv = (overrides = {}) => ({
    uuid: 'c-1',
    model: 'claude-opus-4-6',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  });

  it('records the first-seen model for a new conversation', () => {
    const { snapshots, changed } = mergeModelSnapshots({}, [conv()], now);
    expect(changed).toBe(true);
    expect(snapshots['c-1']).toEqual({
      conversationCreatedAt: '2026-01-01T00:00:00Z',
      conversationUpdatedAt: '2026-01-02T00:00:00Z',
      firstSeen: 'claude-opus-4-6',
      firstSeenAt: now,
      current: 'claude-opus-4-6',
      currentAt: now,
      history: [{ model: 'claude-opus-4-6', at: now }],
    });
  });

  it('keeps the original model and appends history when the model changes', () => {
    const first = mergeModelSnapshots({}, [conv()], '2026-06-01T00:00:00.000Z').snapshots;
    const { snapshots, changed } = mergeModelSnapshots(first, [conv({ model: 'claude-opus-5-5' })], now);
    expect(changed).toBe(true);
    expect(snapshots['c-1'].firstSeen).toBe('claude-opus-4-6');
    expect(snapshots['c-1'].current).toBe('claude-opus-5-5');
    expect(snapshots['c-1'].history.map((h) => h.model)).toEqual(['claude-opus-4-6', 'claude-opus-5-5']);
  });

  it('reports no change when nothing differs', () => {
    const first = mergeModelSnapshots({}, [conv()], now).snapshots;
    expect(mergeModelSnapshots(first, [conv()], now).changed).toBe(false);
  });

  it('tracks a newer updated_at without touching the model history', () => {
    const first = mergeModelSnapshots({}, [conv()], now).snapshots;
    const { snapshots, changed } = mergeModelSnapshots(first, [conv({ updated_at: '2026-03-03T00:00:00Z' })], now);
    expect(changed).toBe(true);
    expect(snapshots['c-1'].conversationUpdatedAt).toBe('2026-03-03T00:00:00Z');
    expect(snapshots['c-1'].history).toHaveLength(1);
  });

  it('never snapshots a conversation whose model is unknown', () => {
    const { snapshots, changed } = mergeModelSnapshots({}, [conv({ model: null })], now);
    expect(changed).toBe(false);
    expect(snapshots).toEqual({});
  });

  it('ignores input that is not a list', () => {
    expect(mergeModelSnapshots({}, undefined, now)).toEqual({ snapshots: {}, changed: false });
  });
});
