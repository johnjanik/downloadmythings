# DownloadMyThings

A free, open source browser extension for Chrome and Firefox that downloads your own projects, chats and files from claude.ai. Everything runs in your browser. There are no limits, no account and no server.

DownloadMyThings is an independent project. It is not affiliated with or endorsed by Anthropic.

## What it does

- **Whole projects**: instructions, knowledge files, the project's chats and artifacts in one ZIP, or just the files, or just the chats
- **Export everything**: every project and every other chat in the account in one action, split into several ZIP files when the account is large
- **Chats** as Markdown, JSON (every branch), plain text or PDF, with uploads and pasted text saved as real files if you want them
- **A manifest in every project ZIP** that says how faithful each file is: original, PDF rendition, extracted text, preview or missing, with a SHA-256. A file claude.ai will not serve is reported, never dropped silently
- **Library**: every chat in the account with its project and date, searchable, with select and export
- **Files and Chats explorer** for a project, with a download button on each row
- **Works from any tab**: the panel shows the conversation or project open in the current tab, and lets you pick one when there is none
- **Side panel or popup**: your choice, switched at the bottom of the panel
- **A download button on claude.ai's own pages**, which you can turn off
- **Export tracking** and **model history** on the table view

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

1. Sign in to claude.ai in the same browser.
2. Click the DownloadMyThings icon. It opens the panel, as a side panel where the browser has one.
3. On the **Export** tab, the panel shows the project or conversation open in the current tab. On any other tab, pick a project from the list. Then:
   - **Download Entire Project** saves instructions, files and chats in one ZIP.
   - **Download All Files** and **Download All Chats** save one part each.
   - **Export everything** saves the whole account.
4. On the **Library** tab, search your chats, tick some, and export them.

**Export settings** (under the project buttons) set the ZIP name, whether knowledge files keep their format or are saved as Markdown text, the chat format, a date range for chats, and whether to include chat attachments.

The switch at the bottom of the panel chooses between **Side panel** and **Popup**. Which side of the window the side panel sits on is a browser setting, not something the extension controls. A long export started from the popup moves to its own tab, because a popup closes as soon as you click elsewhere.

**Table view** (linked at the bottom of the panel) is the full-width table of all conversations and projects, with sorting, model history and export tracking.

### What a project ZIP contains

```
instructions.md         the project's custom instructions
files/                  knowledge files
chats/                  one transcript per conversation
artifacts/<chat>/       artifacts as files, when that option is on
attachments/<chat>/     uploads and pasted text, when that option is on
manifest.json           what was saved, from where, how faithful, with hashes
```

### Chat formats

| Format | Contents |
| --- | --- |
| Markdown | The current branch, readable, with optional metadata, thinking and artifacts |
| JSON | Everything the API returns, including every branch and all metadata |
| Plain text | The current branch with `User:` and `Claude:` prefixes |
| PDF | Opens a print view; choose "Save as PDF". Single chats, or several as one document |

## Development

```
src/                 the extension, one copy for every browser
  panel.html/js      the main interface: toolbar popup, side panel and tab in one page
  browse.html/js     the full table view
  print.html/js      the print view behind PDF export
  page-button.js     the download button on claude.ai pages
  theme.css          design tokens; every page reads its colours from here
  lib/api.js         claude.ai client (direct calls, with a relay through an open tab as fallback)
  lib/files.js       file downloads and the fidelity record
  lib/exporter.js    chat exports and ZIPs
  lib/projects.js    project export
  lib/account.js     export everything
  lib/store.js       extension storage helpers
  lib/utils.js       Markdown and text conversion, artifacts, model names, backup, diagnostics
  vendor/            JSZip 3.10.1 and marked 18.3.0, byte for byte from npm
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

- The project and file endpoints are claude.ai's internal ones. They are undocumented and can change without notice.
- Word files usually come back as the text claude.ai extracted, and images sometimes as a preview. The manifest says which.
- Binary files Claude generated in its sandbox are not exported yet. Text files it created are, as artifacts.
- Memory is included in Export everything only when claude.ai returns it. Styles are not exported yet.
- Exports are built in memory. Export everything starts a new ZIP file every 256 MB.
- Markdown and plain text exports contain only the currently selected branch.
- The Firefox build is checked with Mozilla's linter but has not been run in Firefox.

## Credits and licence

MIT; see [LICENSE](LICENSE).

DownloadMyThings began as a fork of [Claude Exporter](https://github.com/agoramachina/claude-exporter) by agoramachina, which builds on [Claude Conversation Exporter](https://github.com/socketteer/Claude-Conversation-Exporter) by socketteer. It bundles [JSZip](https://stuk.github.io/jszip/) and [marked](https://marked.js.org/) (both MIT). The colours and style follow the PracticallyZen design tokens.
