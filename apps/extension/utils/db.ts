const DB_NAME = 'scribetab';
const DB_VERSION = 3; // v1: audioChunks. v2: + segments. v3: sessions + re-keyed chunks.
export const CHUNKS_STORE = 'audioChunks';
export const SEGMENTS_STORE = 'segments';
export const SESSIONS_STORE = 'sessions';

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

        if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
          const store = db.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' });
          store.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        }

        // v3 re-keys audioChunks from `index` to composite [sessionId, index].
        // Pre-release: drop legacy chunk rows rather than migrate them —
        // v1/v2 recordings had no sessionId, so they cannot be re-homed.
        if (oldVersion > 0 && oldVersion < 3 && db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.deleteObjectStore(CHUNKS_STORE);
        }
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const store = db.createObjectStore(CHUNKS_STORE, { keyPath: ['sessionId', 'index'] });
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
