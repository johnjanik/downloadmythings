import { describe, it, expect } from 'vitest';
import usage from '../src/lib/usage.js';

const { normalizeUsage, describeReset, formatTokens, conversationTokenEstimate, usageLabel } = usage;

describe('normalizeUsage', () => {
  it('lists the windows claude.ai reports, the session first, then the week', () => {
    const windows = normalizeUsage({
      seven_day_opus: { utilization: 3.2, resets_at: '2026-11-30T09:00:00Z' },
      seven_day: { utilization: 41.6, resets_at: '2026-11-30T09:00:00Z' },
      five_hour: { utilization: 77.0, resets_at: '2026-11-25T18:00:00Z' },
    });
    expect(windows.map((w) => [w.key, w.percent])).toEqual([['five_hour', 77], ['seven_day', 42], ['seven_day_opus', 3]]);
    expect(windows[0]).toMatchObject({ label: 'Current session (5 hours)', resetsAt: '2026-11-25T18:00:00Z' });
  });

  it('leaves out windows that are null or carry no number', () => {
    const windows = normalizeUsage({ five_hour: { utilization: 10 }, seven_day_oauth_apps: null, extra_usage: { is_enabled: false }, note: 'text' });
    expect(windows.map((w) => w.key)).toEqual(['five_hour']);
    expect(windows[0].resetsAt).toBeNull();
  });

  it('keeps the bar inside 0 to 100 and names a window it has never seen', () => {
    const windows = normalizeUsage({ seven_day_haiku: { utilization: 140 }, five_hour: { utilization: -3 } });
    expect(windows).toEqual([
      { key: 'five_hour', label: 'Current session (5 hours)', percent: 0, resetsAt: null },
      { key: 'seven_day_haiku', label: 'Seven day haiku', percent: 100, resetsAt: null },
    ]);
    expect(usageLabel('seven_day')).toBe('This week, all models');
  });

  it('copes with an answer that is not an object', () => {
    expect(normalizeUsage(null)).toEqual([]);
    expect(normalizeUsage('nope')).toEqual([]);
  });
});

describe('describeReset', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  it('counts down in minutes, hours and days', () => {
    expect(describeReset('2026-11-25T12:20:00Z', now)).toBe('resets in 20 min');
    expect(describeReset('2026-11-25T14:14:00Z', now)).toBe('resets in 2 h 14 min');
    expect(describeReset('2026-11-26T12:00:00Z', now)).toBe('resets in 1 day');
    expect(describeReset('2026-11-28T15:00:00Z', now)).toBe('resets in 3 days');
  });
  it('says nothing for a missing or past time', () => {
    expect(describeReset(null, now)).toBe('');
    expect(describeReset('not a date', now)).toBe('');
    expect(describeReset('2026-11-25T11:00:00Z', now)).toBe('');
  });
});

describe('formatTokens', () => {
  it('reads like a person would say it', () => {
    expect(formatTokens(840)).toBe('840');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(150000)).toBe('150k');
    expect(formatTokens(1200000)).toBe('1.2M');
  });
});

describe('conversationTokenEstimate', () => {
  const message = (uuid, parent, text, extra = {}) => ({ uuid, parent_message_uuid: parent, sender: 'human', content: [{ type: 'text', text }], ...extra });

  it('counts the branch being shown, not the branches left behind', () => {
    const data = {
      current_leaf_message_uuid: 'm-3',
      chat_messages: [
        message('m-1', 'root', 'a'.repeat(400)),
        message('m-2', 'm-1', 'b'.repeat(4000)), // an abandoned branch
        message('m-3', 'm-1', 'c'.repeat(800)),
      ],
    };
    expect(conversationTokenEstimate(data).tokens).toBe(300); // (400 + 800) / 4
  });

  it('adds the text of attachments', () => {
    const data = {
      current_leaf_message_uuid: 'm-1',
      chat_messages: [message('m-1', 'root', 'x'.repeat(40), { attachments: [{ extracted_content: 'y'.repeat(360) }] })],
    };
    expect(conversationTokenEstimate(data).tokens).toBe(100);
  });

  it('gives the share of a 200k window, capped at 100', () => {
    const big = { current_leaf_message_uuid: 'm-1', chat_messages: [message('m-1', 'root', 'z'.repeat(400000))] };
    expect(conversationTokenEstimate(big)).toEqual({ tokens: 100000, percent: 50 });
    const huge = { current_leaf_message_uuid: 'm-1', chat_messages: [message('m-1', 'root', 'z'.repeat(2000000))] };
    expect(conversationTokenEstimate(huge).percent).toBe(100);
  });
});
