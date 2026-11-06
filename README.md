# RumbleMute

Chrome extension (Manifest V3) that hides chat messages from specific usernames on [Rumble](https://rumble.com) livestreams.

## Features

- Permanently block a username from the popup or from **Block** on a chat row
- Mute someone for a set time from **Mute** on a chat row, then unmute from the popup or let it expire
- Exact, case-insensitive username match after trimming and an optional leading `@`
- Only that person's own chat rows are hidden. Message text and @mentions in someone else's chat are left alone
- The number beside a name counts how many of their messages have been hidden. Blocks and mutes share that counter, and the total
- Pause filtering (**Disabled**) shows every row again and leaves both lists in place
- Blocklist, mutes, and counters stay in `chrome.storage.local` on this machine

## Install

From the Chrome Web Store (link coming once published), or load it unpacked:

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.

## Usage

1. Open a Rumble livestream with chat visible.
2. Click the extension icon and add a username, or use **Paste a list** for several names. Each name added here is a permanent block. **Add** saves it immediately.
3. On a chat row, hover the username (or focus the row) and choose **Block** or **Mute**. Mute offers 5, 15, or 30 minutes, 1, 2, 6, 12, or 24 hours, or a custom number of minutes.
4. While the header says **Active**, rows from blocked users and unexpired mutes hide. **Disabled** shows everyone.
5. Open **Muted** in the popup to see who is timed out, how long is left, and **Unmute** (one click). The remaining time ticks while the popup is open.
6. A mute ends when its time is up while a Rumble tab or this popup is open. An open Rumble tab brings those rows back, deletes that person's hidden-message count, and shows one short notice on the page. There is no background worker, so a mute stays in place until one of those is open.
7. Remove a permanent block from the popup with two clicks (the second confirms). Reset clears only the total hidden-message counter.
8. If you save while the active tab is not Rumble, storage still updates. Open Rumble tabs pick it up from there.

A person is on at most one list. Blocking someone who is muted drops the mute. Muting someone who is blocked drops the permanent block.

## Project layout

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV3) |
| `shared.js` | Username normalization, state merging, and storage sync shared by the popup and content script |
| `content.js` | Chat observer, in-chat block and mute, filtering, and mute expiry on `*.rumble.com` |
| `content.css` | Styles for the in-chat Block and Mute controls and hidden rows |
| `popup.html` / `popup.js` | Block list, muted list, and `chrome.storage.local` |
| `images/` | Extension icons (16, 48, 128). `icon-source.png` is the master artwork and is not packaged |

## Permissions and privacy

- `storage`: saves the block list, timed mutes, and counters locally on your machine.
- Runs only on `rumble.com` pages.

No network access, analytics, or remote code. Nothing is synced or sent anywhere. See [PRIVACY.md](PRIVACY.md).

## Packaging for the Chrome Web Store

The extension has no build step. Build the upload zip from the committed runtime files only:

```bash
git archive --format=zip -o rumblemute.zip HEAD manifest.json shared.js content.js content.css popup.html popup.js images/icon16.png images/icon48.png images/icon128.png
```

Bump `version` in `manifest.json` before each upload. Dashboard text (single purpose, permission justifications) is in [STORE_LISTING.md](STORE_LISTING.md).

## License

[MIT](LICENSE)
