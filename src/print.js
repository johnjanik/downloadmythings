// Print page: renders one or more conversations as a clean document and opens
// the browser's print dialog, where "Save as PDF" produces the file. The PDF
// is made by the browser on this computer; nothing is sent anywhere.
//
// The job to print is left in extension storage by startPrintJob (lib/store.js).

if (typeof initErrorCapture === 'function') initErrorCapture('print');

var PRINT_BATCH_SIZE = 3;

// Markdown to HTML. Raw HTML in a message is shown as text, and images are
// replaced by a note: a transcript must never load anything from the network.
function createMarkdownRenderer() {
  const escapeText = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return new marked.Marked({
    gfm: true,
    breaks: true, // a single newline is a line break, as in the chat itself
    renderer: {
      html(token) {
        return escapeText(token.text || token.raw || '');
      },
      image(token) {
        return escapeText(`[image: ${token.text || token.href || ''}]`);
      }
    }
  });
}

var PRINT_ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'CODE',
  'EM', 'STRONG', 'DEL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A'
]);
var PRINT_DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

// Second line of defence: rebuild the rendered HTML from an allowlist. Only
// the tags above survive, with no attributes except a safe link target, a
// code language class, a list start and a cell alignment.
function appendSanitized(target, html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  const copyChildren = (from, to) => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(node.textContent));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || PRINT_DROPPED_TAGS.has(node.tagName)) continue;
      if (!PRINT_ALLOWED_TAGS.has(node.tagName)) {
        copyChildren(node, to); // keep the words, drop the element
        continue;
      }

      const element = document.createElement(node.tagName.toLowerCase());
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) {
          element.setAttribute('href', href);
          element.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (node.tagName === 'CODE') {
        const language = node.getAttribute('class') || '';
        if (/^language-[\w+#.-]+$/.test(language)) element.className = language;
      } else if (node.tagName === 'OL') {
        const start = node.getAttribute('start') || '';
        if (/^\d+$/.test(start)) element.setAttribute('start', start);
      } else if (node.tagName === 'TH' || node.tagName === 'TD') {
        const align = node.getAttribute('align') || '';
        if (/^(left|right|center)$/.test(align)) element.style.textAlign = align;
      }
      copyChildren(node, element);
      to.appendChild(element);
    }
  };

  copyChildren(parsed.body, target);
}

function setStatus(message, isError) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.classList.toggle('error', Boolean(isError));
}

async function runPrintJob() {
  const stored = await storageGet('local', ['printJob']);
  const job = stored.printJob;
  if (!job || !job.orgId) {
    throw new Error('Nothing to print. Start a PDF export from the popup or the browse page.');
  }
  chrome.storage.local.remove('printJob');

  const options = job.options || {};
  let conversations = job.conversations;
  if (!Array.isArray(conversations)) {
    setStatus('Listing conversations...');
    conversations = (await listConversations(job.orgId)).map((conv) => ({ uuid: conv.uuid, name: conv.name }));
  }
  if (conversations.length === 0) throw new Error('No conversations to print.');

  const content = document.getElementById('content');
  const renderer = createMarkdownRenderer();
  const printedIds = [];
  let failed = 0;

  // A contents list when there is more than one conversation
  let contentsList = null;
  if (conversations.length > 1) {
    const nav = document.createElement('nav');
    nav.className = 'contents';
    const heading = document.createElement('h1');
    heading.textContent = `Conversations (${conversations.length})`;
    contentsList = document.createElement('ol');
    nav.append(heading, contentsList);
    content.appendChild(nav);
  }

  for (let i = 0; i < conversations.length; i += PRINT_BATCH_SIZE) {
    setStatus(`Loading ${Math.min(i + PRINT_BATCH_SIZE, conversations.length)} of ${conversations.length}...`);
    const batch = conversations.slice(i, i + PRINT_BATCH_SIZE);
    const fetched = await Promise.all(batch.map((conv) => getConversation(job.orgId, conv.uuid).then(
      (data) => ({ conv, data }),
      (error) => ({ conv, error })
    )));

    fetched.forEach(({ conv, data, error }, offset) => {
      const article = document.createElement('article');
      article.id = `chat-${i + offset + 1}`;
      const title = (data && data.name) || conv.name || 'Untitled Conversation';

      if (error) {
        failed++;
        const heading = document.createElement('h1');
        heading.textContent = title;
        const note = document.createElement('p');
        note.className = 'load-error';
        note.textContent = `Could not load this conversation: ${error.message}`;
        article.append(heading, note);
      } else {
        data.model = inferModel(data);
        const markdown = convertToMarkdown(
          data,
          Boolean(options.includeMetadata),
          conv.uuid,
          Boolean(options.includeArtifacts),
          Boolean(options.includeThinking)
        );
        appendSanitized(article, renderer.parse(markdown));
        // The transcript marks each turn with a "## User" or "## Claude" heading
        for (const heading of article.querySelectorAll('h2')) {
          if (heading.textContent === 'User' || heading.textContent === 'Claude') heading.className = 'speaker';
        }
        printedIds.push(conv.uuid);
      }
      content.appendChild(article);

      if (contentsList) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${article.id}`;
        link.textContent = title;
        item.appendChild(link);
        contentsList.appendChild(item);
      }
    });
  }

  // The browser offers the page title as the PDF's filename
  const firstTitle = content.querySelector('article h1');
  document.title = conversations.length === 1 && firstTitle
    ? firstTitle.textContent
    : `Conversations (${conversations.length})`;

  const count = `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`;
  setStatus(
    failed > 0
      ? `${count} loaded, ${failed} failed. Choose "Save as PDF" as the destination.`
      : `${count} ready. Choose "Save as PDF" as the destination.`,
    failed > 0
  );

  const printButton = document.getElementById('printButton');
  printButton.disabled = false;
  printButton.addEventListener('click', () => window.print());
  window.addEventListener('afterprint', () => {
    if (printedIds.length > 0) recordExportTimestamps(printedIds);
  }, { once: true });

  window.print();
}

runPrintJob().catch((error) => {
  console.error('Print job failed:', error);
  setStatus(error.message, true);
});
