import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import type { BridgeCompileResult } from '../sim/bridge-client.ts';
import type { FromSim } from '../sim/protocol.ts';
import { SimSession } from '../sim/session.ts';
import { type StoredFirmware, toImage } from './firmware-store.ts';
import { cachedMicroPython } from '../../../../packages/rp2040/src/micropython.test-helper.ts';
import { compileInline, type InlineRef, MAIN_FILE, MICROPYTHON_MAIN, sourceHash, storedFromInline, storedMicroPython, templateRef } from './inline-compile.ts';

/** A SimSession on a manual clock, with the LED's lit/dark history. */
function bench() {
  let wall = 0;
  let pending: (() => void) | null = null;
  const led: number[] = [];
  const session = new SimSession({
    post: (message: FromSim) => {
      if (message.type !== 'frame') return;
      for (const [id, v] of message.parts) if (id === 'led1') led.push((v.brightness as number) > 0.5 ? 1 : 0);
    },
    now: () => wall,
    schedule: (fn) => {
      pending = fn;
    },
  });
  const advance = (ms: number): void => {
    const end = wall + ms;
    while (wall < end) {
      wall += 4;
      const fn = pending as (() => void) | null;
      pending = null;
      fn?.();
    }
  };
  return { session, advance, led };
}

const doc = (): ProjectDoc => JSON.parse(readFixtureText('fixtures/projects/blink-led.json')) as ProjectDoc;

describe('inline sketch: Compile & Run (BT42)', () => {
  it('sends the files to the bridge, loads the returned firmware into the board and runs it; a compile error keeps the old firmware running', async () => {
    const sent: InlineRef[] = [];
    const stored = new Map<string, StoredFirmware>();
    const { session, advance, led } = bench();
    let loaded = false;
    // The bridge: "compiles" blink (the fixture build of the template) or fails on a typo.
    const compile = (ref: InlineRef): Promise<BridgeCompileResult> => {
      sent.push(structuredClone(ref));
      const typo = ref.files[MAIN_FILE].includes('pinMod(');
      return Promise.resolve(
        typo
          ? {
              ok: false,
              durationMs: 900,
              diagnostics: [{ file: MAIN_FILE, line: 6, column: 3, severity: 'error', message: "'pinMod' was not declared in this scope" }],
              stdout: '',
              stderr: '',
              artifacts: {},
            }
          : { ok: true, durationMs: 1200, diagnostics: [], stdout: '', stderr: '', artifacts: { hex: readFixtureText('fixtures/firmware/uno/blink.hex') } },
      );
    };
    const deps = {
      compile,
      store: (board: string, firmware: StoredFirmware) => stored.set(board, firmware),
      // What the app's controller does: hot-swap a loaded bench, else load and run.
      deliver: (board: string) => {
        const image = toImage(stored.get(board)!);
        if (loaded) session.handle({ type: 'setFirmware', board, image });
        else {
          session.handle({ type: 'load', doc: doc(), firmware: { [board]: image } });
          session.handle({ type: 'run', speed: 1 });
          loaded = true;
        }
      },
    };

    const ref = templateRef('arduino:avr:uno');
    const good = await compileInline('uno', ref, deps);
    expect(good).toEqual({ ok: true, rows: [], detail: '1.2' });
    expect(sent).toEqual([{ kind: 'inline', fqbn: 'arduino:avr:uno', files: ref.files, main: 'sketch.ino' }]);
    expect(stored.get('uno')).toMatchObject({ name: 'sketch.ino.hex', format: 'hex', source: sourceHash(ref) });
    advance(1100);
    expect(led).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1].slice(0, led.length));
    expect(led.slice(0, 4)).toEqual([0, 1, 0, 1]);

    // A typo: the error comes back with file and line, nothing is stored, the old blink keeps going.
    const broken: InlineRef = { ...ref, files: { [MAIN_FILE]: ref.files[MAIN_FILE].replace('pinMode(', 'pinMod(') } };
    const bad = await compileInline('uno', broken, deps);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toBe('1 error');
    expect(bad.rows.map((r) => [r.severity, r.location, r.message])).toEqual([['error', 'sketch.ino:6:3', "'pinMod' was not declared in this scope"]]);
    expect(stored.get('uno')?.source).toBe(sourceHash(ref));
    const before = led.length;
    advance(1100);
    expect(led.slice(before)).toEqual(led.slice(before).map((_, i) => (led[before - 1] + 1 + i) % 2));
  });

  it('marks a build stale by its source: any file, the main file or the board changes the hash', () => {
    const ref = templateRef('arduino:avr:uno');
    const hash = sourceHash(ref);
    expect(sourceHash(structuredClone(ref))).toBe(hash);
    expect(sourceHash({ ...ref, files: { ...ref.files, 'pins.h': '' } })).not.toBe(hash);
    expect(sourceHash({ ...ref, files: { [MAIN_FILE]: `${ref.files[MAIN_FILE]} ` } })).not.toBe(hash);
    expect(sourceHash({ ...ref, fqbn: 'esp32:esp32:esp32' })).not.toBe(hash);
  });

  it('starts the Uno from blink and the ESP32 from serial hello', () => {
    expect(templateRef('arduino:avr:uno').files[MAIN_FILE]).toContain('digitalWrite(LED_BUILTIN, HIGH)');
    expect(templateRef('esp32:esp32:esp32').files[MAIN_FILE]).toContain('Serial.printf("hello %d\\n", count++)');
    expect(templateRef('rp2040:rp2040:rpipico').files[MAIN_FILE]).toContain('Raspberry Pi Pico'); // BT61
  });

  it('keeps a Pico build as its UF2 (BT61)', () => {
    const ref = templateRef('rp2040:rp2040:rpipico');
    const stored = storedFromInline(ref, { ok: true, durationMs: 1, diagnostics: [], stdout: '', stderr: '', artifacts: { uf2: btoa('UF2\n'), elf: btoa('ELF') } });
    expect(stored).toMatchObject({ name: 'sketch.ino.uf2', format: 'uf2', bytes: Uint8Array.from([0x55, 0x46, 0x32, 0x0a]) });
  });

  it('runs a MicroPython sketch without the bridge: stored as is, delivered to the board (BT63)', async () => {
    const ref = templateRef('micropython:rp2:pico');
    expect(ref).toMatchObject({ fqbn: 'micropython:rp2:pico', main: MICROPYTHON_MAIN });
    expect(ref.files[MICROPYTHON_MAIN]).toContain('led.toggle()');
    let compiled = 0;
    const stored = new Map<string, StoredFirmware>();
    const delivered: string[] = [];
    const outcome = await compileInline('pico', ref, {
      compile: () => {
        compiled++;
        return Promise.reject(new Error('no bridge'));
      },
      store: (board, firmware) => stored.set(board, firmware),
      deliver: (board) => delivered.push(board),
    });
    expect(outcome).toEqual({ ok: true, rows: [], detail: '' });
    expect(compiled).toBe(0);
    expect(delivered).toEqual(['pico']);
    const firmware = stored.get('pico');
    expect(firmware).toMatchObject({ name: 'main.py', format: 'micropython', source: sourceHash(ref) });
    expect(toImage(firmware as StoredFirmware)).toEqual({ format: 'micropython', files: ref.files, main: 'main.py' });
    expect(() => toImage({ name: 'main.py', format: 'micropython', bytes: new TextEncoder().encode('{"files":{}}') })).toThrow(/damaged/);
  });

  it('runs it on the Pico in the session: the template blinks GP25 and prints (BT63)', () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    let serial = '';
    const session = new SimSession({
      post: (message: FromSim) => {
        if (message.type === 'serial') serial += new TextDecoder().decode(message.bytes);
      },
      now: () => wall,
      schedule: (fn) => {
        pending = fn;
      },
      micropython: () => cachedMicroPython(),
    });
    const ref = templateRef('micropython:rp2:pico');
    const pico = JSON.parse(readFixtureText('fixtures/projects/pico-blink.json')) as ProjectDoc;
    session.handle({ type: 'load', doc: pico, firmware: { pico: toImage(storedMicroPython(ref)) } });
    session.handle({ type: 'run', speed: 1 });
    while (wall < 1300) {
      wall += 4;
      const fn = pending as (() => void) | null;
      pending = null;
      fn?.();
    }
    expect(serial).toContain('blink 2');
  });
});
