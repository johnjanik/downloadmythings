# Privacy policy

DownloadMyThings is a browser extension that saves your own projects, chats and files from claude.ai to your computer. This page says what it reads, where it puts it, and what it never does.

## What it reads

When you use it, the extension reads from your signed-in claude.ai session, in your browser:

- your conversations, projects, project instructions, knowledge files and uploads, and account memory when claude.ai returns it
- your organization ID, which claude.ai's addresses require

## Where it goes

- Exports are written to your Downloads folder, or to the folder you chose for Sync to a folder.
- Nothing is sent to the developer or to anyone else. The only site the extension contacts is `claude.ai`. There is no server, no analytics, no advertising, no account and no install ID.

## What it keeps in the browser

The extension stores these on your computer, in its own browser storage:

- your settings, including the backup schedule
- when each conversation was last exported, and which model each conversation used, for the table view
- the organization ID
- a reference to the sync folder you chose
- if you switch on search inside messages: the text of your conversations, as a search index

Removing the extension removes all of it. Files already saved to your disk are yours and stay where they are.

## Permissions

| Permission | Why |
| --- | --- |
| Access to `claude.ai` | To read your own data from your signed-in session |
| `storage` | Settings and the items listed above |
| `tabs` | To see which conversation or project is open in the current tab, and to open the extension's own pages |
| `scripting` (Chrome) | To add the download button to claude.ai pages that were open before the extension was installed or updated |
| `sidePanel` (Chrome) | To open the panel as a side panel |
| `alarms` | To run automatic backups on the schedule you set |

## Changes and contact

Changes to this policy are made in this file, with their history, in the public repository. Questions and reports: [open an issue](https://github.com/johnjanik/downloadmythings/issues).

DownloadMyThings is an independent project. It is not affiliated with or endorsed by Anthropic.
