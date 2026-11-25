// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('options');

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  chrome.storage.sync.get(['organizationId'], (result) => {
    if (result.organizationId) {
      document.getElementById('orgId').value = result.organizationId;
      showStatus('status', t('Organization ID loaded from saved settings'), 'success');
      setTimeout(() => hideStatus('status'), 2000);
    }
  });
});

// Save settings
document.getElementById('saveBtn').addEventListener('click', () => {
  const orgId = document.getElementById('orgId').value.trim();
  
  if (!orgId) {
    showStatus('status', t('Please enter an Organization ID'), 'error');
    return;
  }
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(orgId)) {
    showStatus('status', t('Invalid Organization ID format. It should be a UUID like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'), 'error');
    return;
  }
  
  chrome.storage.sync.set({ organizationId: orgId }, () => {
    showStatus('status', t('Settings saved successfully!'), 'success');
  });
});

// Test connection
document.getElementById('testBtn').addEventListener('click', async () => {
  const orgId = document.getElementById('orgId').value.trim();
  
  if (!orgId) {
    showStatus('testStatus', t('Please save an Organization ID first'), 'error');
    return;
  }
  
  showStatus('testStatus', t('Testing connection...'), 'success');
  
  try {
    const conversations = await apiGet(conversationsPath(orgId));
    showStatus('testStatus', tn('Success! Found {n} conversation.', 'Success! Found {n} conversations.', conversations.length), 'success');
  } catch (error) {
    if (error.status === 401) {
      showStatus('testStatus', t('Not signed in. Sign in to claude.ai in this browser and try again.'), 'error');
    } else if (error.status === 403) {
      showStatus('testStatus', t('Access denied. The Organization ID might be incorrect.'), 'error');
    } else {
      showStatus('testStatus', t('Connection failed: {0}', error.message), 'error');
    }
  }
});

// Backup all extension data to a file (shared logic lives in utils.js)
document.getElementById('backupBtn').addEventListener('click', () => {
  backupExtensionData((success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Restore extension data from a backup file. Flow: click → mode-choice modal
// → file picker → import. The mode is held in pendingImportMode across the
// async file-picker boundary.
let pendingImportMode = null;

document.getElementById('restoreBtn').addEventListener('click', () => {
  showImportModeModal((mode) => {
    if (mode === null) return; // user cancelled the modal
    pendingImportMode = mode;
    document.getElementById('restoreFile').click();
  });
});

document.getElementById('restoreFile').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  const mode = pendingImportMode;
  pendingImportMode = null; // consume; never reuse a stale mode
  if (!file || !mode) return;
  importBackup(file, mode, (success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Date & Time format preferences (displayed in the browse view)
function loadDateTimeFormatPrefs() {
  chrome.storage.local.get(['dateFormat', 'timeFormat'], (result) => {
    document.getElementById('dateFormatSelect').value = result.dateFormat || 'mdy';
    document.getElementById('timeFormatSelect').value = result.timeFormat || '12h';
  });
}
loadDateTimeFormatPrefs();

document.getElementById('dateFormatSelect').addEventListener('change', (e) => {
  chrome.storage.local.set({ dateFormat: e.target.value }, () => {
    showStatus('dateTimeStatus', t('Date format saved. Reload the browse page to see the change.'), 'success');
  });
});

document.getElementById('timeFormatSelect').addEventListener('change', (e) => {
  chrome.storage.local.set({ timeFormat: e.target.value }, () => {
    showStatus('dateTimeStatus', t('Time format saved. Reload the browse page to see the change.'), 'success');
  });
});

// Model display preference (browse view's Model column)
function loadModelDisplayPref() {
  chrome.storage.local.get(['modelDisplay'], (result) => {
    const value = result.modelDisplay === 'current' ? 'current' : 'original';
    const radio = document.querySelector(`input[name="modelDisplay"][value="${value}"]`);
    if (radio) radio.checked = true;
  });
}
loadModelDisplayPref();

document.querySelectorAll('input[name="modelDisplay"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    chrome.storage.local.set({ modelDisplay: e.target.value }, () => {
      showStatus('modelDisplayStatus', t('Model display preference saved. Reload the browse page to see the change.'), 'success');
    });
  });
});

// Download button on claude.ai pages (page-button.js reads this setting live)
chrome.storage.local.get(['showPageButton'], (result) => {
  document.getElementById('showPageButton').checked = result.showPageButton !== false;
});
document.getElementById('showPageButton').addEventListener('change', (e) => {
  chrome.storage.local.set({ showPageButton: e.target.checked }, () => {
    showStatus('pageButtonStatus', e.target.checked ? t('The button is on.') : t('The button is off.'), 'success');
  });
});

// Language: follow the browser, or one of the translations shipped with the extension
(function setUpLanguage() {
  const select = document.getElementById('languageSelect');
  const names = Object.entries(DMT_LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));
  select.replaceChildren(
    new Option(t('Follow the browser'), 'auto'),
    ...names.map(([code, name]) => new Option(name, code))
  );
  select.value = dmtI18nOverride ? dmtI18nOverride.lang : 'auto';
  select.addEventListener('change', async () => {
    try {
      await dmtSetLanguage(select.value);
      location.reload(); // this page is drawn again in the new language; others pick it up when opened
    } catch (error) {
      showStatus('languageStatus', t('Could not load that language: {0}', error.message), 'error');
    }
  });
})();

// Contact & Diagnostics
document.getElementById('generateDiagnosticsLink').addEventListener('click', (e) => {
  e.preventDefault();
  generateDiagnostics((success, message) => {
    showStatus('contactStatus', message, success ? 'success' : 'error');
  });
});

// Helper functions
function showStatus(elementId, message, type) {
  const statusEl = document.getElementById(elementId);
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function hideStatus(elementId) {
  const statusEl = document.getElementById(elementId);
  statusEl.className = 'status';
}
