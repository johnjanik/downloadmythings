import { describe, it, expect } from 'vitest';
import exporter from '../src/lib/exporter.js';

const {
  fileDateStamp,
  normalizeExportOptions,
  isNothingToExport,
  renderConversation,
  buildConversationExport,
  buildBulkEntries,
  planBulkConversation,
  bulkAttachmentPrefix,
  countAttachmentRecords,
  bulkZipFilename,
} = exporter;

// A two-message conversation; the assistant reply carries one artifact.
function conversation({ name = 'Trip plan', withArtifact = true } = {}) {
  const artifact = withArtifact
    ? '<antArtifact identifier="a1" type="application/vnd.ant.code" language="python" title="packing list">print("socks")</antArtifact>'
    : '';
  return {
    uuid: 'c-1',
    name,
    model: 'claude-sonnet-4-6',
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-01T10:05:00Z',
    current_leaf_message_uuid: 'm-2',
    chat_messages: [
      { uuid: 'm-1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: 'What should I pack?' }] },
      { uuid: 'm-2', parent_message_uuid: 'm-1', sender: 'assistant', content: [{ type: 'text', text: `Here is a list. ${artifact}` }] },
    ],
  };
}

const paths = (entries) => entries.map((entry) => entry.path);

describe('normalizeExportOptions', () => {
  it('defaults to JSON with chats included and everything else off', () => {
    expect(normalizeExportOptions(undefined)).toEqual({
      format: 'json',
      includeChats: true,
      includeThinking: false,
      includeMetadata: false,
      includeArtifacts: false,
      extractArtifacts: false,
      flattenArtifacts: false,
      artifactFormat: 'original',
      includeAttachments: false,
    });
  });

  it('falls back to JSON for an unknown format', () => {
    expect(normalizeExportOptions({ format: 'docx' }).format).toBe('json');
  });

  it('treats only an explicit false as "chats off"', () => {
    expect(normalizeExportOptions({ includeChats: undefined }).includeChats).toBe(true);
    expect(normalizeExportOptions({ includeChats: false }).includeChats).toBe(false);
  });
});

describe('isNothingToExport', () => {
  it('is true only when chats and both artifact file options are off', () => {
    expect(isNothingToExport({ includeChats: false })).toBe(true);
    expect(isNothingToExport({ includeChats: false, extractArtifacts: true })).toBe(false);
    expect(isNothingToExport({ includeChats: false, flattenArtifacts: true })).toBe(false);
    expect(isNothingToExport({ includeChats: false, includeAttachments: true })).toBe(false);
    expect(isNothingToExport({})).toBe(false);
  });
});

describe('renderConversation', () => {
  it('renders each format with the matching extension and type', () => {
    const data = conversation();
    expect(renderConversation(data, 'c-1', { format: 'markdown' })).toMatchObject({ ext: 'md', type: 'text/markdown' });
    expect(renderConversation(data, 'c-1', { format: 'text' })).toMatchObject({ ext: 'txt', type: 'text/plain' });
    const json = renderConversation(data, 'c-1', { format: 'json' });
    expect(json).toMatchObject({ ext: 'json', type: 'application/json' });
    expect(JSON.parse(json.content).uuid).toBe('c-1');
  });
});

describe('buildConversationExport (one conversation)', () => {
  it('produces a single file when no artifact files are requested', () => {
    const result = buildConversationExport(conversation(), 'c-1', { format: 'markdown' });
    expect(result).toMatchObject({ kind: 'file', filename: 'Trip plan.md', type: 'text/markdown', artifactCount: 0 });
    expect(result.content).toContain('What should I pack?');
  });

  it('prefers the display name, then the conversation name, then the ID', () => {
    expect(buildConversationExport(conversation(), 'c-1', {}, 'Shown name').filename).toBe('Shown name.json');
    expect(buildConversationExport(conversation({ name: '' }), 'c-1', {}).filename).toBe('c-1.json');
  });

  it('makes the conversation name safe for a filename', () => {
    const result = buildConversationExport(conversation({ name: 'a/b: c?' }), 'c-1', { format: 'text' });
    expect(result.filename).toBe('a_b_ c_.txt');
  });

  it('nested artifacts: chat at the root, artifacts in artifacts/', () => {
    const result = buildConversationExport(conversation(), 'c-1', { format: 'markdown', extractArtifacts: true });
    expect(result).toMatchObject({ kind: 'zip', filename: 'Trip plan.zip', artifactCount: 1 });
    expect(paths(result.entries)).toEqual(['Trip plan.md', 'artifacts/packing list.py']);
  });

  it('nested artifacts without chats: artifacts at the root', () => {
    const result = buildConversationExport(conversation(), 'c-1', { includeChats: false, extractArtifacts: true });
    expect(paths(result.entries)).toEqual(['packing list.py']);
  });

  it('flat artifacts: Chats/ and Artifacts/ with a name prefix', () => {
    const result = buildConversationExport(conversation(), 'c-1', { format: 'text', flattenArtifacts: true });
    expect(paths(result.entries)).toEqual(['Chats/Trip plan.txt', 'Artifacts/Trip plan_packing list.py']);
  });

  it('nested wins when both artifact options are on', () => {
    const result = buildConversationExport(conversation(), 'c-1', { extractArtifacts: true, flattenArtifacts: true });
    expect(paths(result.entries)).toEqual(['Trip plan.json', 'artifacts/packing list.py']);
  });

  it('falls back to a single file when artifact files are requested but none exist', () => {
    const result = buildConversationExport(conversation({ withArtifact: false }), 'c-1', { format: 'markdown', extractArtifacts: true });
    expect(result).toMatchObject({ kind: 'file', filename: 'Trip plan.md' });
  });

  it('reports "no artifacts" instead of exporting a chat the user switched off', () => {
    const result = buildConversationExport(conversation({ withArtifact: false }), 'c-1', { includeChats: false, extractArtifacts: true });
    expect(result.kind).toBe('empty');
    expect(result.error).toMatch(/No artifacts/);
  });

  it('reports "nothing to export" when every output is switched off', () => {
    const result = buildConversationExport(conversation(), 'c-1', { includeChats: false });
    expect(result.kind).toBe('empty');
    expect(result.error).toMatch(/Nothing to export/);
  });
});

describe('buildBulkEntries (one conversation inside a bulk ZIP)', () => {
  const conv = { uuid: 'c-1', name: 'Trip plan' };

  it('adds one file at the root when no artifact files are requested', () => {
    const entries = buildBulkEntries(conversation(), conv, { format: 'markdown' }, new Set());
    expect(paths(entries)).toEqual(['Trip plan.md']);
  });

  it('nested: a folder per conversation with an artifacts/ subfolder', () => {
    const entries = buildBulkEntries(conversation(), conv, { format: 'markdown', extractArtifacts: true }, new Set());
    expect(paths(entries)).toEqual(['Trip plan/Trip plan.md', 'Trip plan/artifacts/packing list.py']);
  });

  it('nested without chats: artifacts directly in the conversation folder', () => {
    const entries = buildBulkEntries(conversation(), conv, { includeChats: false, extractArtifacts: true }, new Set());
    expect(paths(entries)).toEqual(['Trip plan/packing list.py']);
  });

  it('flat: shared Chats/ and Artifacts/ folders', () => {
    const entries = buildBulkEntries(conversation(), conv, { format: 'text', flattenArtifacts: true }, new Set());
    expect(paths(entries)).toEqual(['Chats/Trip plan.txt', 'Artifacts/Trip plan_packing list.py']);
  });

  it('skips a conversation with no artifacts when chats are off', () => {
    const entries = buildBulkEntries(conversation({ withArtifact: false }), conv, { includeChats: false, flattenArtifacts: true }, new Set());
    expect(entries).toEqual([]);
  });

  it('keeps same-titled conversations apart', () => {
    const used = new Set();
    const first = buildBulkEntries(conversation(), conv, {}, used);
    const second = buildBulkEntries(conversation(), { uuid: 'c-2', name: 'Trip plan' }, {}, used);
    expect(paths(first)).toEqual(['Trip plan.json']);
    expect(paths(second)).toEqual(['Trip plan (2).json']);
  });

  it('uses the conversation ID when the title is empty', () => {
    const entries = buildBulkEntries(conversation(), { uuid: 'c-9', name: '' }, { format: 'text' }, new Set());
    expect(paths(entries)).toEqual(['c-9.txt']);
  });
});

describe('attachments in a bulk ZIP', () => {
  it('reports the name a conversation was filed under', () => {
    const used = new Set(['trip plan']);
    const plan = planBulkConversation(conversation(), { uuid: 'c-1', name: 'Trip plan' }, {}, used);
    expect(plan.name).toBe('Trip plan (2)');
    expect(paths(plan.entries)).toEqual(['Trip plan (2).json']);
  });

  it('reports no name when the conversation added nothing', () => {
    const plan = planBulkConversation(conversation({ withArtifact: false }), { uuid: 'c-1', name: 'Trip plan' }, { includeChats: false, includeAttachments: true }, new Set());
    expect(plan).toEqual({ name: null, entries: [] });
  });

  it('places attachments to match the artifact layout', () => {
    expect(bulkAttachmentPrefix({}, 'Trip plan')).toBe('attachments/Trip plan/');
    expect(bulkAttachmentPrefix({ extractArtifacts: true }, 'Trip plan')).toBe('Trip plan/attachments/');
    expect(bulkAttachmentPrefix({ flattenArtifacts: true }, 'Trip plan')).toBe('Attachments/Trip plan_');
  });

  it('counts saved and missing attachments', () => {
    expect(countAttachmentRecords([{ fidelity: 'original' }, { fidelity: 'preview' }, { fidelity: 'missing' }])).toEqual({ saved: 2, missing: 1 });
    expect(countAttachmentRecords([])).toEqual({ saved: 0, missing: 0 });
  });
});

describe('filenames', () => {
  const when = new Date(2026, 10, 24, 14, 30, 45); // local time, as fileDateStamp reads it

  it('stamps local date and time', () => {
    expect(fileDateStamp(when)).toBe('20261124-143045');
  });

  it('names the bulk ZIP after its contents', () => {
    expect(bulkZipFilename({}, when)).toBe('downloadmythings-export-20261124-143045.zip');
    expect(bulkZipFilename({ includeChats: false, flattenArtifacts: true }, when))
      .toBe('downloadmythings-artifacts-20261124-143045.zip');
  });
});
