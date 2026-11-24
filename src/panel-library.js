// The panel's Library tab: every chat in the account, with search, selection
// and export. Loaded after panel.js and shares its `state`, `$`, `saveChat`
// and `exportChats`.

const library = {
  selected: new Set(), // conversation UUIDs ticked by the user
  shown: []            // the conversations currently listed
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

function renderLibrary() {
  const query = $('librarySearch').value.trim().toLowerCase();
  const projectNames = libraryProjectNames();
  const projectOf = (conv) => projectNames[projectIdOf(conv)] || '';

  library.shown = state.conversations
    .filter((conv) => !query
      || (conv.name || '').toLowerCase().includes(query)
      || projectOf(conv).toLowerCase().includes(query))
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

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = libraryWhen(conv.updated_at);

    row.append(checkbox, main, when, downloadIconButton(`Download ${conv.name || 'this chat'}`, () => saveChat(conv.uuid, conv.name)));
    return row;
  }));

  updateLibraryBar();
}

document.addEventListener('DOMContentLoaded', () => {
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
});
