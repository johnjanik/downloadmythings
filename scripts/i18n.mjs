// Translations: find every English string in src/, check the translation files
// in locales/, and produce the browser's _locales/<language>/messages.json.
//
//   node scripts/i18n.mjs                  -> report: what each language is missing
//   node scripts/i18n.mjs --verbose        -> the same, naming every string
//   node scripts/i18n.mjs --check de       -> check locales/de.json alone, in full
//   node scripts/i18n.mjs --template de    -> every English string with empty
//                                             translations, shaped for that language
//
// English lives in the source: t('...') and tn('one', 'other', n) in scripts,
// plain text and title/placeholder/aria-label/alt attributes in HTML pages.
// A translation file maps that English text to the translation:
//
//   { "@language": "Deutsch",
//     "Back up now": "Jetzt sichern",
//     "{n} chat | {n} chats": { "one": "{n} Chat", "other": "{n} Chats" } }

import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_STRINGS } from './manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DMT_LANGUAGES, DMT_EXTRA_LANGUAGES, dmtMessageKey, dmtPluralKey, dmtPluralCategories } = createRequire(import.meta.url)(path.join(root, 'src', 'lib', 'i18n.js'));

// Browsers name some languages twice, or by region. These are written from another language's file.
export const LOCALE_ALIASES = { pt_PT: 'pt_BR', no: 'nb' };

export const SOURCE_LANGUAGE = 'en';
const PLURAL_SEPARATOR = ' | ';
const HTML_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', middot: '·', hellip: '…', rarr: '→', larr: '←', times: '×', copy: '©' };

const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const hasLetter = (text) => /\p{L}/u.test(text);

function decodeEntities(text, problems, where) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (name in HTML_ENTITIES) return HTML_ENTITIES[name];
    problems.push(`${where}: unknown HTML entity ${whole} (add it to scripts/i18n.mjs)`);
    return whole;
  });
}

// The translatable strings in an HTML page, as the page's own script will see
// them: each run of text between tags, and the listed attributes.
export function extractFromHtml(html, where = 'html') {
  const strings = [];
  const problems = [];

  // Text marked translate="no" stays as it is; such an element may hold text only
  const kept = html.replace(/<(\w+)\b[^>]*\btranslate="no"[^>]*>([\s\S]*?)<\/\1>/g, (whole, tag, inner) => {
    if (inner.includes('<')) problems.push(`${where}: a translate="no" element must contain text only: <${tag}>`);
    return '';
  });

  const token = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<[^>]+>|[^<]+/gi;
  for (const [piece] of kept.matchAll(token)) {
    if (piece.startsWith('<!--') || /^<(script|style)\b/i.test(piece)) continue;
    if (piece.startsWith('<')) {
      if (/\stranslate="no"/.test(piece)) continue;
      for (const name of HTML_ATTRIBUTES) {
        for (const match of piece.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))) {
          const text = collapse(decodeEntities(match[1], problems, where));
          if (hasLetter(text)) strings.push(text);
        }
      }
      continue;
    }
    const text = collapse(decodeEntities(piece, problems, where));
    if (hasLetter(text)) strings.push(text);
  }
  return { strings, problems };
}

const STRING_LITERAL = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`';

function literalValue(literal) {
  // Our own source, already syntax-checked: evaluate the literal to unescape it
  return Function(`"use strict"; return (${literal});`)();
}

// The strings passed to t() and tn() in a script
export function extractFromJs(code, where = 'js') {
  const strings = [];
  const plurals = [];
  const problems = [];
  const lineOf = (index) => code.slice(0, index).split('\n').length;

  const call = /(?<![\w$.])(tn?)\(\s*/g;
  const literalAt = new RegExp(`(${STRING_LITERAL})\\s*`, 'y');
  for (const match of code.matchAll(call)) {
    const name = match[1];
    let at = match.index + match[0].length;
    const read = () => {
      literalAt.lastIndex = at;
      const found = literalAt.exec(code);
      if (!found) return null;
      at = literalAt.lastIndex;
      return literalValue(found[1]);
    };
    const first = read();
    if (first === null) {
      // `function t(` and `function tn(` are the definitions themselves
      if (!/function\s+$/.test(code.slice(Math.max(0, match.index - 12), match.index))) {
        problems.push(`${where}:${lineOf(match.index)}: ${name}() needs a plain string literal as its first argument`);
      }
      continue;
    }
    if (name === 't') {
      if (!/[,)]/.test(code[at] || '')) problems.push(`${where}:${lineOf(match.index)}: t() takes one string literal, not an expression`);
      strings.push(first);
      continue;
    }
    if (code[at] !== ',') {
      problems.push(`${where}:${lineOf(match.index)}: tn() needs two string literals`);
      continue;
    }
    at += 1;
    while (/\s/.test(code[at])) at += 1;
    const second = read();
    if (second === null) problems.push(`${where}:${lineOf(match.index)}: tn() needs two string literals`);
    else plurals.push([first, second]);
  }
  return { strings, plurals, problems };
}

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else files.push(full);
  }
  return files.sort();
}

// Every English string in the extension.
// Resolves with { strings: Map(text -> [files]), plurals: Map("one | other" -> { one, other, files }), problems }.
export async function collectSourceStrings(srcDir = path.join(root, 'src')) {
  const strings = new Map();
  const plurals = new Map();
  const problems = [];
  const note = (map, key, value, file) => {
    if (!map.has(key)) map.set(key, { ...value, files: [] });
    const files = map.get(key).files;
    if (!files.includes(file)) files.push(file);
  };

  for (const text of MANIFEST_STRINGS) note(strings, text, {}, 'manifest');

  for (const file of await listFiles(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    if (rel.startsWith('vendor/')) continue;
    if (file.endsWith('.html')) {
      const found = extractFromHtml(await readFile(file, 'utf8'), rel);
      problems.push(...found.problems);
      for (const text of found.strings) note(strings, text, {}, rel);
    } else if (file.endsWith('.js')) {
      const found = extractFromJs(await readFile(file, 'utf8'), rel);
      problems.push(...found.problems);
      for (const text of found.strings) note(strings, text, {}, rel);
      for (const [one, other] of found.plurals) note(plurals, `${one}${PLURAL_SEPARATOR}${other}`, { one, other }, rel);
    }
  }

  for (const text of strings.keys()) {
    if (text.includes(PLURAL_SEPARATOR)) problems.push(`"${text}" contains "${PLURAL_SEPARATOR}", which is reserved for plural entries`);
    if (text !== collapse(text)) problems.push(`"${text}" has leading, trailing or repeated spaces; translations are matched on tidy text`);
  }
  return { strings, plurals, problems };
}

export async function loadLocales(localesDir = path.join(root, 'locales')) {
  const locales = {};
  let names = [];
  try {
    names = (await readdir(localesDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    return locales;
  }
  for (const name of names) {
    locales[name.replace(/\.json$/, '')] = JSON.parse(await readFile(path.join(localesDir, name), 'utf8'));
  }
  return locales;
}

const markers = (text) => (text.match(/\{(?:\d+|n)\}/g) || []).sort().join(' ');

export function pluralCategories(lang) {
  return dmtPluralCategories(lang);
}

// Compare one translation file with the source.
// errors: things that would show broken text. missing / unused: informational.
export function checkLocale(lang, data, source) {
  const errors = [];
  const missing = [];
  const unused = [];
  if (typeof data['@language'] !== 'string' || !data['@language']) errors.push(`${lang}: "@language" (the language's own name) is missing`);

  for (const [text] of source.strings) {
    const value = data[text];
    if (value === undefined || value === '') { missing.push(text); continue; }
    if (typeof value !== 'string') { errors.push(`${lang}: "${text}" must be a string`); continue; }
    if (markers(value) !== markers(text)) errors.push(`${lang}: "${text}" -> "${value}" does not keep the same {markers}`);
  }
  const categories = pluralCategories(lang);
  for (const [key, { one, other }] of source.plurals) {
    const value = data[key];
    if (value === undefined) { missing.push(key); continue; }
    if (!value || typeof value !== 'object') { errors.push(`${lang}: "${key}" must list its plural forms: ${categories.join(', ')}`); continue; }
    for (const category of categories) {
      if (typeof value[category] !== 'string' || !value[category]) errors.push(`${lang}: "${key}" has no "${category}" form (needs ${categories.join(', ')})`);
    }
    const wanted = markers(other.replace(/\{n\}/g, ''));
    for (const [category, form] of Object.entries(value)) {
      if (!categories.includes(category)) errors.push(`${lang}: "${key}" has a "${category}" form the language does not use`);
      else if (typeof form === 'string' && markers(form.replace(/\{n\}/g, '')) !== wanted) errors.push(`${lang}: "${key}" (${category}) does not keep the same {markers}`);
    }
    void one;
  }
  for (const key of Object.keys(data)) {
    if (key.startsWith('@')) continue;
    if (!source.strings.has(key) && !source.plurals.has(key)) unused.push(key);
  }
  return { errors, missing, unused };
}

// The browser's messages.json for one language. `data` is null for English.
// A `$` is doubled because the browser reads `$1` and `$NAME$` as placeholders.
export function buildMessages(lang, data, source) {
  const messages = {};
  const put = (key, message) => { messages[key] = { message: message.replace(/\$/g, '$$$$') }; };
  put('dmtLocale', lang);

  for (const [text] of source.strings) {
    const translated = data ? data[text] : text;
    if (typeof translated === 'string' && translated) put(dmtMessageKey(text), translated);
  }
  for (const [key, { one, other }] of source.plurals) {
    const forms = data ? data[key] : { one, other };
    if (!forms || typeof forms !== 'object') continue;
    for (const [category, form] of Object.entries(forms)) {
      if (typeof form === 'string' && form) put(`${dmtPluralKey(one, other)}_${category}`, form);
    }
  }
  // Fixed names the manifest refers to as __MSG_name__
  for (const [name, text] of Object.entries(MANIFEST_STRINGS_BY_NAME)) {
    const translated = data ? data[text] : text;
    put(name, typeof translated === 'string' && translated ? translated : text);
  }

  const seen = new Map();
  for (const [text] of source.strings) {
    const key = dmtMessageKey(text);
    if (seen.has(key)) throw new Error(`Two strings share the message name ${key}: "${seen.get(key)}" and "${text}"`);
    seen.set(key, text);
  }
  return messages;
}

const MANIFEST_STRINGS_BY_NAME = { extDescription: MANIFEST_STRINGS[0] };

// Everything the build and the checks need, in one call
export async function prepareTranslations() {
  const source = await collectSourceStrings();
  const locales = await loadLocales();
  const problems = [...source.problems];
  const report = {};

  if (locales[SOURCE_LANGUAGE]) problems.push(`locales/${SOURCE_LANGUAGE}.json must not exist: English is taken from the source`);
  for (const [lang, data] of Object.entries(locales)) {
    const result = checkLocale(lang, data, source);
    problems.push(...result.errors);
    report[lang] = result;
    if (!(lang in DMT_LANGUAGES)) problems.push(`locales/${lang}.json has no entry in DMT_LANGUAGES (src/lib/i18n.js)`);
    else if (DMT_LANGUAGES[lang] !== data['@language']) problems.push(`${lang}: DMT_LANGUAGES says "${DMT_LANGUAGES[lang]}" but the file's @language is "${data['@language']}"`);
  }
  for (const lang of Object.keys(DMT_LANGUAGES)) {
    if (lang !== SOURCE_LANGUAGE && !locales[lang]) problems.push(`DMT_LANGUAGES lists ${lang} but locales/${lang}.json does not exist`);
  }

  const messages = { [SOURCE_LANGUAGE]: buildMessages(SOURCE_LANGUAGE, null, source) };
  for (const [lang, data] of Object.entries(locales)) {
    if (lang !== SOURCE_LANGUAGE) messages[lang] = buildMessages(lang, data, source);
  }
  // Where each language's messages.json goes inside the extension
  const files = {};
  for (const lang of Object.keys(messages)) {
    files[`${DMT_EXTRA_LANGUAGES.includes(lang) ? 'i18n-extra' : '_locales'}/${lang}/messages.json`] = messages[lang];
  }
  for (const [alias, lang] of Object.entries(LOCALE_ALIASES)) {
    if (messages[lang]) files[`_locales/${alias}/messages.json`] = { ...messages[lang], dmtLocale: { message: lang } };
  }
  return { source, locales, problems, report, messages, files, total: source.strings.size + source.plurals.size };
}

// ---------------------------------------------------------------- command line

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prepared = await prepareTranslations();

  const argument = (flag) => {
    const at = process.argv.indexOf(flag);
    return at === -1 ? null : (process.argv[at + 1] || '');
  };

  if (argument('--template') !== null) {
    const lang = argument('--template');
    if (!(lang in DMT_LANGUAGES)) {
      console.error(`Unknown language "${lang}". Add it to DMT_LANGUAGES in src/lib/i18n.js first.`);
      process.exit(1);
    }
    const template = { '@language': DMT_LANGUAGES[lang] };
    for (const text of prepared.source.strings.keys()) template[text] = '';
    for (const key of prepared.source.plurals.keys()) template[key] = Object.fromEntries(pluralCategories(lang).map((category) => [category, '']));
    console.log(JSON.stringify(template, null, 2));
  } else if (argument('--check') !== null) {
    const lang = argument('--check');
    const data = prepared.locales[lang];
    if (!data) {
      console.error(`locales/${lang}.json does not exist`);
      process.exit(1);
    }
    const result = checkLocale(lang, data, prepared.source);
    for (const error of result.errors) console.log(`ERROR    ${error}`);
    for (const text of result.missing) console.log(`MISSING  ${text}`);
    for (const text of result.unused) console.log(`UNUSED   ${text}`);
    console.log(`${lang}: ${prepared.total - result.missing.length} of ${prepared.total} translated, ${result.errors.length} errors, ${result.unused.length} unused`);
    process.exit(result.errors.length + result.missing.length + result.unused.length > 0 ? 1 : 0);
  } else {
    console.log(`${prepared.total} strings in the source`);
    for (const [lang, result] of Object.entries(prepared.report)) {
      console.log(`${lang}: ${prepared.total - result.missing.length} translated, ${result.missing.length} missing, ${result.unused.length} no longer used`);
      if (process.argv.includes('--verbose')) {
        for (const text of result.missing) console.log(`  missing: ${text}`);
        for (const text of result.unused) console.log(`  unused:  ${text}`);
      }
    }
    if (prepared.problems.length > 0) {
      console.error(prepared.problems.join('\n'));
      process.exit(1);
    }
  }
}
