import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import manage from '../src/lib/manage.js';
import api from '../src/lib/api.js';

const { moveChatsToProject, deleteChats } = manage;
const { apiSend, getUsage, moveConversationsToProject, deleteConversation } = api;
const ORG = 'org-1';
const LIST = '/api/organizations/org-1/chat_conversations';

// A stand-in for claude.ai that keeps a list of conversations and obeys (or
// refuses) the calls that change it. `calls` records every method and path.
function account(behaviour = {}) {
  const state = {
    conversations: [
      { uuid: 'c-1', name: 'One' },
      { uuid: 'c-2', name: 'Two', project_uuid: 'p-old' },
      { uuid: 'c-3', name: 'Three' },
    ],
  };
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, body });

    if (method === 'GET' && pathname === LIST) return json(state.conversations);
    if (method === 'GET' && pathname === '/api/organizations/org-1/usage') return json({ five_hour: { utilization: 12 } });
    if (method === 'POST' && pathname === `${LIST}/move_many`) {
      if (behaviour.noBatchMove) return json({}, 404);
      if (behaviour.refuseMove) return json({}, 403);
      for (const conv of state.conversations) {
        if (body.conversation_uuids.includes(conv.uuid) && !(behaviour.ignoreMove || []).includes(conv.uuid)) conv.project_uuid = body.project_uuid;
      }
      return json({});
    }
    const one = pathname.match(/chat_conversations\/(c-\d)$/);
    if (one && method === 'PUT') {
      const conv = state.conversations.find((item) => item.uuid === one[1]);
      if (!behaviour.ignoreSingleMove) conv.project_uuid = body.project_uuid;
      return json(conv);
    }
    if (one && method === 'DELETE') {
      if ((behaviour.refuseDelete || []).includes(one[1])) return json({}, 500);
      const before = state.conversations.length;
      state.conversations = state.conversations.filter((item) => item.uuid !== one[1]);
      return state.conversations.length < before ? new Response(null, { status: 204 }) : json({}, 404);
    }
    return json({}, 404);
  }));
  return { state, calls, writes: () => calls.filter((call) => call.method !== 'GET') };
}

beforeEach(() => {
  vi.stubGlobal('chrome', { storage: { local: { get: (keys, cb) => cb({}), set: (items, cb) => cb && cb() } } });
  api.dmtRetry.attempts = 0; // a refused call is refused at once
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  api.dmtRetry.attempts = 3;
});

async function finish(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) await vi.advanceTimersByTimeAsync(500);
  return promise;
}

describe('apiSend', () => {
  it('sends JSON with the session and copes with an empty answer', async () => {
    const claude = account();
    expect(await apiSend('DELETE', `${LIST}/c-1`)).toBeNull();
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(init.headers['Content-Type']).toBeUndefined();
    await apiSend('PUT', `${LIST}/c-2`, { project_uuid: 'p-1' });
    expect(fetch.mock.calls[1][1].headers['Content-Type']).toBe('application/json');
    expect(claude.calls[1].body).toEqual({ project_uuid: 'p-1' });
  });

  it('throws with the status when claude.ai refuses', async () => {
    account();
    await expect(apiSend('POST', '/api/nowhere', {})).rejects.toMatchObject({ message: 'claude.ai returned HTTP 404', status: 404 });
  });
});

describe('getUsage', () => {
  it('reads the usage call for the organization', async () => {
    const claude = account();
    expect(await getUsage(ORG)).toEqual({ five_hour: { utilization: 12 } });
    expect(claude.calls[0].pathname).toBe('/api/organizations/org-1/usage');
  });
});

describe('moveConversationsToProject', () => {
  it('uses the batch call when claude.ai knows it', async () => {
    const claude = account();
    expect(await moveConversationsToProject(ORG, ['c-1', 'c-3'], 'p-1')).toBe('batch');
    expect(claude.writes()).toEqual([{ method: 'POST', pathname: `${LIST}/move_many`, body: { conversation_uuids: ['c-1', 'c-3'], project_uuid: 'p-1' } }]);
  });

  it('sets the project on each conversation when the batch call does not exist', async () => {
    const claude = account({ noBatchMove: true });
    expect(await moveConversationsToProject(ORG, ['c-1', 'c-3'], 'p-1')).toBe('single');
    expect(claude.writes().map((call) => `${call.method} ${call.pathname}`)).toEqual([`POST ${LIST}/move_many`, `PUT ${LIST}/c-1`, `PUT ${LIST}/c-3`]);
  });

  it('does not try another way when claude.ai refuses outright', async () => {
    const claude = account({ refuseMove: true });
    await expect(moveConversationsToProject(ORG, ['c-1'], 'p-1')).rejects.toMatchObject({ status: 403 });
    expect(claude.writes()).toHaveLength(1);
  });
});

describe('moveChatsToProject', () => {
  it('reports how many chats the fresh list shows in the project', async () => {
    const claude = account();
    const result = await finish(moveChatsToProject(ORG, ['c-1', 'c-2'], 'p-1'));
    expect(result).toMatchObject({ requested: 2, moved: 2, cancelled: false });
    expect(claude.state.conversations.map((conv) => conv.project_uuid)).toEqual(['p-1', 'p-1', undefined]);
    expect(result.conversations).toHaveLength(3);
  });

  it('does not claim a move that claude.ai accepted but did not make', async () => {
    account({ ignoreMove: ['c-2'] });
    expect(await finish(moveChatsToProject(ORG, ['c-1', 'c-2'], 'p-1'))).toMatchObject({ requested: 2, moved: 1 });
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', { storage: { local: { get: (keys, cb) => cb({}), set: (items, cb) => cb && cb() } } });
    account({ noBatchMove: true, ignoreSingleMove: true });
    expect(await finish(moveChatsToProject(ORG, ['c-1', 'c-3'], 'p-1'))).toMatchObject({ requested: 2, moved: 0 });
  });

  it('stops before sending anything when already cancelled', async () => {
    const claude = account();
    const result = await finish(moveChatsToProject(ORG, ['c-1'], 'p-1', { isCancelled: () => true }));
    expect(result).toMatchObject({ moved: 0, cancelled: true });
    expect(claude.writes()).toEqual([]);
  });
});

describe('deleteConversation', () => {
  it('treats a conversation that is already gone as done', async () => {
    account();
    await expect(deleteConversation(ORG, 'c-9')).resolves.toBe(true);
  });
});

describe('deleteChats', () => {
  it('deletes only the chosen chats and counts what is really gone', async () => {
    const claude = account();
    const progress = [];
    const result = await finish(deleteChats(ORG, ['c-1', 'c-3'], { onProgress: (done, total) => progress.push(`${done}/${total}`) }));
    expect(result).toMatchObject({ requested: 2, deleted: 2, failed: 0, cancelled: false });
    expect(claude.state.conversations.map((conv) => conv.uuid)).toEqual(['c-2']);
    expect(claude.writes().map((call) => `${call.method} ${call.pathname}`).sort()).toEqual([`DELETE ${LIST}/c-1`, `DELETE ${LIST}/c-3`]);
    expect(progress).toEqual(['2/2']);
  });

  it('carries on past a chat claude.ai will not delete and reports it', async () => {
    const claude = account({ refuseDelete: ['c-1'] });
    const result = await finish(deleteChats(ORG, ['c-1', 'c-2', 'c-3']));
    expect(result).toMatchObject({ requested: 3, deleted: 2, failed: 1, firstError: 'claude.ai returned HTTP 500' });
    expect(claude.state.conversations.map((conv) => conv.uuid)).toEqual(['c-1']);
  });

  it('deletes nothing when cancelled first', async () => {
    const claude = account();
    const result = await finish(deleteChats(ORG, ['c-1', 'c-2'], { isCancelled: () => true }));
    expect(result).toMatchObject({ deleted: 0, cancelled: true });
    expect(claude.writes()).toEqual([]);
    expect(claude.state.conversations).toHaveLength(3);
  });
});
