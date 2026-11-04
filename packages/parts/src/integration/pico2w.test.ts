import { Bench, type BenchEnv, NS_PER_MS, parseProject, SymbolTable } from '@benchtop/core';
import { rp2350McuFactory, type Rp2350Mcu } from '@benchtop/rp2350';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText, withheldFirmware } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { cachedRom } from '../../../rp2350/src/rp2350.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// The published repository leaves the Pico 2 W firmware out (THIRD_PARTY_NOTICES.md): skipped there, never here.
const WITHHELD = withheldFirmware('pico2w/blink.uf2') !== undefined;

// BT114: the Raspberry Pi Pico 2 W on a full Bench — the RP2350 factory makes its Mcu with the
// CYW43 from the board's pin map (the Pico W's chip model on the RISC-V harts), the fixtures'
// symbols answer the chip's driver, and the bench's access point and LAN do the rest.

const ROM = cachedRom();

function load(firmware: string, project: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const codes: string[] = [];
  let mcu: Rp2350Mcu | null = null;
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = rp2350McuFactory(
        board,
        id,
        (p) => {
          codes.push(p.code);
          report?.(p);
        },
        { rom: ROM },
      ) as Rp2350Mcu;
      mcu = created;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware('pico2w', { format: 'uf2', bytes: readFixture(`fixtures/firmware/pico2w/${firmware}.uf2`) });
  bench.reset();
  (mcu as Rp2350Mcu | null)?.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/pico2w/${firmware}.syms.tsv`)));
  let serial = '';
  bench.onSerial('pico2w', (bytes) => (serial += String.fromCharCode(...bytes)));
  const led: number[] = [];
  const runUntil = (maxMs: number, done: () => boolean): void => {
    for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'pico2w') led.push(visual.led as number);
    }
  };
  return { bench, runUntil, led, codes, serial: () => serial, mcu: (): Rp2350Mcu => mcu as unknown as Rp2350Mcu };
}

describe.skipIf(WITHHELD)('Raspberry Pi Pico 2 W on the bench (BT114)', () => {
  it('blink: the board’s LED lights and darkens through the CYW43', () => {
    const t = load('blink', 'pico2w-blink');
    t.runUntil(1300, () => false);
    expect(t.led.some((b) => b > 0.9)).toBe(true);
    expect(t.led.at(-1)).toBe(1);
    expect(t.codes).not.toContain('rp2350-cyw43-no-symbols');
  });

  it('scans the access point, joins it and gets 192.168.4.2 from its DHCP server', () => {
    const t = load('wifi-scan', 'pico2w-wifi');
    t.runUntil(8000, () => /connected .*\n/.test(t.serial()));
    expect(t.serial()).toContain('benchtop -50 4\nscan done 1\n');
    expect(t.serial()).toContain('connected 192.168.4.2');
    const ap = t.bench.network?.accessPoints[0];
    expect(ap?.stations.size).toBe(1);
    expect([...(ap?.stations.keys() ?? [])][0]?.startsWith('28:cd:c1:')).toBe(true);
  });

  it('a web server: an HTTP client part switches the LED through /led?state=on|off', () => {
    const t = load('wifi-webserver', 'pico2w-wifi-webserver');
    t.runUntil(3000, () => t.serial().includes('server at'));
    expect(t.serial()).toContain('server at 192.168.4.2');
    t.bench.input('on', { kind: 'press' });
    t.runUntil(t.bench.now() / NS_PER_MS + 100, () => false);
    expect(t.led.at(-1)).toBe(1);
    expect(t.serial()).toContain('GET /led on');
    t.bench.input('off', { kind: 'press' });
    t.runUntil(t.bench.now() / NS_PER_MS + 100, () => false);
    expect(t.led.at(-1)).toBe(0);
  });

  it('HTTPClient halts in __halt_on_unhandled_exception: a misaligned store (mcause 6) in the RISC-V build’s strcpy', () => {
    // Found in BT114: arduino-pico 6.2.0's RISC-V C library copies strings a word at a time with
    // no alignment check, and Hazard3 (like this core) traps misaligned stores; the firmware has no
    // handler that emulates them. String::concat in HTTPClient's request hits it. Kept as found —
    // a human check confirms it on a Pico 2 W (docs/HUMAN_CHECKS.md, BT114).
    const t = load('wifi-http-get', 'pico2w-wifi-http');
    t.runUntil(4000, () => false);
    expect(t.serial()).toContain('connected 192.168.4.2');
    expect(t.serial()).not.toContain('GET ');
    const hart = (t.mcu().soc?.harts[0] as unknown as { mcause: number } | undefined);
    expect(hart?.mcause).toBe(6); // store/AMO address misaligned
  });
});
