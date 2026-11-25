// Export Everything: the whole account in one action.
//
//   Projects/<Project name>/   each project as a project export
//                              (instructions, files, chats, its own manifest)
//   Chats/                     conversations that belong to no exported project
//   memory.json                account memory, when claude.ai returns it
//   manifest.json              what was saved, what was not, and any problems
//
// A large account is written as several ZIP parts, so the browser does not
// have to hold everything in memory at once.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof collectProject === 'undefined') {
  Object.assign(
    globalThis,
    require('./utils.js'), require('./store.js'), require('./api.js'),
    require('./files.js'), require('./exporter.js'), require('./projects.js')
  );
}

// "12 projects and 840 other chats in 2 ZIP files; 3 problems, see manifest.json"
function describeAccountExport(counts, partCount) {
  const text = t('{0} and {1} in {2}',
    tn('{n} project', '{n} projects', counts.projects),
    tn('{n} other chat', '{n} other chats', counts.otherChats),
    tn('{n} ZIP file', '{n} ZIP files', partCount));
  if (counts.problems === 0) return text;
  return t('{0}; {1}', text, tn('{n} problem, see manifest.json', '{n} problems, see manifest.json', counts.problems));
}

// hooks: { onProgress({ label, percent }), isCancelled() }
// Resolves with { cancelled, parts, counts }. Parts downloaded before a cancel stay on disk.
async function exportEverything(orgId, projects, conversations, options, hooks) {
  const o = normalizeProjectOptions(options);
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const report = (label, percent) => { if (h.onProgress) h.onProgress({ label, percent }); };

  const exportedProjectIds = new Set(projects.map((project) => project.uuid));
  // A chat whose project is not being exported still must not be lost
  const otherChats = conversations.filter((conv) => !exportedProjectIds.has(projectIdOf(conv)));
  const totalUnits = Math.max(1, projects.length + otherChats.length);
  let doneUnits = 0;
  const percent = () => (doneUnits / totalUnits) * 100;

  const baseName = `downloadmythings-everything-${fileDateStamp()}`;
  const limit = typeof (options || {}).partLimitBytes === 'number' ? options.partLimitBytes : DMT_PART_LIMIT_BYTES;
  const writer = createPartWriter(baseName, limit, (zipPercent) => report(t('Creating ZIP file...'), zipPercent));

  const manifest = {
    app: typeof DMT_APP_ID === 'string' ? DMT_APP_ID : 'downloadmythings',
    appVersion: typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : null,
    exportedAt: new Date().toISOString(),
    parts: [],
    projects: [],
    otherChats: [],
    memory: null,
    notIncluded: [],
    failures: []
  };
  const exportedChatIds = [];
  const cancelled = () => ({ cancelled: true, parts: writer.parts, counts: null });

  // 1. Projects
  const usedRoots = new Set();
  for (const project of projects) {
    if (isCancelled()) return cancelled();
    const name = project.name || 'Untitled Project';
    const folder = uniqueFilename(sanitizeFilename(name), '', usedRoots);
    const result = await collectProject(orgId, project, conversations, o, `Projects/${folder}/`, {
      isCancelled,
      onStep: (label) => report(`${name}: ${label}`, percent()),
      emit: (entries) => writer.add(entries)
    });
    await writer.add(result.entries);
    exportedChatIds.push(...result.exportedChatIds);
    manifest.projects.push({
      uuid: project.uuid,
      name,
      path: `Projects/${folder}/`,
      instructions: Boolean(result.manifest.instructions),
      knowledgeFiles: result.manifest.knowledge.length,
      chats: result.manifest.chats.length,
      problems: result.manifest.failures.length
        + result.manifest.knowledge.filter((record) => record.fidelity === 'missing').length
    });
    doneUnits++;
  }

  // 2. Chats outside those projects
  const usedNames = new Set();
  for (let i = 0; i < otherChats.length; i += DMT_BULK_BATCH_SIZE) {
    if (isCancelled()) return cancelled();
    report(t('Other chats {0} of {1}', Math.min(i + DMT_BULK_BATCH_SIZE, otherChats.length), otherChats.length), percent());

    const fetched = await Promise.all(otherChats.slice(i, i + DMT_BULK_BATCH_SIZE).map((conv) => getConversation(orgId, conv.uuid).then(
      (data) => ({ conv, data }),
      (error) => ({ conv, error })
    )));

    for (const { conv, data, error: fetchError } of fetched) {
      try {
        if (fetchError) throw fetchError;
        data.model = inferModel(data);
        const plan = planBulkConversation(data, conv, o, usedNames);
        const entries = plan.entries.map((entry) => ({ path: `Chats/${entry.path}`, content: entry.content }));
        const record = { uuid: conv.uuid, name: conv.name || '', updatedAt: conv.updated_at || null };

        if (o.includeAttachments && listConversationAttachments(data).length > 0) {
          const name = plan.name || uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', usedNames);
          const collected = await collectAttachmentEntries(orgId, data, `Chats/${bulkAttachmentPrefix(o, name)}`);
          entries.push(...collected.entries);
          record.attachments = collected.records;
        }
        await writer.add(entries);
        manifest.otherChats.push(record);
        exportedChatIds.push(conv.uuid);
      } catch (error) {
        manifest.failures.push({ what: 'chat', name: conv.name || conv.uuid, message: error.message || String(error) });
      }
      doneUnits++;
    }

    if (i + DMT_BULK_BATCH_SIZE < otherChats.length && !isCancelled()) {
      await new Promise((resolve) => setTimeout(resolve, DMT_BULK_BATCH_PAUSE_MS));
    }
  }
  if (isCancelled()) return cancelled();

  // 3. Memory, when claude.ai hands it over. Styles have no known endpoint yet.
  const lastEntries = [];
  try {
    const memory = await getAccountMemory(orgId);
    lastEntries.push({ path: 'memory.json', content: JSON.stringify(memory, null, 2) });
    manifest.memory = 'memory.json';
  } catch (error) {
    manifest.notIncluded.push({ what: 'memory', reason: `claude.ai did not return it (${error.message})` });
  }
  manifest.notIncluded.push({ what: 'styles', reason: 'Not supported yet' });

  // 4. The account manifest goes in the last part
  const counts = {
    projects: manifest.projects.length,
    projectChats: manifest.projects.reduce((sum, project) => sum + project.chats, 0),
    knowledgeFiles: manifest.projects.reduce((sum, project) => sum + project.knowledgeFiles, 0),
    otherChats: manifest.otherChats.length,
    problems: manifest.failures.length + manifest.projects.reduce((sum, project) => sum + project.problems, 0)
  };
  manifest.counts = counts;
  manifest.parts = [...writer.parts, writer.finalName()];
  lastEntries.push({ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) });

  const parts = await writer.finish(lastEntries);
  if (exportedChatIds.length > 0) await recordExportTimestamps(exportedChatIds);
  return { cancelled: false, parts, counts };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_PART_LIMIT_BYTES,
    createPartWriter,
    describeAccountExport,
    exportEverything,
  };
}
