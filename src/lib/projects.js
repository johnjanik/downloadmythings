// Project export: a project's instructions, its knowledge files and its chats
// as ordinary files, with a manifest that says how faithful each file is.
//
//   <Project name>/
//     instructions.md        the project's custom instructions
//     files/                 knowledge files
//     chats/                 one transcript per conversation
//     artifacts/<chat>/      artifacts as files (when an artifact option is on)
//     manifest.json          what was saved, from where, with SHA-256 hashes
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof renderConversation === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'), require('./exporter.js'));
}

// File types whose content is not plain text. For these, the text claude.ai
// extracted is a stand-in for the file, not the file.
var DMT_BINARY_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'ico',
  'zip', 'gz', 'tar', '7z', 'epub', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'
];

var DMT_MEDIA_TYPE_EXTENSIONS = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'application/pdf': 'pdf'
};

var DMT_FIDELITY_LEGEND = {
  'original': 'The stored file as claude.ai serves it, or the text of a text file.',
  'extracted-text': 'Only the text claude.ai extracted from the file. Formatting and images are lost.',
  'pdf-rendition': 'The PDF claude.ai serves for this document.',
  'preview': 'A preview image, usually smaller than the upload and often WebP.',
  'thumbnail': 'A small thumbnail. Nothing better was available.',
  'missing': 'claude.ai returned neither the file nor its text.'
};

function projectIdOf(conversation) {
  return conversation.project_uuid || conversation.project_id || conversation.projectUuid || null;
}

// "report.final.PDF" -> { base: "report.final", ext: "PDF" }; no dot -> ext ""
function splitExtension(name) {
  const match = /^(.*)\.([A-Za-z0-9]{1,10})$/.exec(name || '');
  return match && match[1] ? { base: match[1], ext: match[2] } : { base: name || '', ext: '' };
}

function isBinaryFilename(name) {
  return DMT_BINARY_EXTENSIONS.includes(splitExtension(name).ext.toLowerCase());
}

function normalizeProjectOptions(options) {
  const o = options || {};
  return {
    ...normalizeExportOptions(o),
    includeInstructions: o.includeInstructions !== false,
    includeKnowledge: o.includeKnowledge !== false,
    includeProjectChats: o.includeProjectChats !== false
  };
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

function contentByteLength(content) {
  return typeof content === 'string' ? new TextEncoder().encode(content).length : content.size;
}

async function sha256Hex(content) {
  const bytes = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : new Uint8Array(await content.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The filename to save a knowledge item under, given how its bytes were obtained.
function knowledgeFilename(name, fidelity, mediaType, usedNames) {
  const safe = sanitizeFilename(name);
  let { base, ext } = splitExtension(safe);

  if (fidelity === 'extracted-text') {
    // Keep the original name visible: "notes.docx" -> "notes.docx.txt"
    base = safe;
    ext = 'txt';
  } else if (fidelity === 'pdf-rendition' && ext.toLowerCase() !== 'pdf') {
    base = safe;
    ext = 'pdf';
  } else if (fidelity === 'preview' || fidelity === 'thumbnail') {
    // A preview is often a different image format than the upload
    const servedExt = DMT_MEDIA_TYPE_EXTENSIONS[String(mediaType || '').split(';')[0].trim().toLowerCase()];
    if (servedExt && servedExt !== ext.toLowerCase() && !(servedExt === 'jpg' && ext.toLowerCase() === 'jpeg')) {
      ext = servedExt;
    }
  }
  return uniqueFilename(base, ext, usedNames);
}

// Get one knowledge item's content. Resolves with { content, record }, where
// content is null when nothing could be fetched.
async function fetchKnowledgeItem(orgId, item, usedNames) {
  const record = { name: item.name, path: null, fidelity: 'missing', source: null, bytes: 0, sha256: null };
  let content = null;
  let mediaType = null;
  const attempts = [];

  if (item.file) {
    for (const candidate of fileDownloadCandidates(orgId, item.file)) {
      try {
        const blob = await getFileBlob(candidate.url);
        content = blob;
        mediaType = blob.type || null;
        record.fidelity = candidate.fidelity;
        record.source = candidate.source;
        break;
      } catch (error) {
        attempts.push(`${candidate.source}: ${error.message}`);
      }
    }
  }

  if (content === null && typeof item.text === 'string' && item.text.length > 0) {
    content = item.text;
    record.fidelity = isBinaryFilename(item.name) ? 'extracted-text' : 'original';
    record.source = 'docs';
  }

  if (content === null) {
    record.note = attempts.length > 0 ? `Tried ${attempts.join('; ')}` : 'No file and no text were returned';
    return { content: null, record };
  }

  record.path = `files/${knowledgeFilename(item.name, record.fidelity, mediaType, usedNames)}`;
  record.bytes = contentByteLength(content);
  record.sha256 = await sha256Hex(content);
  if (mediaType) record.mediaType = mediaType;
  return { content, record };
}

// Everything one project contributes to the ZIP. `root` is the folder prefix
// ('' or 'Project name/'). Resolves with { entries, manifest, exportedChatIds }.
async function collectProject(orgId, project, conversations, options, root, hooks) {
  const o = normalizeProjectOptions(options);
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const step = (label) => { if (h.onStep) h.onStep(label); };

  const entries = [];
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
    if (instructions.trim().length > 0) {
      entries.push({ path: `${root}instructions.md`, content: instructions });
      manifest.instructions = {
        path: 'instructions.md',
        bytes: contentByteLength(instructions),
        sha256: await sha256Hex(instructions)
      };
    }
  }

  // 2. Knowledge files
  if (o.includeKnowledge && !isCancelled()) {
    step('Listing knowledge files');
    let docs = [];
    let files = [];
    try { docs = await listProjectDocs(orgId, project.uuid); } catch (error) { fail('knowledge documents', 'docs', error); }
    try { files = await listProjectFiles(orgId, project.uuid); } catch (error) { fail('knowledge files', 'files', error); }

    const items = mergeProjectKnowledge(docs, files);
    const usedNames = new Set();
    for (let i = 0; i < items.length && !isCancelled(); i++) {
      step(`Knowledge file ${i + 1} of ${items.length}: ${items[i].name}`);
      const { content, record } = await fetchKnowledgeItem(orgId, items[i], usedNames);
      if (content !== null) entries.push({ path: `${root}${record.path}`, content });
      manifest.knowledge.push(record);
    }
  }

  // 3. The project's chats
  if (o.includeProjectChats && !isCancelled()) {
    const chats = conversations.filter((conv) => projectIdOf(conv) === project.uuid);
    const usedNames = new Set();
    const wantsArtifactFiles = o.extractArtifacts || o.flattenArtifacts;

    for (let i = 0; i < chats.length && !isCancelled(); i += DMT_BULK_BATCH_SIZE) {
      step(`Chats ${Math.min(i + DMT_BULK_BATCH_SIZE, chats.length)} of ${chats.length}`);
      await Promise.all(chats.slice(i, i + DMT_BULK_BATCH_SIZE).map(async (conv) => {
        try {
          const data = await getConversation(orgId, conv.uuid);
          data.model = inferModel(data);
          const name = uniqueFilename(sanitizeFilename(conv.name || conv.uuid), '', usedNames);
          const rendered = renderConversation(data, conv.uuid, o);
          const path = `chats/${name}.${rendered.ext}`;
          entries.push({ path: `${root}${path}`, content: rendered.content });

          const artifactFiles = wantsArtifactFiles ? extractArtifactFiles(data, o.artifactFormat) : [];
          for (const artifact of artifactFiles) {
            entries.push({ path: `${root}artifacts/${name}/${artifact.filename}`, content: artifact.content });
          }
          manifest.chats.push({
            uuid: conv.uuid,
            name: conv.name || '',
            path,
            updatedAt: conv.updated_at || null,
            artifacts: artifactFiles.length
          });
          exportedChatIds.push(conv.uuid);
        } catch (error) {
          fail('chat', conv.name || conv.uuid, error);
        }
      }));
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
  const summary = { projects: manifests.length, knowledge: 0, byFidelity: {}, chats: 0, failures: 0, hasInstructions: 0 };
  for (const manifest of manifests) {
    summary.chats += manifest.chats.length;
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
  if (summary.failures > 0) parts.push(`${summary.failures} problem${summary.failures === 1 ? '' : 's'}, see manifest.json`);
  const subject = `${summary.projects} project${summary.projects === 1 ? '' : 's'}`;
  return parts.length > 0 ? `${subject}: ${parts.join(', ')}` : `${subject}: nothing to save`;
}

function projectZipFilename(projects, now) {
  if (projects.length === 1) return `${sanitizeFilename(projects[0].name || 'Untitled Project')}.zip`;
  return `downloadmythings-projects-${fileDateStamp(now)}.zip`;
}

// Export one or more projects as a single ZIP. One project is saved without a
// top-level folder; several get a folder each.
// hooks: { onProgress({ label, percent }), isCancelled() }
// Resolves with { cancelled, filename, summary, manifests }.
async function exportProjectsToZip(orgId, projects, conversations, options, hooks) {
  const h = hooks || {};
  const isCancelled = () => Boolean(h.isCancelled && h.isCancelled());
  const report = (label, percent) => { if (h.onProgress) h.onProgress({ label, percent }); };

  const entries = [];
  const manifests = [];
  const exportedChatIds = [];
  const usedRoots = new Set();

  for (let i = 0; i < projects.length; i++) {
    if (isCancelled()) return { cancelled: true, filename: null, summary: null, manifests };
    const project = projects[i];
    const name = project.name || 'Untitled Project';
    const root = projects.length === 1 ? '' : `${uniqueFilename(sanitizeFilename(name), '', usedRoots)}/`;
    const result = await collectProject(orgId, project, conversations, options, root, {
      isCancelled,
      onStep: (label) => report(`${name}: ${label}`, (i / projects.length) * 100)
    });
    entries.push(...result.entries);
    manifests.push(result.manifest);
    exportedChatIds.push(...result.exportedChatIds);
  }
  if (isCancelled()) return { cancelled: true, filename: null, summary: null, manifests };

  const blob = await zipEntries(entries, (percent) => report('Creating ZIP file...', percent));
  if (isCancelled()) return { cancelled: true, filename: null, summary: null, manifests };

  const filename = projectZipFilename(projects);
  downloadFile(blob, filename, 'application/zip');
  if (exportedChatIds.length > 0) await recordExportTimestamps(exportedChatIds);
  return { cancelled: false, filename, summary: summarizeProjectManifests(manifests), manifests };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    projectIdOf,
    splitExtension,
    isBinaryFilename,
    normalizeProjectOptions,
    mergeProjectKnowledge,
    contentByteLength,
    sha256Hex,
    knowledgeFilename,
    fetchKnowledgeItem,
    collectProject,
    summarizeProjectManifests,
    describeProjectExport,
    projectZipFilename,
    exportProjectsToZip,
  };
}
