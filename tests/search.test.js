import { describe, it, expect } from 'vitest';
import search from '../src/lib/search.js';

const { parseSearchQuery, textMatchesQuery, searchSnippet, conversationSearchText, staleConversations } = search;

describe('parseSearchQuery', () => {
  it('splits words and lowercases them', () => {
    expect(parseSearchQuery('Postgres  Index')).toEqual(['postgres', 'index']);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(parseSearchQuery('"table of contents" pdf')).toEqual(['table of contents', 'pdf']);
  });

  it('copes with an unfinished quote and with nothing at all', () => {
    expect(parseSearchQuery('"half open')).toEqual(['"half', 'open']);
    expect(parseSearchQuery('   ')).toEqual([]);
    expect(parseSearchQuery(undefined)).toEqual([]);
  });
});

describe('textMatchesQuery', () => {
  const text = 'we moved the index from mysql to postgres last spring';

  it('needs every term', () => {
    expect(textMatchesQuery(text, ['postgres', 'index'])).toBe(true);
    expect(textMatchesQuery(text, ['postgres', 'oracle'])).toBe(false);
  });

  it('matches a phrase only when the words are adjacent', () => {
    expect(textMatchesQuery(text, ['mysql to postgres'])).toBe(true);
    expect(textMatchesQuery(text, ['postgres to mysql'])).toBe(false);
  });
});

describe('searchSnippet', () => {
  const text = `${'intro '.repeat(40)}The migration to Postgres\nfinished on Tuesday.${' outro'.repeat(40)}`;

  it('shows the words around the first match on one line, with ellipses', () => {
    const snippet = searchSnippet(text, ['postgres'], 20);
    expect(snippet).toMatch(/^\u2026.*migration to Postgres finished on.*\u2026$/);
    expect(snippet).not.toContain('\n');
  });

  it('uses whichever term comes first in the text', () => {
    expect(searchSnippet('alpha beta gamma delta', ['delta', 'beta'], 3)).toBe('\u2026ha beta ga\u2026');
  });

  it('is empty when nothing matches', () => {
    expect(searchSnippet(text, ['oracle'])).toBe('');
  });
});

describe('conversationSearchText', () => {
  it('gathers what was said on every branch, plus pasted text, and skips tool blocks', () => {
    const data = {
      chat_messages: [
        { content: [{ type: 'text', text: 'First question' }], attachments: [{ extracted_content: 'pasted notes' }] },
        { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'First answer' }, { type: 'tool_use', name: 'bash' }] },
        { text: 'Old-format message' },
        { content: [{ type: 'text', text: 'An answer on another branch' }] },
      ],
    };
    expect(conversationSearchText(data)).toBe('First question\npasted notes\nFirst answer\nOld-format message\nAn answer on another branch');
  });

  it('tolerates an empty conversation', () => {
    expect(conversationSearchText({})).toBe('');
    expect(conversationSearchText(null)).toBe('');
  });
});

describe('staleConversations', () => {
  it('picks the chats the index lacks or holds an older copy of', () => {
    const index = new Map([
      ['a', { updatedAt: '2026-01-01T00:00:00Z' }],
      ['b', { updatedAt: '2026-01-01T00:00:00Z' }],
    ]);
    const conversations = [
      { uuid: 'a', updated_at: '2026-01-01T00:00:00Z' }, // current
      { uuid: 'b', updated_at: '2026-02-02T00:00:00Z' }, // changed since
      { uuid: 'c', updated_at: '2026-03-03T00:00:00Z' }, // never indexed
    ];
    expect(staleConversations(conversations, index).map((conv) => conv.uuid)).toEqual(['b', 'c']);
  });
});
