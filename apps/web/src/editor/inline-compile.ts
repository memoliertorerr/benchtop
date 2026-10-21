/**
 * Inline sketches (BT42): a board whose `FirmwareRef` is `{ kind: 'inline', fqbn, files, main }`
 * keeps its sketch's source in the project document. This module is the flow's pure part —
 * templates, the source hash that marks a build stale, turning a compile result into stored
 * firmware and Problems rows, and Compile & Run with its effects injected — so Node tests drive
 * it with a fake bridge and a real SimSession. editor/sketch-actions.ts wires it to the app.
 */

import type { FirmwareRef } from '@benchtop/core';
import type { BridgeCompileResult } from '../sim/bridge-client.ts';
import { type CompileProblemRow, compileProblemRows } from '../sim/compile-problems.ts';
import type { StoredFirmware } from './firmware-store.ts';

export type InlineRef = Extract<FirmwareRef, { kind: 'inline' }>;

/** The main file of a sketch started in the app. */
export const MAIN_FILE = 'sketch.ino';

const UNO_TEMPLATE = `// Blink: the board's own LED (pin 13, "L") on for a second, off for a second.

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
`;

const ESP32_TEMPLATE = `// Hello from the ESP32: a counter on the serial monitor, once a second.

void setup() {
  Serial.begin(115200);
}

void loop() {
  static int count = 0;
  Serial.printf("hello %d\\n", count++);
  delay(1000);
}
`;

/** A new sketch for a board compiled with `fqbn`: blink on the Uno, serial hello on the ESP32. */
export function templateRef(fqbn: string): InlineRef {
  return { kind: 'inline', fqbn, files: { [MAIN_FILE]: fqbn.startsWith('esp32:') ? ESP32_TEMPLATE : UNO_TEMPLATE }, main: MAIN_FILE };
}

/** Identifies a sketch's source (FNV-1a over the board, main and every file, in name order). */
export function sourceHash(ref: InlineRef): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ 0, 0x01000193) >>> 0;
  };
  mix(ref.fqbn);
  mix(ref.main);
  for (const name of Object.keys(ref.files).sort()) {
    mix(name);
    mix(ref.files[name]);
  }
  return hash.toString(16).padStart(8, '0');
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** The firmware a successful compile produced, tagged with its source; undefined when none. */
export function storedFromInline(ref: InlineRef, result: BridgeCompileResult): StoredFirmware | undefined {
  const source = sourceHash(ref);
  if (ref.fqbn.startsWith('esp32:')) {
    const bin = result.artifacts.bin;
    return bin === undefined ? undefined : { name: `${ref.main}.bin`, format: 'esp32-bin', bytes: base64Bytes(bin), source };
  }
  const hex = result.artifacts.hex;
  return hex === undefined ? undefined : { name: `${ref.main}.hex`, format: 'hex', bytes: new TextEncoder().encode(hex), source };
}

export interface InlineCompileDeps {
  /** Sends the sketch to the bridge (POST /api/compile-inline). */
  compile(ref: InlineRef): Promise<BridgeCompileResult>;
  /** Keeps a good build as the board's firmware. */
  store(board: string, firmware: StoredFirmware): void;
  /** Hands the board's new firmware to the bench and runs it. */
  deliver(board: string): void;
}

export interface InlineOutcome {
  ok: boolean;
  /** The compile's Problems rows (file names as in the editor). */
  rows: CompileProblemRow[];
  /** ok: seconds the compile took; otherwise what went wrong, briefly. */
  detail: string;
}

/**
 * Compile & Run: compile `ref`; on success store the firmware and deliver it (a hot swap of
 * that board, or a load and run); on failure leave the board's old firmware alone — it keeps
 * running — and return the diagnostics as rows. A refusal or an unreachable bridge throws.
 */
export async function compileInline(board: string, ref: InlineRef, deps: InlineCompileDeps): Promise<InlineOutcome> {
  const result = await deps.compile(ref);
  const rows = compileProblemRows(board, '', result);
  if (!result.ok) {
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    return { ok: false, rows, detail: errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : (result.error ?? 'compile failed') };
  }
  const firmware = storedFromInline(ref, result);
  if (firmware === undefined) return { ok: false, rows, detail: 'the compile produced no firmware' };
  deps.store(board, firmware);
  deps.deliver(board);
  return { ok: true, rows, detail: (result.durationMs / 1000).toFixed(1) };
}
