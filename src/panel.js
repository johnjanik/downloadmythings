// The panel: DownloadMyThings' main interface. The same page is the toolbar
// popup, the browser's side panel, and a full tab.
//
// It works from any tab. If the active tab shows a conversation or a project
// on claude.ai, the panel offers that; if not, the user picks a project here
// or a chat in the Library. Exports run in this page, not in a claude.ai tab.

if (typeof initErrorCapture === 'function') initErrorCapture('panel');

const state = {
  viewMode: 'tab',     // 'popup', 'sidepanel' or 'tab'
  orgId: null,
  projects: [],
  conversations: [],
  context: null,       // what the active tab shows: { kind: 'project' | 'conversation', id }
  chat: null,          // the open conversation, when there is one
  project: null,       // the project the card is showing
  knowledge: null,     // that project's files, once listed
  job: null            // { cancelled } while an export runs
};

const $ = (id) => document.getElementById(id);
const DEFAULT_OPTIONS = { format: 'markdown', includeMetadata: true };
const SAVED_OPTION_IDS = ['fileFormat', 'format', 'includeAttachments', 'includeThinking', 'includeMetadata', 'includeArtifacts', 'extractArtifacts', 'frontMatter'];

// ---------------------------------------------------------------- helpers

function detectViewMode() {
  return new Promise((resolve) => {
    chrome.tabs.getCurrent((tab) => {
      void chrome.runtime.lastError;
      if (tab) {
        resolve('tab');
        return;
      }
      let isPopup = false;
      try {
        isPopup = chrome.extension.getViews({ type: 'popup' }).includes(window);
      } catch (error) {
        // getViews is unavailable: treat the page as a side panel
      }
      resolve(isPopup ? 'popup' : 'sidepanel');
    });
  });
}

// What a claude.ai address shows, or null for any other page
function targetFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'claude.ai') return null;
    const chat = parsed.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
    if (chat) return { kind: 'conversation', id: chat[1] };
    const project = parsed.pathname.match(/^\/project\/([0-9a-f-]{36})/i);
    if (project) return { kind: 'project', id: project[1] };
  } catch (error) {
    // not a URL
  }
  return null;
}

function readActiveTabContext() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs && tabs[0] ? targetFromUrl(tabs[0].url || '') : null);
    });
  });
}

function showNotice(message, kind) {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = kind === 'info' ? 'notice info' : 'notice';
  notice.hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

function shortDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function projectChats(project) {
  return state.conversations
    .filter((conv) => projectIdOf(conv) === project.uuid)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
}

// A small button with a download arrow, used in the explorer lists
function downloadIconButton(title, onClick) {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.textContent = '↓';
  button.addEventListener('click', onClick);
  return button;
}

// ---------------------------------------------------------------- options

function readOptions() {
  return {
    format: $('format').value,
    fileFormat: $('fileFormat').value,
    includeChats: true,
    includeAttachments: $('includeAttachments').checked,
    includeThinking: $('includeThinking').checked,
    includeMetadata: $('includeMetadata').checked,
    includeArtifacts: $('includeArtifacts').checked,
    extractArtifacts: $('extractArtifacts').checked,
    frontMatter: $('frontMatter').checked,
    flattenArtifacts: false,
    artifactFormat: 'original',
    zipName: $('zipName').value.trim(),
    dateFrom: $('dateFrom').value,
    dateTo: $('dateTo').value
  };
}

async function loadOptions() {
  const stored = await storageGet('local', ['exportOptions']);
  const saved = stored.exportOptions || DEFAULT_OPTIONS;
  for (const id of SAVED_OPTION_IDS) {
    const control = $(id);
    if (control.type === 'checkbox') {
      if (typeof saved[id] === 'boolean') control.checked = saved[id];
    } else if (saved[id] && control.querySelector(`option[value="${CSS.escape(saved[id])}"]`)) {
      control.value = saved[id];
    }
  }
}

// The download button on claude.ai pages (page-button.js) uses the same options
function saveOptions() {
  const options = readOptions();
  delete options.zipName;
  delete options.dateFrom;
  delete options.dateTo;
  return storageSet('local', { exportOptions: options });
}

// ---------------------------------------------------------------- rendering

function renderChatCard() {
  $('chatCard').hidden = !state.chat;
  if (state.chat) $('chatName').textContent = state.chat.name || 'Untitled conversation';
}

function renderProjectCard() {
  const picker = $('projectPicker');
  picker.replaceChildren(new Option(state.projects.length > 0 ? 'Choose a project...' : 'No projects found', ''));
  for (const project of state.projects) {
    picker.add(new Option(project.name || 'Untitled Project', project.uuid));
  }
  if (state.project && !state.projects.some((project) => project.uuid === state.project.uuid)) {
    picker.add(new Option(state.project.name || 'Open project', state.project.uuid));
  }
  picker.value = state.project ? state.project.uuid : '';

  $('projectName').textContent = state.project ? (state.project.name || 'Untitled Project') : 'No project selected';
  const counts = $('projectCounts');
  counts.hidden = !state.project;
  if (state.project) {
    const files = state.knowledge ? plural(state.knowledge.length, 'file') : 'Counting files';
    counts.textContent = `${files} · ${plural(projectChats(state.project).length, 'chat')}`;
  }
  $('zipName').placeholder = state.project ? (state.project.name || 'Project') : 'Same as the project name';

  const ready = Boolean(state.project) && Boolean(state.orgId) && !state.job;
  for (const id of ['downloadProject', 'downloadFiles', 'downloadChats', 'moveToClaudeCode']) $(id).disabled = !ready;
  $('everythingButton').disabled = !state.orgId || Boolean(state.job);
  $('downloadChat').disabled = Boolean(state.job);
}

function renderExplorer() {
  const card = $('explorerCard');
  card.hidden = !state.project;
  if (!state.project) return;

  const files = state.knowledge || [];
  $('filesCount').textContent = state.knowledge ? String(files.length) : '...';
  $('filesList').replaceChildren(...files.map((item) => {
    const row = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const size = typeof item.text === 'string'
      ? `~${(item.text.length / 4 / 1000).toFixed(1)}k tokens`
      : (item.file && item.file.file_kind ? item.file.file_kind : 'file');
    meta.textContent = [size, shortDate(item.createdAt)].filter(Boolean).join(' · ');
    main.append(name, meta);
    row.append(main, downloadIconButton(`Download ${item.name}`, () => saveKnowledgeFile(item)));
    return row;
  }));

  const chats = projectChats(state.project);
  $('chatsCount').textContent = String(chats.length);
  $('chatsList').replaceChildren(...chats.map((conv) => {
    const row = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = conv.name || 'Untitled conversation';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = shortDate(conv.updated_at);
    main.append(name, meta);
    row.append(main, downloadIconButton(`Download ${conv.name || 'this chat'}`, () => saveChat(conv.uuid, conv.name)));
    return row;
  }));
}

function renderExportTab() {
  renderChatCard();
  renderProjectCard();
  renderExplorer();
}

// ---------------------------------------------------------------- loading

let knowledgeRequest = 0;

async function selectProject(projectId) {
  state.project = projectId
    ? (state.projects.find((project) => project.uuid === projectId) || { uuid: projectId, name: '' })
    : null;
  state.knowledge = null;
  renderExportTab();
  if (!state.project || !state.orgId) return;

  // List the project's files; ignore the answer if the user has moved on
  const request = ++knowledgeRequest;
  const project = state.project;
  const [docs, files, detail] = await Promise.all([
    listProjectDocs(state.orgId, project.uuid).catch(() => []),
    listProjectFiles(state.orgId, project.uuid).catch(() => []),
    project.name ? null : getProject(state.orgId, project.uuid).catch(() => null)
  ]);
  if (request !== knowledgeRequest) return;
  if (detail && detail.name) state.project = { ...project, ...detail };
  state.knowledge = mergeProjectKnowledge(docs, files);
  renderExportTab();
}

// Follow the active tab: show its conversation, and its project if it has one
async function applyContext() {
  state.context = await readActiveTabContext();
  const context = state.context;

  state.chat = context && context.kind === 'conversation'
    ? (state.conversations.find((conv) => conv.uuid === context.id) || { uuid: context.id, name: '' })
    : null;

  let projectId = state.project ? state.project.uuid : null; // keep the user's own pick
  if (context && context.kind === 'project') projectId = context.id;
  else if (state.chat && projectIdOf(state.chat)) projectId = projectIdOf(state.chat);
  await selectProject(projectId);
}

async function loadAccount() {
  hideNotice();
  try {
    state.orgId = await detectOrgId();
    setStoredOrgId(state.orgId);
  } catch (error) {
    state.orgId = await getStoredOrgId();
  }
  if (!state.orgId) {
    showNotice('Sign in to claude.ai in this browser, then press the refresh button.');
    renderExportTab();
    renderLibrary();
    return;
  }

  try {
    const [projects, conversations] = await Promise.all([
      listProjects(state.orgId).catch(() => []),
      listConversations(state.orgId)
    ]);
    state.projects = projects
      .slice()
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
    state.conversations = conversations;
  } catch (error) {
    showNotice(`Could not load your account: ${error.message}`);
  }

  await applyContext();
  renderLibrary();
}

// ---------------------------------------------------------------- single downloads

async function saveChat(uuid, name) {
  const options = readOptions();
  try {
    if (options.format === 'pdf') {
      await startPrintJob({ orgId: state.orgId, conversations: [{ uuid, name: name || '' }], options });
      return;
    }
    const saved = await exportConversationToFile(state.orgId, uuid, options, name || undefined);
    showNotice(`Saved ${saved.filename}`, 'info');
  } catch (error) {
    showNotice(`Could not save the chat: ${error.message}`);
  }
}

async function saveKnowledgeFile(item) {
  try {
    const wanted = { ...item, preferText: readOptions().fileFormat === 'markdown' };
    const { content, record } = await fetchFileItem(state.orgId, wanted, new Set(), '');
    if (content === null) {
      showNotice(`claude.ai did not return ${item.name}. ${record.note || ''}`);
      return;
    }
    downloadFile(content, record.path, typeof content === 'string' ? 'text/plain' : (record.mediaType || 'application/octet-stream'));
    showNotice(record.fidelity === 'original' ? `Saved ${record.path}` : `Saved ${record.path} (${record.fidelity})`, 'info');
  } catch (error) {
    showNotice(`Could not save ${item.name}: ${error.message}`);
  }
}

// ---------------------------------------------------------------- jobs (long exports)

// The project buttons differ only in which parts they include and how they lay them out
function projectJob(part) {
  const options = readOptions();
  const base = options.zipName || state.project.name || 'Project';
  const parts = {
    all: { includeInstructions: true, includeKnowledge: true, includeProjectChats: true, zipFilename: base },
    files: { includeInstructions: false, includeKnowledge: true, includeProjectChats: false, zipFilename: `${base}_files` },
    chats: { includeInstructions: false, includeKnowledge: false, includeProjectChats: true, zipFilename: `${base}_chats` },
    'claude-code': { includeInstructions: true, includeKnowledge: true, includeProjectChats: true, zipFilename: `${base}_claude-code`, layout: 'claude-code' }
  }[part];
  // A project ZIP holds files, so the print-to-PDF format falls back to Markdown
  return {
    type: 'project',
    projectId: state.project.uuid,
    options: { ...options, ...parts, format: options.format === 'pdf' ? 'markdown' : options.format }
  };
}

// After "Move to Claude Code": the prompt to paste into Claude Code
function showHandoff(filename) {
  $('handoffFile').textContent = filename;
  $('handoffPrompt').value = DMT_CLAUDE_CODE_PROMPT;
  $('handoffCard').hidden = false;
}

function setProgress(label, percent) {
  $('progressLabel').textContent = label;
  $('progressBar').style.width = `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%`;
}

async function runJob(job) {
  if (state.job) return;
  state.job = { cancelled: false, controller: new AbortController() };
  setRequestSignal(state.job.controller.signal); // Cancel aborts requests already in flight
  $('handoffCard').hidden = true;
  hideNotice();
  $('progressCard').hidden = false;
  setProgress('Preparing export...', 0);
  renderProjectCard();

  const hooks = {
    isCancelled: () => state.job.cancelled,
    onProgress: (progress) => setProgress(progress.label, progress.percent)
  };
  const options = job.options;
  const inRange = filterConversationsByUpdated(state.conversations, options.dateFrom, options.dateTo);

  try {
    let message = null;

    if (job.type === 'project') {
      const project = state.projects.find((item) => item.uuid === job.projectId)
        || await getProject(state.orgId, job.projectId);
      const result = await exportProjectsToZip(state.orgId, [project], inRange, options, hooks);
      if (!result.cancelled) {
        message = `Saved ${result.filename}. ${describeProjectExport(result.summary)}`;
        if (options.layout === 'claude-code') showHandoff(result.filename);
      }
    } else if (job.type === 'everything') {
      const everythingOptions = { ...options, format: options.format === 'pdf' ? 'markdown' : options.format };
      const result = await exportEverything(state.orgId, state.projects, inRange, everythingOptions, hooks);
      if (!result.cancelled) message = `Saved ${describeAccountExport(result.counts, result.parts.length)}`;
    } else if (job.type === 'chats') {
      const wanted = new Set(job.ids);
      const picked = state.conversations.filter((conv) => wanted.has(conv.uuid));
      const result = await exportConversationsToZip(state.orgId, picked, options, {
        isCancelled: hooks.isCancelled,
        onProgress: (progress) => {
          if (progress.phase === 'zip') setProgress('Creating ZIP file...', progress.percent);
          else setProgress(`${progress.completed + progress.failed} of ${progress.total} chats`, ((progress.completed + progress.failed) / progress.total) * 100);
        }
      });
      if (!result.cancelled) {
        message = result.included === 0
          ? 'Nothing was saved: no chat had anything to export with these settings.'
          : `Saved ${result.filename}: ${plural(result.completed, 'chat')}${result.failed > 0 ? `, ${result.failed} failed` : ''}`;
      }
    }

    if (message) showNotice(message, 'info');
    else showNotice('Export cancelled. ZIP files already saved stay on disk.', 'info');
  } catch (error) {
    console.error('Export failed:', error);
    showNotice(`Export failed: ${error.message}`);
  } finally {
    setRequestSignal(null);
    state.job = null;
    $('progressCard').hidden = true;
    renderProjectCard();
    renderLibrary();
  }
}

// A popup closes the moment it loses focus, which would end a long export.
// From the popup, hand the job to a tab; anywhere else, run it here.
async function startJob(job) {
  if (state.viewMode === 'popup') {
    await storageSet('local', { panelJob: job });
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
    window.close();
    return;
  }
  await runJob(job);
}

// Used by the Library (panel-library.js)
async function exportChats(ids) {
  const options = readOptions();
  if (ids.length === 0) return;
  if (options.format === 'pdf') {
    const wanted = new Set(ids);
    const picked = state.conversations.filter((conv) => wanted.has(conv.uuid));
    await startPrintJob({ orgId: state.orgId, conversations: picked.map((conv) => ({ uuid: conv.uuid, name: conv.name })), options });
    return;
  }
  if (ids.length === 1) {
    const conv = state.conversations.find((item) => item.uuid === ids[0]);
    await saveChat(ids[0], conv ? conv.name : '');
    return;
  }
  await startJob({ type: 'chats', ids, options });
}

// ---------------------------------------------------------------- display mode

function sidePanelAvailable() {
  return Boolean(chrome.sidePanel) || Boolean(typeof browser !== 'undefined' && browser.sidebarAction);
}

async function setUpDisplayMode() {
  if (!sidePanelAvailable()) return; // this browser only has the popup
  $('displayModeBox').hidden = false;
  const stored = await storageGet('local', ['displayMode']);
  $('displayMode').value = stored.displayMode === 'popup' ? 'popup' : 'sidepanel';

  $('displayMode').addEventListener('change', async (event) => {
    const mode = event.target.value;
    await storageSet('local', { displayMode: mode }); // background.js applies it to the toolbar button

    if (mode === 'sidepanel' && state.viewMode === 'popup') {
      // Move over to the side panel straight away
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          const current = await new Promise((resolve) => chrome.windows.getCurrent(resolve));
          await chrome.sidePanel.open({ windowId: current.id });
        } else {
          await browser.sidebarAction.open();
        }
        window.close();
      } catch (error) {
        showNotice('The toolbar button now opens the side panel.', 'info');
      }
    } else {
      showNotice(mode === 'popup' ? 'The toolbar button now opens a popup.' : 'The toolbar button now opens the side panel.', 'info');
    }
  });
}

// ---------------------------------------------------------------- wiring

function showTab(name) {
  const tab = name === 'library' ? 'library' : 'export';
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $('tab-export').hidden = tab !== 'export';
  $('tab-library').hidden = tab !== 'library';
}

let contextTimer = null;
function scheduleContextRefresh() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    if (!state.job) applyContext();
  }, 300);
}

document.addEventListener('DOMContentLoaded', async () => {
  state.viewMode = await detectViewMode();
  document.body.classList.add(`view-${state.viewMode}`);
  $('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  $('popOut').hidden = state.viewMode === 'tab';

  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => showTab(button.dataset.tab)));
  showTab(location.hash.replace('#', ''));

  $('popOut').addEventListener('click', () => {
    const tab = document.querySelector('.tab.active').dataset.tab;
    chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html#${tab}`) });
    if (state.viewMode === 'popup') window.close();
  });
  $('refresh').addEventListener('click', loadAccount);
  $('projectPicker').addEventListener('change', (event) => selectProject(event.target.value || null));
  $('downloadProject').addEventListener('click', () => startJob(projectJob('all')));
  $('downloadFiles').addEventListener('click', () => startJob(projectJob('files')));
  $('moveToClaudeCode').addEventListener('click', () => startJob(projectJob('claude-code')));
  $('copyHandoff').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('handoffPrompt').value);
      $('copyHandoff').textContent = 'Copied';
    } catch (error) {
      $('handoffPrompt').select(); // clipboard refused: leave the text selected to copy by hand
    }
  });
  $('downloadChats').addEventListener('click', () => startJob(projectJob('chats')));
  $('downloadChat').addEventListener('click', () => state.chat && saveChat(state.chat.uuid, state.chat.name));
  $('everythingButton').addEventListener('click', () => startJob({ type: 'everything', options: readOptions() }));
  $('cancelJob').addEventListener('click', () => {
    if (state.job) {
      state.job.cancelled = true;
      state.job.controller.abort();
    }
    setProgress('Cancelling...', 100);
  });
  $('settings').addEventListener('change', saveOptions);
  $('openOptions').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('openTable').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
  });

  await loadOptions();
  await setUpDisplayMode();
  await loadAccount();

  // A side panel stays open while the user moves between tabs
  if (state.viewMode === 'sidepanel') {
    chrome.tabs.onActivated.addListener(scheduleContextRefresh);
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url) scheduleContextRefresh();
    });
  }

  // A job handed over by the popup
  if (state.viewMode === 'tab') {
    const stored = await storageGet('local', ['panelJob']);
    if (stored.panelJob) {
      chrome.storage.local.remove('panelJob');
      runJob(stored.panelJob);
    }
  }
});
