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
  const toggleEnabled = document.getElementById('toggle-enabled');
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
  let muteTimer = null;
  let copyTimer = null;

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

  function iconX() {
    return iconSvg('M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2');
  }

  function iconCheck() {
    return iconSvg('M3.2 8.3l3 3.1 6.6-7');
  }

  function sameName(a, b) {
    return normalizeEntry(a).toLowerCase() === normalizeEntry(b).toLowerCase();
  }

  function clearConfirming() {
    if (confirmingName === null) {
      return;
    }
    confirmingName = null;
    render();
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

  function compareAlpha(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  }

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
      names.sort(function (a, b) {
        const diff = countFor(b) - countFor(a);
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
    renderCountsOnly();
    fillTotalCount(blockedCount);
  }

  function showSaveError() {
    resultNote.textContent = 'Could not save. Try again.';
    resultNote.hidden = false;
  }

  function isBlockedName(name) {
    return blockedUsers.some(function (existing) {
      return sameName(existing, name);
    });
  }

  function stripMutesNowBlocked() {
    const next = mutedUsers.filter(function (entry) {
      return !isBlockedName(entry.name);
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
    if (n > 0) {
      el.textContent = n.toLocaleString();
    } else {
      el.textContent = '';
    }
    el.dataset.count = String(n);
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
    el.textContent = n.toLocaleString();
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
      const nameEl = rows[i].querySelector('.user-name');
      const countEl = rows[i].querySelector('.user-count');
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
      const nameEl = muteRows[j].querySelector('.user-name');
      const countEl = muteRows[j].querySelector('.user-count');
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

    listEl.replaceChildren();
    sortedBlockedUsers().forEach(function (name) {
      const confirming = confirmingName !== null && sameName(name, confirmingName);
      const li = document.createElement('li');
      li.className = confirming ? 'user-row is-confirming' : 'user-row';

      const span = document.createElement('span');
      span.className = 'user-name';
      span.textContent = name;
      span.title = name;

      const count = document.createElement('span');
      count.className = 'user-count';
      fillCount(count, name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.append(confirming ? iconCheck() : iconX());
      remove.setAttribute(
        'aria-label',
        confirming ? 'Confirm remove ' + name : 'Remove ' + name
      );
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        if (!confirming) {
          confirmingName = name;
          render();
          const next = listEl.querySelector('.is-confirming .remove');
          if (next) {
            next.focus();
          }
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

      li.append(span, count, remove);
      listEl.append(li);
    });

    emptyEl.hidden = blockedUsers.length > 0;
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
      const nameEl = rows[i].querySelector('.user-name');
      const timeEl = rows[i].querySelector('.mute-remaining');
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
    mutedListEl.replaceChildren();
    mutedUsers.forEach(function (entry) {
      const li = document.createElement('li');
      li.className = 'user-row mute-row';

      const span = document.createElement('span');
      span.className = 'user-name';
      span.textContent = entry.name;
      span.title = entry.name;

      const count = document.createElement('span');
      count.className = 'user-count';
      fillCount(count, entry.name);

      const time = document.createElement('span');
      time.className = 'mute-remaining';
      time.textContent = formatRemaining(entry.until - now);
      time.title = 'Time remaining';

      const unmute = document.createElement('button');
      unmute.type = 'button';
      unmute.className = 'unmute';
      unmute.textContent = 'Unmute';
      unmute.setAttribute('aria-label', 'Unmute ' + entry.name);
      unmute.addEventListener('click', function (event) {
        event.stopPropagation();
        unmuteUser(entry.name);
      });

      li.append(span, count, time, unmute);
      mutedListEl.append(li);
    });

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
    let mutesChanged = false;

    let hitLimit = false;
    parts.forEach(function (part) {
      const name = normalizeEntry(part);
      if (!name) {
        return;
      }
      const exists = blockedUsers.some(function (existing) {
        return normalizeEntry(existing).toLowerCase() === name.toLowerCase();
      });
      if (exists) {
        duplicate += 1;
        return;
      }
      if (blockedUsers.length >= RCB.MAX_BLOCKED) {
        hitLimit = true;
        return;
      }
      const nextMutes = mutedUsers.filter(function (entry) {
        return countKey(entry.name) !== name.toLowerCase();
      });
      if (nextMutes.length !== mutedUsers.length) {
        mutedUsers = nextMutes;
        mutesChanged = true;
      }
      blockedUsers.push(name);
      added += 1;
    });

    showResult(added, duplicate, bulk);
    if (hitLimit) {
      const prefix = resultNote.hidden || !resultNote.textContent ? '' : resultNote.textContent + ' ';
      resultNote.textContent = prefix + 'The block list is full.';
      resultNote.hidden = false;
    }

    if (added > 0) {
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

  function setPasteOpen(open) {
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
    if (event.key !== 'Enter') {
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
      if (changes.blockListSort) {
        const next = changes.blockListSort.newValue;
        if (typeof next === 'string' && SORT_MODES.indexOf(next) !== -1) {
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
    chrome.storage.local.get(RCB.STORAGE_FIELDS.concat(['filteringEnabled', 'blockListSort']), function (result) {
      if (chrome.runtime.lastError) {
        showSaveError();
        syncFilteringEnabledUI();
        render();
        renderMuted();
        fillTotalCount(0);
        return;
      }
      filteringEnabled = !result || result.filteringEnabled !== false;
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

  if (toggleEnabled) {
    toggleEnabled.addEventListener('click', function () {
      filteringEnabled = !filteringEnabled;
      persistFilteringEnabled();
    });
  }

  document.getElementById('reset-counter').addEventListener('click', function () {
    blockedCount = 0;
    pendingResetNonce = Math.max(Date.now(), pendingResetNonce + 1, countResetNonce + 1);
    fillTotalCount(0);
    if (storageSync) {
      storageSync.schedule();
    }
  });
});
