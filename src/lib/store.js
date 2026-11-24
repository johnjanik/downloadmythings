// Extension storage helpers shared by every page and by the content script.
//
// Plain script, no modules: only function declarations and `var` at the top
// level, so the file can be injected into a tab more than once without
// "already declared" errors.

function storageGet(area, keys) {
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(area, items) {
  return new Promise((resolve) => {
    chrome.storage[area].set(items, () => resolve());
  });
}

async function getStoredOrgId() {
  const result = await storageGet('sync', ['organizationId']);
  return result.organizationId || null;
}

function setStoredOrgId(orgId) {
  return storageSet('sync', { organizationId: orgId });
}

// Mark conversations as exported now. Resolves with the full timestamp map.
async function recordExportTimestamps(conversationIds) {
  const result = await storageGet('local', ['exportTimestamps']);
  const timestamps = result.exportTimestamps || {};
  const now = new Date().toISOString();
  for (const id of conversationIds) {
    timestamps[id] = now;
  }
  await storageSet('local', { exportTimestamps: timestamps });
  return timestamps;
}

// Pure merge used by recordModelSnapshots. Snapshot each conversation's model
// so it survives a model bounce (when a model retires and old chats are moved
// onto a newer one). Only the model the API reports is recorded, never an
// inferred guess. Also keeps the conversation's created/updated times in sync.
// Mutates and returns `snapshots`; `changed` says whether anything was written.
function mergeModelSnapshots(snapshots, conversations, now) {
  let changed = false;
  if (!Array.isArray(conversations)) return { snapshots, changed };

  for (const conv of conversations) {
    const model = conv && conv.model;
    const id = conv && conv.uuid;
    if (!model || !id) continue; // null-model chats: do not snapshot a guess

    const existing = snapshots[id];
    if (!existing) {
      snapshots[id] = {
        conversationCreatedAt: conv.created_at,
        conversationUpdatedAt: conv.updated_at,
        firstSeen: model,
        firstSeenAt: now,
        current: model,
        currentAt: now,
        history: [{ model, at: now }]
      };
      changed = true;
      continue;
    }

    if (existing.current !== model) {
      existing.current = model;
      existing.currentAt = now;
      existing.history = existing.history || [];
      existing.history.push({ model, at: now });
      changed = true;
    }
    if (conv.created_at && existing.conversationCreatedAt !== conv.created_at) {
      existing.conversationCreatedAt = conv.created_at;
      changed = true;
    }
    if (conv.updated_at && existing.conversationUpdatedAt !== conv.updated_at) {
      existing.conversationUpdatedAt = conv.updated_at;
      changed = true;
    }
  }
  return { snapshots, changed };
}

async function recordModelSnapshots(conversations) {
  const result = await storageGet('local', ['modelSnapshots']);
  const merged = mergeModelSnapshots(result.modelSnapshots || {}, conversations, new Date().toISOString());
  if (merged.changed) {
    await storageSet('local', { modelSnapshots: merged.snapshots });
  }
  return merged.snapshots;
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    storageGet,
    storageSet,
    getStoredOrgId,
    setStoredOrgId,
    recordExportTimestamps,
    mergeModelSnapshots,
    recordModelSnapshots,
  };
}
