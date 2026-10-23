/**
 * Boots an ESP32-C3 fixture (fixtures/firmware/esp32c3/<name>.bin + .partitions.bin) on an
 * Esp32c3Soc with the cached ROM, for tests (Node-only). UART output is kept per port as text
 * (latin-1), and every byte with the reference time its stop bit ended.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { directBoot } from '../boot/direct-boot.ts';
import { Esp32c3Soc } from '../soc/soc.ts';
import { cachedC3Rom } from './rom.test-helper.ts';

export const C3_FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32c3');

export interface BootedC3 {
  soc: Esp32c3Soc;
  uart: [string, string];
  /** UART0's bytes as [byte, reference time] pairs. */
  sent: [number, number][];
}

export function fixtureImage(name: string): { app: Uint8Array; partitions: Uint8Array } {
  return {
    app: new Uint8Array(readFileSync(join(C3_FIXTURE_DIR, `${name}.bin`))),
    partitions: new Uint8Array(readFileSync(join(C3_FIXTURE_DIR, `${name}.partitions.bin`))),
  };
}

export function bootC3Fixture(name: string): BootedC3 {
  const soc = new Esp32c3Soc();
  const boot = directBoot(soc, { ...fixtureImage(name), rom: cachedC3Rom() });
  if (!boot.ok) throw new Error(`direct boot of ${name}: ${boot.error}`);
  const booted: BootedC3 = { soc, uart: ['', ''], sent: [] };
  soc.uarts.forEach((uart, port) => {
    uart.onTx = (byte) => {
      booted.uart[port] += String.fromCharCode(byte);
      if (port === 0) booted.sent.push([byte, soc.now()]);
    };
  });
  return booted;
}
