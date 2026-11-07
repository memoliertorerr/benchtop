/**
 * Boots an ESP32-S3 fixture (fixtures/firmware/esp32s3/<name>.bin + .partitions.bin) on an
 * Esp32s3Soc with the cached ROM, for tests (Node-only). UART output is kept per port as text
 * (latin-1), and UART0's bytes with the reference time each frame ended.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { directBootS3 } from '../boot/direct-boot.ts';
import { Esp32s3Soc } from '../soc/soc.ts';
import { cachedS3Rom } from './rom.test-helper.ts';

export const S3_FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32s3');

export interface BootedS3 {
  soc: Esp32s3Soc;
  uart: [string, string, string];
  /** UART0's bytes as [byte, reference time] pairs. */
  sent: [number, number][];
}

export function s3FixtureImage(name: string): { app: Uint8Array; partitions: Uint8Array } {
  return {
    app: new Uint8Array(readFileSync(join(S3_FIXTURE_DIR, `${name}.bin`))),
    partitions: new Uint8Array(readFileSync(join(S3_FIXTURE_DIR, `${name}.partitions.bin`))),
  };
}

export function bootS3Fixture(name: string): BootedS3 {
  const soc = new Esp32s3Soc();
  const boot = directBootS3(soc, { ...s3FixtureImage(name), rom: cachedS3Rom() });
  if (!boot.ok) throw new Error(`direct boot of ${name}: ${boot.error}`);
  const booted: BootedS3 = { soc, uart: ['', '', ''], sent: [] };
  soc.uarts.forEach((uart, port) => {
    uart.onTx = (byte) => {
      booted.uart[port] += String.fromCharCode(byte);
      if (port === 0) booted.sent.push([byte, soc.now()]);
    };
  });
  return booted;
}
