// Background script: a service worker on Chrome (Manifest V3) and a background
// page on Firefox (Manifest V2). It puts the content scripts into claude.ai
// tabs that do not have a live copy, opens the print page when a content
// script asks for it, starts scheduled backups, and makes the toolbar button
// open the panel as a side panel or a popup.

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

// ---- Automatic backups --------------------------------------------------
// A backup needs a page (to build a ZIP and hand it to the browser), so the
// alarm opens the panel in a background tab, which runs the backup and closes
// itself. Backups therefore run only while the browser is open.

var BACKUP_ALARM = 'dmt-backup';
var BACKUP_PERIOD_MINUTES = { daily: 24 * 60, weekly: 7 * 24 * 60 };

function scheduleBackupAlarm() {
  if (!chrome.alarms) return;
  chrome.storage.local.get(['backup'], (result) => {
    const backup = (result || {}).backup || {};
    const period = BACKUP_PERIOD_MINUTES[backup.schedule];
    if (!period) {
      chrome.alarms.clear(BACKUP_ALARM);
      return;
    }
    // Due one period after the last run; a run missed while the browser was
    // closed happens a minute after it starts again.
    const last = backup.lastRunAt ? new Date(backup.lastRunAt).getTime() : 0;
    const due = Math.max(Date.now() + 60 * 1000, last + period * 60 * 1000);
    chrome.alarms.create(BACKUP_ALARM, { when: due, periodInMinutes: period });
  });
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== BACKUP_ALARM) return;
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html#backup-run'), active: false });
  });
  chrome.runtime.onInstalled.addListener(scheduleBackupAlarm);
  chrome.runtime.onStartup.addListener(scheduleBackupAlarm);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.backup) return;
    const before = (changes.backup.oldValue || {}).schedule;
    const after = (changes.backup.newValue || {}).schedule;
    if (before !== after) scheduleBackupAlarm(); // not on every "last run" update
  });
}

// ---- Side panel or popup -----------------------------------------------
// The toolbar button opens the panel page either as the browser's side panel
// or as a popup. The choice is stored as `displayMode`; side panel is the
// default where the browser has one.

function toolbarButton() {
  return chrome.action || chrome.browserAction;
}

function firefoxSidebar() {
  return typeof browser !== 'undefined' && browser.sidebarAction ? browser.sidebarAction : null;
}

function applyDisplayMode() {
  chrome.storage.local.get(['displayMode'], (result) => {
    const canSidePanel = Boolean(chrome.sidePanel && chrome.sidePanel.setPanelBehavior) || Boolean(firefoxSidebar());
    const useSidePanel = canSidePanel && (result || {}).displayMode !== 'popup';

    // With no popup set, a click on the toolbar button goes to the side panel
    toolbarButton().setPopup({ popup: useSidePanel ? '' : 'panel.html' });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useSidePanel }).catch((error) => {
        console.log('Could not set the side panel behaviour:', error);
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(applyDisplayMode);
chrome.runtime.onStartup.addListener(applyDisplayMode);
applyDisplayMode(); // and whenever the background script itself starts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) applyDisplayMode();
});

// Firefox has no "open the sidebar on click" setting: do it by hand. This
// only fires while no popup is set, which is side panel mode.
if (firefoxSidebar() && toolbarButton().onClicked) {
  toolbarButton().onClicked.addListener(() => {
    firefoxSidebar().toggle();
  });
}

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
