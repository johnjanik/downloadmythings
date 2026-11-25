// Sync to a folder: the whole account as ordinary files in a folder the user
// picks, kept up to date. Each run writes only what is new or changed.
//
//   Projects/<Project name>/instructions.md
//   Projects/<Project name>/files/          knowledge files
//   Projects/<Project name>/chats/          the project's conversations
//   Chats/                                  conversations outside those projects
//   .downloadmythings/sync-index.json       what was written, so the next run can skip it
//
// How a run decides:
//   - a conversation is read again only when claude.ai reports a newer
//     `updated_at`, when its file is missing, or when the export settings changed;
//   - a text knowledge file is rewritten when its SHA-256 changes;
//   - an uploaded file is downloaded once (an upload never changes).
// Nothing is ever deleted because it disappeared from claude.ai: the folder is
// an archive. A file is removed only when its conversation was renamed and
// has been written again under the new name.
//
// `dir` is a FileSystemDirectoryHandle (File System Access API).
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof collectProject === 'undefined') {
  Object.assign(
    globalThis,
    require('./utils.js'), require('./store.js'), require('./api.js'),
    require('./files.js'), require('./exporter.js'), require('./projects.js')
  );
}

var DMT_SYNC_INDEX_PATH = '.downloadmythings/sync-index.json';
var DMT_SYNC_SAVE_EVERY = 20; // write the index after this many conversations, so a stopped run can resume

// ---------------------------------------------------------------- folder helpers

// Walk to the folder holding `path`. Returns { folder, name }, or null when a
// folder on the way does not exist and `create` is false.
async function fsLocate(dir, path, create) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let folder = dir;
  for (const part of parts) {
    try {
      folder = await folder.getDirectoryHandle(part, { create });
    } catch (error) {
      if (create) throw error;
      return null;
    }
  }
  return { folder, name };
}

async function fsWriteFile(dir, path, content) {
  const { folder, name } = await fsLocate(dir, path, true);
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function fsReadText(dir, path) {
  try {
    const place = await fsLocate(dir, path, false);
    if (!place) return null;
    const handle = await place.folder.getFileHandle(place.name);
    return await (await handle.getFile()).text();
  } catch (error) {
    return null;
  }
}

async function fsExists(dir, path) {
  try {
    const place = await fsLocate(dir, path, false);
    if (!place) return false;
    await place.folder.getFileHandle(place.name);
    return true;
  } catch (error) {
    return false;
  }
}

// Remove a file or a folder (with its contents). Missing is fine.
async function fsRemove(dir, path) {
  try {
    const place = await fsLocate(dir, path, false);
    if (!place) return false;
    await place.folder.removeEntry(place.name, { recursive: true });
    return true;
  } catch (error) {
    return false;
  }
}

// ---------------------------------------------------------------- index

function emptySyncIndex() {
  return { version: 1, updatedAt: null, projects: {}, instructions: {}, knowledge: {}, chats: {} };
}

async function readSyncIndex(dir) {
  const text = await fsReadText(dir, DMT_SYNC_INDEX_PATH);
  if (!text) return emptySyncIndex();
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.version === 1 ? { ...emptySyncIndex(), ...parsed } : emptySyncIndex();
  } catch (error) {
    return emptySyncIndex();
  }
}

function writeSyncIndex(dir, index) {
  index.updatedAt = new Date().toISOString();
  return fsWriteFile(dir, DMT_SYNC_INDEX_PATH, JSON.stringify(index, null, 2));
}

// The export settings that change what a transcript file contains
function syncSignature(o) {
  return [o.format, o.includeThinking, o.includeMetadata, o.includeArtifacts, o.frontMatter].join('|');
}

function baseNameOf(path) {
  const file = path.split('/').pop();
  return splitExtension(file).base;
}

// "12 written, 1,043 unchanged" (+ ", 2 failed")
function describeSync(counts) {
  const parts = [t('{0} written', counts.written), t('{0} unchanged', counts.unchanged)];
  if (counts.renamed > 0) parts.push(t('{0} renamed', counts.renamed));
  if (counts.failed > 0) parts.push(t('{0} failed', counts.failed));
  return parts.join(', ');
}

// ---------------------------------------------------------------- the sync

// hooks: { onProgress({ label, percent }), isCancelled() }
// Resolves with { cancelled, counts: { written, unchanged, renamed, failed }, failures }.
async function syncAccountToFolder(orgId, dir, projects, conversations, options, hooks) {
  const o = normalizeProjectOptions(options);
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const report = (label, percent) => { if (h.onProgress) h.onProgress({ label, percent }); };

  const index = await readSyncIndex(dir);
  const counts = { written: 0, unchanged: 0, renamed: 0, failed: 0 };
  const failures = [];
  const fail = (what, name, error) => {
    counts.failed++;
    failures.push({ what, name, message: (error && error.message) || String(error) });
  };
  const signature = syncSignature(o);
  const finish = async (cancelled) => {
    await writeSyncIndex(dir, index);
    return { cancelled, counts, failures };
  };

  const totalUnits = Math.max(1, projects.length + conversations.length);
  let doneUnits = 0;
  const percent = () => (doneUnits / totalUnits) * 100;

  // A project keeps the folder it was first given, even if it is renamed later
  const takenFolders = new Set(Object.values(index.projects).map((name) => name.toLowerCase()));
  const projectFolder = (project) => {
    if (!index.projects[project.uuid]) {
      index.projects[project.uuid] = uniqueFilename(sanitizeFilename(project.name || 'Untitled Project'), '', takenFolders);
    }
    return `Projects/${index.projects[project.uuid]}/`;
  };

  // ---- 1. Projects: instructions and knowledge files
  for (const project of projects) {
    if (isCancelled()) return finish(true);
    const name = project.name || 'Untitled Project';
    const base = projectFolder(project);
    report(t('{0}: instructions and files', name), percent());

    if (o.includeInstructions) {
      try {
        const detail = await getProject(orgId, project.uuid);
        const instructions = typeof detail.prompt_template === 'string' ? detail.prompt_template : '';
        if (instructions.trim().length > 0) {
          const hash = await sha256Hex(instructions);
          const path = `${base}instructions.md`;
          if (index.instructions[project.uuid] === hash && await fsExists(dir, path)) {
            counts.unchanged++;
          } else {
            await fsWriteFile(dir, path, instructions);
            index.instructions[project.uuid] = hash;
            counts.written++;
          }
        }
      } catch (error) {
        if (error.cancelled) return finish(true);
        fail('project details', name, error);
      }
    }

    if (o.includeKnowledge) {
      let docs = [];
      let files = [];
      try { docs = await listProjectDocs(orgId, project.uuid); } catch (error) { if (!error.cancelled) fail('knowledge documents', name, error); }
      try { files = await listProjectFiles(orgId, project.uuid); } catch (error) { if (!error.cancelled) fail('knowledge files', name, error); }

      // Names already used in this project's files/ folder
      const usedNames = new Set(Object.entries(index.knowledge)
        .filter(([key]) => key.startsWith(`${project.uuid}/`))
        .map(([, entry]) => entry.path.split('/').pop().toLowerCase()));

      for (const item of mergeProjectKnowledge(docs, files)) {
        if (isCancelled()) return finish(true);
        const fileId = item.file && (item.file.file_uuid || item.file.uuid);
        const key = `${project.uuid}/${fileId ? `file:${fileId}` : `doc:${item.name}`}`;
        const known = index.knowledge[key];
        try {
          if (fileId) {
            // An upload never changes: one download is enough
            if (known && await fsExists(dir, known.path)) {
              counts.unchanged++;
              continue;
            }
            const { content, record } = await fetchFileItem(orgId, item, usedNames, 'files/');
            if (content === null) {
              fail('knowledge file', item.name, new Error(record.note || 'not returned by claude.ai'));
              continue;
            }
            await fsWriteFile(dir, `${base}${record.path}`, content);
            index.knowledge[key] = { path: `${base}${record.path}`, sha256: record.sha256, fidelity: record.fidelity };
            counts.written++;
          } else if (typeof item.text === 'string') {
            const hash = await sha256Hex(item.text);
            if (known && known.sha256 === hash && await fsExists(dir, known.path)) {
              counts.unchanged++;
              continue;
            }
            const fidelity = isBinaryFilename(item.name) ? 'extracted-text' : 'original';
            const path = known ? known.path : `${base}files/${fidelityFilename(item.name, fidelity, null, usedNames)}`;
            await fsWriteFile(dir, path, item.text);
            index.knowledge[key] = { path, sha256: hash, fidelity };
            counts.written++;
          }
        } catch (error) {
          if (error.cancelled) return finish(true);
          fail('knowledge file', item.name, error);
        }
      }
    }
    doneUnits++;
  }

  // ---- 2. Conversations
  if (o.includeProjectChats) {
    const projectIds = new Set(projects.map((project) => project.uuid));
    // Where a conversation's files go: its project's folder, or the top level
    const baseFor = (conv) => (projectIds.has(projectIdOf(conv)) ? index.projects[projectIdOf(conv)] && `Projects/${index.projects[projectIdOf(conv)]}/` : '');
    const chatFolder = (conv) => (baseFor(conv) ? `${baseFor(conv)}chats/` : 'Chats/');

    // Names in use per chat folder, from what earlier runs wrote
    const namesByFolder = new Map();
    const namesIn = (folder) => {
      if (!namesByFolder.has(folder)) namesByFolder.set(folder, new Set());
      return namesByFolder.get(folder);
    };
    for (const entry of Object.values(index.chats)) {
      namesIn(entry.path.slice(0, entry.path.lastIndexOf('/') + 1)).add(baseNameOf(entry.path).toLowerCase());
    }

    // First pass, no network: which conversations need reading again?
    const wanted = [];
    for (const conv of conversations) {
      const known = index.chats[conv.uuid];
      const current = known
        && known.updatedAt === (conv.updated_at || '')
        && known.signature === signature
        && known.path.startsWith(chatFolder(conv))
        && await fsExists(dir, known.path);
      if (current) {
        counts.unchanged++;
        doneUnits++;
      } else {
        wanted.push(conv);
      }
    }

    let sinceSave = 0;
    for (let i = 0; i < wanted.length; i += DMT_BULK_BATCH_SIZE) {
      if (isCancelled()) return finish(true);
      report(t('Chats: {0} of {1} to update', Math.min(i + DMT_BULK_BATCH_SIZE, wanted.length), wanted.length), percent());

      const fetched = await Promise.all(wanted.slice(i, i + DMT_BULK_BATCH_SIZE).map((conv) => getConversation(orgId, conv.uuid).then(
        (data) => ({ conv, data }),
        (error) => ({ conv, error })
      )));

      for (const { conv, data, error: fetchError } of fetched) {
        doneUnits++;
        try {
          if (fetchError) throw fetchError;
          data.model = inferModel(data);
          const known = index.chats[conv.uuid];
          const folder = chatFolder(conv);
          const base = baseFor(conv) || '';
          const used = namesIn(folder);
          const rendered = renderConversation(data, conv.uuid, o);

          // Keep the name it already has, unless the title or the folder changed
          let name;
          if (known && known.name === (conv.name || '') && known.path.startsWith(folder)) {
            name = baseNameOf(known.path);
          } else {
            if (known) used.delete(baseNameOf(known.path).toLowerCase());
            name = uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', used);
          }
          const path = `${folder}${name}.${rendered.ext}`;

          if (known && known.path !== path) {
            // Written under a new name: take the old copy away
            const oldName = baseNameOf(known.path);
            const oldBase = known.path.startsWith('Chats/') ? '' : known.path.slice(0, known.path.lastIndexOf('chats/'));
            await fsRemove(dir, known.path);
            await fsRemove(dir, `${oldBase}artifacts/${oldName}`);
            await fsRemove(dir, `${oldBase}attachments/${oldName}`);
            if (baseNameOf(known.path) !== name) counts.renamed++;
          }

          await fsWriteFile(dir, path, rendered.content);
          if (o.extractArtifacts || o.flattenArtifacts) {
            for (const artifact of extractArtifactFiles(data, o.artifactFormat)) {
              await fsWriteFile(dir, `${base}artifacts/${name}/${artifact.filename}`, artifact.content);
            }
          }
          if (o.includeAttachments) {
            const attachments = await collectAttachmentEntries(orgId, data, `${base}attachments/${name}/`);
            for (const entry of attachments.entries) await fsWriteFile(dir, entry.path, entry.content);
          }

          index.chats[conv.uuid] = { path, name: conv.name || '', updatedAt: conv.updated_at || '', signature };
          counts.written++;
        } catch (error) {
          if (error.cancelled) return finish(true);
          fail('chat', conv.name || conv.uuid, error);
        }
      }

      sinceSave += fetched.length;
      if (sinceSave >= DMT_SYNC_SAVE_EVERY) {
        await writeSyncIndex(dir, index); // a stopped run resumes from here
        sinceSave = 0;
      }
      if (i + DMT_BULK_BATCH_SIZE < wanted.length && !isCancelled()) {
        await new Promise((resolve) => setTimeout(resolve, DMT_BULK_BATCH_PAUSE_MS));
      }
    }
  }

  return finish(false);
}

// ---------------------------------------------------------------- remembering the folder

// The chosen folder's handle is kept in IndexedDB (handles cannot go in
// extension storage). The browser may still ask for permission again.
function syncHandleStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('downloadmythings-sync', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('handles', mode);
      const request = action(transaction.objectStore('handles'));
      transaction.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}

function saveSyncFolder(handle) {
  return syncHandleStore('readwrite', (store) => store.put(handle, 'folder'));
}

async function loadSyncFolder() {
  try {
    return (await syncHandleStore('readonly', (store) => store.get('folder'))) || null;
  } catch (error) {
    return null;
  }
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_SYNC_INDEX_PATH,
    fsWriteFile,
    fsReadText,
    fsExists,
    fsRemove,
    readSyncIndex,
    syncSignature,
    describeSync,
    syncAccountToFolder,
    saveSyncFolder,
    loadSyncFolder,
  };
}
