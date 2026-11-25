import { describe, it, expect, afterEach } from 'vitest';
import i18n from '../src/lib/i18n.js';
import { extractFromHtml, extractFromJs, checkLocale, buildMessages, prepareTranslations } from '../scripts/i18n.mjs';

const { t, tn, dmtMessageKey, dmtPluralKey, dmtUseMessages, dmtLocale, dmtLocaleTag, dmtPluralCategory, dmtPluralCategories, dmtEscape, DMT_LANGUAGES, DMT_RTL_LANGUAGES, DMT_EXTRA_LANGUAGES } = i18n;

afterEach(() => dmtUseMessages(null));

// Messages as a chosen language stores them: by message name
function useLanguage(lang, strings, plurals = {}) {
  const messages = {};
  for (const [english, translated] of Object.entries(strings)) messages[dmtMessageKey(english)] = translated;
  for (const [pair, forms] of Object.entries(plurals)) {
    const [one, other] = pair.split(' | ');
    for (const [category, form] of Object.entries(forms)) messages[`${dmtPluralKey(one, other)}_${category}`] = form;
  }
  dmtUseMessages({ lang, version: '0', messages });
}

describe('message names', () => {
  it('are stable, distinct, and made only of characters the browser allows', () => {
    expect(dmtMessageKey('Back up now')).toBe(dmtMessageKey('Back up now'));
    expect(dmtMessageKey('Back up now')).not.toBe(dmtMessageKey('Back up now.'));
    expect(dmtMessageKey('Export')).toMatch(/^m[0-9a-f]{16}$/);
    expect(dmtMessageKey('日本語のテキスト')).toMatch(/^m[0-9a-f]{16}$/);
  });
});

describe('t', () => {
  it('returns the English text when there is no translation, with the markers filled', () => {
    expect(t('Saved {0}', 'a.zip')).toBe('Saved a.zip');
    expect(t('{1} before {0}', 'a', 'b')).toBe('b before a');
    expect(t('Nothing to fill')).toBe('Nothing to fill');
  });

  it('leaves a marker alone when no value was given, and never fills a value twice', () => {
    expect(t('{0} and {1}', 'only one')).toBe('only one and {1}');
    expect(t('{0} {1}', '{1}', 'x')).toBe('{1} x');
  });

  it('uses the chosen language, and falls back to English string by string', () => {
    useLanguage('de', { 'Saved {0}': '{0} gespeichert' });
    expect(t('Saved {0}', 'a.zip')).toBe('a.zip gespeichert');
    expect(t('Not translated yet')).toBe('Not translated yet');
    expect(dmtLocale()).toBe('de');
  });

  it('lets a translation move the markers around', () => {
    useLanguage('ja', { 'Moved {0} to {1}': '{1}に{0}を移動しました' });
    expect(t('Moved {0} to {1}', 'A', 'B')).toBe('BにAを移動しました');
  });
});

describe('tn', () => {
  it('counts in English without any translation', () => {
    expect(tn('{n} chat', '{n} chats', 1)).toBe('1 chat');
    expect(tn('{n} chat', '{n} chats', 0)).toBe('0 chats');
    expect(tn('Moved {n} chat to "{0}".', 'Moved {n} chats to "{0}".', 3, 'Beta')).toBe('Moved 3 chats to "Beta".');
  });

  it('uses every plural form a language has', () => {
    useLanguage('ru', {}, { '{n} chat | {n} chats': { one: '{n} чат', few: '{n} чата', many: '{n} чатов', other: '{n} чата' } });
    expect([1, 2, 5, 21, 22, 25].map((n) => tn('{n} chat', '{n} chats', n))).toEqual(['1 чат', '2 чата', '5 чатов', '21 чат', '22 чата', '25 чатов']);
  });

  it('falls back to the "other" form, then to English', () => {
    useLanguage('ru', {}, { '{n} chat | {n} chats': { other: '{n} чата' } });
    expect(tn('{n} chat', '{n} chats', 5)).toBe('5 чата');
    expect(tn('{n} file', '{n} files', 5)).toBe('5 files');
  });

  it('counts Sanskrit with its dual, and Levantine Arabic as Arabic', () => {
    expect([1, 2, 3].map((n) => dmtPluralCategory('sa', n))).toEqual(['one', 'two', 'other']);
    expect(dmtPluralCategories('sa')).toEqual(['one', 'two', 'other']);
    expect([0, 1, 2, 3, 11, 100].map((n) => dmtPluralCategory('apc', n))).toEqual([0, 1, 2, 3, 11, 100].map((n) => dmtPluralCategory('ar', n)));
    expect(dmtPluralCategories('apc').slice().sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
  });
});

describe('languages', () => {
  it('names a date format for each language, borrowing one where the browser has none', () => {
    useLanguage('pt_BR', {});
    expect(dmtLocaleTag()).toBe('pt-BR');
    useLanguage('apc', {});
    expect(dmtLocaleTag()).toBe('ar');
  });

  it('knows which languages are written right to left and which the browser cannot pick', () => {
    expect(DMT_RTL_LANGUAGES.every((lang) => lang in DMT_LANGUAGES)).toBe(true);
    expect(DMT_EXTRA_LANGUAGES.every((lang) => lang in DMT_LANGUAGES)).toBe(true);
    expect(DMT_RTL_LANGUAGES).toEqual(['ar', 'apc', 'fa', 'he']);
  });
});

describe('dmtEscape', () => {
  it('keeps a translation from adding markup', () => {
    expect(dmtEscape('<b>"x" & \'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });
});

describe('extractFromHtml', () => {
  it('finds each run of text and the attributes people read', () => {
    const { strings, problems } = extractFromHtml(`
      <h2>Export   everything</h2>
      <button title="Open in its own tab" aria-label="Open in its own tab">&#8599;</button>
      <input placeholder="Search chats">
      <label><input type="checkbox"> Extended thinking</label>
      <p>Tom &amp; Jerry</p>`);
    expect(problems).toEqual([]);
    expect(strings).toEqual(['Export everything', 'Open in its own tab', 'Open in its own tab', 'Search chats', 'Extended thinking', 'Tom & Jerry']);
  });

  it('skips scripts, styles, comments, text without letters, and anything marked translate="no"', () => {
    const { strings } = extractFromHtml(`
      <style>.a { color: red }</style><script>var x = "Hidden";</script><!-- A comment -->
      <span>&ndash;</span><span>42</span>
      <div translate="no">DownloadMyThings</div>
      <input translate="no" placeholder="xxxx-xxxx">
      <p>Kept</p>`);
    expect(strings).toEqual(['Kept']);
  });

  it('reports markup it cannot read safely', () => {
    expect(extractFromHtml('<div translate="no"><b>Bold</b></div>', 'page.html').problems).toEqual(['page.html: a translate="no" element must contain text only: <div>']);
    expect(extractFromHtml('<p>Caf&eacute;</p>', 'page.html').problems[0]).toContain('unknown HTML entity &eacute;');
  });
});

describe('extractFromJs', () => {
  it('finds the strings passed to t() and tn(), in any quoting', () => {
    const found = extractFromJs([
      "showNotice(t('Saved {0}', name));",
      'const a = t("It\'s done");',
      'const b = t(`Plain template`);',
      "const c = tn('{n} chat', '{n} chats', count);",
      "const d = tn('Moved {n} chat to \"{0}\".', 'Moved {n} chats to \"{0}\".', n, name);",
    ].join('\n'));
    expect(found.problems).toEqual([]);
    expect(found.strings).toEqual(['Saved {0}', "It's done", 'Plain template']);
    expect(found.plurals).toEqual([['{n} chat', '{n} chats'], ['Moved {n} chat to "{0}".', 'Moved {n} chats to "{0}".']]);
  });

  it('ignores other functions and the definitions of t and tn themselves', () => {
    const found = extractFromJs("function t(text) {}\nfunction tn(one, other) {}\nconst x = list.split('a b'); object.t('Not ours'); const fit = set('No');");
    expect(found).toEqual({ strings: [], plurals: [], problems: [] });
  });

  it('refuses a string the build could not find', () => {
    expect(extractFromJs('t(message)', 'a.js').problems).toEqual(['a.js:1: t() needs a plain string literal as its first argument']);
    expect(extractFromJs("t('a ' + b)", 'a.js').problems).toEqual(['a.js:1: t() takes one string literal, not an expression']);
    expect(extractFromJs('t(`Saved ${name}`)', 'a.js').problems).toEqual(['a.js:1: t() needs a plain string literal as its first argument']);
    expect(extractFromJs("tn('one', count)", 'a.js').problems).toEqual(['a.js:1: tn() needs two string literals']);
  });
});

describe('translation files', () => {
  const source = {
    strings: new Map([['Saved {0}', { files: [] }], ['Costs $5', { files: [] }]]),
    plurals: new Map([['{n} chat | {n} chats', { one: '{n} chat', other: '{n} chats', files: [] }]]),
  };

  it('accepts a complete translation', () => {
    const result = checkLocale('de', { '@language': 'Deutsch', 'Saved {0}': '{0} gespeichert', 'Costs $5': 'Kostet 5 $', '{n} chat | {n} chats': { one: '{n} Chat', other: '{n} Chats' } }, source);
    expect(result).toEqual({ errors: [], missing: [], unused: [] });
  });

  it('reports what is missing or no longer used without calling it an error', () => {
    const result = checkLocale('de', { '@language': 'Deutsch', 'Saved {0}': '{0} gespeichert', 'Old string': 'Alt' }, source);
    expect(result.errors).toEqual([]);
    expect(result.missing).toEqual(['Costs $5', '{n} chat | {n} chats']);
    expect(result.unused).toEqual(['Old string']);
  });

  it('refuses a translation that loses a marker or a plural form', () => {
    const lost = checkLocale('de', { '@language': 'Deutsch', 'Saved {0}': 'Gespeichert', 'Costs $5': 'x', '{n} chat | {n} chats': { one: '{n} Chat', other: '{n} Chats' } }, source);
    expect(lost.errors).toEqual(['de: "Saved {0}" -> "Gespeichert" does not keep the same {markers}']);
    const forms = checkLocale('ru', { '@language': 'Русский', 'Saved {0}': '{0}', 'Costs $5': 'x', '{n} chat | {n} chats': { one: '{n} чат', other: '{n} чата' } }, source);
    expect(forms.errors).toEqual([
      'ru: "{n} chat | {n} chats" has no "few" form (needs few, many, one, other)',
      'ru: "{n} chat | {n} chats" has no "many" form (needs few, many, one, other)',
    ]);
  });

  it('writes the browser file by message name, with every plural form, and doubles each $', () => {
    const messages = buildMessages('de', { 'Saved {0}': '{0} gespeichert', 'Costs $5': 'Kostet 5 $', '{n} chat | {n} chats': { one: '{n} Chat', other: '{n} Chats' } }, source);
    expect(messages[dmtMessageKey('Saved {0}')]).toEqual({ message: '{0} gespeichert' });
    expect(messages[dmtMessageKey('Costs $5')]).toEqual({ message: 'Kostet 5 $$' });
    expect(messages[`${dmtPluralKey('{n} chat', '{n} chats')}_one`]).toEqual({ message: '{n} Chat' });
    expect(messages.dmtLocale).toEqual({ message: 'de' });
    expect(typeof messages.extDescription.message).toBe('string');
  });
});

describe('the shipped translations', () => {
  it('find every string in the source, with nothing the build cannot read', async () => {
    const prepared = await prepareTranslations();
    expect(prepared.problems).toEqual([]);
    expect(prepared.total).toBeGreaterThan(400);
    expect(Object.keys(prepared.report).sort()).toEqual(Object.keys(DMT_LANGUAGES).filter((lang) => lang !== 'en').sort());
  });

  it('put languages no browser offers outside _locales, and write the regional doubles', async () => {
    const files = Object.keys((await prepareTranslations()).files);
    expect(files).toContain('i18n-extra/sa/messages.json');
    expect(files).toContain('i18n-extra/apc/messages.json');
    expect(files).not.toContain('_locales/sa/messages.json');
    expect(files).toContain('_locales/en/messages.json');
    expect(files).toContain('_locales/pt_PT/messages.json');
    expect(files).toContain('_locales/no/messages.json');
  });
});
