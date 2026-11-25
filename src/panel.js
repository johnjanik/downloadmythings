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
  job: null,           // { cancelled } while an export runs
  syncFolder: null,    // the folder chosen for "Sync to a folder"
  folders: { folders: [], chats: {}, projects: {} } // the user's own folders (lib/folders.js)
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
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(dmtLocaleTag());
}

// Counted words. Each is one entry in the translation files, with every plural form a language needs.
function countChats(count) {
  return tn('{n} chat', '{n} chats', count);
}

function countFiles(count) {
  return tn('{n} file', '{n} files', count);
}

function countProjects(count) {
  return tn('{n} project', '{n} projects', count);
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
  if (state.chat) $('chatName').textContent = state.chat.name || t('Untitled conversation');
}

function renderProjectCard() {
  const picker = $('projectPicker');
  picker.replaceChildren(new Option(state.projects.length > 0 ? t('Choose a project...') : t('No projects found'), ''));
  // Projects the user has filed are listed under their folder, the rest below
  const filed = state.projects.some((project) => folderOf(state.folders, 'projects', project.uuid));
  const groups = new Map();
  for (const project of state.projects) {
    const option = new Option(project.name || t('Untitled Project'), project.uuid);
    if (!filed) {
      picker.add(option);
      continue;
    }
    const folder = folderOf(state.folders, 'projects', project.uuid);
    const label = folder ? folder.name : t('Not in a folder');
    if (!groups.has(label)) {
      const group = document.createElement('optgroup');
      group.label = label;
      groups.set(label, { group, unfiled: !folder });
    }
    groups.get(label).group.appendChild(option);
  }
  const ordered = [...groups.values()].sort((a, b) => a.unfiled - b.unfiled || a.group.label.localeCompare(b.group.label));
  picker.append(...ordered.map((entry) => entry.group));
  if (state.project && !state.projects.some((project) => project.uuid === state.project.uuid)) {
    picker.add(new Option(state.project.name || t('Open project'), state.project.uuid));
  }
  picker.value = state.project ? state.project.uuid : '';

  $('projectName').textContent = state.project ? (state.project.name || t('Untitled Project')) : t('No project selected');
  const counts = $('projectCounts');
  counts.hidden = !state.project;
  if (state.project) {
    const files = state.knowledge ? countFiles(state.knowledge.length) : t('Counting files');
    counts.textContent = `${files} · ${countChats(projectChats(state.project).length)}`;
  }
  $('zipName').placeholder = state.project ? (state.project.name || 'Project') : t('Same as the project name');

  const ready = Boolean(state.project) && Boolean(state.orgId) && !state.job;
  for (const id of ['downloadProject', 'downloadFiles', 'downloadChats', 'moveToClaudeCode']) $(id).disabled = !ready;
  $('everythingButton').disabled = !state.orgId || Boolean(state.job);
  $('downloadChat').disabled = Boolean(state.job);
  renderSyncCard();
  renderBackupCard();
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
    row.append(main, downloadIconButton(t('Download {0}', item.name), () => saveKnowledgeFile(item)));
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
    name.textContent = conv.name || t('Untitled conversation');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = shortDate(conv.updated_at);
    main.append(name, meta);
    row.append(main, downloadIconButton(conv.name ? t('Download {0}', conv.name) : t('Download this chat'), () => saveChat(conv.uuid, conv.name)));
    return row;
  }));
}

function renderExportTab() {
  renderChatCard();
  renderProjectCard();
  renderExplorer();
  renderInsights(); // panel-insights.js: chat size, what fills the project, the project's folder
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
    showNotice(t('Sign in to claude.ai in this browser, then press the refresh button.'));
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
    showNotice(t('Could not load your account: {0}', error.message));
  }

  await applyContext();
  renderLibrary();
  loadUsage(); // panel-insights.js
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
    showNotice(t('Saved {0}', saved.filename), 'info');
  } catch (error) {
    showNotice(t('Could not save the chat: {0}', error.message));
  }
}

async function saveKnowledgeFile(item) {
  try {
    const wanted = { ...item, preferText: readOptions().fileFormat === 'markdown' };
    const { content, record } = await fetchFileItem(state.orgId, wanted, new Set(), '');
    if (content === null) {
      showNotice(t('claude.ai did not return {0}. {1}', item.name, record.note || ''));
      return;
    }
    downloadFile(content, record.path, typeof content === 'string' ? 'text/plain' : (record.mediaType || 'application/octet-stream'));
    showNotice(record.fidelity === 'original' ? t('Saved {0}', record.path) : t('Saved {0} ({1})', record.path, record.fidelity), 'info');
  } catch (error) {
    showNotice(t('Could not save {0}: {1}', item.name, error.message));
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
  $('handoffText').textContent = t('Unzip {0} into an empty folder, start Claude Code there, and paste this prompt.', filename);
  $('handoffPrompt').value = DMT_CLAUDE_CODE_PROMPT;
  $('handoffCard').hidden = false;
}

function setProgress(label, percent) {
  $('progressLabel').textContent = label;
  $('progressBar').style.width = `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%`;
}

// "Alpha.zip", or "3 ZIP files (backup-part1.zip to backup-part3.zip)" for a large export
function savedZipNames(result) {
  const parts = result.parts || [];
  return parts.length > 1 ? t('{0} ZIP files ({1} to {2})', parts.length, parts[0], parts[parts.length - 1]) : result.filename;
}

async function runJob(job) {
  if (state.job) return;
  state.job = { cancelled: false, controller: new AbortController() };
  setRequestSignal(state.job.controller.signal); // Cancel aborts requests already in flight
  $('handoffCard').hidden = true;
  $('recoveryCard').hidden = true;
  hideNotice();
  $('progressCard').hidden = false;
  setProgress(t('Preparing export...'), 0);
  renderProjectCard();

  const hooks = {
    isCancelled: () => state.job.cancelled,
    onProgress: (progress) => setProgress(progress.label, progress.percent)
  };
  const options = job.options;
  const inRange = filterConversationsByUpdated(state.conversations, options.dateFrom, options.dateTo);

  try {
    let message = null;
    let problem = false; // show the message as a warning, not as good news
    let cancelledMessage = t('Export cancelled. ZIP files already saved stay on disk.');

    if (job.type === 'project') {
      const project = state.projects.find((item) => item.uuid === job.projectId)
        || await getProject(state.orgId, job.projectId);
      const result = await exportProjectsToZip(state.orgId, [project], inRange, options, hooks);
      if (!result.cancelled) {
        message = t('Saved {0}. {1}', savedZipNames(result), describeProjectExport(result.summary));
        if (options.layout === 'claude-code') showHandoff(result.filename);
        else showRecovery(filesNeedingRecovery(result.manifests));
      }
    } else if (job.type === 'files-selected') {
      const project = state.projects.find((item) => item.uuid === job.projectId)
        || await getProject(state.orgId, job.projectId);
      const base = options.zipName || project.name || 'Project';
      const result = await exportProjectsToZip(state.orgId, [project], [], {
        ...options,
        includeInstructions: false, includeKnowledge: true, includeProjectChats: false,
        knowledgeNames: job.names, zipFilename: `${base}_selected-files`
      }, hooks);
      if (!result.cancelled) {
        message = t('Saved {0}. {1}', savedZipNames(result), describeProjectExport(result.summary));
        showRecovery(filesNeedingRecovery(result.manifests));
      }
    } else if (job.type === 'move') {
      const project = state.projects.find((item) => item.uuid === job.projectId);
      if (!project) throw new Error(t('That project no longer exists.'));
      const name = project.name || t('Untitled Project');
      const result = await moveChatsToProject(state.orgId, job.ids, job.projectId, {
        isCancelled: hooks.isCancelled,
        onProgress: (done, total) => setProgress(t('Moving {0} of {1} chats', done, total), (done / total) * 100)
      });
      state.conversations = result.conversations;
      cancelledMessage = tn('Stopped. {0} of {n} chat had been moved to "{1}".', 'Stopped. {0} of {n} chats had been moved to "{1}".', result.requested, result.moved, name);
      if (!result.cancelled) {
        if (result.moved === result.requested) {
          message = tn('Moved {n} chat to "{0}".', 'Moved {n} chats to "{0}".', result.moved, name);
        } else {
          problem = true;
          message = result.moved === 0
            ? t('claude.ai accepted the request but moved nothing. The chats are where they were.')
            : tn('Moved {0} of {n} chat to "{1}". claude.ai left the others where they were.', 'Moved {0} of {n} chats to "{1}". claude.ai left the others where they were.', result.requested, result.moved, name);
        }
      }
    } else if (job.type === 'delete') {
      const wanted = new Set(job.ids);
      const picked = state.conversations.filter((conv) => wanted.has(conv.uuid));
      let copied = '';
      let stoppedEarly = false;
      cancelledMessage = t('Stopped. Nothing was deleted.');
      if (job.copyFirst) {
        // The copy must be complete before anything is deleted
        const copyOptions = { ...options, format: options.format === 'pdf' ? 'markdown' : options.format };
        const copy = await exportConversationsToZip(state.orgId, picked, copyOptions, {
          isCancelled: hooks.isCancelled,
          onProgress: (progress) => {
            if (progress.phase === 'zip') setProgress(t('Saving the copy...'), progress.percent);
            else setProgress(t('Saving a copy first: {0} of {1} chats', progress.completed + progress.failed, progress.total), ((progress.completed + progress.failed) / progress.total) * 100);
          }
        });
        if (copy.cancelled) stoppedEarly = true;
        else if (copy.failed > 0) throw new Error(tn('{0} of {n} chat could not be saved, so nothing was deleted.', '{0} of {n} chats could not be saved, so nothing was deleted.', picked.length, copy.failed));
        else if (copy.included < picked.length) throw new Error(t('The copy would not hold every chat with the current export settings, so nothing was deleted.'));
        else copied = t('A copy is in {0}.', copy.filename);
      }
      if (!stoppedEarly) {
        const result = await deleteChats(state.orgId, picked.map((conv) => conv.uuid), {
          isCancelled: hooks.isCancelled,
          onProgress: (done, total) => setProgress(t('Deleting {0} of {1} chats', done, total), (done / total) * 100)
        });
        state.conversations = result.conversations;
        forgetDeletedChats(job.ids); // panel-library.js
        const sentences = (...parts) => parts.filter(Boolean).join(' ');
        cancelledMessage = sentences(tn('Stopped. {0} of {n} chat had been deleted.', 'Stopped. {0} of {n} chats had been deleted.', result.requested, result.deleted), copied);
        if (!result.cancelled) {
          problem = result.deleted < result.requested;
          const outcome = problem
            ? tn('Deleted {0} of {n} chat.', 'Deleted {0} of {n} chats.', result.requested, result.deleted)
            : tn('Deleted {n} chat from claude.ai.', 'Deleted {n} chats from claude.ai.', result.deleted);
          const detail = problem && (result.firstError ? t('First problem: {0}.', result.firstError) : t('claude.ai still lists the others.'));
          message = sentences(outcome, detail, copied);
        }
      }
    } else if (job.type === 'backup-projects') {
      const wanted = new Set(job.projectIds);
      const chosen = state.projects.filter((project) => wanted.has(project.uuid));
      if (chosen.length === 0) throw new Error(t('None of the chosen projects exist any more. Pick the projects to back up again.'));
      const backupOptions = {
        ...options,
        includeInstructions: true, includeKnowledge: true, includeProjectChats: true,
        projectFolders: true, zipFilename: `downloadmythings-backup-${fileDateStamp()}`
      };
      const result = await exportProjectsToZip(state.orgId, chosen, inRange, backupOptions, hooks);
      if (!result.cancelled) message = t('Saved {0}. {1}', savedZipNames(result), describeProjectExport(result.summary));
    } else if (job.type === 'everything') {
      const everythingOptions = { ...options, format: options.format === 'pdf' ? 'markdown' : options.format };
      const result = await exportEverything(state.orgId, state.projects, inRange, everythingOptions, hooks);
      if (!result.cancelled) message = t('Saved {0}', describeAccountExport(result.counts, result.parts.length));
    } else if (job.type === 'sync') {
      const syncOptions = { ...options, format: options.format === 'pdf' ? 'markdown' : options.format };
      const result = await syncAccountToFolder(state.orgId, state.syncFolder, state.projects, inRange, syncOptions, hooks);
      const summary = describeSync(result.counts);
      await storageSet('local', { lastSync: { at: new Date().toISOString(), folder: state.syncFolder.name, summary, cancelled: result.cancelled } });
      if (result.failures.length > 0) console.warn('Folder sync problems:', result.failures);
      cancelledMessage = t('Sync stopped ({0}). What was written stays in the folder, and the next run carries on from there.', summary);
      if (!result.cancelled) {
        message = t('Synced to "{0}": {1}.', state.syncFolder.name, summary);
        if (result.failures.length > 0) message += ` ${t('First problem: {0}: {1}', result.failures[0].name, result.failures[0].message)}`;
      }
    } else if (job.type === 'chats') {
      const wanted = new Set(job.ids);
      const picked = state.conversations.filter((conv) => wanted.has(conv.uuid));
      const result = await exportConversationsToZip(state.orgId, picked, options, {
        isCancelled: hooks.isCancelled,
        onProgress: (progress) => {
          if (progress.phase === 'zip') setProgress(t('Creating ZIP file...'), progress.percent);
          else setProgress(tn('{0} of {n} chat', '{0} of {n} chats', progress.total, progress.completed + progress.failed), ((progress.completed + progress.failed) / progress.total) * 100);
        }
      });
      if (!result.cancelled) {
        message = result.included === 0
          ? t('Nothing was saved: no chat had anything to export with these settings.')
          : (result.failed > 0
            ? tn('Saved {0}: {n} chat, {1} failed', 'Saved {0}: {n} chats, {1} failed', result.completed, result.filename, result.failed)
            : tn('Saved {0}: {n} chat', 'Saved {0}: {n} chats', result.completed, result.filename));
      }
    }

    if (message) showNotice(message, problem ? undefined : 'info');
    else showNotice(cancelledMessage, 'info');
    if (job.backup) await recordBackupRun(message || t('Stopped before it finished'));
  } catch (error) {
    console.error('Export failed:', error);
    showNotice(t('Export failed: {0}', error.message));
    if (job.backup) await recordBackupRun(`Failed: ${error.message}`);
  } finally {
    setRequestSignal(null);
    state.job = null;
    $('progressCard').hidden = true;
    renderExportTab();
    renderLibrary();
  }
}

// A popup closes the moment it loses focus, which would end a long export.
// From the popup, hand the job to a tab; anywhere else, run it here.
async function startJob(job) {
  if (state.viewMode === 'popup') {
    await storageSet('local', { panelJob: { ...job, handedOverAt: Date.now() } });
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

// ---------------------------------------------------------------- sync to a folder

function folderSyncAvailable() {
  return typeof window.showDirectoryPicker === 'function'; // Chromium browsers; not Firefox
}

async function renderSyncCard() {
  if (!folderSyncAvailable()) return;
  const name = $('syncFolderName');
  name.hidden = !state.syncFolder;
  if (state.syncFolder) name.textContent = `Folder: ${state.syncFolder.name}`;
  $('chooseSyncFolder').textContent = state.syncFolder ? t('Change folder...') : t('Choose folder...');
  $('syncNow').disabled = !state.syncFolder || !state.orgId || Boolean(state.job);

  const stored = await storageGet('local', ['lastSync']);
  const last = stored.lastSync;
  const when = last ? new Date(last.at).toLocaleString(dmtLocaleTag()) : '';
  $('syncLast').textContent = !last ? '' : (last.cancelled
    ? t('Last sync {0} to "{1}": {2} (stopped early)', when, last.folder, last.summary)
    : t('Last sync {0} to "{1}": {2}', when, last.folder, last.summary));
}

async function setUpSync() {
  if (!folderSyncAvailable()) return;
  $('syncCard').hidden = false;
  // The folder picker needs an ordinary page, so the controls live in the tab view
  const inTab = state.viewMode === 'tab';
  $('syncControls').hidden = !inTab;
  $('openSync').hidden = inTab;
  state.syncFolder = await loadSyncFolder();
  renderSyncCard();

  $('openSync').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html#sync') });
    if (state.viewMode === 'popup') window.close();
  });

  $('chooseSyncFolder').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'downloadmythings-sync', mode: 'readwrite' });
      await saveSyncFolder(handle);
      state.syncFolder = handle;
      renderSyncCard();
    } catch (error) {
      if (error.name !== 'AbortError') showNotice(t('Could not open that folder: {0}', error.message));
    }
  });

  $('syncNow').addEventListener('click', async () => {
    // The browser may want to be asked again; this must happen inside the click
    const access = { mode: 'readwrite' };
    let permission = await state.syncFolder.queryPermission(access);
    if (permission !== 'granted') permission = await state.syncFolder.requestPermission(access);
    if (permission !== 'granted') {
      showNotice(t('The browser did not allow writing to that folder. Choose the folder again.'));
      return;
    }
    runJob({ type: 'sync', options: readOptions() });
  });
}

// ---------------------------------------------------------------- backups

const BACKUP_DEFAULTS = { scope: 'everything', projectIds: [], method: 'zip', schedule: 'off', lastRunAt: null, lastResult: '' };

async function loadBackupSettings() {
  const stored = await storageGet('local', ['backup']);
  return { ...BACKUP_DEFAULTS, ...(stored.backup || {}) };
}

// background.js watches `backup.schedule` and sets or clears the alarm
async function saveBackupSettings(changes) {
  const backup = { ...(await loadBackupSettings()), ...changes };
  await storageSet('local', { backup });
  return backup;
}

async function recordBackupRun(result) {
  await saveBackupSettings({ lastRunAt: new Date().toISOString(), lastResult: result });
  renderBackupCard();
}

async function renderBackupCard() {
  const backup = await loadBackupSettings();
  $('backupScope').value = backup.scope === 'projects' ? 'projects' : 'everything';
  $('backupSchedule').value = ['daily', 'weekly'].includes(backup.schedule) ? backup.schedule : 'off';

  // The list of projects to tick, for "Projects I choose"
  const list = $('backupProjects');
  list.hidden = backup.scope !== 'projects';
  const chosen = new Set(backup.projectIds);
  list.replaceChildren(...state.projects.map((project) => {
    const row = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'check main';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(project.uuid);
    box.addEventListener('change', async () => {
      const current = new Set((await loadBackupSettings()).projectIds);
      if (box.checked) current.add(project.uuid);
      else current.delete(project.uuid);
      await saveBackupSettings({ projectIds: [...current] });
      renderBackupCard();
    });
    label.append(box, document.createTextNode(project.name || t('Untitled Project')));
    row.appendChild(label);
    return row;
  }));

  // Updating the sync folder is offered once a folder has been chosen
  $('backupMethodBox').hidden = !state.syncFolder;
  $('backupMethod').value = backup.method === 'folder' && state.syncFolder ? 'folder' : 'zip';

  const nothingChosen = backup.scope === 'projects' && backup.projectIds.length === 0;
  $('backupNow').disabled = !state.orgId || Boolean(state.job) || nothingChosen;
  $('backupLast').textContent = backup.lastRunAt
    ? t('Last backup {0}: {1}', new Date(backup.lastRunAt).toLocaleString(dmtLocaleTag()), backup.lastResult)
    : '';
}

// Run the backup the settings describe. `automatic` runs have no click behind
// them, so they cannot ask the browser for folder permission.
async function runBackup(automatic) {
  const backup = await loadBackupSettings();
  const options = { ...readOptions(), dateFrom: '', dateTo: '', zipName: '' };
  if (options.format === 'pdf') options.format = 'markdown';

  if (backup.method === 'folder' && state.syncFolder) {
    const access = { mode: 'readwrite' };
    let permission = await state.syncFolder.queryPermission(access);
    if (permission !== 'granted' && !automatic) permission = await state.syncFolder.requestPermission(access);
    if (permission === 'granted') {
      await runJob({ type: 'sync', options, backup: true });
      return;
    }
    // No permission and nobody to ask: fall back to a ZIP so the backup still happens
  }
  if (backup.scope === 'projects') {
    await runJob({ type: 'backup-projects', projectIds: backup.projectIds, options, backup: true });
  } else {
    await runJob({ type: 'everything', options, backup: true });
  }
}

function setUpBackups() {
  renderBackupCard();
  $('backupScope').addEventListener('change', async (event) => {
    await saveBackupSettings({ scope: event.target.value });
    renderBackupCard();
  });
  $('backupMethod').addEventListener('change', (event) => saveBackupSettings({ method: event.target.value }));
  $('backupSchedule').addEventListener('change', async (event) => {
    await saveBackupSettings({ schedule: event.target.value });
    const said = {
      off: t('Automatic backups are off.'),
      daily: t('Automatic backups are on: daily, while the browser is open.'),
      weekly: t('Automatic backups are on: weekly, while the browser is open.')
    };
    showNotice(said[event.target.value] || said.off, 'info');
  });
  $('backupNow').addEventListener('click', () => {
    if (state.viewMode === 'popup') {
      // A popup would close mid-backup: run it in a tab, as the schedule does
      chrome.tabs.create({ url: chrome.runtime.getURL('panel.html#backup-run') });
      window.close();
      return;
    }
    runBackup(false);
  });
}

// A scheduled run: this tab was opened by the background script's alarm
async function runScheduledBackup() {
  if (!state.orgId) {
    await recordBackupRun(t('Skipped: not signed in to claude.ai'));
  } else {
    await runBackup(true);
  }
  // Give the browser time to take over the download, then close this tab
  setTimeout(() => {
    chrome.tabs.getCurrent((tab) => {
      if (tab) chrome.tabs.remove(tab.id);
    });
  }, 12000);
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
        showNotice(t('The toolbar button now opens the side panel.'), 'info');
      }
    } else {
      showNotice(mode === 'popup' ? t('The toolbar button now opens a popup.') : t('The toolbar button now opens the side panel.'), 'info');
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
  showTab(location.hash === '#library' ? 'library' : 'export');

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
      $('copyHandoff').textContent = t('Copied');
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
    setProgress(t('Cancelling...'), 100);
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
  state.folders = await loadFolders();
  await setUpDisplayMode();
  await setUpSync();
  if (location.hash === '#sync') $('syncCard').scrollIntoView();
  setUpBackups();
  await loadAccount();

  // A side panel stays open while the user moves between tabs
  if (state.viewMode === 'sidepanel') {
    chrome.tabs.onActivated.addListener(scheduleContextRefresh);
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url) scheduleContextRefresh();
    });
  }

  // A job handed over by the popup, or a backup started by the schedule
  if (state.viewMode === 'tab') {
    const stored = await storageGet('local', ['panelJob']);
    // Only a job handed over a moment ago: a stale one (the tab never opened)
    // must not start by surprise later, least of all a deletion
    const fresh = stored.panelJob && Date.now() - (stored.panelJob.handedOverAt || 0) < 2 * 60 * 1000;
    if (stored.panelJob) chrome.storage.local.remove('panelJob');
    if (fresh) {
      runJob(stored.panelJob);
    } else if (location.hash === '#backup-run') {
      runScheduledBackup();
    }
  }
});
