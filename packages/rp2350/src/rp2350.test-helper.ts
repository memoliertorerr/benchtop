/**
 * Test helpers for the RP2350 (BT65; Node-only): the cached bootrom (tests that need it fail with
 * instructions without it — never skip), fixture UF2s, a booted Mcu, edge timing on a pin.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { ROM_CACHE_DIR, ROM_IMAGE } from './rom-manifest.ts';
import { createRp2350Mcu, RP2350_CLOCK_HZ, type Rp2350Mcu } from './rp2350-mcu.ts';

/** bootrom-combined.bin from .cache/rp2350-rom, size- and hash-checked. */
export function cachedRom(): Uint8Array {
  const path = join(REPO_ROOT, ROM_CACHE_DIR, ROM_IMAGE.name);
  if (!existsSync(path)) throw new Error(`RP2350 bootrom not found at ${path}: run npm run fetch:rp2350-rom (needs a human-approved download)`);
  const bytes = new Uint8Array(readFileSync(path));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== ROM_IMAGE.bytes || hash !== ROM_IMAGE.sha256) throw new Error(`${path} is ${bytes.length} bytes with SHA-256 ${hash}, expected ${ROM_IMAGE.sha256}: delete it and run npm run fetch:rp2350-rom again`);
  return bytes;
}

export function pico2Firmware(name: string): Uint8Array {
  return readFixture(`fixtures/firmware/pico2/${name}.uf2`);
}

/** A Pico 2 running a fixture, with UART0 and UART1 text collected and Problems kept. */
export function bootPico2(name: string): { mcu: Rp2350Mcu; serial: string[]; problems: string[] } {
  const problems: string[] = [];
  const mcu = createRp2350Mcu({ rom: cachedRom(), onProblem: (p) => problems.push(`${p.code}: ${p.message}`) });
  mcu.load({ format: 'uf2', bytes: pico2Firmware(name) });
  const serial = ['', ''];
  for (let i = 0; i < 2; i++) mcu.uart(i + 1)?.onTransmit((b) => (serial[i] += String.fromCharCode(b)));
  return { mcu, serial, problems };
}

/** Runs `ms` of simulated time in 1 ms slices; throws on a halt or fault. */
export function runMs(mcu: Rp2350Mcu, ms: number): void {
  const step = RP2350_CLOCK_HZ / 1000;
  const end = mcu.cycles + ms * step;
  while (mcu.cycles < end) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + step));
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
  }
}

/** The times (ms) a pin's output level changes. */
export function edgeTimes(mcu: Rp2350Mcu, pin: string): { times: number[]; levels: number[] } {
  const p = mcu.pins.get(pin);
  if (p === undefined) throw new Error(`no pin ${pin}`);
  const times: number[] = [];
  const levels: number[] = [];
  let last = -1;
  p.onOutputChange(() => {
    const level = p.mode() === 'output' ? p.outputLevel() : -1;
    if (level === last) return;
    last = level;
    times.push((mcu.cycles / RP2350_CLOCK_HZ) * 1000);
    levels.push(level);
  });
  return { times, levels };
}
