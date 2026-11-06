# Agent notes — Rumble Chat Blocker

Brief context for automated or human helpers working in this repo.

## What this is

- **Chrome Manifest V3 extension**, no build step, no package manager.
- **Load for development:** point Chrome “Load unpacked” at this repository root (`manifest.json` must be valid **JSON** — no comments or leading `//` lines).
- **Scope:** `content.js` runs only on `https://rumble.com/*` and `https://*.rumble.com/*` (`manifest.json`).

## Architecture

| Piece | Role |
|-------|------|
| `popup.html` / `popup.js` | UI; reads/writes `chrome.storage.local` (`blockedUsers`, `blockedCount`, `blockedUserCounts`). Reset clears only `blockedCount`. |
| `content.js` | Finds chat rows, hides/shows matches, batched counter writes, `MutationObserver`, `chrome.storage.onChanged`. |
| Messages | None. Popup and Rumble tabs stay in sync through `chrome.storage.onChanged`. |

There is **no background service worker**. Saving from a non-Rumble active tab still updates storage; open Rumble tabs pick up `blockedUsers` via `chrome.storage.onChanged`.

## Rumble DOM coupling (main maintenance risk)

Filtering depends on Rumble’s live chat markup. Current selectors (verify on a live stream if blocking breaks):

- Container: `.chat-history`
- Rows: `li.chat-history--row.js-chat-history-item`
- Username: attribute `data-username`, fallback `.chat-history--username`

When Rumble changes HTML, fix selectors here first.

## Matching behavior

- Usernames are compared **case-insensitively** to the chat row author (`data-username` / `.chat-history--username` only).
- A block entry matches only when it equals that author username (after trimming and optional leading `@`). Message text and @mentions of a blocked name in someone else’s chat are not filtered.

## Conventions for changes

- Keep the diff small; avoid adding a bundler or test harness unless explicitly requested.
- **`manifest.json`**: strict JSON only. **`popup.html`**: must not start with non-HTML lines (e.g. `// filename` breaks parsing).
- **`permissions`**: currently only `storage`; avoid expanding permissions without a clear need.
- Icons live under `images/` (16, 48, 128); referenced from `manifest.json` and `action.default_icon`.

## Git / release

- `.gitignore` excludes `.crx`, `.pem`, and zip packs.
- No CI in repo; “test” = load unpacked on a Rumble livestream, save blocklist, confirm rows hide and counter moves.
