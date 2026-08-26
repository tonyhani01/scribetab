export interface ChunkRow {
  index: number;
  sampleRate: number;
  startOffsetSamples: number; // cumulative samples before this chunk (session-relative timing)
  wav: ArrayBuffer;
  createdAt: number;
}

const DB_NAME = 'scribetab';
const DB_VERSION = 1;
const STORE = 'audioChunks';

// Memoized: opening a connection per operation leaked one IDBDatabase per
// chunk (~80/hour meeting), and any lingering open connection would block a
// future onupgradeneeded (e.g. Phase 4's sessions re-key). onversionchange
// closes the memoized connection and clears the memo so the next call
// reopens against the new version instead of hanging as 'blocked'.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'index' });
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

export async function putChunk(row: ChunkRow): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllChunks(): Promise<ChunkRow[]> {
  const db = await openDb();
  const rows = await new Promise<ChunkRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as ChunkRow[]);
    req.onerror = () => reject(req.error);
  });
  return rows.sort((a, b) => a.index - b.index);
}

export async function clearChunks(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
