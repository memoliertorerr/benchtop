/**
 * Files a part model holds (BT89: a microSD card), for the UI, the MCP server and test specs.
 * Not a contract: `PartModel` is frozen, so a model opts in by carrying a `storage` member and
 * `Bench.storage(partId)` finds it — a bench convention, like the `$analog` prop.
 */

/** One file or directory on a part's storage. */
export interface StoredFile {
  /** From the root, '/'-separated, no leading slash: `LOG.TXT`, `data/run1.csv`. */
  readonly path: string;
  readonly dir: boolean;
  /** Bytes (0 for a directory). */
  readonly size: number;
  /** Last write as `YYYY-MM-DD hh:mm:ss`, from the file system's own stamp. */
  readonly modified: string;
}

export interface PartStorage {
  /** Bumped by every change, the firmware's writes included. */
  readonly version: number;
  /** Every file and directory, depth first; empty when nothing is readable (no card, no volume). */
  list(): StoredFile[];
  /** A file's bytes, or undefined when there is no such file. Paths match case-insensitively. */
  read(path: string): Uint8Array | undefined;
  /** Creates or replaces a file, making directories on the way; false when it can't (no volume, full). */
  write(path: string, bytes: Uint8Array): boolean;
  /** Removes a file or a directory with everything in it; false when there was nothing there. */
  remove(path: string): boolean;
}

/** The storage a part model carries, if any. */
export function storageOf(model: unknown): PartStorage | undefined {
  if (typeof model !== 'object' || model === null || !('storage' in model)) return undefined;
  const storage = (model as { storage: unknown }).storage;
  if (typeof storage !== 'object' || storage === null) return undefined;
  const s = storage as Partial<PartStorage>;
  return typeof s.list === 'function' && typeof s.read === 'function' && typeof s.write === 'function' && typeof s.remove === 'function' ? (storage as PartStorage) : undefined;
}
