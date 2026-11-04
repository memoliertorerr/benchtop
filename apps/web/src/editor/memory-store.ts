/**
 * BT120: each board's EEPROM or flash data — what its firmware stored (Preferences, EEPROM,
 * LittleFS) — kept outside the project document, by board part id as the firmware store keeps
 * bytes, so a reload of the page finds a counter where the board left it. Its own IndexedDB
 * database (`benchtop-memory`): the firmware store's schema stays as it is. The current project's
 * only: opening another clears it. Every access is in try/catch; without IndexedDB it lives for
 * the session only. What comes back from storage is checked (it can rot); the worker checks again.
 */

import type { MemorySector } from '../sim/protocol.ts';

const DB_NAME = 'benchtop-memory';
const STORE = 'memory';
const memory = new Map<string, MemorySector[]>();
let db: Promise<IDBDatabase | null> | null = null;
let epoch = 0;

function database(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const opened = await database();
    if (opened === null) return undefined;
    return await new Promise<T | undefined>((resolve) => {
      const request = work(opened.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  } catch (error) {
    console.warn('benchtop: memory storage failed', error);
    return undefined;
  }
}

/** Saved sectors as storage returned them, or undefined when they aren't what this store writes. */
export function checkSectors(value: unknown): MemorySector[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MemorySector[] = [];
  for (const sector of value) {
    const s = sector as Partial<MemorySector> | null;
    if (typeof s !== 'object' || s === null || !Number.isInteger(s.offset) || (s.offset as number) < 0 || !(s.bytes instanceof Uint8Array)) return undefined;
    out.push({ offset: s.offset as number, bytes: s.bytes });
  }
  return out;
}

const copy = (sectors: readonly MemorySector[]): MemorySector[] => sectors.map((s) => ({ offset: s.offset, bytes: s.bytes.slice() }));

export const memoryStore = {
  /** Moves on at every `clear` (another project): a save read before it is dropped. */
  get epoch(): number {
    return epoch;
  },
  get(board: string): MemorySector[] | undefined {
    return memory.get(board);
  },
  /** Each board of `boards` that has saved data, for the worker (copies: it takes them). */
  forBoards(boards: readonly string[]): Record<string, MemorySector[]> {
    const out: Record<string, MemorySector[]> = {};
    for (const board of boards) {
      const sectors = memory.get(board);
      if (sectors !== undefined && sectors.length > 0) out[board] = copy(sectors);
    }
    return out;
  },
  /** `since`: the epoch the data was read in — a clear since then drops it (it was the old project's). */
  async put(board: string, sectors: readonly MemorySector[], since = epoch): Promise<void> {
    if (since !== epoch) return;
    if (sectors.length === 0) {
      await this.delete(board);
      return;
    }
    const kept = copy(sectors);
    memory.set(board, kept);
    await transact('readwrite', (store) => store.put(kept, board));
  },
  async delete(board: string): Promise<void> {
    if (!memory.delete(board)) return;
    await transact('readwrite', (store) => store.delete(board));
  },
  /** Another project opened: no board's data carries over to it. */
  async clear(): Promise<void> {
    epoch++;
    memory.clear();
    await transact('readwrite', (store) => store.clear());
  },
  /** Reads every board's saved data into memory (at startup). */
  async loadAll(): Promise<void> {
    const keys = await transact('readonly', (store) => store.getAllKeys());
    const values = await transact('readonly', (store) => store.getAll());
    if (keys === undefined || values === undefined) return;
    keys.forEach((key, i) => {
      const sectors = checkSectors(values[i]);
      if (typeof key === 'string' && sectors !== undefined) memory.set(key, sectors);
    });
  },
};
