/**
 * Firmware bytes for each board, kept outside the project document (which stores only a
 * `FirmwareRef`). Persisted in IndexedDB by board part id; every access is in try/catch, and
 * when IndexedDB is unavailable the bytes live for the session only.
 */

import type { FirmwareImage } from '@benchtop/core';

export type FirmwareFormat = 'hex' | 'elf' | 'esp32-bin';

/** Files larger than this are refused before they are read. */
export const MAX_FIRMWARE_BYTES = 4 * 1024 * 1024;

export interface StoredFirmware {
  name: string;
  format: FirmwareFormat;
  bytes: Uint8Array;
  /** For an inline sketch's build (BT42): the source it was compiled from (`sourceHash`). */
  source?: string;
}

/** The firmware format a file name implies, or undefined. */
export function formatOf(fileName: string): FirmwareFormat | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.hex')) return 'hex';
  if (lower.endsWith('.elf')) return 'elf';
  if (lower.endsWith('.bin')) return 'esp32-bin';
  return undefined;
}

/** What the worker loads for stored firmware. */
export function toImage(firmware: StoredFirmware): FirmwareImage {
  switch (firmware.format) {
    case 'hex':
      return { format: 'hex', text: new TextDecoder().decode(firmware.bytes) };
    case 'elf':
      return { format: 'elf', bytes: firmware.bytes };
    case 'esp32-bin':
      return { format: 'esp32-bin', app: firmware.bytes };
  }
}

const DB_NAME = 'benchtop';
const STORE = 'firmware';
const memory = new Map<string, StoredFirmware>();
let db: Promise<IDBDatabase | null> | null = null;

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
    console.warn('benchtop: firmware storage failed', error);
    return undefined;
  }
}

export const firmwareStore = {
  get(board: string): StoredFirmware | undefined {
    return memory.get(board);
  },
  async put(board: string, firmware: StoredFirmware): Promise<void> {
    memory.set(board, firmware);
    await transact('readwrite', (store) => store.put({ ...firmware, bytes: firmware.bytes.slice() }, board));
  },
  async delete(board: string): Promise<void> {
    memory.delete(board);
    await transact('readwrite', (store) => store.delete(board));
  },
  /** Reads every stored firmware into memory (at startup). */
  async loadAll(): Promise<void> {
    const keys = await transact('readonly', (store) => store.getAllKeys());
    const values = await transact('readonly', (store) => store.getAll());
    if (keys === undefined || values === undefined) return;
    keys.forEach((key, i) => {
      const value = values[i] as StoredFirmware | undefined;
      if (typeof key === 'string' && value !== undefined && value.bytes instanceof Uint8Array) memory.set(key, value);
    });
  },
};
