// IndexedDB ラッパー: 時代・人物・出来事(参加者つき)を永続化する
const DB_NAME = 'JinbutsurokuDB';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('eras')) {
        const store = db.createObjectStore('eras', { keyPath: 'id', autoIncrement: true });
        store.createIndex('startYear', 'startYear', { unique: false });
      }
      if (!db.objectStoreNames.contains('people')) {
        const store = db.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
        store.createIndex('eraId', 'eraId', { unique: false });
      }
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        store.createIndex('year', 'year', { unique: false });
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
  // ---- 時代 ----
  async addEra(era) {
    const store = await tx('eras', 'readwrite');
    return promisifyRequest(store.add(era));
  },
  async getAllEras() {
    const store = await tx('eras', 'readonly');
    const list = await promisifyRequest(store.getAll());
    return list.sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  },
  async getEra(id) {
    const store = await tx('eras', 'readonly');
    return promisifyRequest(store.get(id));
  },
  async updateEra(era) {
    const store = await tx('eras', 'readwrite');
    return promisifyRequest(store.put(era));
  },
  async deleteEra(id) {
    const store = await tx('eras', 'readwrite');
    return promisifyRequest(store.delete(id));
  },

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
    return list.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
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
  // 指定した人物が参加している出来事を、年の昇順で返す
  async getEventsForPerson(personId) {
    const all = await DB.getAllEvents();
    return all.filter((ev) => (ev.participants || []).some((p) => p.personId === personId));
  },
};
