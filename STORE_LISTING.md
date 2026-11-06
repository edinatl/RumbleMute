# Chrome Web Store submission notes

Text to paste into the Developer Dashboard. Not shipped in the extension package.

## Single purpose

Hide chat messages from specific usernames, blocked permanently or muted for a set time, in Rumble livestream chats.

## Permission justifications

**storage**: Saves the user's block list, timed mutes, hidden-message counters, and settings locally on their computer. Nothing is synced or sent anywhere.

**Host access (`https://rumble.com/*`, `https://*.rumble.com/*`, content script)**: The content script reads chat row usernames and message ids on Rumble pages so it can hide messages from listed users and add the in-chat Block and Mute buttons. It runs on no other site.

**Remote code**: None. All code is packaged with the extension.

## Data usage disclosures

- Collects no user data. Every "data type collected" box stays unchecked.
- Certify: data is not sold, not used for unrelated purposes, and not used for creditworthiness or lending.
- Privacy policy URL: link to `PRIVACY.md` in the public GitHub repository.

## Short description (132 characters max)

Block or temporarily mute specific users in Rumble livestream chats

## Assets the dashboard also needs

- Store icon: 128×128 (`images/icon128.png`)
- At least one screenshot, 1280×800 or 640×400
- Optional: small promo tile, 440×280
