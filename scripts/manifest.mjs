// The extension manifest for each browser, generated from one definition.
// Chrome gets Manifest V3; Firefox gets Manifest V2 (its long-supported form).
// The version comes from package.json, so it is set in exactly one place.

export const TARGETS = ['chrome', 'firefox'];

// Firefox add-on ID. It identifies the add-on on addons.mozilla.org and must
// never change once a version has been published.
export const FIREFOX_ADDON_ID = '{a419207e-b68e-4339-a2d2-dd10cca238bd}';

const CLAUDE_HOST = 'https://claude.ai/*';
const PANEL_PAGE = 'panel.html';

const ICONS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

// Loaded into claude.ai tabs, in this order. background.js reads the same list
// from the built manifest when it has to inject the scripts itself.
export const CONTENT_SCRIPTS = [
  'vendor/jszip.min.js',
  'lib/i18n.js',
  'lib/utils.js',
  'lib/store.js',
  'lib/api.js',
  'lib/files.js',
  'lib/exporter.js',
  'lib/projects.js',
  'page-button.js',
  'content.js',
];

// English text the manifest shows. The build translates it like every other
// string and the manifest refers to it by name (see scripts/i18n.mjs).
const DESCRIPTION = 'Download your projects, chats and files from claude.ai. Free, local and open source.';
export const MANIFEST_STRINGS = [DESCRIPTION];

export function buildManifest(target, version) {
  const shared = {
    name: 'DownloadMyThings',
    version,
    description: '__MSG_extDescription__',
    default_locale: 'en',
    icons: ICONS,
    content_scripts: [
      { matches: [CLAUDE_HOST], js: CONTENT_SCRIPTS },
    ],
  };
  // The panel page is the toolbar popup and, where the browser has one, the
  // side panel. background.js switches between the two (see applyDisplayMode).
  const toolbarButton = { default_popup: PANEL_PAGE, default_icon: ICONS };

  if (target === 'chrome') {
    return {
      manifest_version: 3,
      ...shared,
      permissions: ['storage', 'scripting', 'tabs', 'sidePanel', 'alarms'],
      host_permissions: [CLAUDE_HOST],
      action: toolbarButton,
      side_panel: { default_path: PANEL_PAGE },
      background: { service_worker: 'background.js' },
      options_page: 'options.html',
    };
  }

  if (target === 'firefox') {
    return {
      manifest_version: 2,
      ...shared,
      permissions: ['storage', 'tabs', 'alarms', CLAUDE_HOST],
      browser_action: toolbarButton,
      sidebar_action: {
        default_title: 'DownloadMyThings',
        default_panel: PANEL_PAGE,
        default_icon: ICONS,
        open_at_install: false,
      },
      background: { scripts: ['background.js'] },
      options_ui: { page: 'options.html', open_in_tab: true },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: '79.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    };
  }

  throw new Error(`Unknown build target: ${target}`);
}
