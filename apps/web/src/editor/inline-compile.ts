/**
 * Inline sketches (BT42): a board whose `FirmwareRef` is `{ kind: 'inline', fqbn, files, main }`
 * keeps its sketch's source in the project document. This module is the flow's pure part —
 * templates, the source hash that marks a build stale, turning a compile result into stored
 * firmware and Problems rows, and Compile & Run with its effects injected — so Node tests drive
 * it with a fake bridge and a real SimSession. editor/sketch-actions.ts wires it to the app.
 */

import { type FirmwareRef, isMicroPythonFqbn } from '@benchtop/core';
import type { BridgeCompileResult } from '../sim/bridge-client.ts';
import { type CompileProblemRow, compileProblemRows } from '../sim/compile-problems.ts';
import { microPythonBytes, type StoredFirmware } from './firmware-store.ts';

export type InlineRef = Extract<FirmwareRef, { kind: 'inline' }>;

/** The main file of a sketch started in the app. */
export const MAIN_FILE = 'sketch.ino';
/** BT63: a MicroPython sketch's main file — what MicroPython runs at boot. */
export const MICROPYTHON_MAIN = 'main.py';

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

const PICO_TEMPLATE = `// Blink on the Raspberry Pi Pico: the onboard LED (GP25) toggles every half second, and the
// count goes to the serial monitor (USB serial).

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  static int count = 0;
  digitalWrite(LED_BUILTIN, count % 2 == 0 ? HIGH : LOW);
  Serial.printf("blink %d\\n", count++);
  delay(500);
}
`;

const MICROPYTHON_TEMPLATE = `# Blink in MicroPython on the Raspberry Pi Pico: the onboard LED toggles every half second,
# and the count goes to the serial monitor (USB serial). Run needs no compile.
import time
from machine import Pin

led = Pin("LED", Pin.OUT)
count = 0
while True:
    led.toggle()
    print("blink", count)
    count += 1
    time.sleep_ms(500)
`;

/**
 * A new sketch for a board compiled with `fqbn`: blink on the Uno and the Pico, serial hello on
 * the ESP32; a MicroPython fqbn (BT63) starts main.py with blink.
 */
export function templateRef(fqbn: string): InlineRef {
  if (isMicroPythonFqbn(fqbn)) return { kind: 'inline', fqbn, files: { [MICROPYTHON_MAIN]: MICROPYTHON_TEMPLATE }, main: MICROPYTHON_MAIN };
  const template = fqbn.startsWith('esp32:') ? ESP32_TEMPLATE : fqbn.startsWith('rp2040:') ? PICO_TEMPLATE : UNO_TEMPLATE;
  return { kind: 'inline', fqbn, files: { [MAIN_FILE]: template }, main: MAIN_FILE };
}

/** BT63: a MicroPython sketch is its own firmware — stored as is, tagged with its source. */
export function storedMicroPython(ref: InlineRef): StoredFirmware {
  return { name: ref.main, format: 'micropython', bytes: microPythonBytes(ref.files, ref.main), source: sourceHash(ref) };
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
  // BT74: the ELF rides along for the debugger (symbols, source lines) whatever the image is.
  const elf = result.artifacts.elf;
  const debugElf = elf === undefined ? {} : { debugElf: base64Bytes(elf) };
  if (ref.fqbn.startsWith('esp32:')) {
    const bin = result.artifacts.bin;
    return bin === undefined ? undefined : { name: `${ref.main}.bin`, format: 'esp32-bin', bytes: base64Bytes(bin), source, ...debugElf };
  }
  if (ref.fqbn.startsWith('rp2040:')) {
    const uf2 = result.artifacts.uf2;
    return uf2 === undefined ? undefined : { name: `${ref.main}.uf2`, format: 'uf2', bytes: base64Bytes(uf2), source, ...debugElf };
  }
  const hex = result.artifacts.hex;
  return hex === undefined ? undefined : { name: `${ref.main}.hex`, format: 'hex', bytes: new TextEncoder().encode(hex), source, ...debugElf };
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
 * running — and return the diagnostics as rows. A refusal or an unreachable bridge throws. A
 * MicroPython sketch skips the bridge: Run stores and delivers it at once.
 */
export async function compileInline(board: string, ref: InlineRef, deps: InlineCompileDeps): Promise<InlineOutcome> {
  if (isMicroPythonFqbn(ref.fqbn)) {
    // Nothing to compile: the board's MicroPython takes the files as they are (BT63).
    deps.store(board, storedMicroPython(ref));
    deps.deliver(board);
    return { ok: true, rows: [], detail: '' };
  }
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
