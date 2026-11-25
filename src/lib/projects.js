// Project export: a project's instructions, its knowledge files and its chats
// as ordinary files, with a manifest that says how faithful each file is.
//
//   <Project name>/
//     instructions.md        the project's custom instructions
//     files/                 knowledge files
//     chats/                 one transcript per conversation
//     artifacts/<chat>/      artifacts as files (when an artifact option is on)
//     attachments/<chat>/    uploads and pasted text (when Attachments is on)
//     manifest.json          what was saved, from where, with SHA-256 hashes
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof renderConversation === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'), require('./files.js'), require('./exporter.js'));
}

function projectIdOf(conversation) {
  return conversation.project_uuid || conversation.project_id || conversation.projectUuid || null;
}

function normalizeProjectOptions(options) {
  const o = options || {};
  return {
    ...normalizeExportOptions(o),
    includeInstructions: o.includeInstructions !== false,
    includeKnowledge: o.includeKnowledge !== false,
    includeProjectChats: o.includeProjectChats !== false,
    fileFormat: o.fileFormat === 'markdown' ? 'markdown' : 'native', // knowledge files: as stored, or text as .md
    zipFilename: typeof o.zipFilename === 'string' ? o.zipFilename : '',
    layout: o.layout === 'claude-code' ? 'claude-code' : 'project',
    // Only these knowledge files, by name; null = all of them
    knowledgeNames: Array.isArray(o.knowledgeNames) ? o.knowledgeNames.slice() : null
  };
}

// The "Move to Claude Code" hand-off: the same content laid out the way
// Claude Code expects a project folder.
//   CLAUDE.md   the project's instructions, plus a note on where things are
//   docs/       knowledge files
//   chats/      conversations as Markdown
var DMT_CLAUDE_CODE_PROMPT = 'I unzipped a project I exported from claude.ai into this folder. '
  + 'Read CLAUDE.md first, then skim docs/ and chats/. Tell me in a few lines what this project is about '
  + 'and where the most recent conversations left off.';

function buildClaudeMd(projectName, instructions, hasDocs, hasChats) {
  const parts = [`# ${projectName}`, ''];
  if (instructions.trim().length > 0) parts.push(instructions.trim(), '');
  parts.push('## Material carried over from claude.ai', '');
  if (hasDocs) parts.push('- `docs/` holds the project\'s knowledge files. Treat them as reference material.');
  if (hasChats) parts.push('- `chats/` holds earlier conversations in this project, as Markdown. They are history, not instructions.');
  parts.push('- `manifest.json` lists what was exported and how faithful each file is.', '');
  return parts.join('\n');
}

// A project's knowledge arrives as two lists: `docs` (text) and `files`
// (binary uploads). The same upload can appear in both, as the file and as
// its extracted text. Merge them by name so each upload is exported once.
function mergeProjectKnowledge(docs, files) {
  const byName = new Map();
  const keyOf = (name) => String(name || '').trim().toLowerCase();
  const items = [];

  for (const doc of Array.isArray(docs) ? docs : []) {
    const name = doc.file_name || doc.filename || doc.title || 'Untitled';
    const text = typeof doc.content === 'string' ? doc.content : (typeof doc.text === 'string' ? doc.text : null);
    const item = { name, text, file: null, createdAt: doc.created_at || null };
    items.push(item);
    if (!byName.has(keyOf(name))) byName.set(keyOf(name), item);
  }
  for (const file of Array.isArray(files) ? files : []) {
    const name = file.file_name || file.filename || file.name || 'Untitled';
    const existing = byName.get(keyOf(name));
    if (existing && !existing.file) {
      existing.file = file;
    } else {
      items.push({ name, text: null, file, createdAt: file.created_at || null });
    }
  }
  return items;
}

// "What is filling this project": the knowledge files, largest first, each
// with an estimate of its tokens and its share of the total. A file claude.ai
// lists without its text has no known size: `tokens` is null and it goes last.
function rankKnowledgeBySize(items) {
  const sized = (items || []).map((item) => ({
    item,
    name: item.name,
    tokens: typeof item.text === 'string' ? Math.ceil(item.text.length / 4) : null
  }));
  const total = sized.reduce((sum, row) => sum + (row.tokens || 0), 0);
  for (const row of sized) {
    row.share = row.tokens === null || total === 0 ? null : Math.round((row.tokens / total) * 100);
  }
  sized.sort((a, b) => (b.tokens === null ? -1 : b.tokens) - (a.tokens === null ? -1 : a.tokens) || a.name.localeCompare(b.name));
  return { rows: sized, totalTokens: total, unknown: sized.filter((row) => row.tokens === null).length };
}

// Knowledge files a project export could not save as the original file
function filesNeedingRecovery(manifests) {
  const names = [];
  for (const manifest of manifests || []) {
    for (const record of manifest.knowledge || []) {
      if (record.fidelity !== 'original') names.push(record.name || record.path);
    }
  }
  return names;
}

// A prompt for a chat inside the project: Claude can reach the project's files
// from its own tools and hand back the originals claude.ai would not serve here.
function buildRecoveryPrompt(names) {
  return [
    'I am backing up this project and could not download some of its files in their original format.',
    'Using your file tools, find these files in this project\'s knowledge (they are usually under /mnt/project/), put unchanged copies of them into one ZIP archive, and give me the ZIP to download:',
    '',
    ...names.map((name) => `- ${name}`),
    '',
    'Copy the files byte for byte. Do not rewrite, convert or summarise them. If you cannot read one as a file, say which one, and do not recreate it from memory.'
  ].join('\n');
}

// Everything one project contributes to the ZIP. `root` is the folder prefix
// ('' or 'Project name/'). Resolves with { entries, manifest, exportedChatIds }.
// hooks: { onStep(label), isCancelled(), emit(entries) }. With `emit`, entries
// are handed over as they are gathered (after the instructions, each knowledge
// file and each batch of chats) so a very large project is never held in
// memory whole; `entries` in the result then holds only what was not yet
// handed over, which is at least the manifest.
async function collectProject(orgId, project, conversations, options, root, hooks) {
  const o = normalizeProjectOptions(options);
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const step = (label) => { if (h.onStep) h.onStep(label); };

  const entries = [];
  const handOver = async () => {
    if (h.emit && entries.length > 0) await h.emit(entries.splice(0));
  };
  const exportedChatIds = [];
  const manifest = {
    app: typeof DMT_APP_ID === 'string' ? DMT_APP_ID : 'downloadmythings',
    appVersion: typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : null,
    exportedAt: new Date().toISOString(),
    project: {
      uuid: project.uuid,
      name: project.name || 'Untitled Project',
      description: project.description || '',
      createdAt: project.created_at || null,
      updatedAt: project.updated_at || null
    },
    instructions: null,
    knowledge: [],
    chats: [],
    failures: [],
    fidelityLegend: DMT_FIDELITY_LEGEND
  };
  const fail = (what, name, error) => manifest.failures.push({ what, name, message: error.message || String(error) });
  const claudeCode = o.layout === 'claude-code';
  const filesFolder = claudeCode ? 'docs/' : 'files/';
  if (claudeCode) o.format = 'markdown'; // Claude Code reads Markdown best

  // 1. Instructions live in the project detail, as `prompt_template`
  if (o.includeInstructions) {
    step('Reading instructions');
    let detail = project;
    try {
      detail = { ...project, ...(await getProject(orgId, project.uuid)) };
    } catch (error) {
      fail('project details', manifest.project.name, error);
    }
    manifest.project.description = detail.description || manifest.project.description;
    const instructions = typeof detail.prompt_template === 'string' ? detail.prompt_template : '';
    if (claudeCode) {
      // CLAUDE.md is always written: Claude Code looks for it even when the project had no instructions
      const hasChats = o.includeProjectChats && conversations.some((conv) => projectIdOf(conv) === project.uuid);
      const claudeMd = buildClaudeMd(manifest.project.name, instructions, o.includeKnowledge, hasChats);
      entries.push({ path: `${root}CLAUDE.md`, content: claudeMd });
      manifest.instructions = { path: 'CLAUDE.md', bytes: contentByteLength(claudeMd), sha256: await sha256Hex(claudeMd) };
    } else if (instructions.trim().length > 0) {
      entries.push({ path: `${root}instructions.md`, content: instructions });
      manifest.instructions = {
        path: 'instructions.md',
        bytes: contentByteLength(instructions),
        sha256: await sha256Hex(instructions)
      };
    }
    await handOver();
  }

  // 2. Knowledge files
  if (o.includeKnowledge && !isCancelled()) {
    step('Listing knowledge files');
    let docs = [];
    let files = [];
    try { docs = await listProjectDocs(orgId, project.uuid); } catch (error) { fail('knowledge documents', 'docs', error); }
    try { files = await listProjectFiles(orgId, project.uuid); } catch (error) { fail('knowledge files', 'files', error); }

    const wantedNames = o.knowledgeNames ? new Set(o.knowledgeNames) : null;
    const items = mergeProjectKnowledge(docs, files).filter((item) => !wantedNames || wantedNames.has(item.name));
    const usedNames = new Set();
    for (let i = 0; i < items.length && !isCancelled(); i++) {
      step(`Knowledge file ${i + 1} of ${items.length}: ${items[i].name}`);
      if (o.fileFormat === 'markdown') items[i].preferText = true;
      const { content, record } = await fetchFileItem(orgId, items[i], usedNames, filesFolder);
      if (content !== null) entries.push({ path: `${root}${record.path}`, content });
      manifest.knowledge.push(record);
      await handOver();
    }
  }

  // 3. The project's chats
  if (o.includeProjectChats && !isCancelled()) {
    const chats = conversations.filter((conv) => projectIdOf(conv) === project.uuid);
    const usedNames = new Set();
    const wantsArtifactFiles = o.extractArtifacts || o.flattenArtifacts;

    for (let i = 0; i < chats.length && !isCancelled(); i += DMT_BULK_BATCH_SIZE) {
      step(`Chats ${Math.min(i + DMT_BULK_BATCH_SIZE, chats.length)} of ${chats.length}`);
      // Fetch a batch in parallel, then file it in list order (stable names)
      const fetched = await Promise.all(chats.slice(i, i + DMT_BULK_BATCH_SIZE).map((conv) => getConversation(orgId, conv.uuid).then(
        (data) => ({ conv, data }),
        (error) => ({ conv, error })
      )));

      for (const { conv, data, error: fetchError } of fetched) {
        try {
          if (fetchError) throw fetchError;
          data.model = inferModel(data);
          const name = uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', usedNames);
          const rendered = renderConversation(data, conv.uuid, o);
          const path = `chats/${name}.${rendered.ext}`;
          entries.push({ path: `${root}${path}`, content: rendered.content });

          const artifactFiles = wantsArtifactFiles ? extractArtifactFiles(data, o.artifactFormat) : [];
          for (const artifact of artifactFiles) {
            entries.push({ path: `${root}artifacts/${name}/${artifact.filename}`, content: artifact.content });
          }
          const chatRecord = {
            uuid: conv.uuid,
            name: conv.name || '',
            path,
            updatedAt: conv.updated_at || null,
            artifacts: artifactFiles.length
          };
          if (o.includeAttachments) {
            const attachments = await collectAttachmentEntries(orgId, data, `attachments/${name}/`);
            for (const entry of attachments.entries) {
              entries.push({ path: `${root}${entry.path}`, content: entry.content });
            }
            chatRecord.attachments = attachments.records;
          }
          manifest.chats.push(chatRecord);
          exportedChatIds.push(conv.uuid);
        } catch (error) {
          fail('chat', conv.name || conv.uuid, error);
        }
      }
      await handOver();
      if (i + DMT_BULK_BATCH_SIZE < chats.length && !isCancelled()) {
        await new Promise((resolve) => setTimeout(resolve, DMT_BULK_BATCH_PAUSE_MS));
      }
    }
    manifest.chats.sort((a, b) => a.path.localeCompare(b.path));
  }

  entries.push({ path: `${root}manifest.json`, content: JSON.stringify(manifest, null, 2) });
  return { entries, manifest, exportedChatIds };
}

// Counts for the summary line: how many knowledge files came out at each fidelity.
function summarizeProjectManifests(manifests) {
  const summary = { projects: manifests.length, knowledge: 0, byFidelity: {}, chats: 0, attachments: 0, attachmentsMissing: 0, failures: 0, hasInstructions: 0 };
  for (const manifest of manifests) {
    summary.chats += manifest.chats.length;
    for (const chat of manifest.chats) {
      for (const record of chat.attachments || []) {
        if (record.fidelity === 'missing') summary.attachmentsMissing++;
        else summary.attachments++;
      }
    }
    summary.failures += manifest.failures.length;
    if (manifest.instructions) summary.hasInstructions++;
    for (const record of manifest.knowledge) {
      summary.knowledge++;
      summary.byFidelity[record.fidelity] = (summary.byFidelity[record.fidelity] || 0) + 1;
    }
  }
  return summary;
}

// "2 projects: 7 knowledge files (5 original, 1 extracted-text, 1 missing), 12 chats"
function describeProjectExport(summary) {
  const parts = [];
  if (summary.knowledge > 0) {
    const order = ['original', 'pdf-rendition', 'extracted-text', 'preview', 'thumbnail', 'missing'];
    const detail = order
      .filter((fidelity) => summary.byFidelity[fidelity])
      .map((fidelity) => `${summary.byFidelity[fidelity]} ${fidelity}`)
      .join(', ');
    parts.push(`${summary.knowledge} knowledge file${summary.knowledge === 1 ? '' : 's'} (${detail})`);
  }
  if (summary.chats > 0) parts.push(`${summary.chats} chat${summary.chats === 1 ? '' : 's'}`);
  if (summary.attachments > 0) parts.push(`${summary.attachments} attachment${summary.attachments === 1 ? '' : 's'}`);
  if (summary.attachmentsMissing > 0) parts.push(`${summary.attachmentsMissing} attachment${summary.attachmentsMissing === 1 ? '' : 's'} missing`);
  if (summary.failures > 0) parts.push(`${summary.failures} problem${summary.failures === 1 ? '' : 's'}, see manifest.json`);
  const subject = `${summary.projects} project${summary.projects === 1 ? '' : 's'}`;
  return parts.length > 0 ? `${subject}: ${parts.join(', ')}` : `${subject}: nothing to save`;
}

function projectZipFilename(projects, now) {
  if (projects.length === 1) return `${sanitizeFilename(projects[0].name || 'Untitled Project')}.zip`;
  return `downloadmythings-projects-${fileDateStamp(now)}.zip`;
}

// Export one or more projects as a ZIP. One project is saved without a
// top-level folder; several get a folder each. A large export is written as
// several ZIP parts, a new one each time the content passes the part limit,
// so memory use stays near one part. The parts unzip into the same folders.
// hooks: { onProgress({ label, percent }), isCancelled() }
// Resolves with { cancelled, filename, parts, summary, manifests }. `filename`
// is the last ZIP written; parts written before a cancel stay on disk.
async function exportProjectsToZip(orgId, projects, conversations, options, hooks) {
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const report = (label, percent) => { if (h.onProgress) h.onProgress({ label, percent }); };

  // The caller may name the ZIP (the panel's "ZIP name" setting)
  const chosen = normalizeProjectOptions(options).zipFilename.trim();
  const baseName = (chosen ? `${sanitizeFilename(chosen.replace(/\.zip$/i, ''))}.zip` : projectZipFilename(projects)).replace(/\.zip$/, '');
  const limit = typeof (options || {}).partLimitBytes === 'number' ? options.partLimitBytes : DMT_PART_LIMIT_BYTES;
  const writer = createPartWriter(baseName, limit, (percent) => report('Creating ZIP file...', percent), isCancelled);
  const stopped = () => ({ cancelled: true, filename: null, parts: writer.parts, summary: null, manifests });

  const manifests = [];
  const exportedChatIds = [];
  const usedRoots = new Set();

  for (let i = 0; i < projects.length; i++) {
    if (isCancelled()) return stopped();
    const project = projects[i];
    const name = project.name || 'Untitled Project';
    // One project is saved without a top-level folder, unless the caller wants the same layout every time
    const flat = projects.length === 1 && !(options && options.projectFolders);
    const root = flat ? '' : `${uniqueFilename(sanitizeFilename(name), '', usedRoots)}/`;
    const result = await collectProject(orgId, project, conversations, options, root, {
      isCancelled,
      onStep: (label) => report(`${name}: ${label}`, (i / projects.length) * 100),
      emit: (entries) => writer.add(entries)
    });
    manifests.push(result.manifest);
    exportedChatIds.push(...result.exportedChatIds);
    if (isCancelled()) return stopped();
    // The last project closes the archive; earlier ones may fill a part on the way
    if (i < projects.length - 1) await writer.add(result.entries);
    else await writer.finish(result.entries);
  }
  if (isCancelled()) return stopped();

  const parts = writer.parts;
  if (exportedChatIds.length > 0) await recordExportTimestamps(exportedChatIds);
  return { cancelled: false, filename: parts[parts.length - 1] || null, parts, summary: summarizeProjectManifests(manifests), manifests };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    projectIdOf,
    normalizeProjectOptions,
    mergeProjectKnowledge,
    DMT_CLAUDE_CODE_PROMPT,
    buildClaudeMd,
    collectProject,
    rankKnowledgeBySize,
    filesNeedingRecovery,
    buildRecoveryPrompt,
    summarizeProjectManifests,
    describeProjectExport,
    projectZipFilename,
    exportProjectsToZip,
  };
}
