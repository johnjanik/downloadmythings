# DownloadMyThings

A free, open source browser extension for Chrome and Firefox that exports your own conversations and artifacts from claude.ai. Everything runs in your browser. There are no limits, no account and no server.

DownloadMyThings is an independent project. It is not affiliated with or endorsed by Anthropic.

## Status

Version 0.1.0 is the foundation release. It exports conversations and artifacts. Project export (knowledge files, instructions and a project's chats in one ZIP), PDF, attachments as files and scheduled backups are planned next.

## What it does today

- **Export one conversation** from the toolbar popup, as Markdown, JSON or plain text
- **Browse all conversations** in a searchable, sortable table, with project and model columns
- **Bulk export** all or selected conversations into one ZIP
- **Artifacts** kept inline, or extracted as separate files in nested or flat folders
- **Every branch** of a conversation is kept in the JSON export
- **Extended thinking** and metadata can be included or left out
- **Export tracking**: conversations that are new or changed since their last export are marked
- **Model history**: records which model each conversation started on, even after it is moved to a newer one
- **Backup and restore** of the extension's own data (export history, model history, preferences)
- **Light and dark themes**

## Privacy

- Your conversations are read from your own signed-in claude.ai session and saved straight to your Downloads folder.
- The only site the extension contacts is `claude.ai`. There is no analytics, no licence server and no install ID.
- Its site access is limited to `claude.ai`. No page of the extension is exposed to other websites.
- The source is public under the MIT licence, and release ZIPs are built reproducibly from a tagged commit, so a build can be checked against the code.

## Install

DownloadMyThings is not in the browser stores yet. To run it from source, see [docs/INSTALL.md](docs/INSTALL.md). The short version:

```bash
npm install
```

```bash
npm run build
```

Then load `dist/chrome` as an unpacked extension in Chrome, or `dist/firefox/manifest.json` as a temporary add-on in Firefox.

## Use

1. Sign in to claude.ai.
2. Click the DownloadMyThings icon.
3. **Export Current Conversation** saves the conversation in the open tab. **Browse All Conversations** opens the table, where you can search, select and export many at once.

The browse page talks to claude.ai directly, so it works without a claude.ai tab open. Your organization is detected automatically; if detection fails, set the Organization ID in the extension's options.

### Export formats

| Format | Contents |
| --- | --- |
| JSON | Everything the API returns, including every branch and all metadata |
| Markdown | The current branch, readable, with optional metadata, thinking and artifacts |
| Plain text | The current branch with `User:` and `Claude:` prefixes |

## Development

```
src/                 the extension, one copy for every browser
  lib/api.js         claude.ai client (direct calls, with a relay through an open tab as fallback)
  lib/exporter.js    builds export files and ZIPs
  lib/store.js       extension storage helpers
  lib/utils.js       Markdown and text conversion, artifacts, model names, backup, diagnostics
  vendor/            JSZip 3.10.1, unmodified
scripts/manifest.mjs the manifest for each browser, generated from one definition
scripts/build.mjs    copies src/ into dist/chrome and dist/firefox and writes each manifest
tests/               unit tests (Vitest) and an end-to-end smoke test
```

| Command | What it does |
| --- | --- |
| `npm run build` | Build `dist/chrome` and `dist/firefox` |
| `npm run package` | Build and also write a release ZIP for each browser |
| `npm run check` | Syntax, missing-file and remote-resource checks |
| `npm test` | Unit tests |
| `npm run test:e2e` | Loads the built Chrome extension in Chromium against a stand-in for claude.ai. Needs Playwright; see the note at the top of `tests/e2e/smoke.js` |

The version lives in `package.json` only. Files in `src/lib/` and `src/content.js` can be injected into a tab more than once, so they must not declare anything with `const`, `let` or `class` at the top level; a test enforces this.

The extension relies on claude.ai's internal web API, which is undocumented and can change without notice.

## Known limitations

- Markdown and plain text exports contain only the currently selected branch.
- The API reports only a conversation's current model. Model history starts from the first time the extension sees a conversation.
- Attachments are exported as the text claude.ai extracted from them, not as the original files.
- Large bulk exports are built in memory and can take several minutes.

## Credits and licence

MIT; see [LICENSE](LICENSE).

DownloadMyThings began as a fork of [Claude Exporter](https://github.com/agoramachina/claude-exporter) by agoramachina, which builds on [Claude Conversation Exporter](https://github.com/socketteer/Claude-Conversation-Exporter) by socketteer. It bundles [JSZip](https://stuk.github.io/jszip/) (MIT).
