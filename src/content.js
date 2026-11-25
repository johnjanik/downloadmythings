// Content script for claude.ai.
//
// It relays API calls for extension pages whose direct call to claude.ai was
// refused (see lib/api.js). Exports themselves run in the extension's own
// pages (the panel, the browse page) or from the in-page button
// (page-button.js); this file only routes messages.

(function () {
  // Skip if a live copy is already listening in this tab. After the extension
  // updates or reloads, the old copy is orphaned (its runtime is gone), so a
  // fresh one must take over.
  var previous = globalThis.__dmtContentScript;
  if (previous && previous.isAlive()) return;
  globalThis.__dmtContentScript = {
    isAlive: function () {
      try {
        return Boolean(chrome.runtime && chrome.runtime.id);
      } catch (error) {
        return false;
      }
    }
  };

  // Capture unhandled errors for diagnostics (sanitized, stored locally)
  if (typeof initErrorCapture === 'function') initErrorCapture('content');

  // Answer a message with { success: true, ...result } or { success: false, error }.
  function reply(sendResponse, promise) {
    promise
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => {
        console.debug('DownloadMyThings request failed:', error); // the caller reports it
        sendResponse({ success: false, error: error.message, details: error.stack });
      });
    return true; // keep the message channel open for the async answer
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'ping':
        sendResponse({ success: true });
        return false;

      // Relay calls for extension pages
      case 'detectOrgId':
        return reply(sendResponse, detectOrgId().then((orgId) => ({ orgId })));
      case 'loadConversations':
        return reply(sendResponse, listConversations(request.orgId).then((conversations) => ({ conversations })));
      case 'loadProjects':
        return reply(sendResponse, listProjects(request.orgId).then((projects) => ({ projects })));
      case 'getProject':
        return reply(sendResponse, getProject(request.orgId, request.projectId).then((project) => ({ project })));
      case 'listProjectDocs':
        return reply(sendResponse, listProjectDocs(request.orgId, request.projectId).then((docs) => ({ docs })));
      case 'listProjectFiles':
        return reply(sendResponse, listProjectFiles(request.orgId, request.projectId).then((files) => ({ files })));
      case 'getFileBlob':
        return reply(sendResponse, apiGetBlob(request.path).then(blobToDataUrl).then((dataUrl) => ({ dataUrl })));
      case 'getConversation':
        return reply(sendResponse, getConversation(request.orgId, request.conversationId).then((conversation) => ({ conversation })));
      case 'getUsage':
        return reply(sendResponse, getUsage(request.orgId).then((usage) => ({ usage })));

      // The two calls that change the account; the panel asks the user first
      case 'deleteConversation':
        return reply(sendResponse, deleteConversation(request.orgId, request.conversationId).then(() => ({})));
      case 'moveConversations':
        return reply(sendResponse, moveConversationsToProject(request.orgId, request.conversationIds, request.projectId).then((method) => ({ method })));

      default:
        return false;
    }
  });
})();
