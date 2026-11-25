// claude.ai API client shared by every page and by the content script.
//
// Extension pages (popup, browse, options) call claude.ai directly using the
// signed-in session. If a direct call fails, they fall back to relaying the
// request through the content script in an open claude.ai tab. The content
// script itself runs on claude.ai, so it only ever calls directly.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

var DMT_CLAUDE_ORIGIN = 'https://claude.ai';

if (typeof module !== 'undefined' && module.exports && typeof recordModelSnapshots === 'undefined') {
  Object.assign(globalThis, require('./store.js'));
}

// claude.ai answers 429 (or a brief 5xx) when asked too fast. Wait and try
// again a few times before giving up; a long export makes hundreds of calls.
var dmtRetry = { attempts: 3, baseMs: 1500, maxMs: 30000 };

// A long export hands its AbortSignal here, so Cancel stops the requests that
// are already in flight instead of waiting for them to finish.
var dmtRequestSignal = null;

function setRequestSignal(signal) {
  dmtRequestSignal = signal || null;
}

function cancelledError() {
  const error = new Error('Cancelled');
  error.status = -2; // never worth relaying or retrying
  error.cancelled = true;
  return error;
}

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    if (dmtRequestSignal && dmtRequestSignal.aborted) throw cancelledError();
    const response = await fetch(url, dmtRequestSignal ? { ...init, signal: dmtRequestSignal } : init);
    const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
    if (!retryable || attempt >= dmtRetry.attempts) return response;

    const header = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('retry-after')) : NaN;
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : dmtRetry.baseMs * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, dmtRetry.maxMs)));
  }
}

async function apiGet(path) {
  let response;
  try {
    response = await fetchWithRetry(`${DMT_CLAUDE_ORIGIN}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
  } catch (cause) {
    if (cause.cancelled || cause.name === 'AbortError') throw cancelledError();
    const error = new Error(`Could not reach claude.ai (${cause.message})`);
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`claude.ai returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// Fetch a file's bytes. Accepts a path or a URL taken from an API response, but
// only ever talks to claude.ai: anything pointing elsewhere is refused, so the
// session is never sent to another host.
async function apiGetBlob(pathOrUrl) {
  let url;
  try {
    url = new URL(pathOrUrl, DMT_CLAUDE_ORIGIN);
  } catch (cause) {
    url = null;
  }
  if (!url || url.origin !== DMT_CLAUDE_ORIGIN) {
    const error = new Error('Not a claude.ai address');
    error.status = -1;
    throw error;
  }

  let response;
  try {
    response = await fetchWithRetry(url.href, { credentials: 'include' });
  } catch (cause) {
    if (cause.cancelled || cause.name === 'AbortError') throw cancelledError();
    const error = new Error(`Could not reach claude.ai (${cause.message})`);
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`claude.ai returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  // An HTML page here is the web app or a sign-in page, not the file
  if (blob.size === 0 || /^text\/html/i.test(blob.type)) {
    const error = new Error(blob.size === 0 ? 'claude.ai returned an empty file' : 'claude.ai returned a web page instead of the file');
    error.status = -1;
    throw error;
  }
  return blob;
}

// A call that changes something (DELETE, PUT, POST). Resolves with the parsed
// answer, or null when claude.ai sends none.
async function apiSend(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchWithRetry(`${DMT_CLAUDE_ORIGIN}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (cause) {
    if (cause.cancelled || cause.name === 'AbortError') throw cancelledError();
    const error = new Error(`Could not reach claude.ai (${cause.message})`);
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`claude.ai returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (cause) {
    return null;
  }
}

// Blobs cannot cross the messaging channel, so the relay carries them as data URLs.
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

function conversationsPath(orgId) {
  return `/api/organizations/${orgId}/chat_conversations`;
}

function conversationPath(orgId, conversationId) {
  return `${conversationsPath(orgId)}/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
}

function projectsPath(orgId) {
  return `/api/organizations/${orgId}/projects`;
}

function projectPath(orgId, projectId) {
  return `${projectsPath(orgId)}/${projectId}`;
}

// Where a file's bytes may be found, best first. Each candidate says how
// faithful its bytes are to what was uploaded:
//   original       the stored file, from the contents endpoint
//   pdf-rendition  the PDF claude.ai serves for a document
//   preview        a preview image (often a smaller WebP)
//   thumbnail      a small thumbnail, the last resort
// `file` is an entry from a project's file list or from a message's files.
// The endpoint names come from claude.ai's own web app; they are undocumented.
function fileDownloadCandidates(orgId, file) {
  const uuid = file.file_uuid || file.uuid || null;
  const candidates = [];
  const add = (url, fidelity, source) => {
    if (url && !candidates.some((c) => c.url === url)) candidates.push({ url, fidelity, source });
  };

  if (uuid) add(`/api/organizations/${orgId}/files/${uuid}/contents`, 'original', 'contents');
  add(file.document_asset && file.document_asset.url, 'pdf-rendition', 'document_asset');
  if (uuid && /\.pdf$/i.test(file.file_name || '')) add(`/api/${orgId}/files/${uuid}/document_pdf`, 'pdf-rendition', 'document_pdf');
  add(file.preview_asset && file.preview_asset.url, 'preview', 'preview_asset');
  add(file.preview_url, 'preview', 'preview_url');
  if (uuid) add(`/api/${orgId}/files/${uuid}/preview`, 'preview', 'preview');
  add(file.thumbnail_asset && file.thumbnail_asset.url, 'thumbnail', 'thumbnail_asset');
  add(file.thumbnail_url, 'thumbnail', 'thumbnail_url');
  if (uuid) add(`/api/${orgId}/files/${uuid}/thumbnail`, 'thumbnail', 'thumbnail');
  return candidates;
}

// An account can belong to several organizations (for example a claude.ai org
// and an API org). Prefer the one with the "chat" capability.
function pickChatOrgId(orgs) {
  if (!Array.isArray(orgs) || orgs.length === 0) return null;
  const chatOrg = orgs.find((org) => Array.isArray(org.capabilities) && org.capabilities.includes('chat'));
  return (chatOrg || orgs[0]).uuid || null;
}

// --- Relay through an open claude.ai tab -----------------------------------

function canRelayThroughTab() {
  return typeof chrome !== 'undefined' && Boolean(chrome.tabs) && typeof chrome.tabs.query === 'function';
}

function relayToClaudeTab(action, data) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: `${DMT_CLAUDE_ORIGIN}/*` }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tabs || tabs.length === 0) {
        reject(new Error('no claude.ai tab is open'));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.success) {
          resolve(response);
        } else {
          reject(new Error((response && response.error) || 'request failed'));
        }
      });
    });
  });
}

// A direct call that fails this way may still work from inside a claude.ai
// tab: no network path (0), or the session was not accepted (401, 403).
function isRelayWorthTrying(error) {
  return error.status === 0 || error.status === 401 || error.status === 403;
}

// Set once a relay has succeeded where the direct call failed, so the rest of
// a long export does not pay for a failed direct call every time.
var dmtPreferRelay = false;

// Try the direct call; if it is refused, retry once through a claude.ai tab.
async function directOrRelay(direct, action, data, pick) {
  if (dmtPreferRelay && canRelayThroughTab()) {
    try {
      return pick(await relayToClaudeTab(action, data));
    } catch (relayError) {
      dmtPreferRelay = false; // the tab is gone; go back to trying directly
    }
  }

  try {
    return await direct();
  } catch (directError) {
    if (!canRelayThroughTab() || !isRelayWorthTrying(directError)) throw directError;
    try {
      const result = pick(await relayToClaudeTab(action, data));
      dmtPreferRelay = true;
      return result;
    } catch (relayError) {
      const error = new Error(
        `${directError.message}. Sign in to claude.ai in this browser, then try again.`
      );
      error.status = directError.status;
      throw error;
    }
  }
}

// --- Public calls ----------------------------------------------------------

async function detectOrgId() {
  return directOrRelay(
    async () => {
      const orgId = pickChatOrgId(await apiGet('/api/organizations'));
      if (!orgId) throw new Error('No organizations found for this account');
      return orgId;
    },
    'detectOrgId',
    {},
    (response) => response.orgId
  );
}

// Lists every conversation and snapshots their current models as a side effect.
async function listConversations(orgId) {
  const conversations = await directOrRelay(
    () => apiGet(conversationsPath(orgId)),
    'loadConversations',
    { orgId },
    (response) => response.conversations
  );
  try {
    await recordModelSnapshots(conversations);
  } catch (error) {
    console.warn('Could not record model snapshots:', error);
  }
  return conversations;
}

async function listProjects(orgId) {
  return directOrRelay(
    () => apiGet(projectsPath(orgId)),
    'loadProjects',
    { orgId },
    (response) => response.projects
  );
}

// One project with its instructions (`prompt_template`).
async function getProject(orgId, projectId) {
  return directOrRelay(
    () => apiGet(projectPath(orgId, projectId)),
    'getProject',
    { orgId, projectId },
    (response) => response.project
  );
}

// A project's knowledge documents, as text: [{ file_name, content, ... }]
async function listProjectDocs(orgId, projectId) {
  return directOrRelay(
    () => apiGet(`${projectPath(orgId, projectId)}/docs`),
    'listProjectDocs',
    { orgId, projectId },
    (response) => response.docs
  );
}

// A project's uploaded files (PDFs, images, ...): [{ file_uuid, file_name, ... }]
async function listProjectFiles(orgId, projectId) {
  return directOrRelay(
    () => apiGet(`${projectPath(orgId, projectId)}/files`),
    'listProjectFiles',
    { orgId, projectId },
    (response) => response.files
  );
}

// A file's bytes as a Blob, from a path or claude.ai URL.
async function getFileBlob(pathOrUrl) {
  return directOrRelay(
    () => apiGetBlob(pathOrUrl),
    'getFileBlob',
    { path: pathOrUrl },
    (response) => dataUrlToBlob(response.dataUrl)
  );
}

// Account memory. This endpoint is unconfirmed: callers must treat a failure
// as "not available", not as an error.
async function getAccountMemory(orgId) {
  return apiGet(`/api/organizations/${orgId}/memories`);
}

async function getConversation(orgId, conversationId) {
  return directOrRelay(
    () => apiGet(conversationPath(orgId, conversationId)),
    'getConversation',
    { orgId, conversationId },
    (response) => response.conversation
  );
}

// The account's usage against its limits: { five_hour: { utilization, resets_at }, seven_day: {...}, ... }
async function getUsage(orgId) {
  return directOrRelay(
    () => apiGet(`/api/organizations/${orgId}/usage`),
    'getUsage',
    { orgId },
    (response) => response.usage
  );
}

// --- Calls that change the account ------------------------------------------
// Everything above only reads. These two write, and only when the user has
// confirmed the action in the panel (see lib/manage.js).

// Deletes one conversation for good. A conversation that is already gone counts as done.
async function deleteConversation(orgId, conversationId) {
  return directOrRelay(
    async () => {
      try {
        await apiSend('DELETE', `${conversationsPath(orgId)}/${conversationId}`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      return true;
    },
    'deleteConversation',
    { orgId, conversationId },
    () => true
  );
}

// Moves conversations into a project. claude.ai's move call is undocumented
// and has two known shapes, so this tries the batch call first and, if
// claude.ai does not know it, sets the project on each conversation instead.
// Resolves with the shape that was accepted: 'batch' or 'single'. The caller
// must check the result against a fresh list; an accepted call is not proof.
async function moveConversationsToProject(orgId, conversationIds, projectId) {
  return directOrRelay(
    async () => {
      try {
        await apiSend('POST', `${conversationsPath(orgId)}/move_many`, { conversation_uuids: conversationIds, project_uuid: projectId });
        return 'batch';
      } catch (error) {
        if (error.status !== 404 && error.status !== 405) throw error;
      }
      for (const conversationId of conversationIds) {
        await apiSend('PUT', `${conversationsPath(orgId)}/${conversationId}`, { project_uuid: projectId });
      }
      return 'single';
    },
    'moveConversations',
    { orgId, conversationIds, projectId },
    (response) => response.method
  );
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dmtRetry,
    apiSend,
    getUsage,
    deleteConversation,
    moveConversationsToProject,
    setRequestSignal,
    fetchWithRetry,
    apiGet,
    apiGetBlob,
    blobToDataUrl,
    dataUrlToBlob,
    conversationsPath,
    conversationPath,
    projectsPath,
    projectPath,
    fileDownloadCandidates,
    pickChatOrgId,
    canRelayThroughTab,
    relayToClaudeTab,
    isRelayWorthTrying,
    directOrRelay,
    detectOrgId,
    listConversations,
    listProjects,
    getProject,
    listProjectDocs,
    listProjectFiles,
    getFileBlob,
    getAccountMemory,
    getConversation,
  };
}
