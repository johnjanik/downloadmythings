# Publishing DownloadMyThings

A release has two halves. The first is automated: pushing a tag builds both browsers, runs the checks and attaches the ZIPs to a GitHub release. The second, submitting to the browser stores, is done by hand, because each store needs a developer account and a first listing that only the owner can create.

Store forms and rules change. Treat the answers below as a prepared draft and read each form as you fill it in.

## 1. Cut a release

1. Set the version in `package.json` (and `package-lock.json`), add a `docs/CHANGELOG.md` entry, and merge to `main`.
2. Tag the commit on `main` and push the tag:

```bash
git tag v0.3.0
```

```bash
git push origin v0.3.0
```

The Release workflow refuses a tag that does not match `package.json` or is not on `main`. It publishes `downloadmythings-chrome-<version>.zip`, `downloadmythings-firefox-<version>.zip` and `SHA256SUMS.txt`. The ZIPs are reproducible: `npm run package` on the same commit gives the same bytes.

## 2. Before the first submission

- [ ] Run the extension on a real claude.ai account in Chrome and in Firefox. The Firefox build has passed Mozilla's linter but has not been run in Firefox.
- [ ] Take screenshots at 1280x800: the panel on a project, the Library, the Backups card, an unzipped project with its manifest.
- [ ] Decide the support contact shown in the stores. Each store publishes the developer's contact email.
- [ ] Privacy policy address: `https://github.com/johnjanik/downloadmythings/blob/main/docs/PRIVACY.md`

## 3. Listing text

**Name**: DownloadMyThings

**Summary** (fits Chrome's 132 characters):

> Save your own projects, chats and files from claude.ai to your computer. Free and open source. Nothing leaves your browser.

**Description**:

> DownloadMyThings saves your own work from claude.ai to your computer. It is free, open source and has no limits.
>
> - Whole projects: instructions, knowledge files and chats in one ZIP, or just the files, or just the chats
> - Export everything: every project and every chat in the account in one action
> - Chats as Markdown, JSON, plain text or PDF, with uploads saved as real files
> - Sync to a folder: an incremental copy of the whole account that rewrites only what changed (Chrome and Edge)
> - Backups on demand, or automatically every day or week
> - A Library of every chat, with search inside messages from an index kept on your computer
> - A manifest in every project ZIP that says how faithful each file is, with a SHA-256
> - Works from any tab, as a side panel or a popup
>
> Privacy: everything runs in your browser. The only site the extension contacts is claude.ai. There is no server, no analytics and no account.
>
> Source code: https://github.com/johnjanik/downloadmythings
>
> DownloadMyThings is an independent project. It is not affiliated with or endorsed by Anthropic. It relies on claude.ai's internal web interface, which can change without notice.

**Category**: Productivity (Chrome: Tools or Workflow and planning)

The name does not contain another company's mark. The description names claude.ai only to say which site the extension works with, and carries the non-affiliation line.

## 4. Chrome Web Store

Needs a Chrome Web Store developer account, which has a small one-time registration fee. Upload `downloadmythings-chrome-<version>.zip`.

**Single purpose**: Saves the signed-in user's own projects, chats and files from claude.ai to their computer.

**Permission justifications**:

| Permission | Justification |
| --- | --- |
| Host access to `https://claude.ai/*` | Reads the user's own conversations, projects and files from their signed-in session so they can be saved to disk. No other site is accessed |
| `storage` | Stores settings, export history, the backup schedule and, if the user switches it on, a local search index |
| `tabs` | Reads the address of the current tab to show the conversation or project open there, and opens the extension's own pages for long exports and scheduled backups |
| `scripting` | Adds the download button to claude.ai tabs that were open before the extension was installed or updated |
| `sidePanel` | Opens the extension's panel as a side panel |
| `alarms` | Runs the automatic daily or weekly backup the user sets up |

**Remote code**: No. All code ships in the package. The two bundled libraries (JSZip 3.10.1, marked 18.3.0) are byte for byte the npm releases; `tests/vendor.test.js` pins their hashes.

**Data use**: The extension handles website content and personal communications (the user's own conversations) on the user's device only, to save them to the user's disk. Nothing is transmitted to the developer or any third party, sold, or used for any other purpose. Fill in the data-use form to match and certify the three statements at its end.

## 5. Firefox Add-ons

Needs a free Firefox account at addons.mozilla.org. Upload `downloadmythings-firefox-<version>.zip` as a listed add-on.

- The manifest already carries the add-on ID and declares that no data is collected (`data_collection_permissions: none`).
- **Source code**: the package is the source. No bundler or minifier is run on our own code.
- **Notes to reviewer**: "Built with `npm ci && npm run package` from the tagged commit; the build copies `src/` and writes the manifest. `vendor/jszip.min.js` is JSZip 3.10.1 and `vendor/marked.umd.js` is marked 18.3.0, unmodified from npm, with SHA-256 hashes pinned in `tests/vendor.test.js`. The extension contacts only claude.ai and needs a signed-in claude.ai account to test."
- Sync to a folder does not appear in Firefox, which has no folder access for extensions.

## 6. Microsoft Edge Add-ons

Needs a free Partner Center developer account. Upload the Chrome ZIP unchanged; Edge runs the same Manifest V3 package. Reuse the listing text and the permission justifications above.

## 7. After the first listing

- Each store assigns its own ID on first submission. Once they exist, uploads can be added to the Release workflow (Chrome Web Store API, `web-ext sign` for Firefox, the Edge Add-ons API) with the credentials stored as repository secrets. That step is not built yet, because it cannot be written or tested without the IDs and accounts.
- Update `README.md` and `docs/INSTALL.md` with the store links.

## 8. Translations

The interface is English only. Nothing has been translated yet. The plan is to move every string into `_locales/en/messages.json`, then add languages, after the phase 5 features have settled so the text is translated once.
