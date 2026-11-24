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
2. Click the DownloadMyThings icon and choose **Browse All Conversations**, or open a conversation and choose **Export Current Conversation**.

Your organization is detected automatically. If you see "Could not find your organization", open the extension's options and paste the Organization ID from [claude.ai/settings/account](https://claude.ai/settings/account).

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| "claude.ai returned HTTP 401" or "HTTP 403" | Sign in to claude.ai in this browser, then reload the page. A VPN can also cause 403 responses |
| The popup says "Open a conversation on claude.ai first" | The active tab must be a conversation, at an address like `claude.ai/chat/...` |
| Nothing downloads | Check that the browser is not blocking multiple downloads from the page |
| Something else | Options, then **attach a diagnostics file**, and [open an issue](https://github.com/johnjanik/downloadmythings/issues). The file holds versions, counts and recent errors, with all IDs removed |

## Browser differences

The same source builds both targets. Chrome gets a Manifest V3 extension with a service worker; Firefox gets Manifest V2 with a background page. `scripts/manifest.mjs` holds the differences.
