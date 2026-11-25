// The panel's meters and project housekeeping. Loaded after panel.js and
// shares its `state`, `$`, `showNotice` and `startJob`.
//
//   - "Your Claude limits": the account's usage windows, from claude.ai
//   - the open conversation's size, as an estimate of its context
//   - "What is filling this project": files ranked by size, with a backup of the ticked ones
//   - the prompt that asks Claude for originals claude.ai would not serve
//   - the folder the shown project is filed in

const insights = {
  usageRequest: 0,
  chatSizes: new Map(),   // conversation uuid -> { updatedAt, estimate }
  chatSizePending: new Set(), // conversations being measured right now
  ticked: new Set(),      // names of knowledge files ticked under "What is filling this project"
  tickedProject: null     // the project those ticks belong to
};

// A labelled bar: "This week, all models        42%" over a thin track
function meterRow(label, value, percent, hint) {
  const meter = document.createElement('div');
  meter.className = 'meter';
  const row = document.createElement('div');
  row.className = 'meter-row';
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('span');
  amount.className = 'value';
  amount.textContent = value;
  row.append(name, amount);
  const track = document.createElement('div');
  track.className = 'progress-track thin';
  const bar = document.createElement('div');
  bar.className = percent >= 90 ? 'progress-bar high' : 'progress-bar';
  bar.style.width = `${percent}%`;
  track.appendChild(bar);
  meter.append(row, track);
  if (hint) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = hint;
    meter.appendChild(note);
  }
  return meter;
}

// ---------------------------------------------------------------- limits

async function loadUsage() {
  const card = $('usageCard');
  if (!state.orgId) {
    card.hidden = true;
    return;
  }
  const request = ++insights.usageRequest;
  try {
    const windows = normalizeUsage(await getUsage(state.orgId));
    if (request !== insights.usageRequest) return;
    card.hidden = false;
    $('usageRows').replaceChildren(...windows.map((item) => meterRow(item.label, `${item.percent}%`, item.percent, describeReset(item.resetsAt))));
    $('usageNote').textContent = windows.length > 0
      ? `As claude.ai reported at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      : 'claude.ai returned no limits for this account.';
  } catch (error) {
    if (request !== insights.usageRequest) return;
    card.hidden = false;
    $('usageRows').replaceChildren();
    $('usageNote').textContent = `claude.ai did not return your limits: ${error.message}`;
  }
}

// ---------------------------------------------------------------- the open conversation's size

function showChatSize(estimate) {
  $('chatSize').hidden = !estimate;
  if (!estimate) return;
  $('chatSizeLabel').textContent = `About ${formatTokens(estimate.tokens)} tokens`;
  $('chatSizePercent').textContent = `${estimate.percent}% of a 200k window`;
  $('chatSizeBar').style.width = `${estimate.percent}%`;
  $('chatSizeBar').className = estimate.percent >= 90 ? 'progress-bar high' : 'progress-bar';
}

async function renderChatSize() {
  const chat = state.chat;
  if (!chat || !state.orgId) {
    showChatSize(null);
    return;
  }
  const known = insights.chatSizes.get(chat.uuid);
  if (known && known.updatedAt === (chat.updated_at || '')) {
    showChatSize(known.estimate);
    return;
  }
  showChatSize(known ? known.estimate : null);
  // One request per conversation at a time, and none on top of a running export
  if (state.job || insights.chatSizePending.has(chat.uuid)) return;

  insights.chatSizePending.add(chat.uuid);
  try {
    const estimate = conversationTokenEstimate(await getConversation(state.orgId, chat.uuid));
    insights.chatSizes.set(chat.uuid, { updatedAt: chat.updated_at || '', estimate });
    if (state.chat && state.chat.uuid === chat.uuid) showChatSize(estimate);
  } catch (error) {
    // the size is a nicety: leave the card without it
  } finally {
    insights.chatSizePending.delete(chat.uuid);
  }
}

// ---------------------------------------------------------------- what is filling this project

function renderSizeRanking() {
  const project = state.project;
  if (!project) return;
  if (insights.tickedProject !== project.uuid) {
    insights.tickedProject = project.uuid;
    insights.ticked.clear();
  }

  const ranked = rankKnowledgeBySize(state.knowledge || []);
  const present = new Set(ranked.rows.map((row) => row.name));
  for (const name of [...insights.ticked]) {
    if (!present.has(name)) insights.ticked.delete(name);
  }

  let summary = 'Counting files';
  if (state.knowledge) {
    summary = ranked.rows.length === 0
      ? 'This project has no knowledge files.'
      : `About ${formatTokens(ranked.totalTokens)} tokens of text in ${plural(ranked.rows.length, 'file')}, largest first.`;
    if (ranked.unknown > 0) summary += ` claude.ai gives no size for ${ranked.unknown} of them.`;
  }
  $('sizeSummary').textContent = summary;

  const updateButton = () => {
    const button = $('backupTicked');
    button.disabled = insights.ticked.size === 0 || Boolean(state.job);
    button.textContent = insights.ticked.size > 0 ? `Back up ticked files (${insights.ticked.size})` : 'Back up ticked files';
  };

  $('sizeList').replaceChildren(...ranked.rows.map((entry) => {
    const row = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = insights.ticked.has(entry.name);
    box.setAttribute('aria-label', `Tick ${entry.name}`);
    box.addEventListener('change', () => {
      if (box.checked) insights.ticked.add(entry.name);
      else insights.ticked.delete(entry.name);
      updateButton();
    });

    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = entry.tokens === null
      ? 'Size not reported'
      : `About ${formatTokens(entry.tokens)} tokens · ${entry.share}% of the total`;
    main.append(name, meta);
    if (entry.share !== null) {
      const track = document.createElement('div');
      track.className = 'progress-track thin';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      bar.style.width = `${entry.share}%`;
      track.appendChild(bar);
      main.appendChild(track);
    }
    row.append(box, main);
    return row;
  }));
  updateButton();
}

// ---------------------------------------------------------------- originals claude.ai would not serve

function showRecovery(names) {
  const card = $('recoveryCard');
  card.hidden = names.length === 0;
  if (names.length === 0) return;
  $('recoveryText').textContent = `${plural(names.length, 'file')} could not be saved in the original format. Claude can reach the project's files itself and hand them over as a ZIP.`;
  $('recoveryPrompt').value = buildRecoveryPrompt(names);
  $('copyRecovery').textContent = 'Copy prompt';
}

// ---------------------------------------------------------------- the project's folder

function renderProjectFolder() {
  const box = $('projectFolderBox');
  const folders = state.folders.folders;
  box.hidden = !state.project || folders.length === 0;
  if (box.hidden) return;
  const select = $('projectFolder');
  select.replaceChildren(new Option('Not in a folder', ''), ...folders.map((folder) => new Option(folder.name, folder.id)));
  const current = folderOf(state.folders, 'projects', state.project.uuid);
  select.value = current ? current.id : '';
}

function renderInsights() {
  renderChatSize();
  renderSizeRanking();
  renderProjectFolder();
}

document.addEventListener('DOMContentLoaded', () => {
  $('refreshUsage').addEventListener('click', loadUsage);

  $('backupTicked').addEventListener('click', () => {
    if (!state.project || insights.ticked.size === 0) return;
    startJob({ type: 'files-selected', projectId: state.project.uuid, names: [...insights.ticked], options: readOptions() });
  });

  $('copyRecovery').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('recoveryPrompt').value);
      $('copyRecovery').textContent = 'Copied';
    } catch (error) {
      $('recoveryPrompt').select(); // clipboard refused: leave the text selected to copy by hand
    }
  });

  $('projectFolder').addEventListener('change', async (event) => {
    if (!state.project) return;
    state.folders = assignToFolder(state.folders, 'projects', [state.project.uuid], event.target.value || null);
    await saveFolders(state.folders);
    renderProjectCard();
  });
});
