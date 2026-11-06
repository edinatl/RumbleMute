# Agent notes — Rumble Chat Blocker

Brief context for automated or human helpers working in this repo.

## What this is

- **Chrome Manifest V3 extension**, no build step, no package manager.
- **Load for development:** point Chrome “Load unpacked” at this repository root (`manifest.json` must be valid **JSON** — no comments or leading `//` lines).
- **Scope:** `content.js` runs only on `https://rumble.com/*` and `https://*.rumble.com/*` (`manifest.json`).

## Architecture

| Piece | Role |
|-------|------|
| `shared.js` | Loaded before `content.js` (content script) and by the popup. Username normalization (`normalizeEntry`, `countKey`), state normalization, the 3-way merge (`mergeAll`), and `createSync`, which writes storage. Exposed as `RCB`. |
| `content.js` | Finds chat rows, hides/shows matches, mute expiry, batched counter writes, `MutationObserver`, `chrome.storage.onChanged`. |
| `content.css` | Styles for the in-chat Block/Mute controls and hidden-row state. |
| `popup.html` / `popup.js` | UI for the block list, muted list, and settings. Reads/writes storage through `RCB` and `createSync`. |
| Messages | None. Popup and Rumble tabs stay in sync through `chrome.storage.onChanged`. |

There is **no background service worker**. Saving from a non-Rumble active tab still updates storage; open Rumble tabs pick up changes via `chrome.storage.onChanged`.

### Storage keys (`chrome.storage.local`)

- Synced state (in `RCB.STORAGE_FIELDS`): `blockedUsers`, `mutedUsers`, `blockedUserCounts`, `blockedCount`, `countedMessages`, `countResetNonce`.
- Settings: `filteringEnabled` (popup toggle; absent or `true` means on), `blockListSort` (popup sort mode).
- Sync advisory lock: `syncLock` (owner token), `syncLockUntil` (expiry ms). Advisory only: `createSync` takes it best-effort, and correctness comes from `mergeAll`, not the lock. Stale locks expire on their own.
- `countedMessages` de-duplicates hidden-message counts by message id, capped by `MAX_COUNTED`. `countResetNonce` marks a Reset so other tabs apply it.
- Synced state is written through `createSync` (read, merge against the last baseline, write, re-read). Don't write those keys directly from new code. Settings keys are written directly.

## Rumble DOM coupling (main maintenance risk)

Filtering depends on Rumble’s live chat markup. Current selectors (verify on a live stream if blocking breaks):

- Container: `.chat-history`
- Rows: `li.chat-history--row.js-chat-history-item`
- Username: attribute `data-username`, fallback `.chat-history--username`
- Message id: attribute `data-message-id` (19-digit numeric string; passes `RCB.sanitizeMessageId`). `concealRow()` uses it to de-duplicate hidden-message counts across re-renders and tabs. Rows lacking a valid id fall back to per-element `dataset.rcbCounted`, which can double-count re-rendered rows.
- Other row attributes seen (not used by the extension): `data-message-user-id`, `data-entity-type` (`user`), `data-video-fid`.

Verified 2026-11-05 on a live stream (Timcast IRL): all 54 rows had a unique `data-message-id`; none were missing. Only `data-entity-type="user"` rows were observed, so rants/system rows were not checked. Re-check if counts start double-incrementing.

When Rumble changes HTML, fix selectors here first.

## Matching behavior

- Usernames are compared **case-insensitively** to the chat row author (`data-username` / `.chat-history--username` only).
- A block or active mute entry matches only when it equals that author username (after trimming and optional leading `@`). Message text and @mentions of a blocked name in someone else’s chat are not filtered.

## Conventions for changes

- Keep the diff small; avoid adding a bundler or test harness unless explicitly requested.
- **`manifest.json`**: strict JSON only. **`popup.html`**: must not start with non-HTML lines (e.g. `// filename` breaks parsing).
- **`permissions`**: currently only `storage`; avoid expanding permissions without a clear need.
- Icons live under `images/` (16, 48, 128); referenced from `manifest.json` and `action.default_icon`.
- `images/icon-source.png` is the master icon artwork. It is not referenced by `manifest.json`, so it is not needed at runtime; exclude it when packaging if you want a smaller zip.

## Git / release

- `.gitignore` excludes `.crx`, `.pem`, and zip packs.
- No CI in repo; “test” = load unpacked on a Rumble livestream, save blocklist, confirm rows hide and counter moves.
