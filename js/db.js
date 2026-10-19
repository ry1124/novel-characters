// IndexedDB ラッパー: 人物・出来事(参加者つき)を永続化する
const DB_NAME = 'JinbutsurokuDB';
const DB_VERSION = 3; // 2: 時代(eras)ストアを廃止(人物の生年〜没年に置き換え) 3: 組織(爵位など組織自体の情報)ストアを追加
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains('eras')) {
        db.deleteObjectStore('eras');
      }
      if (!db.objectStoreNames.contains('people')) {
        db.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('year', 'year', { unique: false });
      }
      // 組織のメンバーや役職は人物側に持たせたまま、組織そのものの情報(爵位の推移など)だけを組織名をキーにして持つ
      if (!db.objectStoreNames.contains('organizations')) {
        db.createObjectStore('organizations', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  // ---- 人物 ----
  async addPerson(person) {
    const store = await tx('people', 'readwrite');
    return promisifyRequest(store.add(person));
  },
  async getAllPeople() {
    const store = await tx('people', 'readonly');
    return promisifyRequest(store.getAll());
  },
  async getPerson(id) {
    const store = await tx('people', 'readonly');
    return promisifyRequest(store.get(id));
  },
  async updatePerson(person) {
    const store = await tx('people', 'readwrite');
    return promisifyRequest(store.put(person));
  },
  async deletePerson(id) {
    const store = await tx('people', 'readwrite');
    return promisifyRequest(store.delete(id));
  },

  // ---- 出来事(参加者つき) ----
  async addEvent(event) {
    const store = await tx('events', 'readwrite');
    return promisifyRequest(store.add(event));
  },
  async getAllEvents() {
    const store = await tx('events', 'readonly');
    const list = await promisifyRequest(store.getAll());
    const key = (e) => (e.year ?? 0) * 100 + (e.month ?? 0);
    return list.sort((a, b) => key(a) - key(b));
  },
  async getEvent(id) {
    const store = await tx('events', 'readonly');
    return promisifyRequest(store.get(id));
  },
  async updateEvent(event) {
    const store = await tx('events', 'readwrite');
    return promisifyRequest(store.put(event));
  },
  async deleteEvent(id) {
    const store = await tx('events', 'readwrite');
    return promisifyRequest(store.delete(id));
  },
  // ---- 組織(組織名がキー。{ name, peerages: [{ title, startYear }] }) ----
  async getAllOrganizations() {
    const store = await tx('organizations', 'readonly');
    return promisifyRequest(store.getAll());
  },
  async putOrganization(org) {
    const store = await tx('organizations', 'readwrite');
    return promisifyRequest(store.put(org));
  },
  async deleteOrganization(name) {
    const store = await tx('organizations', 'readwrite');
    return promisifyRequest(store.delete(name));
  },

  // 指定した人物が参加している出来事を、年の昇順で返す
  async getEventsForPerson(personId) {
    const all = await DB.getAllEvents();
    return all.filter((ev) => (ev.participants || []).some((p) => p.personId === personId));
  },
};
