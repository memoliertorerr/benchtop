import { buildUf2, UF2_FAMILY } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { ackingPart, scanLines } from '../../rp2040/src/rp2040.test-helper.ts';
import { CODE_ROM_MISSING, createRp2350Mcu, RP2350_CLOCK_HZ } from './rp2350-mcu.ts';
import { bootPico2, edgeTimes, runMs } from './rp2350.test-helper.ts';

// BT65: the RP2350 SoC on real arduino-pico 6.2.0 firmware built for its RISC-V cores
// (fixtures/sketches/pico2), booted by the real bootrom (A4, from .cache/rp2350-rom; these tests
// fail with instructions without it).

describe('RP2350 Mcu', () => {
  it('serial-hello: the bootrom boots the image; UART0 on GP0/GP1 and UART1 on GP4/GP5 at 115200', () => {
    const { mcu, serial, problems } = bootPico2('serial-hello');
    runMs(mcu, 2600);
    expect(mcu.soc?.image).toMatchObject({ offset: 0, entry: 0x10000022 }); // arduino-pico's OTA loader, then the sketch
    expect(serial[0]).toBe('uart0 0\r\nuart0 1\r\nuart0 2\r\n');
    expect(serial[1]).toBe('uart1 0\r\nuart1 1\r\nuart1 2\r\n');
    expect(mcu.uart(1)?.pins?.()).toEqual({ tx: 'GPIO0', rx: 'GPIO1' });
    expect(mcu.uart(2)?.pins?.()).toEqual({ tx: 'GPIO4', rx: 'GPIO5' });
    expect(Math.abs((mcu.uart(1)?.baud?.() ?? 0) - 115_200) / 115_200).toBeLessThan(0.01);
    expect(mcu.soc?.clocks.sysHz).toBe(150_000_000);
    expect(mcu.pins.get('GPIO0')?.mode()).toBe('peripheral');
    expect(problems.filter((p) => !p.startsWith('rp2350-unimplemented'))).toEqual([]);
  });

  it('blink: GP25 toggles every 500 ms ±1 %', () => {
    const { mcu } = bootPico2('blink');
    const edges = edgeTimes(mcu, 'GPIO25');
    runMs(mcu, 3100);
    const highs = edges.times.filter((_, i) => edges.levels[i] === 1);
    expect(highs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < highs.length; i++) expect(Math.abs(highs[i] - highs[i - 1] - 1000)).toBeLessThan(10);
    for (const low of edges.times.filter((_, i) => edges.levels[i] === 0 && i > 1)) {
      const high = highs.filter((h) => h < low).at(-1);
      if (high !== undefined) expect(Math.abs(low - high - 500)).toBeLessThan(5);
    }
    expect(mcu.pins.get('GPIO25')?.mode()).toBe('output');
  });

  it('eeprom: EEPROM.commit() programs flash through the bootrom\'s flash functions; a reset reads it back', () => {
    const { mcu, serial } = bootPico2('eeprom');
    runMs(mcu, 300);
    expect(serial[0]).toBe('boot 0\nsaved 1 ok\n');
    mcu.reset();
    runMs(mcu, 300);
    expect(serial[0]).toBe('boot 0\nsaved 1 ok\nboot 1\nsaved 2 ok\n');
  });

  it('i2c-scan: one-byte writes to 0x08–0x77 find the one part at once; empty addresses NACK, also once it is gone', () => {
    // rp2040js's I2C through the shared bridge: an address NACK used to leave TX_EMPTY low, so
    // every empty address waited out Wire's 1 s timeout (endTransmission 5, a scan 111 s).
    const { mcu, problems } = bootPico2('i2c-scan');
    let usb = '';
    mcu.uart(0)?.onTransmit((b) => (usb += String.fromCharCode(b)));
    const part = ackingPart(0x3c);
    mcu.i2c(0)?.attach(part);
    runMs(mcu, 400);
    const present = scanLines(usb);
    expect(present.length).toBeGreaterThanOrEqual(2); // one every 100 ms; those before USB enumerates are lost
    for (const scan of present) {
      expect(scan).toMatchObject({ found: ' 0x3C', codes: '1 0 0 0 111 0', read: '0', timeout: '0' });
      expect(scan.us).toBeLessThan(2000);
    }
    expect(part.log.join(' ')).toMatch(/^W w0 P( W w0 P)*$/);
    mcu.i2c(0)?.detach(part);
    const seen = usb.length;
    runMs(mcu, 400);
    const gone = scanLines(usb.slice(seen)).slice(1); // the first may straddle the detach
    expect(gone.length).toBeGreaterThanOrEqual(2);
    for (const scan of gone) {
      expect(scan).toMatchObject({ found: '', codes: '0 0 0 0 112 0', read: '0', timeout: '0' });
      expect(scan.us).toBeLessThan(2000);
    }
    expect(problems.filter((p) => !p.startsWith('rp2350-unimplemented'))).toEqual([]);
  });

  it('reports simulated MIPS on a busy loop, whose sum matches the host\'s', () => {
    const { mcu, serial } = bootPico2('mips');
    let x = 1;
    let sum = 0;
    for (let i = 0; i < 200_000; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      sum = (sum + (x >>> 16)) >>> 0;
    }
    const hart = mcu.soc?.harts[0];
    runMs(mcu, 100); // boot
    const instructions = hart?.instructions ?? 0;
    const start = performance.now();
    runMs(mcu, 400);
    const seconds = (performance.now() - start) / 1000;
    const retired = (hart?.instructions ?? 0) - instructions;
    const line = /done (\d+) in (\d+) us/.exec(serial[0]);
    expect(line?.[1]).toBe(String(sum));
    console.info(`rp2350 mips: ${(retired / seconds / 1e6).toFixed(1)} MIPS (0.4 s simulated in ${seconds.toFixed(2)} s, ${((0.4 / seconds) * 100).toFixed(0)} % of real time); the loop took ${line?.[2]} µs of simulated time`);
    expect(mcu.cycles).toBeGreaterThanOrEqual(RP2350_CLOCK_HZ / 2);
  }, 60_000);

  it('refuses RP2040 and Arm images, and RAM-only ones', () => {
    const mcu = createRp2350Mcu();
    const image = (family: number, address = 0x10000000) => ({ format: 'uf2' as const, bytes: buildUf2([{ address, data: new Uint8Array(256) }], family) });
    expect(() => mcu.load(image(UF2_FAMILY.RP2040))).toThrow(/RP2040/);
    expect(() => mcu.load(image(UF2_FAMILY.RP2350_ARM_S))).toThrow(/Arm cores/);
    expect(() => mcu.load(image(UF2_FAMILY.RP2350_RISCV, 0x20000000))).toThrow(/RAM-only/);
    expect(() => mcu.load({ format: 'hex', text: ':00000001FF' })).toThrow(/UF2 and ELF/);
  });

  it('without the bootrom it halts with the fetch command', () => {
    const problems: string[] = [];
    const mcu = createRp2350Mcu({ onProblem: (p) => problems.push(`${p.code}: ${p.message}`) });
    mcu.load({ format: 'uf2', bytes: buildUf2([{ address: 0x10000000, data: new Uint8Array(256) }], UF2_FAMILY.RP2350_RISCV) });
    const result = mcu.runUntil(1000);
    expect(result.reason).toBe('halted');
    expect(result.detail).toMatch(/npm run fetch:rp2350-rom/);
    expect(problems[0]).toMatch(new RegExp(`^${CODE_ROM_MISSING}: `));
  });
});
