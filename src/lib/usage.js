// Usage: how much of the account's limits is used, and how large the open
// conversation is. The limits come from claude.ai's own usage call; the
// conversation size is an estimate made here.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

if (typeof module !== 'undefined' && module.exports && typeof getCurrentBranch === 'undefined') {
  Object.assign(globalThis, require('./utils.js'));
}

if (typeof module !== 'undefined' && module.exports && typeof t === 'undefined') {
  Object.assign(globalThis, require('./i18n.js'));
}

// The windows claude.ai reports, in the order they are shown
var DMT_USAGE_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'extra_usage'];

var DMT_CONTEXT_WINDOW_TOKENS = 200000; // the standard window, used as the yardstick
var DMT_CHARS_PER_TOKEN = 4;            // a rough average for English text

// "seven_day_haiku" -> "Seven day haiku", for a window this version has no name for
function usageLabel(key) {
  switch (key) {
    case 'five_hour': return t('Current session (5 hours)');
    case 'seven_day': return t('This week, all models');
    case 'seven_day_opus': return t('This week, Opus');
    case 'seven_day_sonnet': return t('This week, Sonnet');
    case 'seven_day_oauth_apps': return t('This week, connected apps');
    case 'extra_usage': return t('Extra usage');
    default: break;
  }
  const words = String(key).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// claude.ai's answer as a list of { key, label, percent, resetsAt }, known
// windows first. Entries without a number are left out.
function normalizeUsage(raw) {
  const windows = [];
  for (const key of Object.keys(raw && typeof raw === 'object' ? raw : {})) {
    const entry = raw[key];
    if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.utilization)) continue;
    windows.push({
      key,
      label: usageLabel(key),
      percent: Math.max(0, Math.min(100, Math.round(entry.utilization))),
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null
    });
  }
  const order = DMT_USAGE_ORDER;
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return windows.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

// "resets in 2 h 14 min", "resets in 3 days", or '' when the time is unknown or past
function describeReset(resetsAt, now) {
  const at = new Date(resetsAt || '').getTime();
  const from = now instanceof Date ? now.getTime() : Date.now();
  if (Number.isNaN(at) || at <= from) return '';
  const minutes = Math.round((at - from) / 60000);
  if (minutes < 60) return t('resets in {0} min', Math.max(1, minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('resets in {0} h {1} min', hours, minutes % 60);
  return tn('resets in {n} day', 'resets in {n} days', Math.round(hours / 24));
}

function estimateTokens(characters) {
  return Math.ceil(characters / DMT_CHARS_PER_TOKEN);
}

// "840", "12.3k", "1.2M"
function formatTokens(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(tokens < 100000 ? 1 : 0)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

// An estimate of what the open conversation puts into Claude's context: the
// text of the branch being shown, plus the text of its attachments. Project
// files, instructions and images are not counted.
function conversationTokenEstimate(data) {
  let characters = 0;
  const branch = typeof getCurrentBranch === 'function' ? getCurrentBranch(data) : ((data && data.chat_messages) || []);
  for (const message of branch) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block.text === 'string') characters += block.text.length;
        else if (block && block.type === 'tool_use' && block.input) characters += JSON.stringify(block.input).length;
        else if (block && block.type === 'tool_result') characters += JSON.stringify(block.content || '').length;
      }
    } else if (typeof message.text === 'string') {
      characters += message.text.length;
    }
    for (const attachment of message.attachments || []) {
      if (attachment && typeof attachment.extracted_content === 'string') characters += attachment.extracted_content.length;
    }
  }
  const tokens = estimateTokens(characters);
  return { tokens, percent: Math.min(100, Math.round((tokens / DMT_CONTEXT_WINDOW_TOKENS) * 100)) };
}

// Node (vitest) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_USAGE_ORDER,
    DMT_CONTEXT_WINDOW_TOKENS,
    usageLabel,
    normalizeUsage,
    describeReset,
    estimateTokens,
    formatTokens,
    conversationTokenEstimate,
  };
}
