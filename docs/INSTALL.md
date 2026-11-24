# Installing DownloadMyThings

DownloadMyThings is not in the browser stores yet, so it is installed from source. You need [Node.js](https://nodejs.org/) 22 or newer.

## 1. Build

```bash
git clone https://github.com/johnjanik/downloadmythings.git
```

```bash
cd downloadmythings
```

```bash
npm install
```

```bash
npm run build
```

This writes `dist/chrome` and `dist/firefox`.

## 2. Load it

### Chrome, Edge, Brave and other Chromium browsers

1. Open `chrome://extensions` (in Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/chrome` folder.

After you rebuild, click the reload icon on the extension's card.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Choose `dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox closes. A signed build that stays installed will come with the first store release.

## 3. First run

1. Sign in to claude.ai in the same browser.
2. Click the DownloadMyThings icon. The panel opens, as a side panel where the browser has one. It shows the project or conversation in the current tab, or lets you pick a project.

Your organization is detected automatically. If you see "Could not find your organization", open the extension's options and paste the Organization ID from [claude.ai/settings/account](https://claude.ai/settings/account).

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| "claude.ai returned HTTP 401" or "HTTP 403" | Sign in to claude.ai in this browser, then reload the page. A VPN can also cause 403 responses |
| The panel says "Sign in to claude.ai" | Sign in on claude.ai in this browser, then press the refresh button on the project card |
| The toolbar button does nothing | Switch "Open as" to Popup at the bottom of the panel, or open the panel from the browser's side panel menu |
| Nothing downloads | Check that the browser is not blocking multiple downloads from the page |
| "Sync to a folder" is missing | It needs Chrome or Edge. Firefox does not give extensions access to a folder |
| Sync says it needs permission again | The browser withdraws folder access from time to time. Press **Sync now** and allow it |
| An automatic backup did not run | The browser must be open. A missed run happens about a minute after the browser next starts. The Backups card shows the last run and its result |
| Something else | Options, then **attach a diagnostics file**, and [open an issue](https://github.com/johnjanik/downloadmythings/issues). The file holds versions, counts and recent errors, with all IDs removed |

## Browser differences

The same source builds both targets. Chrome gets a Manifest V3 extension with a service worker; Firefox gets Manifest V2 with a background page. `scripts/manifest.mjs` holds the differences.
