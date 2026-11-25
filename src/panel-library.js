// The panel's Library tab: every chat in the account, with search, selection
// and export. Loaded after panel.js and shares its `state`, `$`, `saveChat`
// and `exportChats`.
//
// Ticked chats can be exported, put in one of the user's own folders, moved
// into a project on claude.ai, or deleted from claude.ai. The last two change
// the account, so each asks first and states how many chats it will touch.
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
  indexedList: null,   // the conversation list the index was last brought up to date for
  folder: '',          // which folder is shown: '' = every chat, 'none' = unfiled, or a folder id
  fileIntoNew: false,  // the next folder that is added receives the ticked chats
  confirm: null        // what the confirmation card will do when confirmed
};

function libraryProjectNames() {
  const names = {};
  for (const project of state.projects) names[project.uuid] = project.name || t('Untitled Project');
  return names;
}

// "11:59 AM" today, "Nov 23" this year, "Nov 23, 2025" before that
function libraryWhen(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(dmtLocaleTag(), { hour: 'numeric', minute: '2-digit' });
  }
  const options = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(dmtLocaleTag(), options);
}

function updateLibraryBar() {
  const total = state.conversations.length;
  const shown = library.shown.length;
  $('libraryCount').textContent = shown === total ? countChats(total) : tn('{0} of {n} chat', '{0} of {n} chats', total, shown);
  $('librarySelectAll').checked = shown > 0 && library.shown.every((conv) => library.selected.has(conv.uuid));
  const button = $('libraryExport');
  button.disabled = library.selected.size === 0 || Boolean(state.job);
  button.textContent = library.selected.size > 0 ? t('Export selected ({0})', library.selected.size) : t('Export selected');
  renderLibraryActions();
}

// The folder filter above the list. It appears once there is a folder.
function renderFolderFilter() {
  const select = $('libraryFolder');
  const folders = state.folders.folders;
  select.hidden = folders.length === 0;
  if (library.folder !== '' && library.folder !== 'none' && !folders.some((folder) => folder.id === library.folder)) {
    library.folder = ''; // the folder being shown was deleted
  }
  const counts = folderChatCounts(state.folders, state.conversations);
  select.replaceChildren(
    new Option(t('All chats ({0})', state.conversations.length), ''),
    ...folders.map((folder) => new Option(`${folder.name} (${counts[folder.id]})`, folder.id)),
    new Option(t('Not in a folder ({0})', counts['']), 'none')
  );
  select.value = library.folder;
}

// What can be done with the ticked chats, as one menu
function renderLibraryActions() {
  const count = library.selected.size;
  $('libraryActions').hidden = count === 0;
  if (count === 0) return;
  const select = $('libraryAction');
  select.disabled = Boolean(state.job);

  const group = (label, options) => {
    const element = document.createElement('optgroup');
    element.label = label;
    element.append(...options);
    return element;
  };
  const folderOptions = state.folders.folders.map((folder) => new Option(folder.name, `folder:${folder.id}`));
  folderOptions.push(new Option(t('New folder...'), 'folder:new'), new Option(t('Take out of its folder'), 'folder:none'));
  const projectOptions = state.projects
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((project) => new Option(project.name || t('Untitled Project'), `project:${project.uuid}`));

  const children = [new Option(tn('With the {n} ticked chat...', 'With the {n} ticked chats...', count), ''), group(t('Put in a folder'), folderOptions)];
  if (projectOptions.length > 0) children.push(group(t('Move to a project on claude.ai'), projectOptions));
  children.push(new Option(t('Delete from claude.ai...'), 'delete'));
  select.replaceChildren(...children);
  select.value = '';
}

// ---------------------------------------------------------------- confirmation

// Show the confirmation card. `go` runs only when its button is pressed.
function askToConfirm(request) {
  library.confirm = request;
  $('confirmTitle').textContent = request.title;
  $('confirmText').textContent = request.text;
  $('confirmCopyBox').hidden = !request.offerCopy;
  $('confirmCopy').checked = true;
  $('confirmGo').textContent = request.button;
  $('confirmGo').className = request.danger ? 'btn danger' : 'btn primary';
  $('confirmCard').hidden = false;
  $('confirmCard').scrollIntoView({ block: 'nearest' });
}

function closeConfirm() {
  library.confirm = null;
  $('confirmCard').hidden = true;
}

// ---------------------------------------------------------------- folders

async function saveFolderChange(data) {
  state.folders = data;
  await saveFolders(data);
  renderFoldersCard();
  renderLibrary();
  renderProjectCard();
  renderProjectFolder();
}

function renderFoldersCard() {
  const chatCounts = folderChatCounts(state.folders, state.conversations);
  const known = new Set(state.projects.map((project) => project.uuid));
  $('foldersList').replaceChildren(...state.folders.folders.map((folder) => {
    const row = document.createElement('li');
    row.dataset.id = folder.id;
    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = folder.name;
    const projects = Object.entries(state.folders.projects).filter(([uuid, id]) => id === folder.id && known.has(uuid)).length;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${countChats(chatCounts[folder.id])}, ${countProjects(projects)}`;
    main.append(name, meta);

    const rename = document.createElement('button');
    rename.className = 'icon-btn';
    rename.title = t('Rename {0}', folder.name);
    rename.setAttribute('aria-label', rename.title);
    rename.textContent = '✎';
    rename.addEventListener('click', () => {
      // Swap the name for a field; Enter or leaving the field saves it
      const field = document.createElement('input');
      field.type = 'text';
      field.maxLength = 60;
      field.value = folder.name;
      field.setAttribute('aria-label', t('New name for {0}', folder.name));
      let finished = false;
      const finish = async (save) => {
        if (finished) return;
        finished = true;
        if (!save || field.value.trim() === folder.name) {
          renderFoldersCard();
          return;
        }
        try {
          await saveFolderChange(renameFolder(state.folders, folder.id, field.value));
        } catch (error) {
          showNotice(error.message);
          renderFoldersCard();
        }
      };
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      field.addEventListener('blur', () => finish(true));
      name.replaceChildren(field);
      field.focus();
      field.select();
    });

    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = t('Delete the folder {0}', folder.name);
    remove.setAttribute('aria-label', remove.title);
    remove.textContent = '×';
    remove.addEventListener('click', () => askToConfirm({
      title: t('Delete the folder "{0}"?', folder.name),
      text: t('Its chats and projects stay exactly as they are on claude.ai. They only leave this folder.'),
      button: t('Delete folder'),
      danger: true,
      go: () => saveFolderChange(removeFolder(state.folders, folder.id))
    }));

    row.append(main, rename, remove);
    return row;
  }));
}

async function addFolderFromField() {
  const field = $('newFolderName');
  try {
    const result = addFolder(state.folders, field.value);
    let data = result.data;
    if (library.fileIntoNew && library.selected.size > 0) {
      data = assignToFolder(data, 'chats', [...library.selected], result.folder.id);
      showNotice(tn('Put {n} chat in "{0}".', 'Put {n} chats in "{0}".', library.selected.size, result.folder.name), 'info');
    }
    library.fileIntoNew = false;
    field.value = '';
    await saveFolderChange(data);
  } catch (error) {
    showNotice(error.message);
  }
}

// After a bulk delete: the chats are gone, so untick them and take them out of their folders
function forgetDeletedChats(ids) {
  const remaining = new Set(state.conversations.map((conv) => conv.uuid));
  const gone = ids.filter((id) => !remaining.has(id));
  for (const id of gone) library.selected.delete(id);
  if (gone.some((id) => state.folders.chats[id])) {
    state.folders = assignToFolder(state.folders, 'chats', gone, null);
    saveFolders(state.folders);
  }
}

// The menu under the list: act on the ticked chats
async function runLibraryAction(value) {
  const ids = [...library.selected];
  if (!value || ids.length === 0) return;
  hideNotice();

  if (value === 'folder:new') {
    library.fileIntoNew = true;
    $('foldersCard').hidden = false;
    renderFoldersCard();
    $('newFolderName').focus();
    return;
  }
  if (value.startsWith('folder:')) {
    const folderId = value === 'folder:none' ? null : value.slice('folder:'.length);
    const folder = state.folders.folders.find((item) => item.id === folderId);
    await saveFolderChange(assignToFolder(state.folders, 'chats', ids, folderId));
    showNotice(folder
      ? tn('Put {n} chat in "{0}".', 'Put {n} chats in "{0}".', ids.length, folder.name)
      : tn('Took {n} chat out of its folder.', 'Took {n} chats out of their folders.', ids.length), 'info');
    return;
  }
  if (value.startsWith('project:')) {
    const projectId = value.slice('project:'.length);
    const project = state.projects.find((item) => item.uuid === projectId);
    const name = project ? (project.name || t('Untitled Project')) : t('the project');
    askToConfirm({
      title: tn('Move {n} chat to "{0}"?', 'Move {n} chats to "{0}"?', ids.length, name),
      text: t('This changes your account on claude.ai: the chats will belong to that project and follow its instructions and files.'),
      button: tn('Move {n} chat', 'Move {n} chats', ids.length),
      go: () => startJob({ type: 'move', ids, projectId, options: readOptions() })
    });
    return;
  }
  if (value === 'delete') {
    askToConfirm({
      title: tn('Delete {n} chat from claude.ai?', 'Delete {n} chats from claude.ai?', ids.length),
      text: t('This removes them from your account for good. It cannot be undone, here or on claude.ai.'),
      button: tn('Delete {n} chat', 'Delete {n} chats', ids.length),
      danger: true,
      offerCopy: true,
      go: () => startJob({ type: 'delete', ids, copyFirst: $('confirmCopy').checked, options: readOptions() })
    });
  }
}

function setSearchStatus(text) {
  $('deepSearchOffer').hidden = library.deepSearch;
  $('deepSearchStatus').hidden = !library.deepSearch;
  if (text) $('deepSearchStatus').textContent = text;
  $('librarySearch').placeholder = library.deepSearch ? t('Search every message') : t('Search chats by title or project');
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

  renderFolderFilter();
  const inFolder = (conv) => {
    if (library.folder === '') return true;
    const folder = folderOf(state.folders, 'chats', conv.uuid);
    return library.folder === 'none' ? !folder : Boolean(folder && folder.id === library.folder);
  };

  library.shown = state.conversations
    .filter((conv) => inFolder(conv) && matches(conv))
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

  $('libraryList').replaceChildren(...library.shown.map((conv) => {
    const row = document.createElement('li');
    row.dataset.id = conv.uuid;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = library.selected.has(conv.uuid);
    checkbox.setAttribute('aria-label', conv.name ? t('Select {0}', conv.name) : t('Select this chat'));
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
    name.textContent = conv.name || t('Untitled conversation');
    main.appendChild(name);
    const folder = folderOf(state.folders, 'chats', conv.uuid);
    const where = [projectOf(conv), folder ? t('Folder: {0}', folder.name) : ''].filter(Boolean).join(' · ');
    if (where) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = where;
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

    row.append(checkbox, main, when, downloadIconButton(conv.name ? t('Download {0}', conv.name) : t('Download this chat'), () => saveChat(conv.uuid, conv.name)));
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
      setSearchStatus(t('Indexing {0} / {1} chats for search', conversations.length - waiting, conversations.length));
    }
    const result = await updateSearchIndex(state.orgId, conversations, library.index, {
      onProgress: (done, total) => setSearchStatus(t('Indexing {0} / {1} chats for search', done, total)),
      shouldPause: () => Boolean(state.job)
    });
    library.indexedList = conversations;
    setSearchStatus(result.failed > 0
      ? tn('Searching inside {0} of {n} chat. {1} could not be read.', 'Searching inside {0} of {n} chats. {1} could not be read.', result.total, result.total - result.failed, result.failed)
      : tn('Searching inside all {n} chat.', 'Searching inside all {n} chats.', result.total));
  } catch (error) {
    console.error('Search index failed:', error);
    setSearchStatus(t('The search index could not be updated: {0}', error.message));
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

  // Folders, and the actions on ticked chats
  $('libraryFolder').addEventListener('change', (event) => {
    library.folder = event.target.value;
    renderLibrary();
  });
  $('manageFolders').addEventListener('click', () => {
    library.fileIntoNew = false;
    $('foldersCard').hidden = !$('foldersCard').hidden;
    renderFoldersCard();
  });
  $('addFolder').addEventListener('click', addFolderFromField);
  $('newFolderName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addFolderFromField();
  });
  $('libraryAction').addEventListener('change', (event) => {
    const value = event.target.value;
    event.target.value = '';
    runLibraryAction(value);
  });
  $('confirmCancel').addEventListener('click', closeConfirm);
  $('confirmGo').addEventListener('click', () => {
    const request = library.confirm;
    closeConfirm();
    if (request) request.go();
  });
  // Folders changed in another copy of the panel (a side panel and a tab can both be open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.folders) return;
    state.folders = normalizeFolders(changes.folders.newValue);
    renderFoldersCard();
    renderLibrary();
    renderProjectCard();
    renderProjectFolder();
  });

  // Search inside messages is opt-in: building the index reads every chat once
  const stored = await storageGet('local', ['deepSearch']);
  library.deepSearch = stored.deepSearch === true;
  setSearchStatus(library.deepSearch ? t('Search inside messages is on.') : '');
  $('enableDeepSearch').addEventListener('click', async (event) => {
    event.preventDefault();
    library.deepSearch = true;
    await storageSet('local', { deepSearch: true });
    setSearchStatus(t('Preparing the search index...'));
    bringSearchIndexUpToDate();
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => bringSearchIndexUpToDate()));
});
