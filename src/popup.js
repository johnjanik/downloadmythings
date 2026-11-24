// Toolbar popup. Exports run in the claude.ai tab's content script, so they
// keep going if the popup closes.

// Capture unhandled errors for diagnostics (sanitized, stored locally)
if (typeof initErrorCapture === 'function') initErrorCapture('popup');

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function isClaudeTab(tab) {
  try {
    return new URL(tab.url).hostname === 'claude.ai';
  } catch (error) {
    return false;
  }
}

function conversationIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/chat\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

// Auto-detect the organization, falling back to the one saved in Options
async function getOrgId() {
  try {
    const orgId = await detectOrgId();
    await setStoredOrgId(orgId);
    return orgId;
  } catch (error) {
    console.log('Could not auto-detect the organization ID, using the saved one:', error);
    return getStoredOrgId();
  }
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

// A tab that was open before the extension was installed or updated has no
// live content script. If the first message gets no answer, inject and retry.
async function sendToContentScript(tabId, message) {
  try {
    return await sendMessageToTab(tabId, message);
  } catch (firstError) {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'ensureContentScript', tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    return sendMessageToTab(tabId, message);
  }
}

function readExportOptions() {
  return {
    format: document.getElementById('format').value,
    includeChats: document.getElementById('includeChats').checked,
    includeThinking: document.getElementById('includeThinking').checked,
    includeMetadata: document.getElementById('includeMetadata').checked,
    includeAttachments: document.getElementById('includeAttachments').checked,
    includeArtifacts: document.getElementById('includeArtifacts').checked,
    extractArtifacts: document.getElementById('extractArtifacts').checked,
    artifactFormat: document.getElementById('artifactFormat').value,
    flattenArtifacts: document.getElementById('flattenArtifacts').checked
  };
}

var ORG_ID_MISSING = 'Could not find your organization ID.';

// Show a status line. Built from text nodes only, never from HTML strings.
function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status');
  statusEl.className = `status ${type}`;
  statusEl.replaceChildren(document.createTextNode(message));

  // Point the user at Options when the organization ID is the likely cause
  const orgIdSuspect = message === ORG_ID_MISSING || /\b(403|404)\b/.test(message);
  if (type === 'error' && orgIdSuspect) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Options';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    statusEl.append(document.createElement('br'), 'Check the Organization ID in ', link, '.');
  }

  if (type === 'success') {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Title and version come from the manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('header-title').textContent = manifest.name;
  document.getElementById('header-version').textContent = `v${manifest.version}`;

  // Thinking, metadata and inline artifacts only apply when chats are included
  const includeChatsCheckbox = document.getElementById('includeChats');
  const dependents = ['includeThinking', 'includeMetadata', 'includeArtifacts']
    .map((id) => document.getElementById(id));

  function updateCheckboxStates() {
    const chatsEnabled = includeChatsCheckbox.checked;
    for (const checkbox of dependents) {
      checkbox.disabled = !chatsEnabled;
      if (!chatsEnabled) checkbox.checked = false;
    }
  }

  includeChatsCheckbox.addEventListener('change', updateCheckboxStates);
  updateCheckboxStates();
});

// Run one export button: disable it, show progress, report the outcome.
async function runExport(button, startMessage, action) {
  button.disabled = true;
  showStatus(startMessage, 'info');
  try {
    await action();
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// Export current conversation
document.getElementById('exportCurrent').addEventListener('click', (event) => {
  runExport(event.currentTarget, 'Fetching conversation...', async () => {
    const tab = await queryActiveTab();
    const conversationId = tab && isClaudeTab(tab) ? conversationIdFromUrl(tab.url) : null;
    if (!conversationId) {
      throw new Error('Open a conversation on claude.ai first.');
    }
    const orgId = await getOrgId();
    if (!orgId) throw new Error(ORG_ID_MISSING);

    // PDF: a print page renders the conversation and opens the print dialog
    if (readExportOptions().format === 'pdf') {
      await startPrintJob({ orgId, conversations: [{ uuid: conversationId, name: '' }], options: readExportOptions() });
      return;
    }

    const response = await sendToContentScript(tab.id, {
      action: 'exportConversation',
      conversationId,
      orgId,
      ...readExportOptions()
    });
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'Export failed');
    }
    showStatus('Conversation exported successfully!', 'success');
  });
});

// Export all conversations
document.getElementById('exportAll').addEventListener('click', (event) => {
  runExport(event.currentTarget, 'Fetching all conversations...', async () => {
    if (readExportOptions().format === 'pdf') {
      const printOrgId = await getOrgId();
      if (!printOrgId) throw new Error(ORG_ID_MISSING);
      await startPrintJob({ orgId: printOrgId, conversations: null, options: readExportOptions() });
      return;
    }

    const tab = await queryActiveTab();
    if (!tab || !isClaudeTab(tab)) {
      throw new Error('Open claude.ai in this tab first, or use Browse All Conversations.');
    }
    const orgId = await getOrgId();
    if (!orgId) throw new Error(ORG_ID_MISSING);

    const response = await sendToContentScript(tab.id, {
      action: 'exportAllConversations',
      orgId,
      ...readExportOptions()
    });
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'Export failed');
    }
    if (response.warnings) {
      showStatus(response.warnings, 'info');
    } else {
      showStatus(`Exported ${response.count} conversations!`, 'success');
    }
  });
});

// Browse conversations
document.getElementById('browseConversations').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
});
