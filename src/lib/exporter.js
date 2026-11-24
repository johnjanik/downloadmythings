// Export logic shared by the content script (popup exports) and the browse page.
//
// The build* functions are pure: they turn conversation data plus options into
// a list of files, and are covered by unit tests. The export* functions fetch,
// zip, download and record what was exported.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof convertToMarkdown === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'));
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
    artifactFormat: o.artifactFormat || 'original'
  };
}

// True when the options cannot produce any file at all.
function isNothingToExport(options) {
  const o = normalizeExportOptions(options);
  return !o.includeChats && !o.extractArtifacts && !o.flattenArtifacts;
}

var DMT_NOTHING_TO_EXPORT = 'Nothing to export. Enable "Chats" or one of the artifact file options.';

// The conversation transcript in the chosen format.
function renderConversation(data, conversationId, options) {
  const o = normalizeExportOptions(options);
  switch (o.format) {
    case 'markdown':
      return {
        content: convertToMarkdown(data, o.includeMetadata, conversationId, o.includeArtifacts, o.includeThinking),
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
  const o = normalizeExportOptions(options);
  if (isNothingToExport(o)) return [];

  const wantsArtifactFiles = o.extractArtifacts || o.flattenArtifacts;
  const artifactFiles = wantsArtifactFiles ? extractArtifactFiles(data, o.artifactFormat) : [];
  if (!o.includeChats && artifactFiles.length === 0) return [];

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
  return entries;
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

// Fetch one conversation and download it. Resolves with { filename, artifactCount }.
async function exportConversationToFile(orgId, conversationId, options, displayName) {
  if (isNothingToExport(options)) throw new Error(DMT_NOTHING_TO_EXPORT);

  const data = await getConversation(orgId, conversationId);
  if (!data || !Array.isArray(data.chat_messages)) {
    throw new Error('Unexpected conversation data from claude.ai. Refresh the page and try again.');
  }
  data.model = inferModel(data);

  const result = buildConversationExport(data, conversationId, options, displayName);
  if (result.kind === 'empty') throw new Error(result.error);

  if (result.kind === 'zip') {
    downloadFile(await zipEntries(result.entries), result.filename, 'application/zip');
  } else {
    downloadFile(result.content, result.filename, result.type);
  }
  await recordExportTimestamps([conversationId]);
  return { filename: result.filename, artifactCount: result.artifactCount };
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
  let completed = 0;
  let included = 0;

  const summary = (extra) => ({
    total, completed, failed: failures.length, included, failures, cancelled: false, filename: null, ...extra
  });

  for (let i = 0; i < total; i += DMT_BULK_BATCH_SIZE) {
    if (isCancelled()) return summary({ cancelled: true });

    const batch = conversations.slice(i, i + DMT_BULK_BATCH_SIZE);
    await Promise.all(batch.map(async (conv) => {
      try {
        const data = await getConversation(orgId, conv.uuid);
        data.model = inferModel(data);
        const convEntries = buildBulkEntries(data, conv, options, usedNames);
        entries.push(...convEntries);
        if (convEntries.length > 0) included++;
        exportedIds.push(conv.uuid);
        completed++;
      } catch (error) {
        console.error(`Failed to export ${conv.name || conv.uuid}:`, error);
        failures.push({ id: conv.uuid, name: conv.name || conv.uuid, message: error.message });
      }
    }));

    report({ phase: 'fetch', completed, failed: failures.length, total });

    if (i + DMT_BULK_BATCH_SIZE < total && !isCancelled()) {
      await new Promise((resolve) => setTimeout(resolve, DMT_BULK_BATCH_PAUSE_MS));
    }
  }

  if (isCancelled()) return summary({ cancelled: true });
  if (included === 0) return summary();

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
    fileDateStamp,
    normalizeExportOptions,
    isNothingToExport,
    renderConversation,
    buildConversationExport,
    buildBulkEntries,
    bulkZipFilename,
    zipEntries,
    exportConversationToFile,
    exportConversationsToZip,
  };
}
