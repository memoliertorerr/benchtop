/**
 * Boots an ESP32-S2 fixture (fixtures/firmware/esp32s2/<name>.bin + .partitions.bin) on an
 * Esp32s2Soc with the cached ROM, for tests (Node-only). UART output is kept per port as text
 * (latin-1), and UART0's bytes with the reference time each frame ended.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { directBootS2 } from '../boot/direct-boot.ts';
import { Esp32s2Soc } from '../soc/soc.ts';
import { cachedS2Rom } from './rom.test-helper.ts';

export const S2_FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32s2');

export interface BootedS2 {
  soc: Esp32s2Soc;
  uart: [string, string];
  /** UART0's bytes as [byte, reference time] pairs. */
  sent: [number, number][];
}

export function s2FixtureImage(name: string): { app: Uint8Array; partitions: Uint8Array } {
  return {
    app: new Uint8Array(readFileSync(join(S2_FIXTURE_DIR, `${name}.bin`))),
    partitions: new Uint8Array(readFileSync(join(S2_FIXTURE_DIR, `${name}.partitions.bin`))),
  };
}

export function bootS2Fixture(name: string): BootedS2 {
  const soc = new Esp32s2Soc();
  const boot = directBootS2(soc, { ...s2FixtureImage(name), rom: cachedS2Rom() });
  if (!boot.ok) throw new Error(`direct boot of ${name}: ${boot.error}`);
  const booted: BootedS2 = { soc, uart: ['', ''], sent: [] };
  soc.uarts.forEach((uart, port) => {
    uart.onTx = (byte) => {
      booted.uart[port] += String.fromCharCode(byte);
      if (port === 0) booted.sent.push([byte, soc.now()]);
    };
  });
  return booted;
}
