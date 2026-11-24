// Downloading files (project knowledge, chat uploads) and saying honestly how
// faithful each saved copy is to what was uploaded.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof getFileBlob === 'undefined') {
  Object.assign(globalThis, require('./utils.js'), require('./store.js'), require('./api.js'));
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

// "report.final.PDF" -> { base: "report.final", ext: "PDF" }; no dot -> ext ""
function splitExtension(name) {
  const match = /^(.*)\.([A-Za-z0-9]{1,10})$/.exec(name || '');
  return match && match[1] ? { base: match[1], ext: match[2] } : { base: name || '', ext: '' };
}

function isBinaryFilename(name) {
  return DMT_BINARY_EXTENSIONS.includes(splitExtension(name).ext.toLowerCase());
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

// The filename to save a file under, given how its bytes were obtained.
function fidelityFilename(name, fidelity, mediaType, usedNames) {
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

// Get one file's content. `item` is { name, file, text }: `file` is an API file
// entry (bytes are downloaded), `text` is extracted or pasted text (the
// fallback, or the whole content when there is no file). `folder` is where the
// file goes, such as 'files/'. Resolves with { content, record }; content is
// null when nothing could be fetched.
async function fetchFileItem(orgId, item, usedNames, folder) {
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
    record.source = item.textSource || 'docs';
  }

  if (content === null) {
    record.note = attempts.length > 0 ? `Tried ${attempts.join('; ')}` : 'No file and no text were returned';
    return { content: null, record };
  }

  record.path = `${folder}${fidelityFilename(item.name, record.fidelity, mediaType, usedNames)}`;
  record.bytes = contentByteLength(content);
  record.sha256 = await sha256Hex(content);
  if (mediaType) record.mediaType = mediaType;
  return { content, record };
}

// What a conversation's messages carry, on every branch:
//   files        uploads with an ID (images, PDFs, ...), fetched as bytes
//   attachments  pasted or uploaded text, already extracted by claude.ai
// Returns [{ name, file, text, textSource }], one per distinct upload.
function listConversationAttachments(data) {
  const items = [];
  const seenFiles = new Set();
  let pasted = 0;

  for (const message of (data && Array.isArray(data.chat_messages)) ? data.chat_messages : []) {
    const files = [].concat(message.files_v2 || [], message.files || []);
    for (const file of files) {
      const uuid = file && (file.file_uuid || file.uuid);
      if (!uuid || seenFiles.has(uuid)) continue;
      seenFiles.add(uuid);
      items.push({ name: file.file_name || `file-${uuid}`, file, text: null });
    }
    for (const attachment of message.attachments || []) {
      if (!attachment || typeof attachment.extracted_content !== 'string' || attachment.extracted_content.length === 0) continue;
      pasted++;
      items.push({
        name: attachment.file_name || `pasted-${pasted}.txt`,
        file: null,
        text: attachment.extracted_content,
        textSource: 'attachment'
      });
    }
  }
  return items;
}

// Download a conversation's attachments into `folder`.
// Resolves with { entries: [{ path, content }], records }.
async function collectAttachmentEntries(orgId, data, folder) {
  const entries = [];
  const records = [];
  const usedNames = new Set();
  for (const item of listConversationAttachments(data)) {
    const { content, record } = await fetchFileItem(orgId, item, usedNames, folder);
    if (content !== null) entries.push({ path: record.path, content });
    records.push(record);
  }
  return { entries, records };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_BINARY_EXTENSIONS,
    DMT_MEDIA_TYPE_EXTENSIONS,
    DMT_FIDELITY_LEGEND,
    splitExtension,
    isBinaryFilename,
    contentByteLength,
    sha256Hex,
    fidelityFilename,
    fetchFileItem,
    listConversationAttachments,
    collectAttachmentEntries,
  };
}
