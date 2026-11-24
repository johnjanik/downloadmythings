// Export logic shared by the content script (popup exports) and the browse page.
//
// The build* functions are pure: they turn conversation data plus options into
// a list of files, and are covered by unit tests. The export* functions fetch,
// zip, download and record what was exported.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof convertToMarkdown === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'), require('./files.js'));
}

var DMT_BULK_BATCH_SIZE = 3;      // conversations fetched in parallel
var DMT_BULK_BATCH_PAUSE_MS = 200; // pause between batches, to go easy on the API

// Local date and time for filenames: 20261124-143045
function fileDateStamp(now) {
  const d = now || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeExportOptions(options) {
  const o = options || {};
  return {
    format: o.format === 'markdown' || o.format === 'text' ? o.format : 'json',
    includeChats: o.includeChats !== false,
    includeThinking: Boolean(o.includeThinking),
    includeMetadata: Boolean(o.includeMetadata),
    includeArtifacts: Boolean(o.includeArtifacts),
    extractArtifacts: Boolean(o.extractArtifacts),   // artifacts as files in nested folders
    flattenArtifacts: Boolean(o.flattenArtifacts),   // artifacts as files in one flat folder
    artifactFormat: o.artifactFormat || 'original',
    includeAttachments: Boolean(o.includeAttachments), // uploads and pasted text as files
    frontMatter: Boolean(o.frontMatter)               // YAML front matter on Markdown chats (Obsidian)
  };
}

// True when the options cannot produce any file at all.
function isNothingToExport(options) {
  const o = normalizeExportOptions(options);
  return !o.includeChats && !o.extractArtifacts && !o.flattenArtifacts && !o.includeAttachments;
}

var DMT_NOTHING_TO_EXPORT = 'Nothing to export. Enable "Chats", "Attachments" or one of the artifact file options.';

// Keep the conversations last updated inside a date range. `from` and `to`
// are 'YYYY-MM-DD' strings from date inputs (local days, both inclusive);
// either may be empty. A conversation with no usable date is kept.
function filterConversationsByUpdated(conversations, from, to) {
  const start = from ? new Date(`${from}T00:00:00`) : null;
  const end = to ? new Date(`${to}T23:59:59.999`) : null;
  const valid = (date) => date && !Number.isNaN(date.getTime());
  if (!valid(start) && !valid(end)) return conversations;

  return conversations.filter((conv) => {
    const updated = new Date(conv.updated_at || conv.created_at || '');
    if (Number.isNaN(updated.getTime())) return true;
    if (valid(start) && updated < start) return false;
    if (valid(end) && updated > end) return false;
    return true;
  });
}

// The conversation transcript in the chosen format.
// YAML front matter for a Markdown transcript: the properties Obsidian and
// similar note tools read. Values are JSON strings, which are valid YAML.
function buildFrontMatter(data, conversationId, extra) {
  const fields = {
    title: data.name || 'Untitled Conversation',
    created: data.created_at || null,
    updated: data.updated_at || null,
    model: data.model || null,
    source: conversationId ? `https://claude.ai/chat/${conversationId}` : null,
    ...(extra || {})
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`);
  return `---\n${lines.join('\n')}\ntags: ["claude"]\n---\n\n`;
}

function renderConversation(data, conversationId, options) {
  const o = normalizeExportOptions(options);
  switch (o.format) {
    case 'markdown':
      return {
        content: (o.frontMatter ? buildFrontMatter(data, conversationId, (options || {}).frontMatterExtra) : '')
          + convertToMarkdown(data, o.includeMetadata, conversationId, o.includeArtifacts, o.includeThinking),
        ext: 'md',
        type: 'text/markdown'
      };
    case 'text':
      return {
        content: convertToText(data, o.includeMetadata, o.includeArtifacts, o.includeThinking),
        ext: 'txt',
        type: 'text/plain'
      };
    default:
      return { content: JSON.stringify(data, null, 2), ext: 'json', type: 'application/json' };
  }
}

// What exporting ONE conversation produces:
//   { kind: 'file', filename, content, type, artifactCount: 0 }
//   { kind: 'zip', filename, entries: [{ path, content }], artifactCount }
//   { kind: 'empty', error }
function buildConversationExport(data, conversationId, options, displayName) {
  const o = normalizeExportOptions(options);
  if (isNothingToExport(o)) return { kind: 'empty', error: DMT_NOTHING_TO_EXPORT };

  const safeName = sanitizeFilename(displayName || data.name || conversationId);
  const wantsArtifactFiles = o.extractArtifacts || o.flattenArtifacts;
  const artifactFiles = wantsArtifactFiles ? extractArtifactFiles(data, o.artifactFormat) : [];

  if (artifactFiles.length === 0) {
    if (!o.includeChats) return { kind: 'empty', error: 'No artifacts found in this conversation.' };
    const rendered = renderConversation(data, conversationId, o);
    return {
      kind: 'file',
      filename: `${safeName}.${rendered.ext}`,
      content: rendered.content,
      type: rendered.type,
      artifactCount: 0
    };
  }

  const entries = [];
  const flat = o.flattenArtifacts && !o.extractArtifacts;
  if (o.includeChats) {
    const rendered = renderConversation(data, conversationId, o);
    entries.push({ path: `${flat ? 'Chats/' : ''}${safeName}.${rendered.ext}`, content: rendered.content });
  }
  for (const artifact of artifactFiles) {
    const path = flat
      ? `Artifacts/${safeName}_${artifact.filename}`
      : `${o.includeChats ? 'artifacts/' : ''}${artifact.filename}`;
    entries.push({ path, content: artifact.content });
  }
  return { kind: 'zip', filename: `${safeName}.zip`, entries, artifactCount: artifactFiles.length };
}

// The files ONE conversation contributes to a bulk ZIP. Returns [] when the
// conversation has nothing to add (chats off and no artifacts). `usedNames`
// is a Set shared across the whole export so same-titled chats do not collide.
function buildBulkEntries(data, conv, options, usedNames) {
  return planBulkConversation(data, conv, options, usedNames).entries;
}

// As buildBulkEntries, and also returns the unique name the conversation was
// filed under (null when it added nothing), so attachments can sit beside it.
function planBulkConversation(data, conv, options, usedNames) {
  const o = normalizeExportOptions(options);
  if (isNothingToExport(o)) return { name: null, entries: [] };

  const wantsArtifactFiles = o.extractArtifacts || o.flattenArtifacts;
  const artifactFiles = wantsArtifactFiles ? extractArtifactFiles(data, o.artifactFormat) : [];
  if (!o.includeChats && artifactFiles.length === 0) return { name: null, entries: [] };

  const safeName = uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', usedNames);
  const entries = [];
  const rendered = o.includeChats ? renderConversation(data, conv.uuid, o) : null;

  if (o.extractArtifacts) {
    // Nested: one folder per conversation, artifacts in a subfolder
    if (rendered) entries.push({ path: `${safeName}/${safeName}.${rendered.ext}`, content: rendered.content });
    for (const artifact of artifactFiles) {
      entries.push({ path: `${safeName}/${rendered ? 'artifacts/' : ''}${artifact.filename}`, content: artifact.content });
    }
  } else if (o.flattenArtifacts) {
    // Flat: Chats/ and Artifacts/ at the top level
    if (rendered) entries.push({ path: `Chats/${safeName}.${rendered.ext}`, content: rendered.content });
    for (const artifact of artifactFiles) {
      entries.push({ path: `Artifacts/${safeName}_${artifact.filename}`, content: artifact.content });
    }
  } else {
    entries.push({ path: `${safeName}.${rendered.ext}`, content: rendered.content });
  }
  return { name: safeName, entries };
}

// Where a conversation's attachments go inside a bulk ZIP, matching the
// artifact layout in use. The result is a path prefix, not always a folder.
function bulkAttachmentPrefix(options, name) {
  const o = normalizeExportOptions(options);
  if (o.extractArtifacts) return `${name}/attachments/`;   // nested: inside the conversation's folder
  if (o.flattenArtifacts) return `Attachments/${name}_`;   // flat: one shared folder, name as prefix
  return `attachments/${name}/`;
}

function countAttachmentRecords(records) {
  const missing = records.filter((record) => record.fidelity === 'missing').length;
  return { saved: records.length - missing, missing };
}

function bulkZipFilename(options, now) {
  const o = normalizeExportOptions(options);
  const artifactsOnly = o.flattenArtifacts && !o.extractArtifacts && !o.includeChats;
  return `downloadmythings-${artifactsOnly ? 'artifacts' : 'export'}-${fileDateStamp(now)}.zip`;
}

function zipEntries(entries, onProgress) {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }
  return zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    onProgress ? (metadata) => onProgress(metadata.percent) : undefined
  );
}

var DMT_PART_LIMIT_BYTES = 256 * 1024 * 1024; // start a new ZIP part past this much content

// Gathers entries and downloads a ZIP part each time the limit is passed.
// A single part is named "<base>.zip"; several are "<base>-part1.zip", ...
// `isCancelled`, when given, is asked after each ZIP is built: a cancelled part is not saved.
function createPartWriter(baseName, limitBytes, onZipProgress, isCancelled) {
  let entries = [];
  let bytes = 0;
  const parts = [];

  const nextName = (isLast) => (isLast && parts.length === 0 ? `${baseName}.zip` : `${baseName}-part${parts.length + 1}.zip`);

  async function flush(isLast) {
    if (entries.length === 0) return;
    const filename = nextName(isLast);
    const blob = await zipEntries(entries, onZipProgress);
    if (isCancelled && isCancelled()) return;
    downloadFile(blob, filename, 'application/zip');
    parts.push(filename);
    entries = [];
    bytes = 0;
  }

  return {
    parts,
    // The name the final part will get, for the manifest inside it
    finalName: () => nextName(true),
    async add(newEntries) {
      for (const entry of newEntries) {
        entries.push(entry);
        bytes += contentByteLength(entry.content);
      }
      if (bytes >= limitBytes) await flush(false);
    },
    async finish(lastEntries) {
      entries.push(...lastEntries);
      await flush(true);
      return parts;
    }
  };
}

// Fetch one conversation and download it. Resolves with { filename, artifactCount }.
async function exportConversationToFile(orgId, conversationId, options, displayName) {
  if (isNothingToExport(options)) throw new Error(DMT_NOTHING_TO_EXPORT);

  const data = await getConversation(orgId, conversationId);
  if (!data || !Array.isArray(data.chat_messages)) {
    throw new Error('Unexpected conversation data from claude.ai. Refresh the page and try again.');
  }
  data.model = inferModel(data);

  let result = buildConversationExport(data, conversationId, options, displayName);
  let attachments = { saved: 0, missing: 0 };

  if (normalizeExportOptions(options).includeAttachments) {
    const collected = await collectAttachmentEntries(orgId, data, 'attachments/');
    attachments = countAttachmentRecords(collected.records);
    if (collected.records.length > 0) {
      // Attachments turn the export into a ZIP: transcript, artifacts, attachments
      const safeName = sanitizeFilename(displayName || data.name || conversationId);
      const base = result.kind === 'zip'
        ? result.entries
        : (result.kind === 'file' ? [{ path: result.filename, content: result.content }] : []);
      result = {
        kind: 'zip',
        filename: `${safeName}.zip`,
        entries: [
          ...base,
          ...collected.entries,
          { path: 'attachments.json', content: JSON.stringify(collected.records, null, 2) }
        ],
        artifactCount: result.artifactCount || 0
      };
    }
  }
  if (result.kind === 'empty') throw new Error(result.error);

  if (result.kind === 'zip') {
    downloadFile(await zipEntries(result.entries), result.filename, 'application/zip');
  } else {
    downloadFile(result.content, result.filename, result.type);
  }
  await recordExportTimestamps([conversationId]);
  return { filename: result.filename, artifactCount: result.artifactCount, attachments };
}

// Fetch many conversations and download them as one ZIP.
// hooks: { onProgress({ phase: 'fetch'|'zip', completed, failed, total, percent }), isCancelled() }
// Resolves with { total, completed, failed, included, failures, cancelled, filename }.
async function exportConversationsToZip(orgId, conversations, options, hooks) {
  if (isNothingToExport(options)) throw new Error(DMT_NOTHING_TO_EXPORT);

  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const report = (update) => { if (h.onProgress) h.onProgress(update); };

  const total = conversations.length;
  const entries = [];
  const usedNames = new Set();
  const exportedIds = [];
  const failures = [];
  const attachmentRecords = [];
  const wantsAttachments = normalizeExportOptions(options).includeAttachments;
  let completed = 0;
  let included = 0;

  const summary = (extra) => ({
    total, completed, failed: failures.length, included, failures, cancelled: false, filename: null,
    attachments: countAttachmentRecords(attachmentRecords), ...extra
  });

  for (let i = 0; i < total; i += DMT_BULK_BATCH_SIZE) {
    if (isCancelled()) return summary({ cancelled: true });

    // Fetch a batch in parallel, then file its conversations in list order so
    // the names given to same-titled chats do not depend on network timing.
    const batch = conversations.slice(i, i + DMT_BULK_BATCH_SIZE);
    const fetched = await Promise.all(batch.map((conv) => getConversation(orgId, conv.uuid).then(
      (data) => ({ conv, data }),
      (error) => ({ conv, error })
    )));

    for (const { conv, data, error: fetchError } of fetched) {
      try {
        if (fetchError) throw fetchError;
        data.model = inferModel(data);
        const plan = planBulkConversation(data, conv, options, usedNames);
        const convEntries = plan.entries;
        if (wantsAttachments && listConversationAttachments(data).length > 0) {
          const name = plan.name || uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', usedNames);
          const collected = await collectAttachmentEntries(orgId, data, bulkAttachmentPrefix(options, name));
          convEntries.push(...collected.entries);
          attachmentRecords.push(...collected.records.map((record) => ({ conversation: conv.name || conv.uuid, ...record })));
        }
        entries.push(...convEntries);
        if (convEntries.length > 0) included++;
        exportedIds.push(conv.uuid);
        completed++;
      } catch (error) {
        console.error(`Failed to export ${conv.name || conv.uuid}:`, error);
        failures.push({ id: conv.uuid, name: conv.name || conv.uuid, message: error.message });
      }
    }

    report({ phase: 'fetch', completed, failed: failures.length, total });

    if (i + DMT_BULK_BATCH_SIZE < total && !isCancelled()) {
      await new Promise((resolve) => setTimeout(resolve, DMT_BULK_BATCH_PAUSE_MS));
    }
  }

  if (isCancelled()) return summary({ cancelled: true });
  if (included === 0) return summary();

  if (attachmentRecords.length > 0) {
    entries.push({ path: 'attachments.json', content: JSON.stringify(attachmentRecords, null, 2) });
  }
  const blob = await zipEntries(entries, (percent) => {
    report({ phase: 'zip', percent, completed, failed: failures.length, total });
  });
  if (isCancelled()) return summary({ cancelled: true });

  const filename = bulkZipFilename(options);
  downloadFile(blob, filename, 'application/zip');
  await recordExportTimestamps(exportedIds);
  return summary({ filename });
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_BULK_BATCH_SIZE,
    DMT_BULK_BATCH_PAUSE_MS,
    DMT_NOTHING_TO_EXPORT,
    fileDateStamp,
    normalizeExportOptions,
    isNothingToExport,
    filterConversationsByUpdated,
    buildFrontMatter,
    renderConversation,
    buildConversationExport,
    buildBulkEntries,
    planBulkConversation,
    bulkAttachmentPrefix,
    countAttachmentRecords,
    bulkZipFilename,
    zipEntries,
    DMT_PART_LIMIT_BYTES,
    createPartWriter,
    exportConversationToFile,
    exportConversationsToZip,
  };
}
