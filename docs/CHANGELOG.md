# Changelog

## [0.1.0] - 2026-11-24

First release as DownloadMyThings. Forked from Claude Exporter 1.10.17 and diverged from it. For the history before the fork, see the [Claude Exporter changelog](https://github.com/agoramachina/claude-exporter/blob/main/docs/CHANGELOG.md).

### Changed

- Renamed to DownloadMyThings, with a new icon and a new Firefox add-on ID. Export, backup and diagnostics files are now named `downloadmythings-*`. Backups made by Claude Exporter still import.
- One source tree (`src/`) now builds both the Chrome and the Firefox extension. The version is set in `package.json` only.
- The browse page, popup and options page call claude.ai directly, so the browse page no longer needs a claude.ai tab to be open. If a direct call is refused, the request is relayed through an open claude.ai tab as before.
- The popup and the browse page share one export implementation. Bulk exports from the popup now fetch three conversations at a time, like the browse page.
- Bug reports go to the project's GitHub issues. The upstream author's contact and donation links were removed.

### Fixed

- Includes the fixes from Claude Exporter's unreleased 1.10.18 to 1.10.24: safe and unique export filenames, a Firefox fix for cancelled downloads, model names for any model family, and conversation dates in model snapshots.
- When a claude.ai tab does not answer the popup (for example, it was open before the extension was installed), the popup now injects the content script and retries, instead of failing with a connection error.
- "Export All" from the popup now honours the Extended Thinking checkbox.
- With "Chats" off and an artifact option on, a conversation with no artifacts is now skipped. Before, a single export saved the chat anyway.
- "Export All" with nothing selected to export now says so at once, instead of fetching every conversation first.

### Security

- Extension pages are no longer exposed to websites (`web_accessible_resources` removed).
- The popup's status line is built from text, never from HTML.
- GitHub Actions are pinned to commit hashes, and release ZIPs are reproducible.
