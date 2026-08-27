const DB_NAME = 'scribetab';
const DB_VERSION = 2; // v1: audioChunks. v2: + segments.
export const CHUNKS_STORE = 'audioChunks';
export const SEGMENTS_STORE = 'segments';

// Memoized: opening a connection per operation leaked one IDBDatabase per
// chunk (~80/hour meeting), and any lingering open connection would block a
// future onupgradeneeded (e.g. Phase 4's sessions re-key). onversionchange
// closes the memoized connection and clears the memo so the next call
// reopens against the new version instead of hanging as 'blocked'.
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: 'index' });
        }
        if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
          const store = db.createObjectStore(SEGMENTS_STORE, { keyPath: 'id' });
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
