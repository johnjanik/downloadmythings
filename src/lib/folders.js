// Folders: the user's own grouping of chats and projects. claude.ai has no
// folders, so this lives only in the extension's storage on this computer.
// A chat or project is in at most one folder; there is no limit on folders.
//
//   { folders: [{ id, name }], chats: { <chat uuid>: <folder id> }, projects: { <project uuid>: <folder id> } }
//
// The functions that change the data return a new object and leave the old one alone.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof storageGet === 'undefined') {
  Object.assign(globalThis, require('./store.js'));
}

if (typeof module !== 'undefined' && module.exports && typeof t === 'undefined') {
  Object.assign(globalThis, require('./i18n.js'));
}

var DMT_FOLDERS_KEY = 'folders';
var DMT_FOLDER_NAME_MAX = 60;

function emptyFolders() {
  return { folders: [], chats: {}, projects: {} };
}

// Whatever was stored, made safe to use: unknown folder ids are dropped
function normalizeFolders(raw) {
  const data = emptyFolders();
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  for (const folder of Array.isArray(source.folders) ? source.folders : []) {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string' || seen.has(folder.id)) continue;
    seen.add(folder.id);
    data.folders.push({ id: folder.id, name: folder.name });
  }
  for (const kind of ['chats', 'projects']) {
    const map = source[kind] && typeof source[kind] === 'object' ? source[kind] : {};
    for (const uuid of Object.keys(map)) {
      if (seen.has(map[uuid])) data[kind][uuid] = map[uuid];
    }
  }
  return data;
}

function tidyFolderName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, DMT_FOLDER_NAME_MAX);
}

function findFolderByName(data, name) {
  const wanted = tidyFolderName(name).toLowerCase();
  return data.folders.find((folder) => folder.name.toLowerCase() === wanted) || null;
}

// Resolves nothing: returns { data, folder }. A name already in use gives that
// folder back instead of a second one. Throws on an empty name.
function addFolder(data, name) {
  const tidy = tidyFolderName(name);
  if (!tidy) throw new Error(t('Give the folder a name'));
  const existing = findFolderByName(data, tidy);
  if (existing) return { data, folder: existing };
  const taken = new Set(data.folders.map((folder) => folder.id));
  let id;
  do {
    id = `f${Math.random().toString(36).slice(2, 10)}`;
  } while (taken.has(id));
  const folder = { id, name: tidy };
  return { data: { ...data, folders: [...data.folders, folder] }, folder };
}

function renameFolder(data, folderId, name) {
  const tidy = tidyFolderName(name);
  if (!tidy) throw new Error(t('Give the folder a name'));
  const clash = findFolderByName(data, tidy);
  if (clash && clash.id !== folderId) throw new Error(t('There is already a folder called "{0}"', clash.name));
  return { ...data, folders: data.folders.map((folder) => (folder.id === folderId ? { ...folder, name: tidy } : folder)) };
}

// Removing a folder never touches the chats and projects in it: they become unfiled
function removeFolder(data, folderId) {
  const keep = (map) => Object.fromEntries(Object.entries(map).filter(([, id]) => id !== folderId));
  return {
    folders: data.folders.filter((folder) => folder.id !== folderId),
    chats: keep(data.chats),
    projects: keep(data.projects)
  };
}

// Put chats or projects in a folder. `folderId` null takes them out of theirs.
function assignToFolder(data, kind, uuids, folderId) {
  if (kind !== 'chats' && kind !== 'projects') throw new Error(`Unknown kind: ${kind}`);
  if (folderId !== null && !data.folders.some((folder) => folder.id === folderId)) throw new Error(t('That folder no longer exists'));
  const map = { ...data[kind] };
  for (const uuid of uuids) {
    if (folderId === null) delete map[uuid];
    else map[uuid] = folderId;
  }
  return { ...data, [kind]: map };
}

function folderOf(data, kind, uuid) {
  const id = data[kind][uuid];
  return id ? (data.folders.find((folder) => folder.id === id) || null) : null;
}

// How many of the listed chats each folder holds: { <folder id>: n, '': unfiled }
function folderChatCounts(data, conversations) {
  const counts = { '': 0 };
  for (const folder of data.folders) counts[folder.id] = 0;
  for (const conv of conversations) {
    const id = data.chats[conv.uuid];
    if (id && id in counts) counts[id]++;
    else counts['']++;
  }
  return counts;
}

// Forget chats and projects that no longer exist on claude.ai. Call only with
// complete lists, or a failed load would empty every folder.
function pruneFolders(data, chatUuids, projectUuids) {
  const keep = (map, known) => Object.fromEntries(Object.entries(map).filter(([uuid]) => known.has(uuid)));
  return { ...data, chats: keep(data.chats, new Set(chatUuids)), projects: keep(data.projects, new Set(projectUuids)) };
}

async function loadFolders() {
  const stored = await storageGet('local', [DMT_FOLDERS_KEY]);
  return normalizeFolders(stored[DMT_FOLDERS_KEY]);
}

function saveFolders(data) {
  return storageSet('local', { [DMT_FOLDERS_KEY]: data });
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_FOLDERS_KEY,
    emptyFolders,
    normalizeFolders,
    tidyFolderName,
    addFolder,
    renameFolder,
    removeFolder,
    assignToFolder,
    folderOf,
    folderChatCounts,
    pruneFolders,
    loadFolders,
    saveFolders,
  };
}
