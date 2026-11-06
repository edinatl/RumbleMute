// popup.js
document.addEventListener('DOMContentLoaded', function () {
  const input = document.getElementById('username');
  const form = document.getElementById('add-form');
  const listEl = document.getElementById('user-list');
  const mutedListEl = document.getElementById('muted-list');
  const emptyEl = document.getElementById('empty-state');
  const mutedEmptyEl = document.getElementById('muted-empty');
  const resultNote = document.getElementById('result-note');
  const togglePaste = document.getElementById('toggle-paste');
  const copyList = document.getElementById('copy-list');
  const pastePanel = document.getElementById('paste-panel');
  const pasteList = document.getElementById('paste-list');
  const addList = document.getElementById('add-list');
  const cancelPaste = document.getElementById('cancel-paste');
  const toggleEdit = document.getElementById('toggle-edit');
  const editPanel = document.getElementById('edit-panel');
  const editList = document.getElementById('edit-list');
  const saveEdit = document.getElementById('save-edit');
  const cancelEdit = document.getElementById('cancel-edit');
  const toggleEnabled = document.getElementById('toggle-enabled');
  const showControlsInput = document.getElementById('show-chat-controls');
  const moreMenuBtn = document.getElementById('more-menu-btn');
  const moreMenu = document.getElementById('more-menu');
  const clearListBtn = document.getElementById('clear-list');
  const clearConfirmEl = document.getElementById('clear-confirm');
  const clearCancelBtn = document.getElementById('clear-cancel');
  const clearYesBtn = document.getElementById('clear-yes');
  const NEW_HIGHLIGHT_MS = 24 * 60 * 60 * 1000;
  const sortCycleBtn = document.getElementById('cycle-sort');

  const SORT_MODES = ['count', 'alpha', 'newest', 'native'];
  const SORT_LABELS = {
    count: 'By count',
    alpha: 'A–Z',
    newest: 'Newest',
    native: 'Unsorted'
  };
  let listSort = 'count';

  let blockedUsers = [];
  let mutedUsers = [];
  let blockedUserCounts = Object.create(null);
  let blockedCount = 0;
  let countedMessages = [];
  let countResetNonce = 0;
  let pendingResetNonce = 0;
  let baselineNonce = 0;
  let storageSync = null;
  let confirmingName = null;
  let filteringEnabled = true;
  let showChatControls = true;
  let recentAdds = {};
  let highlightTimer = null;
  let muteTimer = null;
  let copyTimer = null;
  let firstRenderDone = false;

  // Built once and cloned per row; cheaper than creating each element for every render.
  function iconSvg(pathD) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  const ICON_X = iconSvg('M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2');
  const ICON_CHECK = iconSvg('M3.2 8.3l3 3.1 6.6-7');

  function iconX() {
    return ICON_X.cloneNode(true);
  }

  function iconCheck() {
    return ICON_CHECK.cloneNode(true);
  }

  function rowTemplate(className, extraParts) {
    const li = document.createElement('li');
    li.className = className;
    const name = document.createElement('span');
    name.className = 'user-name';
    const count = document.createElement('span');
    count.className = 'user-count';
    li.append(name, count);
    extraParts.forEach(function (part) {
      li.append(part);
    });
    return li;
  }

  const removeTemplate = document.createElement('button');
  removeTemplate.type = 'button';
  removeTemplate.className = 'remove';
  removeTemplate.append(iconX());
  const BLOCK_ROW = rowTemplate('user-row', [removeTemplate]);

  const muteTimeTemplate = document.createElement('span');
  muteTimeTemplate.className = 'mute-remaining';
  muteTimeTemplate.title = 'Time remaining';
  const unmuteTemplate = document.createElement('button');
  unmuteTemplate.type = 'button';
  unmuteTemplate.className = 'unmute';
  unmuteTemplate.textContent = 'Unmute';
  const MUTE_ROW = rowTemplate('user-row mute-row', [muteTimeTemplate, unmuteTemplate]);

  // Above this many rows, off-screen rows skip layout and paint (see .user-list.is-long).
  const LONG_LIST_ROWS = 40;

  function sameName(a, b) {
    return normalizeEntry(a).toLowerCase() === normalizeEntry(b).toLowerCase();
  }

  function setRowConfirming(row, on) {
    const name = row.firstElementChild.textContent;
    const remove = row.lastElementChild;
    row.classList.toggle('is-confirming', on);
    remove.replaceChildren(on ? iconCheck() : iconX());
    remove.setAttribute('aria-label', (on ? 'Confirm remove ' : 'Remove ') + name);
  }

  function clearConfirming() {
    if (confirmingName === null) {
      return;
    }
    confirmingName = null;
    const row = listEl.querySelector('.user-row.is-confirming');
    if (row) {
      setRowConfirming(row, false);
    }
  }

  function normalizeEntry(entry) {
    return RCB.normalizeEntry(entry);
  }

  function countKey(entry) {
    return RCB.countKey(entry);
  }

  function countFor(name) {
    const n = blockedUserCounts[countKey(name)];
    return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
  }

  // A shared collator sorts ~100x faster than localeCompare with options, which builds one per call.
  const compareAlpha = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
  const numberFormat = new Intl.NumberFormat();

  function sortedBlockedUsers() {
    if (listSort === 'native') {
      return blockedUsers.slice();
    }
    const names = blockedUsers.slice();
    if (listSort === 'alpha') {
      names.sort(compareAlpha);
    } else if (listSort === 'newest') {
      names.reverse();
    } else {
      const counts = new Map();
      names.forEach(function (name) {
        counts.set(name, countFor(name));
      });
      names.sort(function (a, b) {
        const diff = counts.get(b) - counts.get(a);
        if (diff !== 0) {
          return diff;
        }
        return compareAlpha(a, b);
      });
    }
    return names;
  }

  function indexInBlockedUsers(name) {
    for (let i = 0; i < blockedUsers.length; i++) {
      if (sameName(blockedUsers[i], name)) {
        return i;
      }
    }
    return -1;
  }

  function sortModeLabel(mode) {
    return SORT_LABELS[mode] || SORT_LABELS.count;
  }

  function nextSortMode(mode) {
    const index = SORT_MODES.indexOf(mode);
    if (index === -1) {
      return SORT_MODES[0];
    }
    return SORT_MODES[(index + 1) % SORT_MODES.length];
  }

  const SORT_MODE_CLASSES = SORT_MODES.map(function (mode) {
    return 'sort-mode-' + mode;
  });

  function applySortModeClass() {
    if (!sortCycleBtn) {
      return;
    }
    sortCycleBtn.classList.remove.apply(sortCycleBtn.classList, SORT_MODE_CLASSES);
    const mode = SORT_MODES.indexOf(listSort) === -1 ? 'count' : listSort;
    sortCycleBtn.classList.add('sort-mode-' + mode);
  }

  function syncSortCycleUI() {
    if (!sortCycleBtn) {
      return;
    }
    const show = blockedUsers.length > 1;
    sortCycleBtn.hidden = !show;
    applySortModeClass();
    const label = sortModeLabel(listSort);
    sortCycleBtn.textContent = label;
    const next = sortModeLabel(nextSortMode(listSort));
    const hint = 'Sort: ' + label + '. Click for ' + next + '.';
    sortCycleBtn.title = hint;
    sortCycleBtn.setAttribute('aria-label', hint);
  }

  function persistListSort() {
    syncSortCycleUI();
    if (!hasChromeApi('storage') || !chrome.storage.local) {
      return;
    }
    chrome.storage.local.set({ blockListSort: listSort }, function () {
      if (chrome.runtime.lastError) {
        showSaveError();
      }
    });
  }

  function countLabel(n) {
    return n === 1 ? '1 message hidden' : n + ' messages hidden';
  }

  function formatRemaining(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) {
      return '0s';
    }
    const total = Math.ceil(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) {
      return hours + 'h ' + minutes + 'm ' + seconds + 's';
    }
    if (minutes > 0) {
      return minutes + 'm ' + seconds + 's';
    }
    return seconds + 's';
  }

  function snapshotMutes() {
    return mutedUsers.map(function (entry) {
      return { name: entry.name, until: entry.until };
    });
  }

  function readState() {
    const resetting = pendingResetNonce > baselineNonce;
    return {
      blockedUsers: blockedUsers.slice(),
      mutedUsers: snapshotMutes(),
      blockedUserCounts: RCB.copyCounts(blockedUserCounts),
      blockedCount: resetting ? 0 : blockedCount,
      countedMessages: countedMessages.map(function (pair) {
        return [pair[0], pair[1]];
      }),
      countResetNonce: Math.max(countResetNonce, pendingResetNonce),
      absoluteReset: resetting
    };
  }

  function writeState(state) {
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
  }

  function noteBaseline(state) {
    baselineNonce = state.countResetNonce || 0;
    if (pendingResetNonce && baselineNonce >= pendingResetNonce) {
      pendingResetNonce = 0;
    }
  }

  function onStorageApplied() {
    const stripped = stripMutesNowBlocked();
    if (stripped && storageSync) {
      storageSync.schedule();
    }
    if (firstRenderDone) {
      renderCountsOnly();
    } else {
      // The empty-state notes start hidden in popup.html, so the first load always does a full render.
      firstRenderDone = true;
      render();
      renderMuted();
    }
    fillTotalCount(blockedCount);
  }

  function showSaveError() {
    resultNote.textContent = 'Could not save. Try again.';
    resultNote.hidden = false;
  }

  function blockedKeySet() {
    const keys = new Set();
    blockedUsers.forEach(function (name) {
      keys.add(countKey(name));
    });
    return keys;
  }

  function stripMutesNowBlocked() {
    const blocked = blockedKeySet();
    const next = mutedUsers.filter(function (entry) {
      return !blocked.has(countKey(entry.name));
    });
    if (next.length === mutedUsers.length) {
      return false;
    }
    mutedUsers = next;
    return true;
  }

  function stopMuteTimer() {
    if (muteTimer !== null) {
      clearInterval(muteTimer);
      muteTimer = null;
    }
  }

  function syncMuteTimer() {
    if (mutedUsers.length === 0) {
      stopMuteTimer();
      return;
    }
    if (muteTimer !== null) {
      return;
    }
    muteTimer = setInterval(renderMuteTimes, 1000);
  }

  function fillCount(el, name) {
    const n = countFor(name);
    const value = String(n);
    // Live count updates touch every row; skip the ones that didn't change.
    if (el.dataset.count === value) {
      return;
    }
    el.textContent = n > 0 ? numberFormat.format(n) : '';
    el.dataset.count = value;
    el.title = countLabel(n);
    el.setAttribute('aria-label', countLabel(n));
    el.classList.toggle('has-count', n > 0);
  }

  function fillTotalCount(raw) {
    const el = document.getElementById('count');
    if (!el) {
      return;
    }
    const n =
      typeof raw === 'number' && isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    el.textContent = numberFormat.format(n);
    el.dataset.count = String(n);
    el.title = countLabel(n);
    el.setAttribute('aria-label', countLabel(n));
    el.classList.toggle('has-count', n > 0);
  }

  function forgetCount(name) {
    const key = countKey(name);
    if (!key) {
      return;
    }
    delete blockedUserCounts[key];
  }

  function renderCountsOnly() {
    const ordered = sortedBlockedUsers();
    const rows = listEl.children;
    if (rows.length !== ordered.length) {
      render();
      renderMuted();
      return;
    }
    for (let i = 0; i < ordered.length; i++) {
      const nameEl = rows[i].children[0];
      const countEl = rows[i].children[1];
      if (!nameEl || !countEl || nameEl.textContent !== ordered[i]) {
        render();
        renderMuted();
        return;
      }
      fillCount(countEl, ordered[i]);
    }
    const muteRows = mutedListEl.children;
    if (muteRows.length !== mutedUsers.length) {
      renderMuted();
      return;
    }
    for (let j = 0; j < mutedUsers.length; j++) {
      const nameEl = muteRows[j].children[0];
      const countEl = muteRows[j].children[1];
      if (!nameEl || !countEl || nameEl.textContent !== mutedUsers[j].name) {
        renderMuted();
        return;
      }
      fillCount(countEl, mutedUsers[j].name);
    }
  }

  function hasChromeApi(apiName) {
    return typeof chrome !== 'undefined' && !!chrome[apiName];
  }

  function syncFilteringEnabledUI() {
    if (!toggleEnabled) {
      return;
    }
    toggleEnabled.classList.toggle('active', filteringEnabled);
    toggleEnabled.classList.toggle('disabled', !filteringEnabled);
    toggleEnabled.textContent = filteringEnabled ? 'Active' : 'Disabled';
    toggleEnabled.setAttribute('aria-pressed', filteringEnabled ? 'true' : 'false');
    toggleEnabled.title = filteringEnabled
      ? 'Filtering is on. Click to pause.'
      : 'Filtering is disabled. Click to turn on.';
    toggleEnabled.setAttribute(
      'aria-label',
      filteringEnabled ? 'Filtering on. Click to turn off.' : 'Filtering disabled. Click to turn on.'
    );
  }

  function syncShowControlsUI() {
    if (!showControlsInput) {
      return;
    }
    const label = showChatControls
      ? 'Chat Block/Mute buttons shown. Click to hide.'
      : 'Chat Block/Mute buttons hidden. Click to show.';
    showControlsInput.setAttribute('aria-pressed', showChatControls ? 'true' : 'false');
    showControlsInput.title = label;
    showControlsInput.setAttribute('aria-label', label);
  }

  function pruneRecentAdds() {
    const cutoff = Date.now() - NEW_HIGHLIGHT_MS;
    let changed = false;
    Object.keys(recentAdds).forEach(function (key) {
      if (typeof recentAdds[key] !== 'number' || recentAdds[key] <= cutoff) {
        delete recentAdds[key];
        changed = true;
      }
    });
    return changed;
  }

  function saveRecentAdds() {
    if (hasChromeApi('storage') && chrome.storage.local) {
      chrome.storage.local.set({ recentAdds: recentAdds });
    }
  }

  function isRecentlyAdded(name) {
    const at = recentAdds[countKey(name)];
    return typeof at === 'number' && Date.now() - at < NEW_HIGHLIGHT_MS;
  }

  // Age -> RGB stops: green for 5 min, fading to yellow (30 min), orange (2 h),
  // red (3 h), then red until the highlight expires (24 h).
  const HIGHLIGHT_STOPS = [
    { at: 0, rgb: [143, 206, 74] },
    { at: 5 * 60 * 1000, rgb: [143, 206, 74] },
    { at: 30 * 60 * 1000, rgb: [235, 200, 50] },
    { at: 2 * 60 * 60 * 1000, rgb: [240, 150, 40] },
    { at: 3 * 60 * 60 * 1000, rgb: [225, 70, 60] }
  ];

  function highlightRgb(name) {
    const age = Math.max(0, Date.now() - recentAdds[countKey(name)]);
    const last = HIGHLIGHT_STOPS[HIGHLIGHT_STOPS.length - 1];
    if (age >= last.at) {
      return last.rgb.join(', ');
    }
    for (let i = 1; i < HIGHLIGHT_STOPS.length; i++) {
      const b = HIGHLIGHT_STOPS[i];
      if (age <= b.at) {
        const a = HIGHLIGHT_STOPS[i - 1];
        const t = (age - a.at) / (b.at - a.at);
        return a.rgb.map(function (c, k) {
          return Math.round(c + (b.rgb[k] - c) * t);
        }).join(', ');
      }
    }
    return last.rgb.join(', ');
  }

  // Opacity multiplier: full for the first 3 h, then easing down so the
  // highlight dissolves instead of vanishing when it expires at 24 h.
  const HIGHLIGHT_FADE_FROM = 3 * 60 * 60 * 1000;
  const HIGHLIGHT_MIN_STRENGTH = 0.12;

  function highlightStrength(name) {
    const age = Math.max(0, Date.now() - recentAdds[countKey(name)]);
    if (age <= HIGHLIGHT_FADE_FROM) {
      return 1;
    }
    const t = Math.min(1, (age - HIGHLIGHT_FADE_FROM) / (NEW_HIGHLIGHT_MS - HIGHLIGHT_FADE_FROM));
    const eased = 1 - Math.pow(1 - t, 2);
    return Math.round((1 - (1 - HIGHLIGHT_MIN_STRENGTH) * eased) * 100) / 100;
  }

  // Rows added in the last moment get a one-time sweep-in animation.
  const HIGHLIGHT_FRESH_MS = 1500;

  function isFreshAdd(name) {
    return Date.now() - recentAdds[countKey(name)] < HIGHLIGHT_FRESH_MS;
  }

  function scheduleHighlightExpiry() {
    if (highlightTimer !== null) {
      clearTimeout(highlightTimer);
      highlightTimer = null;
    }
    const times = Object.keys(recentAdds).map(function (key) {
      return recentAdds[key] + NEW_HIGHLIGHT_MS;
    });
    if (times.length === 0) {
      return;
    }
    // Re-render at least once a minute so the color keeps fading.
    const delay = Math.max(1000, Math.min(60000, Math.min.apply(null, times) - Date.now() + 50));
    highlightTimer = setTimeout(function () {
      highlightTimer = null;
      if (pruneRecentAdds()) {
        saveRecentAdds();
      }
      refreshHighlights();
    }, delay);
  }

  function applyHighlight(li, name, isRender) {
    if (!isRecentlyAdded(name)) {
      if (li.classList.contains('is-new')) {
        li.classList.remove('is-new', 'is-fresh');
        li.style.removeProperty('--hl-rgb');
        li.style.removeProperty('--hl-strength');
      }
      return;
    }
    li.classList.add('is-new');
    li.style.setProperty('--hl-rgb', highlightRgb(name));
    li.style.setProperty('--hl-strength', String(highlightStrength(name)));
    if (isRender && isFreshAdd(name)) {
      li.classList.add('is-fresh');
    } else if (!isRender) {
      li.classList.remove('is-fresh');
    }
  }

  // Updates the fading colors in place rather than rebuilding the whole list.
  function refreshHighlights() {
    listEl.querySelectorAll('.user-row.is-new').forEach(function (row) {
      applyHighlight(row, row.firstElementChild.textContent, false);
    });
    scheduleHighlightExpiry();
  }

  function persistFilteringEnabled() {
    syncFilteringEnabledUI();
    if (!hasChromeApi('storage') || !chrome.storage.local) {
      return;
    }
    chrome.storage.local.set({ filteringEnabled: filteringEnabled }, function () {
      if (chrome.runtime.lastError) {
        showSaveError();
      }
    });
  }

  function render() {
    if (confirmingName !== null && !blockedUsers.some(function (name) {
      return sameName(name, confirmingName);
    })) {
      confirmingName = null;
    }

    const ordered = sortedBlockedUsers();
    const fragment = document.createDocumentFragment();
    ordered.forEach(function (name) {
      const li = BLOCK_ROW.cloneNode(true);
      li.firstElementChild.textContent = name;
      fillCount(li.children[1], name);
      applyHighlight(li, name, true);
      if (confirmingName !== null && sameName(name, confirmingName)) {
        setRowConfirming(li, true);
      } else {
        li.lastElementChild.setAttribute('aria-label', 'Remove ' + name);
      }
      fragment.append(li);
    });
    listEl.classList.toggle('is-long', ordered.length > LONG_LIST_ROWS);
    listEl.replaceChildren(fragment);

    emptyEl.hidden = blockedUsers.length > 0;
    scheduleHighlightExpiry();
    syncSortCycleUI();
    syncCopyButton();
  }

  function expireDueMutes() {
    const now = Date.now();
    const kept = [];
    let changed = false;
    mutedUsers.forEach(function (entry) {
      if (entry.until <= now) {
        changed = true;
        const key = countKey(entry.name);
        if (key) {
          delete blockedUserCounts[key];
        }
      } else {
        kept.push(entry);
      }
    });
    if (!changed) {
      return false;
    }
    mutedUsers = kept;
    if (storageSync) {
      storageSync.schedule();
    }
    return true;
  }

  function renderMuteTimes() {
    if (expireDueMutes()) {
      renderMuted();
      return;
    }
    const rows = mutedListEl.children;
    if (rows.length !== mutedUsers.length) {
      renderMuted();
      return;
    }
    const now = Date.now();
    for (let i = 0; i < mutedUsers.length; i++) {
      const nameEl = rows[i].children[0];
      const timeEl = rows[i].children[2];
      if (!nameEl || !timeEl || nameEl.textContent !== mutedUsers[i].name) {
        renderMuted();
        return;
      }
      timeEl.textContent = formatRemaining(mutedUsers[i].until - now);
    }
  }

  function renderMuted() {
    if (!mutedListEl || !mutedEmptyEl) {
      return;
    }
    expireDueMutes();
    const now = Date.now();
    const fragment = document.createDocumentFragment();
    mutedUsers.forEach(function (entry) {
      const li = MUTE_ROW.cloneNode(true);
      const parts = li.children;
      parts[0].textContent = entry.name;
      fillCount(parts[1], entry.name);
      parts[2].textContent = formatRemaining(entry.until - now);
      parts[3].setAttribute('aria-label', 'Unmute ' + entry.name);
      fragment.append(li);
    });
    mutedListEl.classList.toggle('is-long', mutedUsers.length > LONG_LIST_ROWS);
    mutedListEl.replaceChildren(fragment);

    mutedEmptyEl.hidden = mutedUsers.length > 0;
    syncMuteTimer();
  }

  function unmuteUser(name) {
    const key = countKey(name);
    mutedUsers = mutedUsers.filter(function (entry) {
      return countKey(entry.name) !== key;
    });
    if (key) {
      delete blockedUserCounts[key];
    }
    renderMuted();
    if (storageSync) {
      storageSync.schedule();
    }
  }

  function persist() {
    if (storageSync) {
      storageSync.schedule();
    }
  }

  function clearResultNote() {
    resultNote.hidden = true;
    resultNote.textContent = '';
  }

  function showResult(added, duplicate, bulk) {
    let message = '';
    if (added === 0 && duplicate === 0) {
      if (!bulk) {
        clearResultNote();
        return;
      }
      message = 'Nothing to add.';
    } else if (added === 0) {
      message = duplicate === 1
        ? 'Already on the list.'
        : 'All of those are already on the list.';
    } else if (duplicate > 0) {
      message = 'Added ' + added + '. ' + duplicate + ' already on the list.';
    } else if (bulk) {
      message = 'Added ' + added + '.';
    }

    if (!message) {
      clearResultNote();
      return;
    }
    resultNote.textContent = message;
    resultNote.hidden = false;
  }

  function commitEntries(raw, bulk) {
    const parts = String(raw).split(/[\n,;]+/);
    let added = 0;
    let duplicate = 0;
    let hitLimit = false;
    const existing = blockedKeySet();
    parts.forEach(function (part) {
      const name = normalizeEntry(part);
      if (!name) {
        return;
      }
      const key = name.toLowerCase();
      if (existing.has(key)) {
        duplicate += 1;
        return;
      }
      if (blockedUsers.length >= RCB.MAX_BLOCKED) {
        hitLimit = true;
        return;
      }
      existing.add(key);
      blockedUsers.push(name);
      recentAdds[countKey(name)] = Date.now();
      added += 1;
    });
    // A person is on at most one list: blocking drops any timed mute for that name.
    const mutesChanged = added > 0 && stripMutesNowBlocked();

    showResult(added, duplicate, bulk);
    if (hitLimit) {
      const prefix = resultNote.hidden || !resultNote.textContent ? '' : resultNote.textContent + ' ';
      resultNote.textContent = prefix + 'The block list is full.';
      resultNote.hidden = false;
    }

    if (added > 0) {
      saveRecentAdds();
      render();
      if (mutesChanged) {
        renderMuted();
      }
      persist();
      const last = listEl.lastElementChild;
      if (last && last.scrollIntoView) {
        last.scrollIntoView({ block: 'nearest' });
      }
    }

    return added;
  }

  function setEditOpen(open) {
    editPanel.hidden = !open;
    toggleEdit.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleEdit.classList.toggle('is-open', open);
    const label = open ? 'Hide list editor' : 'Edit list as text';
    toggleEdit.title = label;
    toggleEdit.setAttribute('aria-label', label);
    if (open) {
      setPasteOpen(false);
      editList.value = blockedUsers.join('\n');
      editList.focus();
    }
  }

  function saveEditedList() {
    const seen = new Set();
    const next = [];
    let hitLimit = false;
    String(editList.value).split(/[\n,;]+/).forEach(function (part) {
      const name = normalizeEntry(part);
      if (!name) {
        return;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      if (next.length >= RCB.MAX_BLOCKED) {
        hitLimit = true;
        return;
      }
      seen.add(key);
      next.push(name);
    });

    const before = blockedKeySet();
    let added = 0;
    let removed = 0;
    next.forEach(function (name) {
      if (!before.has(name.toLowerCase())) {
        added += 1;
        recentAdds[countKey(name)] = Date.now();
      }
    });
    blockedUsers.forEach(function (name) {
      if (!seen.has(name.toLowerCase())) {
        removed += 1;
        forgetCount(name);
      }
    });

    blockedUsers = next;
    confirmingName = null;
    const mutesChanged = added > 0 && stripMutesNowBlocked();

    const parts = [];
    if (added) {
      parts.push('Added ' + added + '.');
    }
    if (removed) {
      parts.push('Removed ' + removed + '.');
    }
    if (hitLimit) {
      parts.push('The block list is full.');
    }
    if (parts.length) {
      resultNote.textContent = parts.join(' ');
      resultNote.hidden = false;
    } else {
      clearResultNote();
    }

    if (added > 0) {
      saveRecentAdds();
    }
    if (added > 0 || removed > 0) {
      render();
      if (mutesChanged) {
        renderMuted();
      }
      persist();
    }
    setEditOpen(false);
  }

  function setPasteOpen(open) {
    if (open && editPanel && !editPanel.hidden) {
      setEditOpen(false);
    }
    pastePanel.hidden = !open;
    togglePaste.setAttribute('aria-expanded', open ? 'true' : 'false');
    togglePaste.classList.toggle('is-open', open);
    const label = open ? 'Hide paste list' : 'Paste a list';
    togglePaste.title = label;
    togglePaste.setAttribute('aria-label', label);
    if (open) {
      pasteList.focus();
    }
  }

  function syncCopyButton() {
    if (!copyList || copyList.classList.contains('is-copied')) {
      return;
    }
    const empty = blockedUsers.length === 0;
    copyList.disabled = empty;
    const label = empty ? 'No usernames to copy' : 'Copy list';
    copyList.title = label;
    copyList.setAttribute('aria-label', label);
  }

  function showCopied() {
    if (!copyList) {
      return;
    }
    copyList.classList.add('is-copied');
    copyList.title = 'Copied';
    copyList.setAttribute('aria-label', 'Copied');
    if (copyTimer !== null) {
      clearTimeout(copyTimer);
    }
    copyTimer = setTimeout(function () {
      copyTimer = null;
      if (!copyList) {
        return;
      }
      copyList.classList.remove('is-copied');
      syncCopyButton();
    }, 1200);
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  function copyBlocklist() {
    if (blockedUsers.length === 0) {
      return;
    }
    const text = blockedUsers.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied, function () {
        if (fallbackCopy(text)) {
          showCopied();
        }
      });
      return;
    }
    if (fallbackCopy(text)) {
      showCopied();
    }
  }

  function addFromInput() {
    const raw = input.value;
    input.value = '';
    commitEntries(raw, false);
    input.focus();
  }

  // One delegated handler for every row's remove button (rows are rebuilt on each render).
  listEl.addEventListener('click', function (event) {
    const remove = event.target.closest('.remove');
    if (!remove) {
      return;
    }
    event.stopPropagation();
    const row = remove.parentElement;
    const name = row.firstElementChild.textContent;
    if (!row.classList.contains('is-confirming')) {
      clearConfirming();
      confirmingName = name;
      setRowConfirming(row, true);
      remove.focus();
      return;
    }
    const storageIndex = indexInBlockedUsers(name);
    if (storageIndex >= 0) {
      blockedUsers.splice(storageIndex, 1);
    }
    confirmingName = null;
    clearResultNote();
    forgetCount(name);
    persist();
    render();
  });

  mutedListEl.addEventListener('click', function (event) {
    const unmute = event.target.closest('.unmute');
    if (!unmute) {
      return;
    }
    event.stopPropagation();
    unmuteUser(unmute.parentElement.firstElementChild.textContent);
  });

  document.addEventListener('click', function (event) {
    if (confirmingName === null) {
      return;
    }
    const row = listEl.querySelector('.user-row.is-confirming');
    if (row && row.contains(event.target)) {
      return;
    }
    clearConfirming();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      clearConfirming();
    }
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    addFromInput();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    addFromInput();
  });

  input.addEventListener('paste', function (event) {
    const text = event.clipboardData && event.clipboardData.getData('text');
    if (!text || !/[\n,;]/.test(text)) {
      return;
    }
    event.preventDefault();
    input.value = '';
    commitEntries(text, true);
    input.focus();
  });

  input.addEventListener('input', clearResultNote);

  togglePaste.addEventListener('click', function () {
    setPasteOpen(pastePanel.hidden);
  });

  toggleEdit.addEventListener('click', function () {
    setEditOpen(editPanel.hidden);
  });

  cancelEdit.addEventListener('click', function () {
    setEditOpen(false);
    input.focus();
  });

  saveEdit.addEventListener('click', saveEditedList);

  editList.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    saveEdit.click();
  });

  if (copyList) {
    copyList.addEventListener('click', copyBlocklist);
  }

  if (sortCycleBtn) {
    sortCycleBtn.addEventListener('click', function () {
      if (blockedUsers.length <= 1) {
        return;
      }
      listSort = nextSortMode(listSort);
      persistListSort();
      render();
    });
  }

  cancelPaste.addEventListener('click', function () {
    pasteList.value = '';
    setPasteOpen(false);
    input.focus();
  });

  addList.addEventListener('click', function () {
    const raw = pasteList.value;
    const added = commitEntries(raw, true);
    if (added > 0) {
      pasteList.value = '';
      setPasteOpen(false);
      input.focus();
    } else {
      pasteList.focus();
    }
  });

  pasteList.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    addList.click();
  });

  function watchStorage() {
    if (!hasChromeApi('storage') || !chrome.storage.onChanged) {
      return;
    }
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !storageSync) {
        return;
      }
      if (changes.filteringEnabled) {
        filteringEnabled = changes.filteringEnabled.newValue !== false;
        syncFilteringEnabledUI();
      }
      if (changes.showChatControls) {
        showChatControls = changes.showChatControls.newValue !== false;
        syncShowControlsUI();
      }
      if (changes.popupTheme) {
        applyTheme(changes.popupTheme.newValue);
      }
      if (changes.blockListSort) {
        const next = changes.blockListSort.newValue;
        // Skip the echo of this popup's own sort change; it already rendered.
        if (typeof next === 'string' && SORT_MODES.indexOf(next) !== -1 && next !== listSort) {
          listSort = next;
          syncSortCycleUI();
          render();
        }
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
  }

  if (hasChromeApi('storage') && chrome.storage.local) {
    const storageApi = RCB.chromeLocal();
    storageSync = RCB.createSync({
      get: storageApi.get,
      set: storageApi.set,
      read: readState,
      write: writeState,
      noteBaseline: noteBaseline,
      onApplied: onStorageApplied,
      onError: showSaveError
    });
    watchStorage();
    // popup-boot.js started this read in <head>; fall back to reading here if it didn't run.
    const initialRead = RCB.popupInitialRead || new Promise(function (resolve) {
      chrome.storage.local.get(RCB.STORAGE_FIELDS.concat(['filteringEnabled', 'showChatControls', 'recentAdds', 'blockListSort', 'popupTheme']), function (result) {
        resolve({ result: result, failed: !!chrome.runtime.lastError });
      });
    });
    initialRead.then(function (read) {
      const result = read.result;
      if (read.failed) {
        showSaveError();
        syncFilteringEnabledUI();
        render();
        renderMuted();
        fillTotalCount(0);
        return;
      }
      filteringEnabled = !result || result.filteringEnabled !== false;
      showChatControls = !result || result.showChatControls !== false;
      syncShowControlsUI();
      applyTheme(result && result.popupTheme);
      const storedAdds = result && result.recentAdds;
      if (storedAdds && typeof storedAdds === 'object' && !Array.isArray(storedAdds)) {
        recentAdds = Object.assign({}, storedAdds);
        if (pruneRecentAdds()) {
          saveRecentAdds();
        }
      }
      const storedSort = result && result.blockListSort;
      if (typeof storedSort === 'string' && SORT_MODES.indexOf(storedSort) !== -1) {
        listSort = storedSort;
      }
      syncFilteringEnabledUI();
      storageSync.start(result || {});
      storageSync.handleExternal();
    });
  } else {
    syncFilteringEnabledUI();
    render();
    renderMuted();
    fillTotalCount(0);
  }

  window.addEventListener('pagehide', stopMuteTimer);

  if (showControlsInput) {
    showControlsInput.addEventListener('click', function () {
      showChatControls = !showChatControls;
      syncShowControlsUI();
      if (!hasChromeApi('storage') || !chrome.storage.local) {
        return;
      }
      chrome.storage.local.set({ showChatControls: showChatControls }, function () {
        if (chrome.runtime.lastError) {
          showSaveError();
        }
      });
    });
  }

  const themeBtn = document.getElementById('toggle-theme');
  // Stored preference: 'dark', 'light', or 'system'. Absent means dark.
  const THEME_ORDER = ['dark', 'light', 'system'];
  const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' };
  const systemLightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let theme = 'dark';

  function resolvedTheme() {
    if (theme === 'system') {
      return systemLightQuery && systemLightQuery.matches ? 'light' : 'dark';
    }
    return theme;
  }

  function renderTheme() {
    document.documentElement.setAttribute('data-theme', resolvedTheme());
    themeBtn.textContent = 'Theme: ' + THEME_LABELS[theme];
  }

  function applyTheme(value) {
    theme = THEME_ORDER.indexOf(value) !== -1 ? value : 'dark';
    renderTheme();
    // Mirror for popup-boot.js, which reads it synchronously so the next open paints in this theme.
    try {
      localStorage.setItem('rcbPopupTheme', theme);
    } catch (err) {
      // Storage unavailable; the popup still applies the theme after chrome.storage loads.
    }
  }

  if (systemLightQuery) {
    const onSystemThemeChange = function () {
      if (theme === 'system') {
        renderTheme();
      }
    };
    if (systemLightQuery.addEventListener) {
      systemLightQuery.addEventListener('change', onSystemThemeChange);
    } else if (systemLightQuery.addListener) {
      systemLightQuery.addListener(onSystemThemeChange);
    }
  }

  // Cycles Dark -> Light -> System. The menu stays open so the user can keep clicking.
  themeBtn.addEventListener('click', function () {
    applyTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]);
    if (hasChromeApi('storage') && chrome.storage.local) {
      chrome.storage.local.set({ popupTheme: theme }, function () {
        if (chrome.runtime.lastError) {
          showSaveError();
        }
      });
    }
  });

  function setMenuOpen(open) {
    moreMenu.hidden = !open;
    moreMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) {
      clearConfirmEl.hidden = true;
      clearListBtn.hidden = false;
    }
  }

  moreMenuBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    setMenuOpen(moreMenu.hidden);
  });

  moreMenu.addEventListener('click', function (event) {
    event.stopPropagation();
  });

  document.addEventListener('click', function () {
    setMenuOpen(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      setMenuOpen(false);
    }
  });

  clearListBtn.addEventListener('click', function () {
    clearListBtn.hidden = true;
    clearConfirmEl.hidden = false;
    clearCancelBtn.focus();
  });

  clearCancelBtn.addEventListener('click', function () {
    setMenuOpen(false);
    moreMenuBtn.focus();
  });

  clearYesBtn.addEventListener('click', function () {
    blockedUsers.forEach(forgetCount);
    blockedUsers = [];
    confirmingName = null;
    recentAdds = {};
    saveRecentAdds();
    clearResultNote();
    render();
    persist();
    setMenuOpen(false);
  });

  if (toggleEnabled) {
    toggleEnabled.addEventListener('click', function () {
      filteringEnabled = !filteringEnabled;
      persistFilteringEnabled();
    });
  }

  document.getElementById('clear-highlights').addEventListener('click', function () {
    recentAdds = {};
    saveRecentAdds();
    render();
    setMenuOpen(false);
  });

  document.getElementById('reset-counter').addEventListener('click', function () {
    blockedCount = 0;
    pendingResetNonce = Math.max(Date.now(), pendingResetNonce + 1, countResetNonce + 1);
    fillTotalCount(0);
    if (storageSync) {
      storageSync.schedule();
    }
    setMenuOpen(false);
  });
});
