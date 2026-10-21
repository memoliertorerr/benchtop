/**
 * Test helpers for the RP2040 (BT60): fixture UF2s, a booted Mcu, edge timing on a pin and
 * collected serial text.
 */

import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { createRp2040Mcu, RP2040_CLOCK_HZ, type Rp2040Mcu } from './rp2040-mcu.ts';

export function picoFirmware(name: string): Uint8Array {
  return readFixture(`fixtures/firmware/pico/${name}.uf2`);
}

/** A Pico running a fixture, with every UART's text collected (index 0: USB serial). */
export function bootPico(name: string): { mcu: Rp2040Mcu; serial: string[]; problems: string[] } {
  const problems: string[] = [];
  const mcu = createRp2040Mcu({ onProblem: (p) => problems.push(`${p.code}: ${p.message}`) });
  mcu.load({ format: 'uf2', bytes: picoFirmware(name) });
  const serial = ['', '', ''];
  for (let i = 0; i < 3; i++) mcu.uart(i)?.onTransmit((b) => (serial[i] += String.fromCharCode(b)));
  return { mcu, serial, problems };
}

/** Runs `ms` of simulated time in 1 ms slices; throws on a halt or fault. */
export function runMs(mcu: Rp2040Mcu, ms: number, each?: () => void): void {
  const step = RP2040_CLOCK_HZ / 1000;
  const end = mcu.cycles + ms * step;
  while (mcu.cycles < end) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + step));
    if (result.reason !== 'target') throw new Error(`run stopped: ${result.reason} ${result.detail ?? ''}`);
    each?.();
  }
}

/** Records the times (ms) a pin's output level changes. */
export function edgeTimes(mcu: Rp2040Mcu, pin: string): { times: number[]; levels: number[] } {
  const p = mcu.pins.get(pin);
  if (p === undefined) throw new Error(`no pin ${pin}`);
  const times: number[] = [];
  const levels: number[] = [];
  let last = -1;
  p.onOutputChange(() => {
    const level = p.mode() === 'output' ? p.outputLevel() : -1;
    if (level === last) return;
    last = level;
    times.push((mcu.cycles / RP2040_CLOCK_HZ) * 1000);
    levels.push(level);
  });
  return { times, levels };
}
