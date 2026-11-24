// A download button on claude.ai's own pages: on a conversation it saves that
// conversation, on a project page it saves the whole project. It uses the
// export options last chosen in the popup.
//
// The button floats above the page instead of being wired into claude.ai's
// layout, so a redesign of the site cannot break it. It carries its own
// inline styles because scripts injected after an install or update arrive
// without a stylesheet.

(function () {
  var previous = globalThis.__dmtPageButton;
  if (previous && previous.isAlive()) return;

  function isAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }
  globalThis.__dmtPageButton = { isAlive: isAlive };

  var BUTTON_ID = 'dmt-page-button';
  var DEFAULT_OPTIONS = { format: 'markdown', includeMetadata: true };
  var enabled = true;
  var busy = false;
  var resetTimer = null;
  var pollTimer = null;

  // What the current page shows, from its address
  function pageTarget() {
    var chat = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
    if (chat) return { kind: 'conversation', id: chat[1] };
    var project = location.pathname.match(/^\/project\/([0-9a-f-]{36})/i);
    if (project) return { kind: 'project', id: project[1] };
    return null;
  }

  function idleLabel(target) {
    return target.kind === 'project' ? 'Download project' : 'Download chat';
  }

  function idleTitle(target) {
    return target.kind === 'project'
      ? 'DownloadMyThings: save this project (instructions, knowledge files and chats) as a ZIP'
      : 'DownloadMyThings: save this conversation. Change the format in the extension popup.';
  }

  function createIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    ['M12 4v10', 'M7.5 10.5 12 15l4.5-4.5', 'M5 18.5h14'].forEach(function (d) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function paint(button, state) {
    button.dataset.state = state;
    button.style.background = state === 'error' ? '#b3261e' : '#2563eb';
    button.style.cursor = state === 'working' ? 'progress' : 'pointer';
    button.style.opacity = state === 'idle' ? '0.88' : '1';
  }

  function createButton() {
    var button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    var style = button.style;
    style.position = 'fixed';
    style.right = '20px';
    style.bottom = '96px';
    style.zIndex = '2147483000';
    style.display = 'inline-flex';
    style.alignItems = 'center';
    style.gap = '6px';
    style.padding = '8px 13px';
    style.border = 'none';
    style.borderRadius = '999px';
    style.color = '#ffffff';
    style.font = '500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.28)';
    style.transition = 'opacity 0.15s';

    var label = document.createElement('span');
    button.append(createIcon(), label);
    paint(button, 'idle');

    button.addEventListener('mouseenter', function () { button.style.opacity = '1'; });
    button.addEventListener('mouseleave', function () { if (button.dataset.state === 'idle') button.style.opacity = '0.88'; });
    button.addEventListener('click', onClick);
    return button;
  }

  function show(target) {
    var button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = createButton();
      (document.body || document.documentElement).appendChild(button);
    }
    button.dataset.kind = target.kind;
    if (button.dataset.state === 'idle') {
      button.lastChild.textContent = idleLabel(target);
      button.title = idleTitle(target);
    }
  }

  function hide() {
    var button = document.getElementById(BUTTON_ID);
    if (button) button.remove();
  }

  // Show a result on the button for a few seconds, then return to idle
  function flash(state, label, title, duration) {
    var button = document.getElementById(BUTTON_ID);
    if (!button) return;
    paint(button, state);
    button.lastChild.textContent = label;
    button.title = title;
    clearTimeout(resetTimer);
    if (state === 'working') return;
    resetTimer = setTimeout(function () {
      var current = document.getElementById(BUTTON_ID);
      if (current) paint(current, 'idle');
      refresh();
    }, duration);
  }

  async function exportTarget(target) {
    var orgId = await detectOrgId();
    var stored = await storageGet('local', ['exportOptions']);
    var options = stored.exportOptions || DEFAULT_OPTIONS;

    if (target.kind === 'conversation') {
      if (options.format === 'pdf') {
        await startPrintJob({ orgId: orgId, conversations: [{ uuid: target.id, name: '' }], options: options });
        return 'Opened the print view';
      }
      var saved = await exportConversationToFile(orgId, target.id, options);
      return 'Saved ' + saved.filename;
    }

    // A project ZIP holds files, so the print-to-PDF format falls back to Markdown
    var projectOptions = Object.assign({}, options, { format: options.format === 'pdf' ? 'markdown' : options.format });
    var lists = await Promise.all([listProjects(orgId), listConversations(orgId)]);
    var project = lists[0].find(function (item) { return item.uuid === target.id; })
      || await getProject(orgId, target.id);
    var result = await exportProjectsToZip(orgId, [project], lists[1], projectOptions);
    return 'Saved ' + result.filename + ' (' + describeProjectExport(result.summary) + ')';
  }

  async function onClick() {
    var target = pageTarget();
    if (busy || !target) return;
    busy = true;
    flash('working', 'Downloading...', 'DownloadMyThings is working');
    try {
      var message = await exportTarget(target);
      flash('done', 'Saved', message, 2500);
    } catch (error) {
      console.warn('DownloadMyThings:', error);
      flash('error', 'Failed', 'DownloadMyThings: ' + error.message, 6000);
    } finally {
      busy = false;
    }
  }

  // claude.ai changes pages without reloading, so re-check the address regularly
  function refresh() {
    if (!isAlive()) {
      clearInterval(pollTimer);
      hide();
      return;
    }
    var target = enabled ? pageTarget() : null;
    if (target) show(target);
    else if (!busy) hide();
  }

  chrome.storage.local.get(['showPageButton'], function (result) {
    enabled = !result || result.showPageButton !== false;
    refresh();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.showPageButton || !isAlive()) return;
    enabled = changes.showPageButton.newValue !== false;
    refresh();
  });
  pollTimer = setInterval(refresh, 1000);
})();
