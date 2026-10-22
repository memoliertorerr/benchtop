import { describe, expect, it } from 'vitest';
import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { buildUf2, UF2_FAMILY } from '@benchtop/core';
import { createRp2040Mcu, RP2040_CLOCK_HZ } from './rp2040-mcu.ts';
import { ackingPart, bootPico, edgeTimes, runMs, scanLines } from './rp2040.test-helper.ts';

// BT60: the RP2040 Mcu on real arduino-pico 6.2.0 firmware (fixtures/sketches/pico).

describe('RP2040 Mcu', () => {
  it('blink: GP25 toggles every 500 ms ±1 %', () => {
    const { mcu } = bootPico('blink');
    const edges = edgeTimes(mcu, 'GPIO25');
    runMs(mcu, 3100);
    const highs = edges.times.filter((_, i) => edges.levels[i] === 1);
    expect(highs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < highs.length; i++) expect(Math.abs(highs[i] - highs[i - 1] - 1000)).toBeLessThan(10);
    const lows = edges.times.filter((_, i) => edges.levels[i] === 0 && i > 1);
    for (const low of lows) {
      const high = highs.filter((h) => h < low).at(-1);
      if (high !== undefined) expect(Math.abs(low - high - 500)).toBeLessThan(5);
    }
    expect(mcu.pins.get('GPIO25')?.mode()).toBe('output');
  });

  it('serial-hello: USB serial (UART 0), UART0 on GP0/GP1 and UART1 on GP4/GP5 at 115200', () => {
    const { mcu, serial } = bootPico('serial-hello');
    runMs(mcu, 2600);
    expect(serial[0]).toMatch(/^(hello from pico \d+\r\n)+$/); // the lines sent before USB enumerated are lost
    expect(serial[0]).toContain('hello from pico 2\r\n');
    expect(serial[1]).toBe('uart0 0\r\nuart0 1\r\nuart0 2\r\n');
    expect(serial[2]).toBe('uart1 0\r\nuart1 1\r\nuart1 2\r\n');
    expect(mcu.uart(1)?.pins?.()).toEqual({ tx: 'GPIO0', rx: 'GPIO1' });
    expect(mcu.uart(2)?.pins?.()).toEqual({ tx: 'GPIO4', rx: 'GPIO5' });
    expect(mcu.uart(1)?.baud?.()).toBeGreaterThan(115200 * 0.99);
    expect(mcu.uart(1)?.baud?.()).toBeLessThan(115200 * 1.01);
    expect(mcu.pins.get('GPIO0')?.mode()).toBe('peripheral');
    expect(mcu.uart(3)).toBeUndefined();
  });

  it('float-math: results through the bootrom float tables match the host to the printed digits', () => {
    const { mcu, serial } = bootPico('float-math');
    runMs(mcu, 30);
    const a = Math.fround(2.5);
    const b = Math.fround(0.75);
    const c = 1 / 3;
    const fix = (x: number, digits: number): string => x.toFixed(digits);
    const want = [
      fix(Math.fround(a * b), 6), fix(Math.fround(a / b), 6), fix(Math.fround(Math.sqrt(a)), 6), fix(Math.fround(Math.sin(b)), 6),
      fix(Math.fround(Math.cos(b)), 6), fix(Math.fround(Math.exp(b)), 6), fix(Math.fround(Math.log(a)), 6), fix(Math.fround(Math.atan2(a, b)), 6),
      fix(c * 2, 10), fix(Math.sqrt(2), 10), fix(Math.sin(c), 10), fix(Math.exp(c), 10), '2500', fix(Math.fround(2 / 7), 6), 'done',
    ];
    expect(serial[1]).toBe(want.map((line) => `${line}\r\n`).join(''));
  });

  it('pwm-fade: analogWrite on GP15 runs at 1 kHz ±1 % with the duty it was given', () => {
    const { mcu } = bootPico('pwm-fade');
    const pin = mcu.pins.get('GPIO15');
    if (pin === undefined) throw new Error('no GPIO15');
    const rises: number[] = [];
    const falls: number[] = [];
    let level = -1;
    pin.onOutputChange(() => {
      const now = pin.outputLevel();
      if (now === level) return;
      level = now;
      (now === 1 ? rises : falls).push((mcu.cycles / RP2040_CLOCK_HZ) * 1000);
    });
    runMs(mcu, 380); // duty 64 from 200 ms, 128 from 400 ms
    expect(pin.mode()).toBe('peripheral');
    const window = rises.filter((t) => t > 250 && t < 370);
    expect(window.length).toBeGreaterThan(50);
    const period = (window.at(-1)! - window[0]) / (window.length - 1);
    expect(Math.abs(period - 1)).toBeLessThan(0.01);
    const highs = window.slice(0, -1).map((r) => (falls.find((f) => f > r) as number) - r);
    const duty = highs.reduce((a, b) => a + b, 0) / highs.length / period;
    expect(Math.abs(duty - 64 / 255)).toBeLessThan(0.01);
  });

  it('i2c-scan: one-byte writes to 0x08–0x77 find the one part at once; empty addresses NACK, also once it is gone', () => {
    // An address NACK used to leave TX_EMPTY low, so every empty address waited out Wire's 1 s
    // timeout inside the pico-sdk's write loop: a scan took 111 s and endTransmission returned 5.
    const { mcu, serial, problems } = bootPico('i2c-scan');
    const part = ackingPart(0x3c);
    mcu.i2c(0)?.attach(part);
    runMs(mcu, 400);
    const present = scanLines(serial[0]);
    expect(present.length).toBeGreaterThanOrEqual(2); // one every 100 ms; those before USB enumerates are lost
    for (const scan of present) {
      // endTransmission: 0 from the part, 4 from the 111 empty addresses (arduino-pico's answer to
      // the pico-sdk's PICO_ERROR_GENERIC, not 2); requestFrom(0x22, 1): nothing; no timeout.
      expect(scan).toMatchObject({ found: ' 0x3C', codes: '1 0 0 0 111 0', read: '0', timeout: '0' });
      expect(scan.us).toBeLessThan(2000);
    }
    expect(part.log.join(' ')).toMatch(/^W w0 P( W w0 P)*$/);
    mcu.i2c(0)?.detach(part); // the part taken off the bus
    const seen = serial[0].length;
    runMs(mcu, 400);
    const gone = scanLines(serial[0].slice(seen)).slice(1); // the first may straddle the detach
    expect(gone.length).toBeGreaterThanOrEqual(2);
    for (const scan of gone) {
      expect(scan).toMatchObject({ found: '', codes: '0 0 0 0 112 0', read: '0', timeout: '0' });
      expect(scan.us).toBeLessThan(2000);
    }
    expect(problems.filter((p) => !p.startsWith('rp2040-unimplemented'))).toEqual([]);
  });

  it('loads an ELF, keeps flash across reset, and reports an empty board as BOOTSEL', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: readFixture('fixtures/rp2040/romcalls.elf') });
    expect(mcu.runUntil(125_000).reason).toBe('target');
    expect(mcu.rp.readUint32(0x10100000) >>> 0).toBe(0x3b3a3938); // romcalls programmed flash
    mcu.reset();
    expect(mcu.cycles).toBe(0);
    expect(mcu.rp.readUint32(0x10100000) >>> 0).toBe(0x3b3a3938); // still there after reset
    const empty = createRp2040Mcu();
    empty.load({ format: 'uf2', bytes: buildUf2([{ address: 0x10200000, data: new Uint8Array(256) }], UF2_FAMILY.RP2040) });
    const result = empty.runUntil(1000);
    expect(result.reason).toBe('halted');
    expect(result.detail).toMatch(/BOOTSEL/);
  });

  it('runs a RAM-only UF2 from its lowest address', () => {
    // movs r0, #42; ldr r1, =0x20001000 (via pc-relative); str r0, [r1]; b .
    const code = Uint8Array.of(0x2a, 0x20, 0x01, 0x49, 0x08, 0x60, 0xfe, 0xe7, 0x00, 0x10, 0x00, 0x20);
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'uf2', bytes: buildUf2([{ address: 0x20000000, data: code }], UF2_FAMILY.RP2040) });
    expect(mcu.runUntil(1000).reason).toBe('target');
    expect(mcu.rp.readUint32(0x20001000)).toBe(42);
  });

  it('refuses other chips\' images and non-RP2040 formats', () => {
    const mcu = createRp2040Mcu();
    expect(() => mcu.load({ format: 'uf2', bytes: buildUf2([{ address: 0x10000000, data: new Uint8Array(256) }], UF2_FAMILY.RP2350_RISCV) })).toThrow(/family/);
    expect(() => mcu.load({ format: 'hex', text: ':00000001FF' })).toThrow(/UF2 and ELF/);
    expect(() => mcu.load({ format: 'uf2', bytes: buildUf2([{ address: 0x30000000, data: new Uint8Array(4) }], UF2_FAMILY.RP2040) })).toThrow(/outside/);
  });

  it('a BKPT outside the ROM halts with a fault (no debugger attached)', () => {
    const code = Uint8Array.of(0x00, 0xbe, 0xfe, 0xe7); // bkpt #0; b .
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'uf2', bytes: buildUf2([{ address: 0x20000000, data: code }], UF2_FAMILY.RP2040) });
    const result = mcu.runUntil(1000);
    expect(result.reason).toBe('fault');
    expect(result.detail).toMatch(/BKPT #0 at 0x20000000/);
  });

  it('reports simulated MHz on blink (sleeping) and float-math (busy)', () => {
    for (const name of ['blink', 'float-math']) {
      const { mcu } = bootPico(name);
      const start = performance.now();
      runMs(mcu, 500);
      const seconds = (performance.now() - start) / 1000;
      console.info(`rp2040 ${name}: 0.5 s simulated in ${seconds.toFixed(2)} s (${((mcu.cycles / RP2040_CLOCK_HZ / seconds) * 100).toFixed(0)} % of real time)`);
      expect(mcu.cycles).toBeGreaterThanOrEqual(RP2040_CLOCK_HZ / 2);
    }
  }, 60_000);
});

describe('the RP2040 clock', () => {
  it('defers an alarm that reschedules itself at the same instant instead of looping', async () => {
    const { Rp2040Clock } = await import('./clock.ts');
    const clock = new Rp2040Clock();
    let fired = 0;
    const alarm = clock.createAlarm(() => {
      fired++;
      alarm.schedule(0); // a zero-period reschedule, as rp2040js's PWM can do
    });
    alarm.schedule(100);
    clock.tickTo(200);
    expect(clock.nanos).toBe(200);
    expect(fired).toBe(13); // at 100, then every 8 ns: 108, 116, …, 196
  });
});
