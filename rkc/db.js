/* Слой данных РКЦ: IndexedDB.
   Хранилища:
   - abonents  — карточки абонентов (ключ id, индекс по лицевому счёту)
   - readings  — показания счётчиков за месяц (ключ [aid, ym])
   - charges   — строки начислений (автоключ, индексы aid, ym, [ym, service])
   - payments  — платежи (автоключ, индексы aid, date)
   - kv        — настройки, агрегаты, служебные записи */
'use strict';

const DB = (() => {
  const NAME = 'rkc-kedrovy', VERSION = 1;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const ab = d.createObjectStore('abonents', { keyPath: 'id' });
        ab.createIndex('account', 'account', { unique: true });
        d.createObjectStore('readings', { keyPath: ['aid', 'ym'] });
        const ch = d.createObjectStore('charges', { keyPath: 'id', autoIncrement: true });
        ch.createIndex('aid', 'aid');
        ch.createIndex('ym', 'ym');
        ch.createIndex('ym_service', ['ym', 'service']);
        const pm = d.createObjectStore('payments', { keyPath: 'id', autoIncrement: true });
        pm.createIndex('aid', 'aid');
        pm.createIndex('date', 'date');
        d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (stores, mode) => db.transaction(stores, mode);
  const reqp = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const txdone = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

  async function getAll(store) { return reqp(tx([store], 'readonly').objectStore(store).getAll()); }
  async function get(store, key) { return reqp(tx([store], 'readonly').objectStore(store).get(key)); }
  async function put(store, value) {
    const t = tx([store], 'readwrite');
    t.objectStore(store).put(value);
    return txdone(t);
  }
  async function del(store, key) {
    const t = tx([store], 'readwrite');
    t.objectStore(store).delete(key);
    return txdone(t);
  }

  /* Пакетная запись: одна транзакция на порцию — быстро даже для десятков тысяч строк. */
  async function bulkPut(store, values, chunk = 4000, onProgress) {
    for (let i = 0; i < values.length; i += chunk) {
      const t = tx([store], 'readwrite');
      const os = t.objectStore(store);
      for (let j = i; j < Math.min(i + chunk, values.length); j++) os.put(values[j]);
      await txdone(t);
      if (onProgress) onProgress(Math.min(i + chunk, values.length), values.length);
    }
  }

  async function kvGet(k, fallback) {
    const row = await get('kv', k);
    return row ? row.v : fallback;
  }
  async function kvSet(k, v) { return put('kv', { k, v }); }

  /* Страница записей по индексу (диапазону), с пропуском offset — для пагинации. */
  function pageByIndex(store, indexName, range, offset, limit) {
    return new Promise((resolve, reject) => {
      const out = [];
      const idx = tx([store], 'readonly').objectStore(store).index(indexName);
      let skipped = false;
      const req = idx.openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        if (!skipped && offset > 0) { skipped = true; return cur.advance(offset); }
        out.push(cur.value);
        if (out.length >= limit) return resolve(out);
        cur.continue();
      };
    });
  }

  function countByIndex(store, indexName, range) {
    return reqp(tx([store], 'readonly').objectStore(store).index(indexName).count(range));
  }

  async function byIndex(store, indexName, key) {
    return reqp(tx([store], 'readonly').objectStore(store).index(indexName).getAll(key));
  }

  async function wipe() {
    db.close(); db = null;
    await new Promise((res, rej) => {
      const req = indexedDB.deleteDatabase(NAME);
      req.onsuccess = res; req.onerror = () => rej(req.error); req.onblocked = res;
    });
    return open();
  }

  return { open, getAll, get, put, del, bulkPut, kvGet, kvSet, pageByIndex, countByIndex, byIndex, wipe };
})();

if (typeof window !== 'undefined') window.DB = DB;
