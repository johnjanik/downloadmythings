// Content script for claude.ai.
//
// It does two jobs:
//   1. runs the exports the popup asks for, in the page, so a long export
//      keeps going after the popup closes;
//   2. relays API calls for extension pages whose direct call to claude.ai
//      failed (see lib/api.js).
//
// The export and API logic lives in lib/; this file only routes messages.

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

  function summarizeBulkExport(result) {
    const response = { count: result.included };
    if (result.failed > 0) {
      const names = result.failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ');
      response.warnings = `Exported ${result.completed} of ${result.total} conversations. Some failed: ${names}`;
    } else if (result.included === 0) {
      response.warnings = 'No artifacts found in any conversation, so nothing was downloaded.';
    }
    return response;
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

      // Exports started from the popup; `request` carries the export options
      case 'exportConversation':
        return reply(sendResponse, exportConversationToFile(request.orgId, request.conversationId, request));
      case 'exportAllConversations':
        if (isNothingToExport(request)) {
          sendResponse({ success: false, error: DMT_NOTHING_TO_EXPORT });
          return false;
        }
        return reply(
          sendResponse,
          listConversations(request.orgId)
            .then((conversations) => exportConversationsToZip(request.orgId, conversations, request))
            .then(summarizeBulkExport)
        );

      default:
        return false;
    }
  });
})();
