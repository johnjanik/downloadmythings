// The panel's Library tab: every chat in the account, with search, selection
// and export. Loaded after panel.js and shares its `state`, `$`, `saveChat`
// and `exportChats`.
//
// Search covers titles and project names at once. Once the user switches on
// "search inside messages", it also covers what was said, from a private
// index kept on this computer (lib/search.js).

const library = {
  selected: new Set(), // conversation UUIDs ticked by the user
  shown: [],           // the conversations currently listed
  deepSearch: false,   // has the user switched on search inside messages?
  index: null,         // Map of uuid -> { updatedAt, text, lower }, once loaded
  indexing: false,
  indexedList: null    // the conversation list the index was last brought up to date for
};

function libraryProjectNames() {
  const names = {};
  for (const project of state.projects) names[project.uuid] = project.name || 'Untitled Project';
  return names;
}

// "11:59 AM" today, "Nov 23" this year, "Nov 23, 2025" before that
function libraryWhen(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const options = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString([], options);
}

function updateLibraryBar() {
  const total = state.conversations.length;
  const shown = library.shown.length;
  $('libraryCount').textContent = shown === total ? plural(total, 'chat') : `${shown} of ${plural(total, 'chat')}`;
  $('librarySelectAll').checked = shown > 0 && library.shown.every((conv) => library.selected.has(conv.uuid));
  const button = $('libraryExport');
  button.disabled = library.selected.size === 0 || Boolean(state.job);
  button.textContent = library.selected.size > 0 ? `Export selected (${library.selected.size})` : 'Export selected';
}

function setSearchStatus(text) {
  $('deepSearchOffer').hidden = library.deepSearch;
  $('deepSearchStatus').hidden = !library.deepSearch;
  if (text) $('deepSearchStatus').textContent = text;
  $('librarySearch').placeholder = library.deepSearch ? 'Search every message' : 'Search chats by title or project';
}

function renderLibrary() {
  const terms = parseSearchQuery($('librarySearch').value);
  const projectNames = libraryProjectNames();
  const projectOf = (conv) => projectNames[projectIdOf(conv)] || '';
  const indexed = (conv) => (library.index ? library.index.get(conv.uuid) : null);

  // Every term must appear in the title, the project name or the messages
  const matches = (conv) => {
    if (terms.length === 0) return true;
    const heading = `${conv.name || ''}\n${projectOf(conv)}`.toLowerCase();
    const entry = indexed(conv);
    return terms.every((term) => heading.includes(term) || Boolean(entry && entry.lower.includes(term)));
  };

  library.shown = state.conversations
    .filter(matches)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

  $('libraryList').replaceChildren(...library.shown.map((conv) => {
    const row = document.createElement('li');
    row.dataset.id = conv.uuid;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = library.selected.has(conv.uuid);
    checkbox.setAttribute('aria-label', `Select ${conv.name || 'this chat'}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) library.selected.add(conv.uuid);
      else library.selected.delete(conv.uuid);
      updateLibraryBar();
    });

    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('a');
    name.className = 'name';
    name.href = `https://claude.ai/chat/${encodeURIComponent(conv.uuid)}`;
    name.target = '_blank';
    name.rel = 'noopener noreferrer';
    name.textContent = conv.name || 'Untitled conversation';
    main.appendChild(name);
    if (projectOf(conv)) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = projectOf(conv);
      main.appendChild(meta);
    }
    // Where the words were found inside the chat
    const entry = indexed(conv);
    const excerpt = terms.length > 0 && entry ? searchSnippet(entry.text, terms) : '';
    if (excerpt) {
      const snippet = document.createElement('div');
      snippet.className = 'meta snippet';
      snippet.textContent = excerpt;
      main.appendChild(snippet);
    }

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = libraryWhen(conv.updated_at);

    row.append(checkbox, main, when, downloadIconButton(`Download ${conv.name || 'this chat'}`, () => saveChat(conv.uuid, conv.name)));
    return row;
  }));

  updateLibraryBar();
  bringSearchIndexUpToDate();
}

// Load the index and read any chats that are new or changed. Runs only while
// the Library is open, waits while an export is running, and never twice at once.
async function bringSearchIndexUpToDate() {
  const libraryOpen = !$('tab-library').hidden;
  if (!library.deepSearch || !libraryOpen || library.indexing || !state.orgId) return;
  if (library.indexedList === state.conversations) return; // already current for this list
  library.indexing = true;
  const conversations = state.conversations;

  try {
    if (!library.index) {
      library.index = await loadSearchIndex();
    }
    const waiting = staleConversations(conversations, library.index).length;
    if (waiting > 0) {
      setSearchStatus(`Indexing ${conversations.length - waiting} / ${conversations.length} chats for search`);
    }
    const result = await updateSearchIndex(state.orgId, conversations, library.index, {
      onProgress: (done, total) => setSearchStatus(`Indexing ${done} / ${total} chats for search`),
      shouldPause: () => Boolean(state.job)
    });
    library.indexedList = conversations;
    setSearchStatus(result.failed > 0
      ? `Searching inside ${result.total - result.failed} of ${plural(result.total, 'chat')}. ${result.failed} could not be read.`
      : `Searching inside all ${plural(result.total, 'chat')}.`);
  } catch (error) {
    console.error('Search index failed:', error);
    setSearchStatus(`The search index could not be updated: ${error.message}`);
  } finally {
    library.indexing = false;
  }
  renderLibrary(); // matches inside messages can now show
}

document.addEventListener('DOMContentLoaded', async () => {
  let searchTimer = null;
  $('librarySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLibrary, 120);
  });

  // Tick or clear every chat currently shown
  $('librarySelectAll').addEventListener('change', (event) => {
    for (const conv of library.shown) {
      if (event.target.checked) library.selected.add(conv.uuid);
      else library.selected.delete(conv.uuid);
    }
    renderLibrary();
  });

  $('libraryExport').addEventListener('click', () => exportChats([...library.selected]));

  // Search inside messages is opt-in: building the index reads every chat once
  const stored = await storageGet('local', ['deepSearch']);
  library.deepSearch = stored.deepSearch === true;
  setSearchStatus(library.deepSearch ? 'Search inside messages is on.' : '');
  $('enableDeepSearch').addEventListener('click', async (event) => {
    event.preventDefault();
    library.deepSearch = true;
    await storageSet('local', { deepSearch: true });
    setSearchStatus('Preparing the search index...');
    bringSearchIndexUpToDate();
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => bringSearchIndexUpToDate()));
});
