import { CODE_MICROPYTHON_MISSING, MICROPYTHON_PICO2_RISCV } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { cachedMicroPython, micropythonFixture } from '../../rp2040/src/micropython.test-helper.ts';
import { createRp2350Mcu, RP2350_CLOCK_HZ } from './rp2350-mcu.ts';
import { cachedRom, edgeTimes, runMs } from './rp2350.test-helper.ts';

// BT67: MicroPython sketches on the Pico 2 — the stock RPI_PICO2-RISCV v1.29.0 UF2 (fetched to
// .cache/micropython with the Pico's) through the real bootrom, the sketch put on the board over
// USB serial by the Pico's raw-REPL installer. These tests fail with the fetch commands without
// the caches.

function bootSketch(name: string) {
  const problems: string[] = [];
  const mcu = createRp2350Mcu({ rom: cachedRom(), micropython: cachedMicroPython(MICROPYTHON_PICO2_RISCV), onProblem: (p) => p.code !== 'rp2350-unimplemented' && problems.push(`${p.code}: ${p.message}`) });
  mcu.load(micropythonFixture(name));
  let serial = '';
  mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
  return { mcu, problems, serial: () => serial };
}

describe('MicroPython sketches on the Pico 2 (BT67)', () => {
  it('hello: print and a traceback reach USB serial, then the REPL answers what you type', () => {
    const t = bootSketch('hello');
    runMs(t.mcu, 600);
    expect(t.serial()).toMatch(/^hello\r\n45\r\nTraceback \(most recent call last\):\r\n {2}File "main.py", line 5, in <module>\r\nValueError: boom\r\nMicroPython v1\.29\.0 on 2026-08-24; Raspberry Pi Pico2 with RP2350-RISCV\r\nType "help\(\)" for more information\.\r\n>>> $/);
    t.mcu.uart(0)?.receive(new TextEncoder().encode('print(6 * 7)\r'));
    runMs(t.mcu, 50);
    expect(t.serial()).toMatch(/>>> print\(6 \* 7\)\r\n42\r\n>>> $/);
    expect(t.problems).toEqual([]);
  });

  it('blink: Pin("LED").toggle() every 250 ms ±1 %, and a reset runs the sketch again', () => {
    const t = bootSketch('blink');
    const edges = edgeTimes(t.mcu, 'GPIO25');
    runMs(t.mcu, 1600);
    const toggles = edges.times.filter((_, i) => edges.levels[i] >= 0).slice(1);
    expect(toggles.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < toggles.length; i++) expect(Math.abs(toggles[i] - toggles[i - 1] - 250)).toBeLessThan(2.5);
    expect(t.serial()).toContain('blink 4\r\n');
    t.mcu.reset();
    runMs(t.mcu, 600);
    expect(t.serial().match(/blink 0\r\n/g)?.length).toBe(2);
    expect(t.problems).toEqual([]);
  });

  it('_thread runs its function on core 1 (launched through the bootrom), beside main.py', () => {
    const problems: string[] = [];
    const mcu = createRp2350Mcu({ rom: cachedRom(), micropython: cachedMicroPython(MICROPYTHON_PICO2_RISCV), onProblem: (p) => p.code !== 'rp2350-unimplemented' && problems.push(`${p.code}: ${p.message}`) });
    const main = ['import _thread, time', 'done = []', 'def work():', '    done.append(sum(range(1000)))', '_thread.start_new_thread(work, ())', 'time.sleep_ms(50)', 'print("core1", done)'].join('\n');
    mcu.load({ format: 'micropython', files: { 'main.py': `${main}\n` }, main: 'main.py' });
    let serial = '';
    mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
    runMs(mcu, 600);
    expect(serial).toContain('core1 [499500]\r\n');
    expect(problems).toEqual([]);
  });

  it('without the interpreter a sketch halts with micropython-missing and the fetch command', () => {
    const problems: string[] = [];
    const mcu = createRp2350Mcu({ rom: cachedRom(), onProblem: (p) => problems.push(`${p.code}: ${p.message}`) });
    mcu.load(micropythonFixture('hello'));
    const result = mcu.runUntil(RP2350_CLOCK_HZ / 1000);
    expect(result.reason).toBe('halted');
    expect(result.detail).toMatch(/npm run fetch:micropython/);
    expect(problems[0]).toMatch(new RegExp(`^${CODE_MICROPYTHON_MISSING}: `));
  });
});
