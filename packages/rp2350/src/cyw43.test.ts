import { type BoardSpec, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText, withheldFirmware } from '../../core/src/firmware/fixtures.test-helper.ts';
import { rp2350McuFactory } from './index.ts';
import { CODE_CYW43_NO_SYMBOLS, createRp2350Mcu, RP2350_CLOCK_HZ, RP2350_HLE_RESUME_PC, type Rp2350Mcu } from './rp2350-mcu.ts';
import { cachedRom } from './rp2350.test-helper.ts';

// BT113: the Pico 2 W — the Pico W's CYW43 model on the RP2350's RISC-V harts, through
// @benchtop/riscv's HLE — on fixtures/sketches/pico2w/blink (the LED on the chip's WL_GPIO0).

const ROM = cachedRom();
// The published repository leaves the Pico 2 W firmware out (THIRD_PARTY_NOTICES.md): skipped there, never here.
const WITHHELD = withheldFirmware('pico2w/blink.uf2') !== undefined;
const UF2 = WITHHELD ? new Uint8Array(0) : readFixture('fixtures/firmware/pico2w/blink.uf2');
const SYMBOLS = SymbolTable.fromNm(WITHHELD ? '' : readFixtureText('fixtures/firmware/pico2w/blink.syms.tsv'));
/** A test that runs the firmware (or reads its symbols); the rest run everywhere. */
const needsFirmware = it.skipIf(WITHHELD);

function boot(symbols: boolean): { mcu: Rp2350Mcu; problems: string[]; edges: [number, number][]; serial: () => string } {
  const problems: string[] = [];
  const mcu = createRp2350Mcu({ rom: ROM, cyw43: {}, onProblem: (p) => problems.push(p.code) });
  mcu.load({ format: 'uf2', bytes: UF2 });
  if (symbols) mcu.useSymbols(SYMBOLS);
  let text = '';
  mcu.uart(0)?.onTransmit((b) => (text += String.fromCharCode(b)));
  const led = mcu.pins.get('WL_GPIO0');
  if (led === undefined) throw new Error('no WL_GPIO0');
  const edges: [number, number][] = [];
  led.onOutputChange(() => edges.push([(mcu.cycles / RP2350_CLOCK_HZ) * 1000, led.outputLevel()]));
  return { mcu, problems, edges, serial: () => text };
}

function run(mcu: Rp2350Mcu, ms: number): void {
  for (let i = 0; i < ms; i++) {
    const r = mcu.runUntil(mcu.cycles + RP2350_CLOCK_HZ / 1000);
    if (r.reason !== 'target') throw new Error(`stopped: ${r.reason} ${r.detail ?? ''}`);
  }
}

describe('the Pico 2 W’s CYW43 on the RP2350 (BT113)', () => {
  needsFirmware('blink: the LED on WL_GPIO0 toggles every 500 ms through cyw43_ll_gpio_set (RISC-V HLE)', () => {
    const { mcu, problems, edges, serial } = boot(true);
    run(mcu, 2200);
    expect(edges.map(([, level]) => level)).toEqual([1, 0, 1, 0, 1]);
    for (let i = 1; i < edges.length; i++) expect(edges[i][0] - edges[i - 1][0]).toBeCloseTo(500, 0);
    expect(serial()).toContain('led 1\r\nled 0\r\n');
    expect(mcu.cyw43?.calls.get('cyw43_ll_bus_init')).toBe(1);
    expect(mcu.cyw43?.calls.get('cyw43_ll_gpio_set')).toBe(5);
    expect(problems).not.toContain(CODE_CYW43_NO_SYMBOLS);
  });

  needsFirmware('a reset answers the chip again (a fresh table): the LED blinks on', () => {
    const { mcu, edges } = boot(true);
    run(mcu, 300);
    mcu.reset();
    edges.length = 0;
    run(mcu, 700);
    expect(edges.map(([, level]) => level)).toEqual([1, 0]);
  });

  needsFirmware('without symbols: rp2350-cyw43-no-symbols once, the LED dark, the sketch running', () => {
    const { mcu, problems, edges, serial } = boot(false);
    run(mcu, 1500);
    expect(problems.filter((p) => p === CODE_CYW43_NO_SYMBOLS)).toHaveLength(1);
    expect(edges).toEqual([]);
    expect(serial()).toContain('led 1');
  });

  it('the resume address is bootrom Arm code past the RISC-V bootrom (whose code ends at 0x7E00)', () => {
    expect(RP2350_HLE_RESUME_PC).toBeGreaterThanOrEqual(0x7e00);
    expect(RP2350_HLE_RESUME_PC).toBeLessThan(0x8000);
  });

  it('the factory makes a Pico 2 W of a board that maps WL_GPIO0 (its MAC 28:CD:C1 and a hash); a Pico 2 has no chip', () => {
    const board: BoardSpec = { mcu: 'rp2350', pinMap: { WL_GPIO0: 'WL_GPIO0', GP0: 'GPIO0' } };
    const w = rp2350McuFactory(board, 'p2w', undefined, { rom: ROM }) as Rp2350Mcu;
    expect(w.pins.has('WL_GPIO0')).toBe(true);
    expect((w.cyw43 as unknown as { host: { mac: number[] } }).host.mac.slice(0, 3)).toEqual([0x28, 0xcd, 0xc1]);
    const pico2 = rp2350McuFactory({ mcu: 'rp2350', pinMap: { TP5: 'GPIO25' } }, 'p2', undefined, { rom: ROM }) as Rp2350Mcu;
    expect(pico2.cyw43).toBeNull();
    expect(pico2.pins.has('WL_GPIO0')).toBe(false);
  });
});
