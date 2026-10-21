/**
 * The project document: what the editor edits, autosaves and exports, and what the bench
 * loads. Plain JSON, so it round-trips through `JSON.stringify` and `structuredClone`.
 * World units are millimetres everywhere in the document.
 *
 * A document from outside (a file, browser storage, the CLI) is untrusted: parse it with
 * `parseProject` (packages/core/src/project/validate.ts) before using it.
 */

/**
 * Format version written into every document. A document with any other `format` is rejected
 * by `parseProject`; a future format 2 comes with a migration.
 */
export const PROJECT_FORMAT = 1;

/** One circuit: parts placed on the bench, wires between their pins, and firmware per board. */
export interface ProjectDoc {
  /** Always `PROJECT_FORMAT`. */
  format: 1;
  /** Display name, shown in the title and used for export file names. */
  name: string;
  /** Every placed part, boards and breadboards included. Order is the paint order. */
  parts: PartInstance[];
  /** Every drawn wire. Order is the paint order. */
  wires: Wire[];
  /**
   * Firmware per board, keyed by the board's `PartInstance.id`. Boards without an entry run
   * nothing until firmware is attached.
   */
  firmware: Record<string, FirmwareRef>;
}

/** A part placed on the bench. Its type's `PartDefinition` (from the catalog) gives its pins. */
export interface PartInstance {
  /** Unique among parts, `[a-z][a-z0-9_-]{0,31}`. Wires, firmware and problems refer to it. */
  id: string;
  /** `PartDefinition.type` in the catalog, e.g. `'arduino-uno'`, `'led'`, `'breadboard-half'`. */
  type: string;
  /** mm, world x of the unrotated part's top-left corner. */
  x: number;
  /** mm, world y of the unrotated part's top-left corner (y grows downward). */
  y: number;
  /** Degrees clockwise about the part's center. */
  rotation: 0 | 90 | 180 | 270;
  /**
   * Values for the definition's props (`PartDefinition.defaults` has every key). Keys missing
   * here take the default; the bench merges them before calling `createModel`.
   */
  props: Record<string, string | number | boolean>;
}

/** One pin of one part: a wire endpoint, a probe target, a problem location. */
export interface PinRef {
  /** `PartInstance.id`. */
  part: string;
  /** `PinDef.name` on that part's definition, e.g. `'13'`, `'GND.1'`, `'5t.a'`. */
  pin: string;
}

/** A wire drawn between two pins. Electrically ideal: both ends are one net. */
export interface Wire {
  /** Unique among wires, `[a-z][a-z0-9_-]{0,31}` (wire and part ids may coincide). */
  id: string;
  /** Start pin. */
  from: PinRef;
  /** End pin. */
  to: PinRef;
  /** mm, world points the wire passes through between `from` and `to`, in order. */
  waypoints: { x: number; y: number }[];
  /** CSS color for the view: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or a color name. */
  color: string;
}

/**
 * Where a board's firmware comes from. The document stores a reference, never the bytes:
 * - `file`: a `.hex` / `.elf` / `.bin` / `.uf2` (BT60) the user dropped; the app keeps the bytes
 *   (IndexedDB in the browser, a path argument in the CLI) keyed by board id.
 * - `sketch`: an absolute sketch folder the compile bridge builds with `fqbn`.
 * - `inline` (BT42, human-approved): the sketch's source lives in the document — `files` maps
 *   file names to their text and `main` names the `.ino` among them; the compile bridge builds
 *   it with `fqbn`. `parseProject` limits it (at most 32 files, 256 KB of source, names
 *   `[A-Za-z0-9_][A-Za-z0-9_.-]*.(ino|h|hpp|c|cpp)`). The compiled bytes stay outside the
 *   document, as for the other kinds. A MicroPython sketch (BT63, approved 2026-10-21) is an
 *   inline one with fqbn `micropython:rp2:pico` (or `micropython:rp2:pico2`): `.py` files, `main`
 *   (by convention `main.py`) the one that runs at boot; nothing compiles it.
 */
export type FirmwareRef =
  | { kind: 'file'; name: string; format: 'hex' | 'elf' | 'esp32-bin' | 'uf2' }
  | { kind: 'sketch'; path: string; fqbn: string }
  | { kind: 'inline'; fqbn: string; files: Record<string, string>; main: string };
