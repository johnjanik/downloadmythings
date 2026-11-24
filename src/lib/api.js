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

async function apiGet(path) {
  let response;
  try {
    response = await fetch(`${DMT_CLAUDE_ORIGIN}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
  } catch (cause) {
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

function conversationsPath(orgId) {
  return `/api/organizations/${orgId}/chat_conversations`;
}

function conversationPath(orgId, conversationId) {
  return `${conversationsPath(orgId)}/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
}

function projectsPath(orgId) {
  return `/api/organizations/${orgId}/projects`;
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

async function getConversation(orgId, conversationId) {
  return directOrRelay(
    () => apiGet(conversationPath(orgId, conversationId)),
    'getConversation',
    { orgId, conversationId },
    (response) => response.conversation
  );
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    apiGet,
    conversationsPath,
    conversationPath,
    projectsPath,
    pickChatOrgId,
    canRelayThroughTab,
    relayToClaudeTab,
    isRelayWorthTrying,
    directOrRelay,
    detectOrgId,
    listConversations,
    listProjects,
    getConversation,
  };
}
