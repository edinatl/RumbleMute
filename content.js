// content.js
let blockedUsers = [];
let mutedUsers = [];
let blockedCount = 0;
let blockedUserCounts = Object.create(null);
let countedMessages = [];
let countedById = Object.create(null);
let countResetNonce = 0;
let filteringEnabled = true;
let showChatControls = true;
let memoryDirty = false;
let storageSync = null;

const MUTE_PRESETS = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '6 hours', minutes: 360 },
  { label: '12 hours', minutes: 720 },
  { label: '24 hours', minutes: 1440 }
];

const toastedExpiries = new Set();
let openMenu = null;
let openMenuRow = null;
let openMenuAnchor = null;
let toastEl = null;
let toastTimer = null;
let menuDismissBound = false;
let chatObservers = [];
let observedChats = [];
let observeTimer = null;
let muteExpiryTimer = null;
let muteLabelTimer = null;
let blockMap = null;
let muteMap = null;

let countSyncTimer = null;

const ROW_SELECTOR = 'li.chat-history--row.js-chat-history-item';
const MUTE_LABEL_REFRESH_MS = 30000;
const MAX_TIMER_MS = 2147483647;
// Hidden-message counter bumps are batched into one storage write per window.
// Block/mute actions and list changes still save immediately.
const COUNT_SYNC_DELAY_MS = 1500;

// False once the extension is reloaded or updated under an open tab; chrome.* calls then throw.
function extensionAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

function flushSync() {
  if (countSyncTimer !== null) {
    clearTimeout(countSyncTimer);
    countSyncTimer = null;
  }
  if (!storageSync) {
    return;
  }
  if (!extensionAlive()) {
    // Keep filtering with the lists already in memory, but stop touching storage.
    storageSync = null;
    return;
  }
  storageSync.schedule();
}

function requestSync(immediate) {
  if (!storageSync) {
    return;
  }
  if (immediate) {
    flushSync();
    return;
  }
  if (countSyncTimer === null) {
    countSyncTimer = setTimeout(flushSync, COUNT_SYNC_DELAY_MS);
  }
}

function invalidateKeyMaps() {
  blockMap = null;
  muteMap = null;
}

// lowercase key -> first matching item (first wins, like the old linear scan)
function buildKeyMap(items, nameOf) {
  const map = new Map();
  for (let i = 0; i < items.length; i++) {
    const key = RCB.countKey(nameOf(items[i]));
    if (key && !map.has(key)) {
      map.set(key, items[i]);
    }
  }
  return map;
}

// ms until the soonest mute expiry (>= 0), or null when there are no mutes
function nextMuteDelay(mutes, now) {
  let soonest = null;
  for (let i = 0; i < mutes.length; i++) {
    if (soonest === null || mutes[i].until < soonest) {
      soonest = mutes[i].until;
    }
  }
  return soonest === null ? null : Math.min(Math.max(0, soonest - now), MAX_TIMER_MS);
}

function touch() {
  memoryDirty = true;
}

// Stamp a name in recentAdds so the popup shows its green "new" highlight.
// Merges with what is stored so concurrent popup writes are not lost.
function recordRecentAdd(name) {
  const key = RCB.countKey(name);
  if (!key || !extensionAlive() || !chrome.storage || !chrome.storage.local) {
    return;
  }
  chrome.storage.local.get('recentAdds', function (result) {
    if (!extensionAlive()) {
      return;
    }
    const stored = result && result.recentAdds;
    const local = {};
    local[key] = Date.now();
    chrome.storage.local.set({
      recentAdds: RCB.mergeRecentAdds(stored && typeof stored === 'object' ? stored : {}, local)
    });
  });
}

function rebuildCountedMap() {
  countedById = Object.create(null);
  countedMessages.forEach(function (pair) {
    countedById[pair[0]] = pair[1];
  });
}

function readState() {
  return {
    blockedUsers: blockedUsers.slice(),
    mutedUsers: mutedUsers.map(function (entry) {
      return { name: entry.name, until: entry.until };
    }),
    blockedUserCounts: RCB.copyCounts(blockedUserCounts),
    blockedCount: blockedCount,
    countedMessages: countedMessages.map(function (pair) {
      return [pair[0], pair[1]];
    }),
    countResetNonce: countResetNonce,
    absoluteReset: false
  };
}

function applyState(state) {
  blockedUsers = state.blockedUsers.slice();
  mutedUsers = state.mutedUsers.map(function (entry) {
    return { name: entry.name, until: entry.until };
  });
  blockedUserCounts = RCB.copyCounts(state.blockedUserCounts);
  blockedCount = state.blockedCount;
  countedMessages = state.countedMessages.map(function (pair) {
    return [pair[0], pair[1]];
  });
  countResetNonce = state.countResetNonce;
  rebuildCountedMap();
  invalidateKeyMaps();
  scheduleMuteTimers();
}

function normalizeBlockEntry(entry) {
  return RCB.normalizeEntry(entry);
}

function countKey(entry) {
  return RCB.countKey(entry);
}

function getRowUsername(message) {
  const fromAttr = message.getAttribute('data-username');
  if (fromAttr && fromAttr.trim()) {
    return fromAttr.trim();
  }
  const button = message.querySelector('button.chat-history--username.js-user-tag');
  if (button && button.textContent.trim()) {
    return button.textContent.trim();
  }
  const usernameElement = message.querySelector('.chat-history--username');
  if (usernameElement && usernameElement.textContent.trim()) {
    return usernameElement.textContent.trim();
  }
  return null;
}

function usernameAnchor(message) {
  return message.querySelector('button.chat-history--username.js-user-tag')
    || message.querySelector('.chat-history--username');
}

function matchingBlockEntry(finalUsername) {
  const lower = countKey(finalUsername);
  if (!lower) {
    return null;
  }
  if (!blockMap) {
    blockMap = buildKeyMap(blockedUsers, function (entry) { return entry; });
  }
  return blockMap.get(lower) || null;
}

function matchingMuteEntry(finalUsername) {
  const lower = countKey(finalUsername);
  if (!lower) {
    return null;
  }
  if (!muteMap) {
    muteMap = buildKeyMap(mutedUsers, function (entry) { return entry.name; });
  }
  return muteMap.get(lower) || null;
}

function activeMuteEntry(finalUsername, now) {
  const entry = matchingMuteEntry(finalUsername);
  if (!entry || entry.until <= now) {
    return null;
  }
  return entry;
}

function hiddenName(username, now) {
  const blockEntry = matchingBlockEntry(username);
  if (blockEntry) {
    return blockEntry;
  }
  const muteEntry = activeMuteEntry(username, now);
  return muteEntry ? muteEntry.name : null;
}

function pruneCounts() {
  const keep = Object.create(null);
  blockedUsers.forEach(function (entry) {
    const key = countKey(entry);
    if (key) {
      keep[key] = true;
    }
  });
  mutedUsers.forEach(function (entry) {
    const key = countKey(entry.name);
    if (key) {
      keep[key] = true;
    }
  });
  let changed = false;
  Object.keys(blockedUserCounts).forEach(function (key) {
    if (!keep[key]) {
      delete blockedUserCounts[key];
      changed = true;
    }
  });
  return changed;
}

function syncCountedToLists() {
  const keep = Object.create(null);
  blockedUsers.forEach(function (entry) {
    const key = countKey(entry);
    if (key) {
      keep[key] = true;
    }
  });
  mutedUsers.forEach(function (entry) {
    const key = countKey(entry.name);
    if (key) {
      keep[key] = true;
    }
  });
  const next = [];
  countedMessages.forEach(function (pair) {
    if (keep[pair[1]]) {
      next.push(pair);
    }
  });
  if (next.length === countedMessages.length) {
    return false;
  }
  countedMessages = next;
  rebuildCountedMap();
  return true;
}

function enforceExclusive() {
  const blockedKeys = Object.create(null);
  blockedUsers.forEach(function (entry) {
    const key = countKey(entry);
    if (key) {
      blockedKeys[key] = true;
    }
  });
  const kept = [];
  let changed = false;
  mutedUsers.forEach(function (entry) {
    if (blockedKeys[countKey(entry.name)]) {
      changed = true;
      return;
    }
    kept.push(entry);
  });
  if (changed) {
    mutedUsers = kept;
    invalidateKeyMaps();
  }
  return changed;
}

function collectExpired(now) {
  const kept = [];
  const expired = [];
  mutedUsers.forEach(function (entry) {
    if (entry.until <= now) {
      expired.push(entry);
    } else {
      kept.push(entry);
    }
  });
  if (expired.length) {
    mutedUsers = kept;
    invalidateKeyMaps();
  }
  return expired;
}

function forgetCountKey(key) {
  if (!key || !Object.prototype.hasOwnProperty.call(blockedUserCounts, key)) {
    return false;
  }
  delete blockedUserCounts[key];
  return true;
}

function removeMuted(name) {
  const key = countKey(name);
  if (!key) {
    return false;
  }
  const kept = [];
  let changed = false;
  mutedUsers.forEach(function (entry) {
    if (countKey(entry.name) === key) {
      changed = true;
      return;
    }
    kept.push(entry);
  });
  if (changed) {
    mutedUsers = kept;
    invalidateKeyMaps();
  }
  return changed;
}

function removeBlocked(name) {
  const key = countKey(name);
  if (!key) {
    return false;
  }
  const kept = [];
  let changed = false;
  blockedUsers.forEach(function (entry) {
    if (countKey(entry) === key) {
      changed = true;
      return;
    }
    kept.push(entry);
  });
  if (changed) {
    blockedUsers = kept;
    invalidateKeyMaps();
  }
  return changed;
}

function blockUsername(raw) {
  const name = normalizeBlockEntry(raw);
  if (!name || matchingBlockEntry(name) || blockedUsers.length >= RCB.MAX_BLOCKED) {
    return;
  }
  removeMuted(name);
  blockedUsers = blockedUsers.concat([name]);
  invalidateKeyMaps();
  recordRecentAdd(name);
  touch();
  processChatMessages({ fullScan: true });
}

function validMinutes(minutes) {
  return typeof minutes === 'number' &&
    isFinite(minutes) &&
    minutes > 0 &&
    minutes <= RCB.MAX_MUTE_MINUTES &&
    Math.floor(minutes) === minutes;
}

function muteUsername(raw, minutes) {
  const name = normalizeBlockEntry(raw);
  if (!name || !validMinutes(minutes)) {
    return;
  }
  if (!matchingMuteEntry(name) && mutedUsers.length >= RCB.MAX_MUTED) {
    return;
  }
  const until = Date.now() + minutes * 60000;
  if (!isFinite(until)) {
    return;
  }
  removeBlocked(name);
  const key = name.toLowerCase();
  let found = false;
  const next = mutedUsers.map(function (entry) {
    if (countKey(entry.name) !== key) {
      return entry;
    }
    found = true;
    return { name: name, until: until };
  });
  if (!found) {
    next.push({ name: name, until: until });
  }
  mutedUsers = next;
  invalidateKeyMaps();
  touch();
  processChatMessages({ fullScan: true });
}

function parseMuteMinutes(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const minutes = Number(text);
  if (!validMinutes(minutes)) {
    return null;
  }
  if (minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60000)) {
    return null;
  }
  return minutes;
}

function formatRemainingShort(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) {
    return '0s';
  }
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return minutes > 0 ? hours + 'h ' + minutes + 'm' : hours + 'h';
  }
  if (minutes > 0) {
    return minutes + 'm';
  }
  return seconds + 's';
}

function setText(el, text) {
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

function showExpiryToast(entries) {
  const names = [];
  entries.forEach(function (entry) {
    const id = countKey(entry.name) + ':' + entry.until;
    if (toastedExpiries.has(id)) {
      return;
    }
    toastedExpiries.add(id);
    names.push(entry.name);
  });
  if (!names.length) {
    return;
  }
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'rcb-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.documentElement.appendChild(toastEl);
  }
  setText(
    toastEl,
    names.length === 1
      ? names[0] + ' is no longer muted.'
      : 'No longer muted: ' + names.join(', ')
  );
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(function () {
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
    toastTimer = null;
  }, 5000);
}

function closeMuteMenu(restoreFocus) {
  const anchor = openMenuAnchor;
  if (openMenuRow) {
    openMenuRow.classList.remove('rcb-menu-open');
  }
  if (openMenu) {
    openMenu.remove();
  }
  openMenu = null;
  openMenuRow = null;
  openMenuAnchor = null;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor.isConnected) {
      anchor.focus({ preventScroll: true });
    }
  }
}

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  menu.style.top = '0px';
  menu.style.left = '0px';
  const menuRect = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - menuRect.width - margin;
  const left = Math.max(margin, Math.min(rect.left, maxLeft));
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuRect.height - 4);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function openMuteMenu(message, anchor, username) {
  const name = normalizeBlockEntry(username);
  if (!name) {
    return;
  }
  closeMuteMenu(false);
  const menu = document.createElement('div');
  menu.className = 'rcb-menu';
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Mute ' + name);

  const grid = document.createElement('div');
  grid.className = 'rcb-menu-grid';
  MUTE_PRESETS.forEach(function (preset) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rcb-preset';
    button.textContent = preset.label;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted) {
        return;
      }
      muteUsername(name, preset.minutes);
      closeMuteMenu(false);
    }, true);
    grid.appendChild(button);
  });

  const form = document.createElement('form');
  form.className = 'rcb-menu-custom';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = 'Minutes';
  input.setAttribute('aria-label', 'Custom minutes');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 6;
  const setBtn = document.createElement('button');
  setBtn.type = 'submit';
  setBtn.textContent = 'Set';
  const error = document.createElement('p');
  error.className = 'rcb-menu-error';
  error.hidden = true;

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) {
      return;
    }
    const minutes = parseMuteMinutes(input.value);
    if (minutes === null) {
      error.hidden = false;
      setText(error, 'Enter a whole number of minutes, up to one year.');
      input.focus();
      positionMenu(menu, anchor);
      return;
    }
    muteUsername(name, minutes);
    closeMuteMenu(false);
  }, true);
  form.append(input, setBtn);

  menu.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      return;
    }
    event.stopPropagation();
  });
  menu.addEventListener('click', function (event) {
    event.stopPropagation();
  });

  menu.append(grid, form, error);
  document.body.appendChild(menu);
  openMenu = menu;
  openMenuRow = message;
  openMenuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  message.classList.add('rcb-menu-open');
  positionMenu(menu, anchor);
  if (menu.focus) {
    menu.focus({ preventScroll: true });
  }
}

function bindMenuDismiss() {
  if (menuDismissBound) {
    return;
  }
  menuDismissBound = true;
  document.addEventListener('click', function (event) {
    if (!openMenu) {
      return;
    }
    if (openMenu.contains(event.target)) {
      return;
    }
    if (event.target.closest && event.target.closest('.rcb-mute')) {
      return;
    }
    closeMuteMenu(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeMuteMenu(true);
    }
  });
  window.addEventListener('scroll', function () {
    if (!openMenu) {
      return;
    }
    if (!openMenuRow || !openMenuRow.isConnected) {
      closeMuteMenu(false);
      return;
    }
    const anchor = openMenuRow.querySelector('.rcb-mute');
    if (!anchor) {
      closeMuteMenu(false);
      return;
    }
    positionMenu(openMenu, anchor);
  }, { capture: true, passive: true });
  window.addEventListener('resize', function () {
    if (!openMenu || !openMenuRow) {
      return;
    }
    const anchor = openMenuRow.querySelector('.rcb-mute');
    if (anchor) {
      positionMenu(openMenu, anchor);
    }
  }, { passive: true });
}

function updateControlLabels(controls, username, message) {
  const blockBtn = controls.querySelector('.rcb-block');
  const muteBtn = controls.querySelector('.rcb-mute');
  if (!blockBtn || !muteBtn) {
    return;
  }
  const now = Date.now();
  const blocked = !!matchingBlockEntry(username);
  const mute = activeMuteEntry(username, now);
  blockBtn.classList.toggle('is-on', blocked);
  if (blocked) {
    blockBtn.setAttribute('aria-disabled', 'true');
  } else {
    blockBtn.removeAttribute('aria-disabled');
  }
  setText(blockBtn, blocked ? 'Blocked' : 'Block');
  blockBtn.setAttribute('aria-label', blocked ? 'Blocked' : 'Block');
  muteBtn.classList.toggle('is-on', !!mute);
  muteBtn.setAttribute('aria-haspopup', 'menu');
  muteBtn.setAttribute('aria-expanded', message && openMenuRow === message ? 'true' : 'false');
  if (mute) {
    const short = formatRemainingShort(mute.until - now);
    setText(muteBtn, 'Mute ' + short);
    muteBtn.setAttribute('aria-label', 'Muted, ' + short + ' remaining. Change duration.');
  } else {
    setText(muteBtn, 'Mute');
    muteBtn.setAttribute('aria-label', 'Mute');
  }
}

function createControls(message) {
  message.dataset.blockerProcessed = 'true';
  const controls = document.createElement('span');
  controls.className = 'rcb-controls';

  const blockBtn = document.createElement('button');
  blockBtn.type = 'button';
  blockBtn.className = 'rcb-btn rcb-block';
  blockBtn.textContent = 'Block';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'rcb-btn rcb-mute';
  muteBtn.textContent = 'Mute';
  muteBtn.setAttribute('aria-haspopup', 'menu');
  muteBtn.setAttribute('aria-expanded', 'false');

  blockBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) {
      return;
    }
    closeMuteMenu(false);
    const username = getRowUsername(message);
    if (username) {
      blockUsername(username);
    }
  }, true);

  muteBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) {
      return;
    }
    const username = getRowUsername(message);
    if (!username) {
      return;
    }
    if (openMenu && openMenuRow === message) {
      closeMuteMenu(false);
      return;
    }
    openMuteMenu(message, muteBtn, username);
  }, true);

  controls.addEventListener('mousedown', function (event) {
    event.stopPropagation();
  });
  controls.addEventListener('click', function (event) {
    event.stopPropagation();
  });

  controls.append(blockBtn, muteBtn);
  const anchor = usernameAnchor(message);
  if (anchor && anchor.parentNode) {
    anchor.insertAdjacentElement('afterend', controls);
  } else {
    message.appendChild(controls);
  }
  return controls;
}

function syncRowControls(message) {
  const username = getRowUsername(message);
  if (!username) {
    return;
  }
  let controls = message.querySelector('.rcb-controls');
  if (!showChatControls) {
    if (controls) {
      if (openMenuRow === message) {
        closeMuteMenu(false);
      }
      controls.remove();
    }
    return;
  }
  if (!controls) {
    message.dataset.blockerProcessed = 'true';
    controls = createControls(message);
  }
  updateControlLabels(controls, username, message);
}

function revealRow(message) {
  message.classList.remove('rcb-hidden');
}

function refreshMuteLabels() {
  muteLabelTimer = null;
  document.querySelectorAll('.rcb-controls').forEach(function (controls) {
    const message = controls.closest(ROW_SELECTOR);
    const username = message && getRowUsername(message);
    if (username) {
      updateControlLabels(controls, username, message);
    }
  });
  scheduleMuteTimers();
}

function scheduleMuteTimers() {
  if (muteExpiryTimer !== null) {
    clearTimeout(muteExpiryTimer);
    muteExpiryTimer = null;
  }
  const delay = nextMuteDelay(mutedUsers, Date.now());
  if (delay === null) {
    if (muteLabelTimer !== null) {
      clearTimeout(muteLabelTimer);
      muteLabelTimer = null;
    }
    return;
  }
  muteExpiryTimer = setTimeout(function () {
    muteExpiryTimer = null;
    processChatMessages({ fullScan: true });
  }, delay);
  if (muteLabelTimer === null) {
    muteLabelTimer = setTimeout(refreshMuteLabels, MUTE_LABEL_REFRESH_MS);
  }
}

function rememberCounted(id, userKey) {
  if (!id || !userKey || countedById[id]) {
    return;
  }
  countedMessages.push([id, userKey]);
  countedById[id] = userKey;
  touch();
}

function concealRow(message, username, now) {
  const token = hiddenName(username, now);
  if (!token) {
    revealRow(message);
    return;
  }
  const key = countKey(token);
  message.classList.add('rcb-hidden');
  if (!key) {
    return;
  }
  const id = RCB.sanitizeMessageId(message.getAttribute('data-message-id'));
  if (id) {
    if (countedById[id]) {
      message.dataset.rcbMsg = id;
      message.dataset.rcbCounted = key;
      return;
    }
  } else if (message.dataset.rcbCounted === key) {
    return;
  }
  message.dataset.rcbCounted = key;
  if (id) {
    message.dataset.rcbMsg = id;
    rememberCounted(id, key);
  }
  blockedUserCounts[key] = (blockedUserCounts[key] || 0) + 1;
  blockedCount += 1;
  touch();
}

function processRow(message, fullScan, now) {
  if (!filteringEnabled) {
    message.dataset.blockerProcessed = 'true';
    syncRowControls(message);
    revealRow(message);
    return;
  }
  const username = getRowUsername(message);
  const seen = message.dataset.blockerUser || '';
  const nameKey = username ? countKey(username) : '';
  const controls = message.querySelector('.rcb-controls');
  if (
    !fullScan &&
    message.dataset.blockerProcessed === 'true' &&
    seen === nameKey &&
    (controls || !username || !showChatControls)
  ) {
    if (controls && username) {
      updateControlLabels(controls, username, message);
    }
    if (username && hiddenName(username, now)) {
      message.classList.add('rcb-hidden');
    }
    return;
  }
  message.dataset.blockerProcessed = 'true';
  if (username) {
    message.dataset.blockerUser = nameKey;
  }
  syncRowControls(message);
  if (!username) {
    revealRow(message);
    return;
  }
  concealRow(message, username, now);
}

// options.fullScan: lists or settings changed, so re-evaluate every row.
// options.rows: only these rows changed (from the MutationObserver). Default: every row, cheaply.
function processChatMessages(options) {
  if (openMenuRow && !openMenuRow.isConnected) {
    closeMuteMenu(false);
  }
  const now = Date.now();
  const expired = collectExpired(now);
  const fullScan = !!(options && options.fullScan) || expired.length > 0;

  // List-wide bookkeeping only matters when the lists changed. Per-row counting only ever
  // touches listed names, so new chat rows cannot break these invariants.
  if (fullScan) {
    if (expired.length) {
      touch();
    }
    if (enforceExclusive()) {
      touch();
    }
    expired.forEach(function (entry) {
      if (forgetCountKey(countKey(entry.name))) {
        touch();
      }
    });
    if (syncCountedToLists()) {
      touch();
    }
  }

  const rows = !fullScan && options && options.rows
    ? options.rows
    : document.querySelectorAll(ROW_SELECTOR);
  rows.forEach(function (message) {
    processRow(message, fullScan, now);
  });

  if (fullScan) {
    if (pruneCounts()) {
      touch();
    }
    if (syncCountedToLists()) {
      touch();
    }
    if (expired.length) {
      showExpiryToast(expired);
    }
    scheduleMuteTimers();
  }
  if (memoryDirty) {
    memoryDirty = false;
    requestSync(fullScan);
  }
}

function sameNodeList(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isOwnNode(node) {
  return node.nodeType === 1 && node.classList.contains('rcb-controls');
}

// Mutations caused by the extension itself: label text inside our controls, or inserting them.
// Removal of our controls is not ours (the extension never removes them), so the row is redone.
function isOwnMutation(record) {
  const target = record.target;
  const el = target && target.nodeType === 1 ? target : target && target.parentElement;
  if (el && el.closest('.rcb-controls, .rcb-menu')) {
    return true;
  }
  const added = record.addedNodes;
  if (!added.length || record.removedNodes.length) {
    return false;
  }
  for (let i = 0; i < added.length; i++) {
    if (!isOwnNode(added[i])) {
      return false;
    }
  }
  return true;
}

// Chat rows touched by these mutations: rows that were added, and rows whose content changed.
function changedRows(records) {
  const rows = new Set();
  records.forEach(function (record) {
    if (isOwnMutation(record)) {
      return;
    }
    const target = record.target;
    if (target && target.nodeType === 1) {
      const row = target.closest(ROW_SELECTOR);
      if (row) {
        rows.add(row);
      }
    }
    record.addedNodes.forEach(function (node) {
      if (node.nodeType !== 1) {
        return;
      }
      if (node.matches(ROW_SELECTOR)) {
        rows.add(node);
        return;
      }
      node.querySelectorAll(ROW_SELECTOR).forEach(function (row) {
        rows.add(row);
      });
    });
  });
  return rows;
}

function bindChatObserver() {
  const nodes = Array.prototype.slice.call(document.querySelectorAll('.chat-history'));
  if (sameNodeList(nodes, observedChats)) {
    return;
  }
  chatObservers.forEach(function (observer) {
    observer.disconnect();
  });
  chatObservers = [];
  observedChats = nodes;
  nodes.forEach(function (node) {
    const observer = new MutationObserver(function (records) {
      if (openMenuRow && !openMenuRow.isConnected) {
        closeMuteMenu(false);
      }
      const rows = changedRows(records);
      if (rows.size) {
        processChatMessages({ rows: rows });
      }
    });
    observer.observe(node, { childList: true, subtree: true });
    chatObservers.push(observer);
  });
  if (nodes.length) {
    processChatMessages();
  }
}

function observeChatChanges() {
  bindChatObserver();
  observeTimer = window.setTimeout(observeChatChanges, 2000);
}

function startAfterStorageReady() {
  if (observeTimer !== null) {
    return;
  }
  if (document.readyState === 'complete') {
    observeChatChanges();
  } else {
    window.addEventListener('load', observeChatChanges);
  }
}

bindMenuDismiss();

// Save batched counter bumps before the tab goes away (best effort).
window.addEventListener('pagehide', function () {
  if (countSyncTimer !== null) {
    flushSync();
  }
});

const storageApi = RCB.chromeLocal();
storageSync = RCB.createSync({
  get: storageApi.get,
  set: storageApi.set,
  read: readState,
  write: applyState,
  onApplied: function () {
    processChatMessages({ fullScan: true });
  }
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'local' || !storageSync) {
    return;
  }
  if (changes.filteringEnabled || changes.showChatControls) {
    if (changes.filteringEnabled) {
      filteringEnabled = changes.filteringEnabled.newValue !== false;
    }
    if (changes.showChatControls) {
      showChatControls = changes.showChatControls.newValue !== false;
    }
    processChatMessages({ fullScan: true });
  }
  if (
    changes.blockedUsers ||
    changes.mutedUsers ||
    changes.blockedUserCounts ||
    changes.blockedCount ||
    changes.countedMessages ||
    changes.countResetNonce
  ) {
    storageSync.handleExternal();
  }
});

chrome.storage.local.get(RCB.STORAGE_FIELDS.concat(['filteringEnabled', 'showChatControls']), function (result) {
  if (chrome.runtime.lastError) {
    startAfterStorageReady();
    return;
  }
  filteringEnabled = !result || result.filteringEnabled !== false;
  showChatControls = !result || result.showChatControls !== false;
  storageSync.start(result || {});
  storageSync.handleExternal();
  startAfterStorageReady();
});
