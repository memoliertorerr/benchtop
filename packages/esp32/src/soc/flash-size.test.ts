import type { BoardSpec } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createEsp32Mcu, ESP32_MODULE_SPECS, esp32McuFactory, type Esp32Mcu } from '../esp32.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';
import { createTestSoc } from '../test-support/soc.test-helper.ts';
import { REF_HZ } from './context.ts';
import { densityOf } from './flash.ts';

// BT143: the ESP32's flash chip says its module's size; a build bigger than the chip stops at
// startup as on a board (ESP-IDF's size check), a smaller one runs.

const MB = 1024 * 1024;
const image = (name: string) => ({ format: 'esp32-bin' as const, app: readFixture(`fixtures/firmware/esp32/${name}.bin`), partitions: readFixture(`fixtures/firmware/esp32/${name}.partitions.bin`) });

function run(name: string, flashChipBytes?: number): { out: string; reason: string; mcu: Esp32Mcu } {
  const mcu = createEsp32Mcu({ rom: loadCachedRom(), ...(flashChipBytes === undefined ? {} : { flashChipBytes }) });
  let out = '';
  mcu.uart(0)!.onTransmit((b) => (out += String.fromCharCode(b)));
  mcu.load(image(name));
  const result = mcu.runUntil(REF_HZ * 2);
  return { out, reason: result.reason, mcu };
}

describe('flash size per module on the ESP32 (BT143)', () => {
  it('RDID’s density byte: the module’s chip, else the flash the image asked for', () => {
    expect([densityOf(4 * MB), densityOf(8 * MB), densityOf(16 * MB)]).toEqual([0x16, 0x17, 0x18]);
    const soc = createTestSoc();
    expect(soc.flash.jedecId()).toEqual([0xef, 0x40, 0x16]); // the 4 MB default flash
    soc.flash.chipBytes = 16 * MB;
    expect(soc.flash.jedecId()).toEqual([0xef, 0x40, 0x18]);
  });

  it('flash-info (built for 16 MB) runs on auto and on a 16 MB module; on a 4 MB one ESP-IDF stops it at startup, as on a board', () => {
    expect(run('flash-info').out).toBe('flash 16777216 chip 16777216 id ef4018\n');
    expect(run('flash-info', 16 * MB).out).toBe('flash 16777216 chip 16777216 id ef4018\n');
    const small = run('flash-info', 4 * MB);
    expect(small.out).toContain('Detected size(4096k) smaller than the size in the binary image header(16384k). Probe failed.');
    expect(small.out).not.toContain('flash 16777216');
    expect(small.reason).toBe('fault'); // its reset loop
    // A 4 MB build on a 16 MB chip runs (the firmware keeps to its header's size).
    expect(run('serial-hello', 16 * MB).out).toContain('hello from esp32');
  });

  it('the factory: each module’s PSRAM and flash chip', () => {
    const factory = esp32McuFactory(loadCachedRom());
    const board = { mcu: 'esp32', pinMap: {} } as BoardSpec;
    const make = (module: string) => factory(board, 'esp', undefined, { module }) as Esp32Mcu;
    expect(make('auto').soc.flash.chipBytes).toBeNull();
    expect(make('WROOM-32').soc.flash.chipBytes).toBe(4 * MB);
    expect(make('WROOM-32E-N16').soc.flash.chipBytes).toBe(16 * MB);
    expect(make('WROOM-32E-N16').soc.psram.present).toBe(false);
    expect(make('WROVER-E-N16R8').soc.psram.present).toBe(true);
    expect(make('WROVER-E-N16R8').pinClaims().map((c) => c.pin)).toEqual(['GPIO16', 'GPIO17']);
    expect(Object.keys(ESP32_MODULE_SPECS)).toEqual(['auto', 'WROOM-32', 'WROVER-E', 'WROOM-32E-N8', 'WROOM-32E-N16', 'WROVER-E-N16R8']);
  });
});
