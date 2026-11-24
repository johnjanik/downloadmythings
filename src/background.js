// Background script: a service worker on Chrome (Manifest V3) and a background
// page on Firefox (Manifest V2). It puts the content scripts into claude.ai
// tabs that do not have a live copy, and opens the print page when a content
// script asks for it.

// Same files, same order, as the manifest declares for claude.ai.
function contentScriptFiles() {
  return chrome.runtime.getManifest().content_scripts[0].js;
}

function injectContentScripts(tabId) {
  const files = contentScriptFiles();

  // Chrome MV3
  if (chrome.scripting && chrome.scripting.executeScript) {
    return chrome.scripting.executeScript({ target: { tabId }, files });
  }

  // Firefox MV2: one file per call, strictly in order
  return files.reduce((chain, file) => chain.then(() => new Promise((resolve, reject) => {
    chrome.tabs.executeScript(tabId, { file }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  })), Promise.resolve());
}

// Tabs that were open before an install or update have no working content
// script until they reload, so inject one now.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
    (tabs || []).forEach((tab) => {
      injectContentScripts(tab.id).catch((error) => {
        console.log('Could not inject into tab', tab.id, error);
      });
    });
  });
});

// The popup asks for this when a claude.ai tab does not answer its message.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // The in-page button asks for the print page; content scripts cannot open tabs
  if (request.action === 'openPrintPage') {
    chrome.tabs.create({ url: chrome.runtime.getURL('print.html') }, () => sendResponse({ success: true }));
    return true;
  }

  if (request.action !== 'ensureContentScript' || typeof request.tabId !== 'number') return false;

  injectContentScripts(request.tabId).then(
    () => sendResponse({ success: true }),
    (error) => sendResponse({ success: false, error: error.message })
  );
  return true; // keep the message channel open for the async answer
});
