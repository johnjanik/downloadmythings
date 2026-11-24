// Search inside messages. The Library can search what was said in every chat,
// not only titles. For that it keeps a private index on this computer: the
// text of each conversation, stored in the extension's own IndexedDB and
// refreshed when a conversation changes. Nothing is uploaded.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof getConversation === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'));
}

var DMT_SEARCH_DB = 'downloadmythings-search';
var DMT_SEARCH_STORE = 'chats';
var DMT_SEARCH_BATCH = 3;        // conversations read in parallel while indexing
var DMT_SEARCH_PAUSE_MS = 250;   // pause between batches, to go easy on the API

// ---------------------------------------------------------------- pure parts

// Split a query into terms. Every term must match; a "quoted phrase" is one term.
function parseSearchQuery(query) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(query || ''))) !== null) {
    const term = (match[1] || match[2]).trim().toLowerCase();
    if (term && term !== '"') terms.push(term);
  }
  return terms;
}

function textMatchesQuery(lowerText, terms) {
  return terms.every((term) => lowerText.includes(term));
}

// A short excerpt around the first place a term appears, on one line
function searchSnippet(text, terms, radius) {
  const around = typeof radius === 'number' ? radius : 60;
  const lower = text.toLowerCase();
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) {
      at = found;
      length = term.length;
    }
  }
  if (at === -1) return '';
  const start = Math.max(0, at - around);
  const end = Math.min(text.length, at + length + around);
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

// Everything that was said in a conversation, on every branch, as plain text
function conversationSearchText(data) {
  const parts = [];
  for (const message of (data && Array.isArray(data.chat_messages)) ? data.chat_messages : []) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    } else if (typeof message.text === 'string') {
      parts.push(message.text);
    }
    for (const attachment of message.attachments || []) {
      if (attachment && typeof attachment.extracted_content === 'string') parts.push(attachment.extracted_content);
    }
  }
  return parts.join('\n');
}

// Which conversations the index is missing or holds an older copy of
function staleConversations(conversations, index) {
  return conversations.filter((conv) => {
    const entry = index.get(conv.uuid);
    return !entry || entry.updatedAt !== (conv.updated_at || '');
  });
}

// ---------------------------------------------------------------- storage

function openSearchDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DMT_SEARCH_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DMT_SEARCH_STORE, { keyPath: 'uuid' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function searchStoreRequest(mode, action) {
  return openSearchDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(DMT_SEARCH_STORE, mode);
    const request = action(transaction.objectStore(DMT_SEARCH_STORE));
    transaction.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  }));
}

// The whole index in memory: Map of uuid -> { updatedAt, text, lower }
async function loadSearchIndex() {
  const rows = await searchStoreRequest('readonly', (store) => store.getAll());
  const index = new Map();
  for (const row of rows || []) {
    index.set(row.uuid, { updatedAt: row.updatedAt, text: row.text, lower: row.text.toLowerCase() });
  }
  return index;
}

function clearSearchIndex() {
  return searchStoreRequest('readwrite', (store) => store.clear());
}

// ---------------------------------------------------------------- indexing

// Read the conversations that are new or changed and add them to the index.
// hooks: { onProgress(done, total), shouldPause(), isCancelled() }
// Resolves with { indexed, failed, total } for this run.
async function updateSearchIndex(orgId, conversations, index, hooks) {
  const h = hooks || {};
  const stale = staleConversations(conversations, index);
  const known = new Set(conversations.map((conv) => conv.uuid));
  let indexed = 0;
  let failed = 0;

  // Forget conversations that no longer exist
  for (const uuid of Array.from(index.keys())) {
    if (!known.has(uuid)) {
      index.delete(uuid);
      await searchStoreRequest('readwrite', (store) => store.delete(uuid));
    }
  }

  for (let i = 0; i < stale.length; i += DMT_SEARCH_BATCH) {
    if (h.isCancelled && h.isCancelled()) break;
    while (h.shouldPause && h.shouldPause()) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // an export is running: wait for it
    }

    await Promise.all(stale.slice(i, i + DMT_SEARCH_BATCH).map(async (conv) => {
      try {
        const text = conversationSearchText(await getConversation(orgId, conv.uuid));
        const row = { uuid: conv.uuid, updatedAt: conv.updated_at || '', text };
        await searchStoreRequest('readwrite', (store) => store.put(row));
        index.set(conv.uuid, { updatedAt: row.updatedAt, text, lower: text.toLowerCase() });
        indexed++;
      } catch (error) {
        failed++; // left stale: the next run tries it again
      }
    }));

    if (h.onProgress) h.onProgress(conversations.length - stale.length + indexed, conversations.length);
    if (i + DMT_SEARCH_BATCH < stale.length) {
      await new Promise((resolve) => setTimeout(resolve, DMT_SEARCH_PAUSE_MS));
    }
  }
  return { indexed, failed, total: conversations.length };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSearchQuery,
    textMatchesQuery,
    searchSnippet,
    conversationSearchText,
    staleConversations,
    loadSearchIndex,
    clearSearchIndex,
    updateSearchIndex,
  };
}
