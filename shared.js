// shared.js — username normalization and storage merges shared by the popup and content script.
(function (root) {
  const MAX_NAME_LENGTH = 200;
  const MAX_BLOCKED = 2000;
  const MAX_MUTED = 500;
  const MAX_MUTE_MINUTES = 525600;
  const MAX_COUNTED = 3000;
  const MAX_SYNC_RETRIES = 8;
  const STORAGE_FIELDS = [
    'blockedUsers',
    'mutedUsers',
    'blockedUserCounts',
    'blockedCount',
    'countedMessages',
    'countResetNonce'
  ];

  function normalizeEntry(entry) {
    if (typeof entry !== 'string') {
      return '';
    }
    const cleaned = entry
      .replace(/[\u0000-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
      .trim()
      .replace(/^@+/, '');
    if (!cleaned || cleaned.length > MAX_NAME_LENGTH) {
      return '';
    }
    return cleaned;
  }

  function countKey(entry) {
    return normalizeEntry(entry).toLowerCase();
  }

  function sanitizeMessageId(id) {
    if (typeof id !== 'string') {
      return '';
    }
    const trimmed = id.trim();
    if (!/^[A-Za-z0-9:_.+\/=-]{1,80}$/.test(trimmed)) {
      return '';
    }
    return trimmed;
  }

  function copyCounts(value) {
    const counts = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return counts;
    }
    Object.keys(value).forEach(function (key) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      const n = desc ? desc.value : undefined;
      if (typeof n === 'number' && isFinite(n) && n > 0) {
        counts[key] = Math.floor(n);
      }
    });
    return counts;
  }

  function plainCounts(counts) {
    const out = {};
    Object.keys(counts).forEach(function (key) {
      Object.defineProperty(out, key, {
        value: counts[key],
        enumerable: true,
        writable: true,
        configurable: true
      });
    });
    return out;
  }

  function normalizeUsers(value) {
    const list = [];
    const seen = Object.create(null);
    if (!Array.isArray(value)) {
      return list;
    }
    value.forEach(function (entry) {
      const name = normalizeEntry(entry);
      const key = name.toLowerCase();
      if (!key || seen[key]) {
        return;
      }
      seen[key] = true;
      list.push(name);
    });
    if (list.length > MAX_BLOCKED) {
      return list.slice(0, MAX_BLOCKED);
    }
    return list;
  }

  function normalizeMutes(value) {
    const list = [];
    const seen = Object.create(null);
    if (!Array.isArray(value)) {
      return list;
    }
    value.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const name = normalizeEntry(entry.name);
      const until = entry.until;
      if (!name || typeof until !== 'number' || !isFinite(until)) {
        return;
      }
      const key = name.toLowerCase();
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      list.push({ name: name, until: until });
    });
    if (list.length > MAX_MUTED) {
      return list.slice(0, MAX_MUTED);
    }
    return list;
  }

  function normalizeTotal(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  function normalizeNonce(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return 0;
    }
    return Math.floor(value);
  }

  function normalizeCounted(value) {
    const list = [];
    const seen = Object.create(null);
    if (!Array.isArray(value)) {
      return list;
    }
    value.forEach(function (pair) {
      if (!Array.isArray(pair) || pair.length < 2) {
        return;
      }
      const id = sanitizeMessageId(pair[0]);
      const user = countKey(pair[1]);
      if (!id || !user || seen[id]) {
        return;
      }
      seen[id] = true;
      list.push([id, user]);
    });
    if (list.length > MAX_COUNTED) {
      return list.slice(list.length - MAX_COUNTED);
    }
    return list;
  }

  function emptyState() {
    return {
      blockedUsers: [],
      mutedUsers: [],
      blockedUserCounts: Object.create(null),
      blockedCount: 0,
      countedMessages: [],
      countResetNonce: 0,
      absoluteReset: false
    };
  }

  function normalizeState(raw) {
    const source = raw || {};
    return {
      blockedUsers: normalizeUsers(source.blockedUsers),
      mutedUsers: normalizeMutes(source.mutedUsers),
      blockedUserCounts: copyCounts(source.blockedUserCounts),
      blockedCount: normalizeTotal(source.blockedCount),
      countedMessages: normalizeCounted(source.countedMessages),
      countResetNonce: normalizeNonce(source.countResetNonce),
      absoluteReset: source.absoluteReset === true
    };
  }

  function cloneState(state) {
    return normalizeState(state);
  }

  function userMap(list) {
    const map = Object.create(null);
    normalizeUsers(list).forEach(function (name) {
      map[name.toLowerCase()] = name;
    });
    return map;
  }

  function muteMap(list) {
    const map = Object.create(null);
    normalizeMutes(list).forEach(function (entry) {
      map[entry.name.toLowerCase()] = { name: entry.name, until: entry.until };
    });
    return map;
  }

  function countedMap(list) {
    const map = Object.create(null);
    normalizeCounted(list).forEach(function (pair) {
      map[pair[0]] = pair[1];
    });
    return map;
  }

  function listedKeys(users, mutes) {
    const listed = Object.create(null);
    normalizeUsers(users).forEach(function (name) {
      listed[name.toLowerCase()] = true;
    });
    normalizeMutes(mutes).forEach(function (entry) {
      listed[entry.name.toLowerCase()] = true;
    });
    return listed;
  }

  function mergeUsers(stored, baseline, desired) {
    const base = userMap(baseline);
    const des = userMap(desired);
    const removed = Object.create(null);
    Object.keys(base).forEach(function (key) {
      if (!des[key]) {
        removed[key] = true;
      }
    });
    const out = [];
    const seen = Object.create(null);
    normalizeUsers(stored).forEach(function (name) {
      const key = name.toLowerCase();
      if (removed[key] || seen[key]) {
        return;
      }
      seen[key] = true;
      out.push(name);
    });
    Object.keys(des).forEach(function (key) {
      if (seen[key] || removed[key] || base[key]) {
        return;
      }
      seen[key] = true;
      out.push(des[key]);
    });
    if (out.length > MAX_BLOCKED) {
      return out.slice(0, MAX_BLOCKED);
    }
    return out;
  }

  function mergeMutes(stored, baseline, desired) {
    const base = muteMap(baseline);
    const des = muteMap(desired);
    const storedMap = muteMap(stored);
    const removed = Object.create(null);
    Object.keys(base).forEach(function (key) {
      if (!des[key] && (!storedMap[key] || storedMap[key].until === base[key].until)) {
        removed[key] = true;
      }
    });
    const out = [];
    const seen = Object.create(null);
    Object.keys(storedMap).forEach(function (key) {
      if (removed[key] || seen[key]) {
        return;
      }
      seen[key] = true;
      if (base[key] && des[key] && base[key].until !== des[key].until) {
        out.push({ name: des[key].name, until: des[key].until });
      } else {
        out.push({ name: storedMap[key].name, until: storedMap[key].until });
      }
    });
    Object.keys(des).forEach(function (key) {
      if (seen[key] || removed[key]) {
        return;
      }
      const changed = base[key] && des[key].until !== base[key].until && !storedMap[key];
      if (!base[key] || changed) {
        seen[key] = true;
        out.push({ name: des[key].name, until: des[key].until });
      }
    });
    if (out.length > MAX_MUTED) {
      return out.slice(0, MAX_MUTED);
    }
    return out;
  }

  function capCounted(list) {
    const normalized = normalizeCounted(list);
    if (normalized.length > MAX_COUNTED) {
      return normalized.slice(normalized.length - MAX_COUNTED);
    }
    return normalized;
  }

  function mergeCounted(stored, baseline, desired, listed) {
    const base = countedMap(baseline);
    const des = countedMap(desired);
    const out = [];
    const seen = Object.create(null);
    normalizeCounted(stored).forEach(function (pair) {
      const id = pair[0];
      const user = pair[1];
      if (seen[id] || !listed[user]) {
        return;
      }
      if (base[id] && !des[id]) {
        return;
      }
      seen[id] = true;
      out.push([id, user]);
    });
    Object.keys(des).forEach(function (id) {
      const user = des[id];
      if (seen[id] || !listed[user] || base[id]) {
        return;
      }
      seen[id] = true;
      out.push([id, user]);
    });
    return capCounted(out);
  }

  function mergeCounts(storedCounts, baselineCounts, desiredCounts, storedCounted, baselineCounted, desiredCounted, listed) {
    const stored = copyCounts(storedCounts);
    const base = copyCounts(baselineCounts);
    const des = copyCounts(desiredCounts);
    const out = copyCounts(stored);
    const baseIds = countedMap(baselineCounted);
    const desIds = countedMap(desiredCounted);
    const storedIds = countedMap(storedCounted);
    const removed = Object.create(null);

    Object.keys(base).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(des, key)) {
        removed[key] = true;
      }
    });

    Object.keys(desIds).forEach(function (id) {
      const user = desIds[id];
      if (!user || !listed[user] || removed[user] || baseIds[id] || storedIds[id]) {
        return;
      }
      out[user] = (out[user] || 0) + 1;
    });

    Object.keys(des).forEach(function (key) {
      if (!listed[key] || removed[key]) {
        return;
      }
      const delta = des[key] - (base[key] || 0);
      if (delta <= 0) {
        return;
      }
      let newIds = 0;
      Object.keys(desIds).forEach(function (id) {
        if (desIds[id] === key && !baseIds[id]) {
          newIds += 1;
        }
      });
      const idLess = delta - newIds;
      if (idLess > 0) {
        out[key] = (out[key] || 0) + idLess;
      }
    });

    Object.keys(removed).forEach(function (key) {
      delete out[key];
    });
    Object.keys(out).forEach(function (key) {
      if (!listed[key]) {
        delete out[key];
      }
    });
    return out;
  }

  function sumIncreases(before, after) {
    let total = 0;
    Object.keys(after).forEach(function (key) {
      const delta = (after[key] || 0) - (before[key] || 0);
      if (delta > 0) {
        total += delta;
      }
    });
    return total;
  }

  function mergeAll(storedRaw, baselineRaw, desiredRaw) {
    const stored = normalizeState(storedRaw);
    const baseline = normalizeState(baselineRaw);
    const desired = normalizeState(desiredRaw);
    const absoluteReset = !!(desiredRaw && desiredRaw.absoluteReset);
    const blockedUsers = mergeUsers(stored.blockedUsers, baseline.blockedUsers, desired.blockedUsers);
    const mutedUsers = mergeMutes(stored.mutedUsers, baseline.mutedUsers, desired.mutedUsers);
    const listed = listedKeys(blockedUsers, mutedUsers);
    // A reset seen in storage (stored nonce > baseline) only zeroed stored.blockedCount, so the
    // normal three-way merge already keeps this context's increments since its baseline on top of it.
    // Math.max yields stored.countResetNonce in that case.
    let countResetNonce = Math.max(stored.countResetNonce, baseline.countResetNonce);
    const countedMessages = mergeCounted(
      stored.countedMessages,
      baseline.countedMessages,
      desired.countedMessages,
      listed
    );
    const blockedUserCounts = mergeCounts(
      stored.blockedUserCounts,
      baseline.blockedUserCounts,
      desired.blockedUserCounts,
      stored.countedMessages,
      baseline.countedMessages,
      desired.countedMessages,
      listed
    );
    const added = sumIncreases(stored.blockedUserCounts, blockedUserCounts);
    const blockedCount = (absoluteReset ? 0 : stored.blockedCount) + added;
    if (absoluteReset) {
      countResetNonce = Math.max(countResetNonce, normalizeNonce(desiredRaw.countResetNonce));
    }

    return {
      blockedUsers: blockedUsers,
      mutedUsers: mutedUsers,
      blockedUserCounts: blockedUserCounts,
      blockedCount: blockedCount,
      countedMessages: countedMessages,
      countResetNonce: countResetNonce,
      absoluteReset: false
    };
  }

  function sameUsers(a, b) {
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

  function sameMutes(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].name !== b[i].name || a[i].until !== b[i].until) {
        return false;
      }
    }
    return true;
  }

  function sameCounts(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (let i = 0; i < aKeys.length; i++) {
      if (a[aKeys[i]] !== b[aKeys[i]]) {
        return false;
      }
    }
    return true;
  }

  function sameCounted(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) {
        return false;
      }
    }
    return true;
  }

  function sameState(a, b) {
    const left = normalizeState(a);
    const right = normalizeState(b);
    return sameUsers(left.blockedUsers, right.blockedUsers) &&
      sameMutes(left.mutedUsers, right.mutedUsers) &&
      sameCounts(left.blockedUserCounts, right.blockedUserCounts) &&
      left.blockedCount === right.blockedCount &&
      left.countResetNonce === right.countResetNonce &&
      sameCounted(left.countedMessages, right.countedMessages);
  }

  function toStorage(state) {
    const norm = normalizeState(state);
    return {
      blockedUsers: norm.blockedUsers.slice(),
      mutedUsers: norm.mutedUsers.map(function (entry) {
        return { name: entry.name, until: entry.until };
      }),
      blockedUserCounts: plainCounts(norm.blockedUserCounts),
      blockedCount: norm.blockedCount,
      countedMessages: norm.countedMessages.map(function (pair) {
        return [pair[0], pair[1]];
      }),
      countResetNonce: norm.countResetNonce
    };
  }

  const LOCK_FIELDS = ['syncLock', 'syncLockUntil'];

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function chromeLocal() {
    return {
      get: function () {
        return new Promise(function (resolve, reject) {
          chrome.storage.local.get(STORAGE_FIELDS.concat(LOCK_FIELDS), function (result) {
            const err = chrome.runtime.lastError;
            if (err) {
              reject(new Error(err.message));
              return;
            }
            resolve(result || {});
          });
        });
      },
      set: function (payload) {
        return new Promise(function (resolve, reject) {
          chrome.storage.local.set(payload, function () {
            const err = chrome.runtime.lastError;
            if (err) {
              reject(new Error(err.message));
              return;
            }
            resolve();
          });
        });
      }
    };
  }

  function createSync(handlers) {
    const get = handlers.get;
    const set = handlers.set;
    const read = handlers.read;
    const write = handlers.write;
    const onApplied = handlers.onApplied || function () {};
    const onError = handlers.onError || function () {};
    const noteBaseline = handlers.noteBaseline || function () {};
    let baseline = emptyState();
    let ready = false;
    let scheduled = false;
    let busy = 0;
    let applying = false;
    let retries = 0;
    let pendingExternal = false;
    let chain = Promise.resolve();
    const lockOwner = Math.random().toString(36).slice(2) + Date.now().toString(36);

    function setBaseline(state) {
      baseline = cloneState(state);
      noteBaseline(baseline);
    }

    function schedule() {
      if (!ready || applying || scheduled) {
        return;
      }
      scheduled = true;
      chain = chain.then(run, run).then(flushExternal, flushExternal);
    }

    function finishBusy() {
      busy -= 1;
    }

    // Advisory, best-effort lock: chrome.storage has no compare-and-set, so two contexts can
    // still occasionally both believe they hold it. Correctness relies on mergeAll's 3-way
    // merge plus run()'s read-back after set (a lost write is detected and retried), not on
    // this lock; the settle delay and jitter only make collisions rarer.
    async function acquireLock() {
      // Give up before the 4s lock TTL so a waiter never outlasts a live holder's lock.
      const deadline = Date.now() + 3500;
      for (let attempt = 0; attempt < 25 && Date.now() < deadline; attempt++) {
        const cur = await get();
        const now = Date.now();
        const until = normalizeNonce(cur.syncLockUntil);
        const heldByOther = !!(cur.syncLock && cur.syncLock !== lockOwner && until > now);
        if (!heldByOther) {
          await set({ syncLock: lockOwner, syncLockUntil: now + 4000 });
          // Let a racing writer's value land before reading back.
          await wait(15 + Math.random() * 25);
          const check = await get();
          if (check.syncLock === lockOwner) {
            return true;
          }
        }
        await wait(20 + attempt * 15 + Math.random() * 20);
      }
      return false;
    }

    async function releaseLock() {
      const cur = await get();
      if (cur.syncLock === lockOwner) {
        await set({ syncLock: '', syncLockUntil: 0 });
      }
    }

    async function run() {
      scheduled = false;
      if (!ready) {
        return;
      }
      const preview = cloneState(read());
      if (sameState(preview, baseline) && !preview.absoluteReset) {
        return;
      }
      if (retries > MAX_SYNC_RETRIES) {
        retries = 0;
        onError(new Error('Could not save.'));
        return;
      }
      busy += 1;
      let locked = false;
      let applied = null;
      try {
        locked = await acquireLock();
        if (!locked) {
          retries += 1;
          if (retries <= MAX_SYNC_RETRIES) {
            schedule();
          } else {
            retries = 0;
            onError(new Error('Could not save.'));
          }
          return;
        }
        const snap = cloneState(read());
        const stored = await get();
        if (sameState(snap, baseline) && !snap.absoluteReset) {
          if (!sameState(stored, baseline)) {
            applying = true;
            setBaseline(stored);
            write(normalizeState(stored));
            applying = false;
            applied = normalizeState(stored);
          }
          retries = 0;
          return;
        }
        const merged = mergeAll(stored, baseline, snap);
        if (sameState(merged, stored) && !snap.absoluteReset) {
          setBaseline(stored);
          retries = 0;
          const now = read();
          if (!sameState(now, snap) || now.absoluteReset) {
            schedule();
          }
          if (!sameState(read(), stored)) {
            applying = true;
            write(normalizeState(stored));
            applying = false;
            applied = normalizeState(stored);
          }
          return;
        }
        await set(toStorage(merged));
        const fresh = await get();
        if (!sameState(fresh, merged)) {
          retries += 1;
          if (retries <= MAX_SYNC_RETRIES) {
            schedule();
          } else {
            retries = 0;
            onError(new Error('Could not save.'));
          }
          return;
        }
        retries = 0;
        const now = read();
        if (sameState(now, snap)) {
          applying = true;
          setBaseline(merged);
          write(merged);
          applying = false;
          applied = merged;
          return;
        }
        const rebased = mergeAll(merged, snap, read());
        applying = true;
        setBaseline(merged);
        write(rebased);
        applying = false;
        applied = rebased;
        schedule();
      } catch (err) {
        retries += 1;
        onError(err);
        if (retries <= MAX_SYNC_RETRIES) {
          schedule();
        }
      } finally {
        if (locked) {
          try {
            await releaseLock();
          } catch (err) {
            onError(err);
          }
        }
        finishBusy();
        if (applied) {
          onApplied();
        }
      }
    }

    function flushExternal() {
      if (pendingExternal) {
        pendingExternal = false;
        handleExternal();
      }
    }

    function handleExternal() {
      if (!ready) {
        return;
      }
      if (scheduled || busy || applying) {
        pendingExternal = true;
        return;
      }
      const now = read();
      if (!sameState(now, baseline) || now.absoluteReset) {
        schedule();
        return;
      }
      busy += 1;
      get().then(function (stored) {
        finishBusy();
        if (scheduled || applying) {
          pendingExternal = true;
          return;
        }
        const live = read();
        if (!sameState(live, baseline) || live.absoluteReset) {
          schedule();
          return;
        }
        if (sameState(stored, baseline)) {
          return;
        }
        applying = true;
        setBaseline(stored);
        write(normalizeState(stored));
        applying = false;
        onApplied();
      }).catch(function (err) {
        finishBusy();
        onError(err);
      }).then(flushExternal);
    }

    return {
      schedule: schedule,
      start: function (initial) {
        const local = cloneState(read());
        const edited = local.blockedUsers.length > 0 || local.mutedUsers.length > 0 || local.absoluteReset;
        const norm = normalizeState(initial);
        applying = true;
        setBaseline(norm);
        write(norm);
        if (edited) {
          write(mergeAll(norm, emptyState(), local));
        }
        applying = false;
        ready = true;
        onApplied();
        if (edited || !sameState(read(), baseline) || read().absoluteReset) {
          schedule();
        }
      },
      handleExternal: handleExternal
    };
  }

  root.RCB = {
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_BLOCKED: MAX_BLOCKED,
    MAX_MUTED: MAX_MUTED,
    MAX_MUTE_MINUTES: MAX_MUTE_MINUTES,
    STORAGE_FIELDS: STORAGE_FIELDS,
    normalizeEntry: normalizeEntry,
    countKey: countKey,
    sanitizeMessageId: sanitizeMessageId,
    normalizeUsers: normalizeUsers,
    normalizeMutes: normalizeMutes,
    normalizeTotal: normalizeTotal,
    normalizeNonce: normalizeNonce,
    copyCounts: copyCounts,
    normalizeState: normalizeState,
    emptyState: emptyState,
    mergeAll: mergeAll,
    sameState: sameState,
    toStorage: toStorage,
    chromeLocal: chromeLocal,
    createSync: createSync
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
