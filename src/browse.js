
// Helper function to escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Theme management
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// State management
let allConversations = [];
let filteredConversations = [];
let allProjects = [];
let projectsMap = {}; // Map project UUID to project name
let orgId = null;
let currentSort = 'updated_desc';
let sortStack = []; // Track multi-level sorting: [{field: 'name', direction: 'asc'}, ...]
let selectedConversations = new Set(); // Track selected conversation IDs
let lastCheckedIndex = null; // Track last checked checkbox for shift+click range selection
let exportTimestamps = {}; // Map conversation UUID to last export timestamp
let modelSnapshots = {}; // Map conversation UUID to { firstSeen, current, ... }, see lib/store.js
let currentView = 'conversations'; // 'conversations' or 'projects' (see browse-projects.js)
let statusFilter = 'all'; // 'all', 'new', 'exported', or 'projects' (search scope = project names)
let dateFormat = 'mdy'; // 'mdy' or 'dmy'
let timeFormat = '12h'; // '12h' or '24h'
let modelDisplay = 'original'; // 'original' (first-seen) or 'current'

// Export timestamp storage helpers
async function loadExportTimestamps() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['exportTimestamps'], (result) => {
      exportTimestamps = result.exportTimestamps || {};
      resolve();
    });
  });
}

// Model snapshots are written whenever the conversation list is fetched
// (see recordModelSnapshots in lib/store.js). They preserve the original model even
// after a chat is bounced to a newer one on model retirement.
async function loadModelSnapshots() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['modelSnapshots'], (result) => {
      modelSnapshots = result.modelSnapshots || {};
      resolve();
    });
  });
}

// Resolve which model to show for a conversation. Honors the modelDisplay
// preference ('original' default, or 'current'). When the chat has been
// bounced (current differs from first-seen), `bounced` is true and the
// `*` marker shows the "other" model in its tooltip.
function getDisplayModel(conv) {
  const snap = modelSnapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const original = snap.firstSeen;
    const current = snap.current || snap.firstSeen;
    const bounced = !!snap.current && snap.current !== snap.firstSeen;
    const useCurrent = modelDisplay === 'current';
    return {
      model: useCurrent ? current : original,
      other: useCurrent ? original : current,
      otherTitle: (name) => (useCurrent ? t('Originally {0}', name) : t('Currently {0}', name)),
      bounced
    };
  }
  return { model: conv.model, other: conv.model, otherLabel: '', bounced: false };
}

async function loadDateTimePrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['dateFormat', 'timeFormat'], (result) => {
      dateFormat = result.dateFormat || 'mdy';
      timeFormat = result.timeFormat || '12h';
      resolve();
    });
  });
}

async function loadModelDisplayPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['modelDisplay'], (result) => {
      modelDisplay = result.modelDisplay === 'current' ? 'current' : 'original';
      resolve();
    });
  });
}

function formatDate(dt) {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return dateFormat === 'dmy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

function formatTime(dt) {
  if (timeFormat === '24h') {
    return dt.toLocaleTimeString(dmtLocaleTag(), { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return dt.toLocaleTimeString(dmtLocaleTag(), { hour: '2-digit', minute: '2-digit', hour12: true });
}

function isNewOrUpdated(conv) {
  const lastExport = exportTimestamps[conv.uuid];
  if (!lastExport) return true; // Never exported
  return new Date(conv.updated_at) > new Date(lastExport);
}

// When user navigates back to this page from the options page (bfcache hit),
// reload so changed preferences (model display, date/time format, etc.) take
// effect without a manual refresh.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  // Wire up UI listeners (settings dropdown, filters, search, etc.) immediately
  // so the chrome stays interactive while orgId / conversations are still loading.
  setupEventListeners();
  const loadingStart = Date.now();
  await loadOrgId();
  await loadExportTimestamps();
  await loadModelSnapshots();
  await loadDateTimePrefs();
  await loadModelDisplayPref();
  const elapsed = Date.now() - loadingStart;
  if (elapsed < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed));
  const loadingText = document.getElementById('loadingText');
  if (loadingText) loadingText.textContent = t('Loading conversations...');
  await loadConversations();
});

// Load the organization ID: auto-detect first, fall back to the one saved in Options
async function loadOrgId() {
  try {
    orgId = await detectOrgId();
    setStoredOrgId(orgId); // remembered as the fallback for next time
    return;
  } catch (error) {
    console.log('Could not auto-detect the organization ID, using the saved one:', error);
  }

  orgId = await getStoredOrgId();
  if (!orgId) {
    showError(t('Could not find your organization. Sign in to claude.ai in this browser and reload this page, or set the Organization ID in the extension options.'));
  }
}

// Load projects (for the Project column and project search)
async function loadProjects() {
  if (!orgId) return [];

  try {
    const projects = await listProjects(orgId);
    allProjects = projects;
    projectsMap = {};
    projects.forEach(project => {
      const projectId = project.uuid || project.id;
      const projectName = project.name || project.title || t('Untitled Project');
      projectsMap[projectId] = projectName;
    });
    return projects;
  } catch (error) {
    console.warn('Error loading projects:', error);
    return [];
  }
}

// Load all conversations
async function loadConversations() {
  if (!orgId) return;

  try {
    await loadProjects();

    const conversations = await listConversations(orgId);
    // listConversations has just refreshed the stored model snapshots
    await loadModelSnapshots();

    // Infer models for conversations with null model
    allConversations = conversations.map(conv => ({
      ...conv,
      model: inferModel(conv)
    }));

    applyFiltersAndSort();
  } catch (error) {
    console.error('Error loading conversations:', error);
    showError(t('Failed to load conversations: {0}', error.message));
  }
}

// Get project name for a conversation
function getProjectName(conversation) {
  const projectId = conversation.project_uuid || conversation.project_id || conversation.projectUuid;
  if (!projectId) return '-';
  return projectsMap[projectId] || '-';
}

// Apply filters and sorting
function applyFiltersAndSort() {
  if (currentView === 'projects') {
    displayProjects();
    return;
  }

  const searchTerm = document.getElementById('searchInput').value.toLowerCase();

  // Filter conversations
  filteredConversations = allConversations.filter(conv => {
    // 'projects' mode: search scope becomes the project name, status filters do not apply
    if (statusFilter === 'projects') {
      if (!searchTerm) return true;
      const projectName = getProjectName(conv);
      return projectName && projectName !== '-' && projectName.toLowerCase().includes(searchTerm);
    }

    const matchesSearch = !searchTerm ||
      conv.name.toLowerCase().includes(searchTerm) ||
      (conv.summary && conv.summary.toLowerCase().includes(searchTerm));

    // Status filter
    let matchesStatus = true;
    if (statusFilter === 'new') {
      matchesStatus = isNewOrUpdated(conv);
    } else if (statusFilter === 'exported') {
      matchesStatus = !isNewOrUpdated(conv);
    }

    return matchesSearch && matchesStatus;
  });

  // Sort conversations
  sortConversations();

  // Reset last checked index when list changes
  lastCheckedIndex = null;

  // Update display
  displayConversations();
  updateStats();
}

// Sort conversations based on current sort setting
function sortConversations() {
  // If sortStack is empty, use currentSort from dropdown
  if (sortStack.length === 0) {
    const [field, direction] = currentSort.split('_');
    sortStack = [{field, direction}];
  }

  filteredConversations.sort((a, b) => {
    // Try each sort criterion in order until we find a difference
    for (const {field, direction} of sortStack) {
      let aVal, bVal;

      switch (field) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'project':
          aVal = getProjectName(a).toLowerCase();
          bVal = getProjectName(b).toLowerCase();
          break;
        case 'created':
          aVal = new Date(a.created_at);
          bVal = new Date(b.created_at);
          break;
        case 'updated':
          aVal = new Date(a.updated_at);
          bVal = new Date(b.updated_at);
          break;
        case 'model':
          aVal = formatModelName(getDisplayModel(a).model || '').toLowerCase();
          bVal = formatModelName(getDisplayModel(b).model || '').toLowerCase();
          break;
        default:
          continue;
      }

      let comparison = 0;
      if (aVal > bVal) comparison = 1;
      else if (aVal < bVal) comparison = -1;

      if (comparison !== 0) {
        return direction === 'asc' ? comparison : -comparison;
      }
    }
    return 0;
  });
}

// Handle column header click for sorting
function handleColumnSort(field) {
  const existingIndex = sortStack.findIndex(s => s.field === field);

  if (existingIndex === 0) {
    // Clicking primary sort: toggle direction
    sortStack[0].direction = sortStack[0].direction === 'asc' ? 'desc' : 'asc';
  } else if (existingIndex > 0) {
    // Clicking a secondary sort: move it to primary position
    const [sortCriterion] = sortStack.splice(existingIndex, 1);
    sortStack.unshift(sortCriterion);
  } else {
    // New sort: add to front with ascending direction
    sortStack.unshift({field, direction: 'asc'});
  }

  applyFiltersAndSort();
}

// Get sort indicator for a column
function getSortIndicator(field) {
  const sortIndex = sortStack.findIndex(s => s.field === field);

  // Only show indicator for the primary (most recent) sort
  if (sortIndex !== 0) return '';

  const {direction} = sortStack[sortIndex];
  const primaryArrow = direction === 'asc' ? '↑' : '↓';
  const secondaryArrow = direction === 'asc' ? '↓' : '↑';

  return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
}

// Display conversations in table
function displayConversations() {
  const tableContent = document.getElementById('tableContent');

  if (filteredConversations.length === 0) {
    tableContent.innerHTML = `<div class="no-results">${escapeHtml(t('No conversations found'))}</div>`;
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">${escapeHtml(t('Name'))}${getSortIndicator('name')}</th>
          <th class="sortable" data-sort="project">${escapeHtml(t('Project'))}${getSortIndicator('project')}</th>
          <th class="sortable" data-sort="updated">${escapeHtml(t('Updated'))}${getSortIndicator('updated')}</th>
          <th class="sortable" data-sort="created">${escapeHtml(t('Created'))}${getSortIndicator('created')}</th>
          <th class="sortable" data-sort="model">${escapeHtml(t('Model'))}${getSortIndicator('model')}</th>
          <th>${escapeHtml(t('Actions'))}</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${selectedConversations.size > 0 ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;
  
  filteredConversations.forEach((conv, index) => {
    const updatedDt = new Date(conv.updated_at);
    const createdDt = new Date(conv.created_at);
    const updatedDate = formatDate(updatedDt);
    const updatedTime = formatTime(updatedDt);
    const createdDate = formatDate(createdDt);
    const createdTime = formatTime(createdDt);
    const modelInfo = getDisplayModel(conv);
    const modelBadgeClass = getModelBadgeClass(modelInfo.model);
    const projectName = getProjectName(conv);

    const newUpdated = isNewOrUpdated(conv);
    html += `
      <tr data-id="${escapeHtml(conv.uuid)}">
        <td>
          <div class="conversation-name">
            ${newUpdated ? `<span class="new-dot" title="${escapeHtml(t('New or updated since last export'))}"></span>` : ''}
            <a href="https://claude.ai/chat/${escapeHtml(conv.uuid)}" target="_blank" title="${escapeHtml(conv.name)}">
              ${escapeHtml(conv.name)}
            </a>
          </div>
        </td>
        <td>${escapeHtml(projectName)}</td>
        <td class="date">${escapeHtml(updatedDate)}<br><span class="time">${escapeHtml(updatedTime)}</span></td>
        <td class="date">${escapeHtml(createdDate)}<br><span class="time">${escapeHtml(createdTime)}</span></td>
        <td>
          ${modelInfo.bounced
            ? `<span class="model-cell" title="${escapeHtml(modelInfo.otherTitle(formatModelName(modelInfo.other)))}"><span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span><span class="model-bounced ${modelBadgeClass}">*</span></span>`
            : `<span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span>`
          }
        </td>
        <td>
          <div class="actions">
            <button class="btn-small btn-export" data-id="${escapeHtml(conv.uuid)}" data-name="${escapeHtml(conv.name)}">
              ${escapeHtml(t('Export'))}
            </button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${escapeHtml(conv.uuid)}" data-index="${index}" ${selectedConversations.has(conv.uuid) ? 'checked' : ''}>
        </td>
      </tr>
    `;
  });
  
  html += `
      </tbody>
    </table>
  `;

  // Security: All user-provided data in html has been sanitized with escapeHtml()
  // before concatenation. The HTML structure itself is static/trusted template code.
  tableContent.innerHTML = html;
  
  // Add export button listeners
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', (e) => {
      exportConversation(e.target.dataset.id, e.target.dataset.name);
    });
  });
  
  // Add checkbox listeners (use 'click' instead of 'change' to capture shift key)
  document.querySelectorAll('.conversation-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', handleCheckboxChange);
  });

  // Add select all checkbox listener
  const selectAllCheckbox = document.getElementById('selectAll');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('click', handleSelectAll);
  }

  // Add sortable header click listeners
  document.querySelectorAll('.sortable').forEach(header => {
    header.addEventListener('click', () => {
      handleColumnSort(header.dataset.sort);
    });
  });

  // Update export button text
  updateExportButtonText();

  // Enable export all button
  document.getElementById('exportAllBtn').disabled = false;
}

// Handle individual checkbox change
function handleCheckboxChange(e) {
  const checkbox = e.target;
  const conversationId = checkbox.dataset.id;
  const currentIndex = parseInt(checkbox.dataset.index);

  // Handle shift+click for range selection
  if (e.shiftKey && lastCheckedIndex !== null) {
    const start = Math.min(lastCheckedIndex, currentIndex);
    const end = Math.max(lastCheckedIndex, currentIndex);

    // Get all checkboxes and select/deselect the range
    const checkboxes = document.querySelectorAll('.conversation-checkbox');
    const isChecking = checkbox.checked;

    for (let i = start; i <= end; i++) {
      const cb = checkboxes[i];
      if (cb) {
        cb.checked = isChecking;
        const id = cb.dataset.id;
        if (isChecking) {
          selectedConversations.add(id);
        } else {
          selectedConversations.delete(id);
        }
      }
    }
  } else {
    // Normal single checkbox toggle
    if (checkbox.checked) {
      selectedConversations.add(conversationId);
    } else {
      selectedConversations.delete(conversationId);
    }
  }

  // Update last checked index
  lastCheckedIndex = currentIndex;

  updateExportButtonText();
  updateSelectAllCheckbox();
}

// Handle select all checkbox
function handleSelectAll(e) {
  const checkboxes = document.querySelectorAll('.conversation-checkbox');

  if (e.target.checked) {
    // Select all visible conversations
    checkboxes.forEach(checkbox => {
      checkbox.checked = true;
      selectedConversations.add(checkbox.dataset.id);
    });
  } else {
    // Deselect all
    checkboxes.forEach(checkbox => {
      checkbox.checked = false;
    });
    selectedConversations.clear();
  }

  // Reset last checked index when using select all
  lastCheckedIndex = null;

  updateExportButtonText();
}

// Update select all checkbox state
function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById('selectAll');
  if (!selectAllCheckbox) return;

  // Show header checkbox as checked when any conversations are selected
  selectAllCheckbox.checked = selectedConversations.size > 0;
}

// Update export button text based on selection
function updateExportButtonText() {
  const exportBtn = document.getElementById('exportAllBtn');
  if (!exportBtn) return;

  if (selectedConversations.size > 0) {
    exportBtn.textContent = t('Export Selected ({0})', selectedConversations.size);
  } else {
    exportBtn.textContent = t('Export All');
  }
}

// Update statistics
function updateStats() {
  const stats = document.getElementById('stats');
  const newCount = allConversations.filter(c => isNewOrUpdated(c)).length;
  stats.textContent = tn('Showing {0} of {n} conversation ({1} new/updated)', 'Showing {0} of {n} conversations ({1} new/updated)', allConversations.length, filteredConversations.length, newCount);
}

// Auto-select new/updated conversations
function autoSelectNewUpdated() {
  selectedConversations.clear();
  filteredConversations.forEach(conv => {
    if (isNewOrUpdated(conv)) {
      selectedConversations.add(conv.uuid);
    }
  });
  displayConversations();
  updateExportButtonText();
}

function readExportOptions() {
  return {
    format: document.getElementById('exportFormat').value,
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

// Refresh the "new or updated" markers once an export has been recorded
async function refreshAfterExport() {
  await loadExportTimestamps();
  displayConversations();
  updateStats();
}

// Export single conversation
async function exportConversation(conversationId, conversationName) {
  try {
    // PDF: a print page renders the conversation and opens the print dialog
    if (readExportOptions().format === 'pdf') {
      await startPrintJob({ orgId, conversations: [{ uuid: conversationId, name: conversationName }], options: readExportOptions() });
      return;
    }

    showToast(t('Exporting {0}...', conversationName));
    const result = await exportConversationToFile(orgId, conversationId, readExportOptions(), conversationName);
    await refreshAfterExport();
    const extras = [];
    if (result.artifactCount > 0) extras.push(tn('{n} artifact', '{n} artifacts', result.artifactCount));
    if (result.attachments.saved > 0) extras.push(tn('{n} attachment', '{n} attachments', result.attachments.saved));
    const missing = result.attachments.missing > 0
      ? tn('{n} attachment could not be downloaded', '{n} attachments could not be downloaded', result.attachments.missing)
      : '';
    let exported = extras.length ? t('Exported: {0} with {1}', conversationName, extras.join(', ')) : t('Exported: {0}', conversationName);
    if (missing) exported += ` (${missing})`;
    showToast(exported, Boolean(missing), missing ? 8000 : 3000);
  } catch (error) {
    console.error('Export error:', error);
    showToast(t('Failed to export: {0}', error.message), true);
  }
}

// Export the selected conversations, or everything currently shown
async function exportAllFiltered() {
  // Checked conversations are exported even when the current filter hides
  // them: the checkbox is the user's explicit choice, the filter is a view.
  const conversationsToExport = selectedConversations.size > 0
    ? allConversations.filter(conv => selectedConversations.has(conv.uuid))
    : filteredConversations;

  if (conversationsToExport.length === 0) {
    showToast(t('No conversations to export'), true);
    return;
  }

  // PDF: one document for all of them, with a contents page
  if (readExportOptions().format === 'pdf') {
    await startPrintJob({
      orgId,
      conversations: conversationsToExport.map(conv => ({ uuid: conv.uuid, name: conv.name })),
      options: readExportOptions()
    });
    return;
  }

  const button = document.getElementById('exportAllBtn');
  const originalButtonText = button.textContent;
  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');

  button.disabled = true;
  button.textContent = t('Preparing...');
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressText.textContent = t('Preparing export...');
  progressModal.style.display = 'block';

  try {
    // One conversation: skip the ZIP when the result is a single file
    if (conversationsToExport.length === 1) {
      const conv = conversationsToExport[0];
      progressText.textContent = t('Exporting {0}...', conv.name);
      await exportConversation(conv.uuid, conv.name);
      return;
    }

    let cancelled = false;
    document.getElementById('cancelExport').onclick = () => {
      cancelled = true;
      progressModal.style.display = 'none';
      showToast(t('Export cancelled'), true);
    };

    progressText.textContent = tn('Exporting {n} conversation...', 'Exporting {n} conversations...', conversationsToExport.length);

    const result = await exportConversationsToZip(orgId, conversationsToExport, readExportOptions(), {
      isCancelled: () => cancelled,
      onProgress: (progress) => {
        if (progress.phase === 'zip') {
          progressText.textContent = t('Creating ZIP file...');
          progressBar.style.width = `${Math.round(progress.percent)}%`;
        } else {
          const done = progress.completed + progress.failed;
          progressBar.style.width = `${Math.round(done / progress.total * 100)}%`;
          progressStats.textContent = t('{0} succeeded, {1} failed out of {2}', progress.completed, progress.failed, progress.total);
        }
      }
    });

    if (result.cancelled) return;
    await refreshAfterExport();

    if (result.included === 0) {
      showToast(t('No artifacts found, so nothing was downloaded.'), true);
    } else {
      const sentences = [result.failed > 0
        ? t('Exported {0} of {1} conversations ({2} failed).', result.completed, result.total, result.failed)
        : tn('Successfully exported {n} conversation.', 'Successfully exported all {n} conversations.', result.completed)];
      if (result.attachments.saved > 0) sentences.push(tn('{n} attachment saved.', '{n} attachments saved.', result.attachments.saved));
      const missing = result.attachments.missing > 0;
      if (missing) sentences.push(tn('{n} attachment could not be downloaded; see attachments.json.', '{n} attachments could not be downloaded; see attachments.json.', result.attachments.missing));
      showToast(sentences.join(' '), missing, missing ? 8000 : 3000);
    }
  } catch (error) {
    console.error('Export error:', error);
    showToast(t('Export failed: {0}', error.message), true);
  } finally {
    progressModal.style.display = 'none';
    button.disabled = false;
    button.textContent = originalButtonText;
  }
}

// Show error message
function showError(message) {
  const tableContent = document.getElementById('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
}

// Show toast notification
function showToast(message, isError = false, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');
  
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// Setup event listeners
function setupEventListeners() {
  // Handle checkbox dependencies
  const includeChatsCheckbox = document.getElementById('includeChats');
  const includeThinkingCheckbox = document.getElementById('includeThinking');
  const includeMetadataCheckbox = document.getElementById('includeMetadata');
  const includeArtifactsCheckbox = document.getElementById('includeArtifacts');

  function updateCheckboxStates() {
    const chatsEnabled = includeChatsCheckbox.checked;

    // Disable thinking, metadata and inline artifacts when chats is unchecked
    includeThinkingCheckbox.disabled = !chatsEnabled;
    includeMetadataCheckbox.disabled = !chatsEnabled;
    includeArtifactsCheckbox.disabled = !chatsEnabled;

    // Optionally uncheck them when disabled
    if (!chatsEnabled) {
      includeThinkingCheckbox.checked = false;
      includeMetadataCheckbox.checked = false;
      includeArtifactsCheckbox.checked = false;
    }
  }

  includeChatsCheckbox.addEventListener('change', updateCheckboxStates);
  updateCheckboxStates(); // Initialize on load

  // Settings dropdown
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
    // Update org ID display when opening
    if (settingsDropdown.classList.contains('open')) {
      const orgDisplay = document.getElementById('orgIdDisplay');
      if (orgId) {
        orgDisplay.textContent = orgId.substring(0, 8) + '...';
        orgDisplay.title = orgId;
      } else {
        // No stored org ID — auto-detect will run on the next export action.
        orgDisplay.textContent = t('[Auto]');
        orgDisplay.title = t('No manual org ID set; auto-detection runs on each export.');
      }
      // Update theme label
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      document.getElementById('themeLabel').textContent = theme === 'dark' ? t('Dark') : t('Light');
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
  });
  settingsDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    toggleTheme();
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    document.getElementById('themeLabel').textContent = theme === 'dark' ? t('Dark') : t('Light');
  });

  // Click org ID row to copy full ID to clipboard
  document.getElementById('settingsOrgId').addEventListener('click', async () => {
    if (!orgId) {
      showToast(t('No org ID set'), true);
      return;
    }
    try {
      await navigator.clipboard.writeText(orgId);
      showToast(t('Org ID copied to clipboard'));
    } catch (e) {
      showToast(t('Failed to copy org ID'), true);
    }
    settingsDropdown.classList.remove('open');
  });

  // Edit org ID — open options in the same tab so the back button returns here
  document.getElementById('editOrgId').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  // Advanced Options — open options in the same tab so the back button returns here
  document.getElementById('advancedOptions').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  // Mark all as exported
  document.getElementById('markAllExported').addEventListener('click', async () => {
    const ids = allConversations.map(c => c.uuid);
    await recordExportTimestamps(ids);
    await refreshAfterExport();
    settingsDropdown.classList.remove('open');
    showToast(tn('Marked {n} conversation as exported', 'Marked {n} conversations as exported', ids.length));
  });

  // Mark all as new
  document.getElementById('markAllNew').addEventListener('click', async () => {
    exportTimestamps = {};
    await new Promise(resolve => chrome.storage.local.set({ exportTimestamps: {} }, resolve));
    selectedConversations.clear();
    autoSelectNewUpdated();
    updateStats();
    settingsDropdown.classList.remove('open');
    showToast(t('All conversations marked as new'));
  });

  // Backup / Restore Database submenu — shared logic lives in utils.js
  document.getElementById('backupData').addEventListener('click', () => {
    backupExtensionData((success, message) => showToast(message, !success));
    settingsDropdown.classList.remove('open');
  });

  // Import flow: mode-choice modal → file picker → import.
  // pendingImportMode bridges the async file-picker boundary.
  let pendingImportMode = null;

  document.getElementById('restoreData').addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
    showImportModeModal((mode) => {
      if (mode === null) return; // user cancelled
      pendingImportMode = mode;
      document.getElementById('restoreFileBrowse').click();
    });
  });

  document.getElementById('restoreFileBrowse').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later
    const mode = pendingImportMode;
    pendingImportMode = null; // consume; never reuse a stale mode
    if (!file || !mode) return;
    importBackup(file, mode, (success, message) => showToast(message, !success));
  });

  // Search input
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', (e) => {
    const searchBox = document.getElementById('searchBox');
    if (e.target.value) {
      searchBox.classList.add('has-text');
    } else {
      searchBox.classList.remove('has-text');
    }
    applyFiltersAndSort();
  });
  
  // Clear search
  document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBox').classList.remove('has-text');
    applyFiltersAndSort();
  });

  // Filter dropdown
  const filterBtn = document.getElementById('filterBtn');
  const filterDropdown = document.getElementById('filterDropdown');

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    filterDropdown.classList.remove('open');
  });
  filterDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll('.filter-option').forEach(option => {
    option.addEventListener('click', () => {
      statusFilter = option.dataset.value;
      // Update selected state
      document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      // Search bar placeholder reflects the active scope
      document.getElementById('searchInput').placeholder = statusFilter === 'projects'
        ? t('Search projects by name...')
        : t('Search conversations by name...');
      // Update button state
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      applyFiltersAndSort();
    });
  });

  // Set initial selected state
  document.querySelector('.filter-option[data-value="all"]').classList.add('selected');

  // Export all button
  document.getElementById('exportAllBtn').addEventListener('click', () => {
    if (currentView === 'projects') exportSelectedProjects();
    else exportAllFiltered();
  });
}
