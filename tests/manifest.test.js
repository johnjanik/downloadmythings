import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifest, CONTENT_SCRIPTS, FIREFOX_ADDON_ID, TARGETS } from '../scripts/manifest.mjs';

const srcDir = path.resolve(import.meta.dirname, '..', 'src');
const chrome = buildManifest('chrome', '1.2.3');
const firefox = buildManifest('firefox', '1.2.3');

describe('manifests', () => {
  it('builds Manifest V3 for Chrome and Manifest V2 for Firefox', () => {
    expect(TARGETS).toEqual(['chrome', 'firefox']);
    expect(chrome.manifest_version).toBe(3);
    expect(firefox.manifest_version).toBe(2);
  });

  it('gives both browsers the same name, version and description', () => {
    for (const key of ['name', 'version', 'description']) {
      expect(firefox[key]).toBe(chrome[key]);
    }
    expect(chrome.version).toBe('1.2.3');
  });

  it('keeps "Claude" out of the product name', () => {
    expect(chrome.name).toBe('DownloadMyThings');
    expect(chrome.name.toLowerCase()).not.toContain('claude');
  });

  it('only asks for access to claude.ai', () => {
    expect(chrome.host_permissions).toEqual(['https://claude.ai/*']);
    expect(firefox.permissions.filter((p) => p.includes('://'))).toEqual(['https://claude.ai/*']);
    expect(chrome.content_scripts[0].matches).toEqual(['https://claude.ai/*']);
  });

  it('asks for no permission beyond the known set', () => {
    expect(chrome.permissions).toEqual(['activeTab', 'storage', 'scripting', 'tabs', 'sidePanel', 'alarms']);
    expect(firefox.permissions).toEqual(['activeTab', 'storage', 'tabs', 'alarms', 'https://claude.ai/*']);
  });

  it('exposes no extension page to websites', () => {
    expect(chrome.web_accessible_resources).toBeUndefined();
    expect(firefox.web_accessible_resources).toBeUndefined();
    expect(chrome.externally_connectable).toBeUndefined();
  });

  it('uses our own Firefox add-on ID, not the upstream one', () => {
    expect(firefox.browser_specific_settings.gecko.id).toBe(FIREFOX_ADDON_ID);
    expect(FIREFOX_ADDON_ID).not.toBe('{25798758-c184-470a-bb5b-9fa76a09d9b5}');
  });

  it('declares that no data is collected', () => {
    expect(firefox.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  it('loads the shared libraries before the content script that uses them', () => {
    expect(chrome.content_scripts[0].js).toEqual(CONTENT_SCRIPTS);
    expect(CONTENT_SCRIPTS.at(-1)).toBe('content.js');
    for (const file of CONTENT_SCRIPTS) {
      expect(existsSync(path.join(srcDir, file)), file).toBe(true);
    }
  });

  it('offers the same panel page as popup and as side panel in both browsers', () => {
    expect(chrome.action.default_popup).toBe('panel.html');
    expect(chrome.side_panel).toEqual({ default_path: 'panel.html' });
    expect(firefox.browser_action.default_popup).toBe('panel.html');
    expect(firefox.sidebar_action.default_panel).toBe('panel.html');
    expect(firefox.sidebar_action.open_at_install).toBe(false);
  });

  it('rejects an unknown browser', () => {
    expect(() => buildManifest('safari', '1.0.0')).toThrow(/Unknown build target/);
  });
});

describe('scripts that may be injected twice', () => {
  // A second injection of a script with a top-level const/let/class throws
  // "already declared" and leaves the tab running stale code.
  it('declare nothing with const, let or class at the top level', () => {
    for (const file of CONTENT_SCRIPTS.filter((f) => !f.startsWith('vendor/'))) {
      const offending = readFileSync(path.join(srcDir, file), 'utf8')
        .split('\n')
        .filter((line) => /^(const|let|class)\s/.test(line));
      expect(offending, file).toEqual([]);
    }
  });
});
