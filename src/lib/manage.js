// Bulk actions that change the account: move chats into a project, delete
// chats. The panel asks the user first and states the count; nothing here asks.
//
// Both actions finish by reading the conversation list again and counting
// what really changed, so the result reports what claude.ai did, not what was
// asked of it.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof deleteConversation === 'undefined') {
  Object.assign(globalThis, require('./store.js'), require('./api.js'));
}

var DMT_MANAGE_BATCH = 3;        // deletions sent at once
var DMT_MANAGE_PAUSE_MS = 250;   // pause between batches, to go easy on the API
var DMT_MOVE_CHUNK = 50;         // conversations per move call

function conversationProjectId(conv) {
  return (conv && (conv.project_uuid || conv.project_id || conv.projectUuid || (conv.project && conv.project.uuid))) || null;
}

// hooks: { onProgress(done, total), isCancelled() }
// Resolves with { requested, moved, cancelled, conversations } where `moved`
// is how many of the chosen chats the fresh list shows in the project and
// `conversations` is that fresh list. Throws when claude.ai refuses the call.
async function moveChatsToProject(orgId, conversationIds, projectId, hooks) {
  const h = hooks || {};
  let cancelled = false;
  for (let i = 0; i < conversationIds.length; i += DMT_MOVE_CHUNK) {
    if (h.isCancelled && h.isCancelled()) { cancelled = true; break; }
    try {
      await moveConversationsToProject(orgId, conversationIds.slice(i, i + DMT_MOVE_CHUNK), projectId);
    } catch (error) {
      if (!error.cancelled) throw error;
      cancelled = true;
      break;
    }
    if (h.onProgress) h.onProgress(Math.min(i + DMT_MOVE_CHUNK, conversationIds.length), conversationIds.length);
  }
  if (cancelled) setRequestSignal(null); // the check below must still go through
  const conversations = await listConversations(orgId);
  const wanted = new Set(conversationIds);
  const moved = conversations.filter((conv) => wanted.has(conv.uuid) && conversationProjectId(conv) === projectId).length;
  return { requested: conversationIds.length, moved, cancelled, conversations };
}

// hooks: { onProgress(done, total), isCancelled() }
// Resolves with { requested, deleted, failed, firstError, cancelled, conversations }
// where `deleted` is how many of the chosen chats are gone from the fresh list.
async function deleteChats(orgId, conversationIds, hooks) {
  const h = hooks || {};
  let failed = 0;
  let firstError = '';
  let cancelled = false;
  let done = 0;

  for (let i = 0; i < conversationIds.length; i += DMT_MANAGE_BATCH) {
    if (h.isCancelled && h.isCancelled()) { cancelled = true; break; }
    await Promise.all(conversationIds.slice(i, i + DMT_MANAGE_BATCH).map(async (conversationId) => {
      try {
        await deleteConversation(orgId, conversationId);
      } catch (error) {
        if (error.cancelled) { cancelled = true; return; }
        failed++;
        if (!firstError) firstError = error.message || String(error);
      }
      done++;
    }));
    if (h.onProgress) h.onProgress(done, conversationIds.length);
    if (cancelled) break;
    if (i + DMT_MANAGE_BATCH < conversationIds.length) {
      await new Promise((resolve) => setTimeout(resolve, DMT_MANAGE_PAUSE_MS));
    }
  }

  if (cancelled) setRequestSignal(null); // the check below must still go through
  const conversations = await listConversations(orgId);
  const remaining = new Set(conversations.map((conv) => conv.uuid));
  const deleted = conversationIds.filter((conversationId) => !remaining.has(conversationId)).length;
  return { requested: conversationIds.length, deleted, failed, firstError, cancelled, conversations };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    moveChatsToProject,
    deleteChats,
  };
}
