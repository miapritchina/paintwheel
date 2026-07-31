// Persistence: snapshots the dried painting + workbench state to IndexedDB
// so a page reload (or PWA relaunch) restores where you left off. Wet washes
// are stored as their deposited pigment — anything still flowing "dries"
// across a reload, exactly like leaving a real painting overnight.

'use strict';

const STORE = (() => {
  const DB = 'paintwheel';
  const KV = 'kv';

  function db() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(KV);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  async function put(key, val) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(KV, 'readwrite');
      tx.objectStore(KV).put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  async function get(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const rq = d.transaction(KV).objectStore(KV).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  async function clear() {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(KV, 'readwrite');
      tx.objectStore(KV).clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  return { put, get, clear };
})();
