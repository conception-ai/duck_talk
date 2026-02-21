/**
 * IndexedDB persistence for utterance recordings.
 * Thin CRUD wrapper — used by recorder.ts (write) and recordings page (read).
 */

const DB_NAME = 'claude-talks-recordings';
const STORE = 'utterances';

export interface StoredRecording {
  id?: number;
  transcript: string;
  chunks: { ts: number; data: string }[];
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRecording(
  transcript: string,
  chunks: { ts: number; data: string }[],
): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).add({ transcript, chunks, createdAt: Date.now() });
  db.close();
}

export async function getAllRecordings(): Promise<StoredRecording[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function deleteRecording(id: number): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  db.close();
}

export async function clearAllRecordings(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  db.close();
}
