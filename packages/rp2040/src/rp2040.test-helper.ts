/**
 * Test helpers for the RP2040 (BT60): fixture UF2s, a booted Mcu, edge timing on a pin and
 * collected serial text; an I2C part and the i2c-scan fixture's lines (the Pico 2's tests too).
 */

import type { I2cDevice } from '@benchtop/core';
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

/** An I2C part at `address` that ACKs everything; `log` is what the bus did ("W"/"R" start, "w<byte>", "P" stop). */
export function ackingPart(address: number): I2cDevice & { log: string[] } {
  const log: string[] = [];
  return {
    address,
    log,
    start: (read) => (log.push(read ? 'R' : 'W'), true),
    write: (byte) => (log.push(`w${byte}`), true),
    read: () => (log.push('r'), 0),
    stop: () => void log.push('P'),
  };
}

/** The i2c-scan fixture's lines (pico and pico2): what each scan found and how long it took. */
export function scanLines(text: string): { found: string; codes: string; read: string; timeout: string; us: number }[] {
  return [...text.matchAll(/scan \d+:(.*?) \| codes ([\d ]+) \| read (\d+) \| timeout (\d) \| (\d+) us\r\n/g)].map((m) => ({
    found: m[1],
    codes: m[2],
    read: m[3],
    timeout: m[4],
    us: Number(m[5]),
  }));
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
