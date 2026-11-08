import type { BoardSpec } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { createEsp32s3Mcu, type Esp32s3Mcu, esp32s3McuFactory, S3_MODULE_FLASH } from '../esp32s3-mcu.ts';
import { s3FixtureImage } from '../test-support/boot.test-helper.ts';
import { loadCachedS3Rom } from '../test-support/rom.test-helper.ts';
import { REF_HZ } from './rtc-cntl.ts';

// BT143: the S3's flash chip says its module's size (the N8s 8 MB, the N16R8 16 MB); the flash
// holds what the image asks for; a build bigger than the chip stops at startup, as on a board.

const MB = 1024 * 1024;

function run(name: string, flashChipBytes?: number): string {
  const mcu = createEsp32s3Mcu({ rom: loadCachedS3Rom(), ...(flashChipBytes === undefined ? {} : { flashChipBytes }) });
  let out = '';
  mcu.uart(0)!.onTransmit((b) => (out += String.fromCharCode(b)));
  mcu.load({ format: 'esp32-bin', ...s3FixtureImage(name) });
  mcu.runUntil(REF_HZ * 1.5);
  return out;
}

describe('flash size per module on the ESP32-S3 (BT143)', () => {
  it('flash-info (built for 16 MB) boots — the flash grows to what the image asks — and runs on auto and an N16R8; an N8 stops it at startup', () => {
    expect(run('flash-info')).toBe('flash 16777216 chip 16777216 id c84018\n');
    expect(run('flash-info', 16 * MB)).toBe('flash 16777216 chip 16777216 id c84018\n');
    const small = run('flash-info', 8 * MB);
    expect(small).toContain('Detected size(8192k) smaller than the size in');
    expect(small).not.toContain('flash 16777216');
    expect(run('serial-hello', 16 * MB)).toContain('hello from esp32s3');
  });

  it('the factory: each module’s flash chip; an N16R8’s octal PSRAM holds IO35–37 under its own name', () => {
    const factory = esp32s3McuFactory(loadCachedS3Rom());
    const board = { mcu: 'esp32s3', pinMap: {} } as BoardSpec;
    const make = (module: string) => factory(board, 's3', undefined, { module }) as Esp32s3Mcu;
    expect(make('auto').soc.flash.chipBytes).toBeNull();
    expect(make('N8').soc.flash.chipBytes).toBe(8 * MB);
    expect(make('N16R8').soc.flash.chipBytes).toBe(16 * MB);
    expect(make('N16R8').soc.psram.protocols).toBe('octal');
    expect(make('N16R8').pinClaims()[2]).toEqual({ pin: 'GPIO35', by: "the N16R8 module's octal PSRAM (SPIIO6)" });
    expect(S3_MODULE_FLASH).toEqual({ auto: null, N8: 8 * MB, N8R2: 8 * MB, N8R8: 8 * MB, N16R8: 16 * MB });
  });
});
