// Projects view of the browse page: list projects, pick some, export them.
// Loaded after browse.js and shares its state (allProjects, allConversations,
// orgId, currentView) and helpers (escapeHtml, formatDate, showToast, ...).

let selectedProjects = new Set(); // project UUIDs ticked in the table

function chatCountsByProject() {
  const counts = {};
  for (const conv of allConversations) {
    const id = projectIdOf(conv);
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

function getFilteredProjects() {
  const term = document.getElementById('searchInput').value.trim().toLowerCase();
  const matches = (project) => !term
    || (project.name || '').toLowerCase().includes(term)
    || (project.description || '').toLowerCase().includes(term);
  return allProjects
    .filter(matches)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
}

function formatProjectDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : `${formatDate(date)} ${formatTime(date)}`;
}

function updateProjectChrome(shown) {
  document.getElementById('stats').textContent = tn('Showing {0} of {n} project', 'Showing {0} of {n} projects', allProjects.length, shown);
  const button = document.getElementById('exportAllBtn');
  button.disabled = allProjects.length === 0;
  button.textContent = selectedProjects.size > 0
    ? t('Export Selected ({0})', selectedProjects.size)
    : t('Export All Projects');
}

function displayProjects() {
  const tableContent = document.getElementById('tableContent');
  const projects = getFilteredProjects();
  updateProjectChrome(projects.length);

  if (projects.length === 0) {
    tableContent.innerHTML = `<div class="no-results">${escapeHtml(t('No projects found'))}</div>`;
    return;
  }

  const counts = chatCountsByProject();
  const rows = projects.map((project) => {
    const id = escapeHtml(project.uuid);
    const name = project.name || t('Untitled Project');
    return `
      <tr data-id="${id}">
        <td>
          <div class="conversation-name">
            <a href="https://claude.ai/project/${id}" target="_blank" title="${escapeHtml(project.description || name)}">
              ${escapeHtml(name)}
            </a>
          </div>
        </td>
        <td>${counts[project.uuid] || 0}</td>
        <td class="date">${escapeHtml(formatProjectDate(project.updated_at))}</td>
        <td class="date">${escapeHtml(formatProjectDate(project.created_at))}</td>
        <td>
          <div class="actions">
            <button class="btn-small btn-export-project" data-id="${id}">${escapeHtml(t('Export'))}</button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="project-checkbox" data-id="${id}" ${selectedProjects.has(project.uuid) ? 'checked' : ''}>
        </td>
      </tr>`;
  }).join('');

  // Every value placed in the markup below went through escapeHtml() above.
  tableContent.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t('Project'))}</th>
          <th>${escapeHtml(t('Chats'))}</th>
          <th>${escapeHtml(t('Updated'))}</th>
          <th>${escapeHtml(t('Created'))}</th>
          <th>${escapeHtml(t('Actions'))}</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAllProjects" class="select-all-checkbox" ${selectedProjects.size > 0 ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  tableContent.querySelectorAll('.btn-export-project').forEach((button) => {
    button.addEventListener('click', () => {
      exportProjects(allProjects.filter((project) => project.uuid === button.dataset.id));
    });
  });
  tableContent.querySelectorAll('.project-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('click', () => {
      if (checkbox.checked) selectedProjects.add(checkbox.dataset.id);
      else selectedProjects.delete(checkbox.dataset.id);
      document.getElementById('selectAllProjects').checked = selectedProjects.size > 0;
      updateProjectChrome(projects.length);
    });
  });
  document.getElementById('selectAllProjects').addEventListener('click', (event) => {
    selectedProjects = new Set(event.target.checked ? projects.map((project) => project.uuid) : []);
    displayProjects();
  });
}

function readProjectExportOptions() {
  return {
    ...readExportOptions(),
    includeInstructions: document.getElementById('includeInstructions').checked,
    includeKnowledge: document.getElementById('includeKnowledge').checked,
    includeProjectChats: document.getElementById('includeProjectChats').checked
  };
}

// Export the ticked projects, or every project currently shown
function exportSelectedProjects() {
  const projects = selectedProjects.size > 0
    ? allProjects.filter((project) => selectedProjects.has(project.uuid))
    : getFilteredProjects();
  return exportProjects(projects);
}

async function exportProjects(projects) {
  if (projects.length === 0) {
    showToast(t('No projects to export'), true);
    return;
  }
  const options = readProjectExportOptions();
  if (!options.includeInstructions && !options.includeKnowledge && !options.includeProjectChats) {
    showToast(t('Nothing to export. Tick Instructions, Knowledge files or Project chats.'), true);
    return;
  }

  const button = document.getElementById('exportAllBtn');
  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  const progressTitle = document.getElementById('progressTitle');
  const previousTitle = progressTitle.textContent;

  button.disabled = true;
  progressTitle.textContent = projects.length === 1 ? t('Exporting Project') : t('Exporting Projects');
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressText.textContent = t('Preparing export...');
  progressModal.style.display = 'block';

  let cancelled = false;
  document.getElementById('cancelExport').onclick = () => {
    cancelled = true;
    progressModal.style.display = 'none';
    showToast(t('Export cancelled'), true);
  };

  try {
    const result = await exportProjectsToZip(orgId, projects, allConversations, options, {
      isCancelled: () => cancelled,
      onProgress: (progress) => {
        progressText.textContent = progress.label;
        progressBar.style.width = `${Math.round(progress.percent)}%`;
      }
    });
    if (result.cancelled) return;

    await loadExportTimestamps(); // project chats now count as exported
    const summary = result.summary;
    const needsAttention = summary.failures > 0 || summary.byFidelity.missing > 0;
    showToast(t('Exported {0}', describeProjectExport(summary)), needsAttention, 8000);
  } catch (error) {
    console.error('Project export error:', error);
    showToast(t('Export failed: {0}', error.message), true);
  } finally {
    progressModal.style.display = 'none';
    progressTitle.textContent = previousTitle;
    displayProjects();
  }
}

// Switch between the Conversations and Projects views
function setView(view) {
  currentView = view === 'projects' ? 'projects' : 'conversations';
  const projectsView = currentView === 'projects';

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === currentView);
  });
  document.getElementById('projectOptions').style.display = projectsView ? '' : 'none';
  document.getElementById('filterBtn').style.display = projectsView ? 'none' : '';
  // A project ZIP holds files, so the print-to-PDF format does not apply here
  const formatSelect = document.getElementById('exportFormat');
  formatSelect.querySelector('option[value="pdf"]').disabled = projectsView;
  if (projectsView && formatSelect.value === 'pdf') formatSelect.value = 'markdown';
  // "Project chats" replaces the plain "Chats" switch in this view
  document.getElementById('includeChats').closest('label').style.display = projectsView ? 'none' : '';
  document.getElementById('searchInput').placeholder = projectsView
    ? t('Search projects by name...')
    : (statusFilter === 'projects' ? t('Search projects by name...') : t('Search conversations by name...'));

  applyFiltersAndSort();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });
});
