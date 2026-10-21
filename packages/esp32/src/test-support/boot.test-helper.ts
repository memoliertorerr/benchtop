/**
 * Boots an ESP32 fixture (fixtures/firmware/esp32/<name>.bin + .partitions.bin + .syms.tsv) on
 * an Esp32Soc with the cached ROM, for tests and scripts/esp32-trace.ts (Node-only).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { directBoot } from '../boot/direct-boot.ts';
import { parseRomElf, type RomImage } from '../boot/rom.ts';
import { EspSymbols } from '../debug/symbols.ts';
import { SocTracer } from '../debug/trace.ts';
import { REF_HZ } from '../soc/context.ts';
import { Esp32Soc } from '../soc/soc.ts';
import { loadCachedRom } from './rom.test-helper.ts';

/** Boot milestones, in the order the BT32 tests expect them. */
export const BOOT_MILESTONES = ['call_start_cpu0', 'call_start_cpu1', 'esp_clk_init', 'app_main', 'initArduino', '_Z5setupv'] as const;

let rom: RomImage | undefined;
export function cachedRom(): RomImage {
  rom ??= parseRomElf(loadCachedRom());
  return rom;
}

export interface BootedFixture {
  soc: Esp32Soc;
  symbols: EspSymbols;
  tracer: SocTracer | null;
  /** UART output per port, as text (latin-1). */
  uart: string[];
}

export function bootFixture(name: string, options: { trace?: boolean; milestones?: readonly string[] } = {}): BootedFixture {
  const dir = join(REPO_ROOT, 'fixtures', 'firmware', 'esp32');
  const app = new Uint8Array(readFileSync(join(dir, `${name}.bin`)));
  const partitions = new Uint8Array(readFileSync(join(dir, `${name}.partitions.bin`)));
  const romImage = cachedRom();
  const symbols = new EspSymbols([...EspSymbols.parseTsv(readFileSync(join(dir, `${name}.syms.tsv`), 'utf8')), ...EspSymbols.fromMap(romImage.symbols)]);
  const soc = new Esp32Soc();
  const boot = directBoot(soc, { app, partitions, rom: romImage });
  if (!boot.ok) throw new Error(`direct boot of ${name}: ${boot.error}`);
  const uart = ['', '', ''];
  soc.onUart = (port, byte) => {
    uart[port] += String.fromCharCode(byte);
  };
  const tracer = options.trace === true ? new SocTracer(soc, symbols, options.milestones ?? BOOT_MILESTONES) : null;
  return { soc, symbols, tracer, uart };
}

/** Runs until `until()` holds, the SoC stops, or `maxSeconds` of simulated time pass; in 1 ms steps. */
export function runUntil(soc: Esp32Soc, maxSeconds: number, until: () => boolean = () => false): void {
  const end = soc.time + maxSeconds * REF_HZ;
  while (soc.time < end && !soc.stopped && !until()) soc.runUntil(Math.min(end, soc.time + REF_HZ / 1000));
}
