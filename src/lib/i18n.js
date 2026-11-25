// Translations.
//
// English is written where it is used: t('Saved {0}', name) in scripts, plain
// text in the HTML pages. The build reads every such string out of the source
// and writes the browser's locale files (scripts/i18n.mjs); the translations
// themselves live in locales/<language>.json, keyed by the English text.
//
//   t('Saved {0}', name)                       one string, {0} {1} ... filled in
//   tn('{n} chat', '{n} chats', count)         a counted string, with the plural
//                                              forms the language needs
//
// The first argument must be a plain string literal, or the build cannot find it.
//
// The browser picks the language. A language chosen in Options overrides it:
// that language's messages are then kept in storage and used instead.
//
// Plain script, no modules: function declarations and `var` only (see store.js).

// Languages with a file in locales/, by their own names. `en` is the source.
var DMT_LANGUAGES = {
  en: 'English',
  ar: 'العربية',
  apc: 'العربية الشامية',
  az: 'Azərbaycan dili',
  bg: 'Български',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  es: 'Español',
  fa: 'فارسی',
  fi: 'Suomi',
  fr: 'Français',
  gu: 'ગુજરાતી',
  he: 'עברית',
  hi: 'हिन्दी',
  hu: 'Magyar',
  hy: 'Հայերեն',
  it: 'Italiano',
  ja: '日本語',
  ka: 'ქართული',
  ko: '한국어',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  nb: 'Norsk bokmål',
  nl: 'Nederlands',
  pl: 'Polski',
  pt_BR: 'Português',
  ru: 'Русский',
  sa: 'संस्कृतम्',
  sr: 'Српски',
  sv: 'Svenska',
  ta: 'தமிழ்',
  tr: 'Türkçe',
  zh_CN: '简体中文',
  zh_TW: '繁體中文'
};

// Written right to left
var DMT_RTL_LANGUAGES = ['ar', 'apc', 'fa', 'he'];

// No browser offers its own interface in these, so the browser never picks
// them by itself: they are chosen in Options. Their files are kept outside
// _locales/, where browsers and stores only expect languages they know.
var DMT_EXTRA_LANGUAGES = ['apc', 'sa'];

// For counting and for dates, these behave like a language the browser knows
var DMT_LANGUAGE_LIKE = { apc: 'ar' };

var DMT_LANGUAGE_KEY = 'dmtUiLanguage';

// { lang, version, messages } once the user has chosen a language; null = follow the browser
var dmtI18nOverride = null;

// The name a string is stored under in the locale files: a 64-bit hash of the
// English text, because the browser allows only letters, digits and _ in names.
function dmtMessageKey(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `m${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

function dmtPluralKey(one, other) {
  return dmtMessageKey(`${one}\n${other}`);
}

// The stored translation under a name, or '' when there is none
function dmtLookup(key) {
  if (dmtI18nOverride) return dmtI18nOverride.messages[key] || '';
  if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
    try {
      return chrome.i18n.getMessage(key) || '';
    } catch (error) {
      return '';
    }
  }
  return '';
}

// The language the strings are actually in: 'en', 'de', 'pt_BR', ...
function dmtLocale() {
  if (dmtI18nOverride) return dmtI18nOverride.lang;
  return dmtLookup('dmtLocale') || 'en';
}

// The language as the browser's own date and number formatting names it: 'pt-BR', 'ar', ...
function dmtLocaleTag() {
  const locale = dmtLocale();
  return (DMT_LANGUAGE_LIKE[locale] || locale).replace('_', '-');
}

// Which plural form a count takes in a language: 'one', 'few', 'many', 'other', ...
function dmtPluralCategory(locale, count) {
  if (locale === 'sa') return count === 1 ? 'one' : (count === 2 ? 'two' : 'other'); // Sanskrit has a dual
  try {
    return new Intl.PluralRules((DMT_LANGUAGE_LIKE[locale] || locale).replace('_', '-')).select(count);
  } catch (error) {
    return count === 1 ? 'one' : 'other';
  }
}

// Every plural form a language has, for the build to check translations against
function dmtPluralCategories(locale) {
  if (locale === 'sa') return ['one', 'two', 'other'];
  return new Intl.PluralRules((DMT_LANGUAGE_LIKE[locale] || locale).replace('_', '-')).resolvedOptions().pluralCategories;
}

function dmtFill(template, values) {
  return template.replace(/\{(\d+)\}/g, (marker, index) => (Number(index) < values.length ? String(values[Number(index)]) : marker));
}

function t(text, ...values) {
  return dmtFill(dmtLookup(dmtMessageKey(text)) || text, values);
}

// A counted string. `{n}` is the count; further values fill {0}, {1}, ...
function tn(one, other, count, ...values) {
  const category = dmtPluralCategory(dmtLocale(), count);
  const key = dmtPluralKey(one, other);
  const template = dmtLookup(`${key}_${category}`) || dmtLookup(`${key}_other`) || (count === 1 ? one : other);
  return dmtFill(template.replace(/\{n\}/g, String(count)), values);
}

// For text placed into markup: a translation must never be able to add tags
function dmtEscape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Use these messages from now on (null = follow the browser again)
function dmtUseMessages(chosen) {
  dmtI18nOverride = chosen && chosen.lang && chosen.messages ? chosen : null;
}

function dmtIsExtensionPage() {
  return typeof location !== 'undefined' && /^(chrome|moz)-extension:$/.test(location.protocol);
}

// Translate the text and tooltips written in an HTML page. Every text node is
// looked up by its English text; anything inside translate="no" is left alone.
function dmtTranslatePage(root) {
  const locale = dmtLocale();
  if (root === document) {
    document.documentElement.lang = locale.replace('_', '-');
    document.documentElement.dir = DMT_RTL_LANGUAGES.includes(locale) ? 'rtl' : 'ltr';
  }
  if (locale === 'en') return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[translate="no"], script, style')) continue;
    const english = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(english)) continue;
    const translated = dmtLookup(dmtMessageKey(english));
    if (!translated || translated === english) continue;
    const lead = /^\s/.test(node.nodeValue) ? ' ' : '';
    const trail = /\s$/.test(node.nodeValue) ? ' ' : '';
    node.nodeValue = `${lead}${translated}${trail}`;
  }

  const scope = root === document ? document.documentElement : root;
  for (const element of scope.querySelectorAll('[title], [placeholder], [aria-label], [alt]')) {
    if (element.closest('[translate="no"]')) continue;
    for (const name of ['title', 'placeholder', 'aria-label', 'alt']) {
      const english = (element.getAttribute(name) || '').replace(/\s+/g, ' ').trim();
      if (!/\p{L}/u.test(english)) continue;
      const translated = dmtLookup(dmtMessageKey(english));
      if (translated && translated !== english) element.setAttribute(name, translated);
    }
  }
}

// Choose the interface language: 'auto' follows the browser, anything else is
// a key of DMT_LANGUAGES. Call from an extension page; reload pages afterwards.
async function dmtSetLanguage(lang) {
  if (!lang || lang === 'auto') {
    localStorage.removeItem(DMT_LANGUAGE_KEY);
    await new Promise((resolve) => chrome.storage.local.remove(DMT_LANGUAGE_KEY, resolve));
    dmtUseMessages(null);
    return;
  }
  const messages = {};
  if (lang !== 'en') {
    const folder = DMT_EXTRA_LANGUAGES.includes(lang) ? 'i18n-extra' : '_locales';
    const response = await fetch(chrome.runtime.getURL(`${folder}/${lang}/messages.json`));
    if (!response.ok) throw new Error(`No translation file for ${lang}`);
    const file = await response.json();
    for (const key of Object.keys(file)) {
      messages[key] = String(file[key].message || '').replace(/\$\$/g, '$');
    }
  }
  const chosen = { lang, version: chrome.runtime.getManifest().version, messages };
  // Extension pages read it from localStorage, at once; claude.ai tabs from extension storage
  localStorage.setItem(DMT_LANGUAGE_KEY, JSON.stringify(chosen));
  await new Promise((resolve) => chrome.storage.local.set({ [DMT_LANGUAGE_KEY]: chosen }, resolve));
  dmtUseMessages(chosen);
}

// For scripts running in a claude.ai tab, which cannot use the pages' localStorage
function dmtLoadLanguage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([DMT_LANGUAGE_KEY], (result) => {
        dmtUseMessages((result || {})[DMT_LANGUAGE_KEY] || null);
        resolve();
      });
    } catch (error) {
      resolve();
    }
  });
}

// In the extension's own pages: pick up the chosen language before anything is
// drawn, translate the page, and refresh the stored messages after an update.
if (dmtIsExtensionPage() && typeof document !== 'undefined') {
  try {
    dmtUseMessages(JSON.parse(localStorage.getItem(DMT_LANGUAGE_KEY) || 'null'));
  } catch (error) {
    dmtUseMessages(null);
  }
  document.addEventListener('DOMContentLoaded', () => {
    dmtTranslatePage(document);
    const stale = dmtI18nOverride && dmtI18nOverride.version !== chrome.runtime.getManifest().version;
    if (stale) {
      dmtSetLanguage(dmtI18nOverride.lang)
        .catch(() => dmtSetLanguage('auto'))
        .then(() => location.reload());
    }
  });
}

// Node (vitest and the build) only; in the browser these are plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DMT_LANGUAGES,
    DMT_RTL_LANGUAGES,
    DMT_EXTRA_LANGUAGES,
    DMT_LANGUAGE_KEY,
    dmtLocaleTag,
    dmtPluralCategory,
    dmtPluralCategories,
    dmtMessageKey,
    dmtPluralKey,
    dmtLocale,
    dmtFill,
    t,
    tn,
    dmtEscape,
    dmtUseMessages,
    dmtTranslatePage,
  };
}
