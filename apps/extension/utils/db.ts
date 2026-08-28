const DB_NAME = 'scribetab';
const DB_VERSION = 5; // v1: audioChunks. v2: + segments. v3: sessions + re-keyed chunks. v4: captionCues. v5: highlights.
export const CHUNKS_STORE = 'audioChunks';
export const SEGMENTS_STORE = 'segments';
export const SESSIONS_STORE = 'sessions';
export const CAPTIONS_STORE = 'captionCues';
export const HIGHLIGHTS_STORE = 'highlights';

// Memoized: opening a connection per operation leaked one IDBDatabase per
// chunk (~80/hour meeting), and any lingering open connection would block a
// future onupgradeneeded. onversionchange closes the memoized connection and
// clears the memo so the next call reopens against the new version instead of
// hanging as 'blocked'.
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldVersion = event.oldVersion;

        // v3 re-keys audioChunks from `index` to composite [sessionId, index]
        // and introduces the sessions store. Pre-release: drop legacy chunk
        // and segment rows rather than migrate them — v1/v2 recordings had no
        // session rows, so leftover v2 segments would be searchable orphans
        // the Library cannot open.
        if (oldVersion > 0 && oldVersion < 3) {
          if (db.objectStoreNames.contains(CHUNKS_STORE)) db.deleteObjectStore(CHUNKS_STORE);
          if (db.objectStoreNames.contains(SEGMENTS_STORE)) db.deleteObjectStore(SEGMENTS_STORE);
        }

        if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
          const store = db.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const store = db.createObjectStore(CHUNKS_STORE, { keyPath: ['sessionId', 'index'] });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(CAPTIONS_STORE)) {
          const store = db.createObjectStore(CAPTIONS_STORE, { keyPath: 'id' });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) {
          const store = db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'id' });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

/** Close the memoized connection so tests can delete the database. */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    db.close();
  } catch {
    // open failed — still drop the memo
  }
  dbPromise = null;
}
