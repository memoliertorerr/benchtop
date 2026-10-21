/**
 * Shared helpers for the AVR chip tests (atmega328p.test.ts, atmega2560.test.ts): real fixture
 * firmware on an Mcu with no bench, timing in CPU cycles.
 */

import { type Level, type NetState, Strength } from '@benchtop/core';
import { readFixture, readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import type { AvrMcu } from './avr-mcu.ts';

/** Loads fixtures/firmware/<board>/<name>.hex|.elf into `create()`'s MCU and records UART0. */
export function bootFixture<M extends AvrMcu>(create: () => M, board: string, name: string, format: 'hex' | 'elf' = 'hex') {
  const mcu = create();
  if (format === 'hex') mcu.load({ format, text: readFixtureText(`fixtures/firmware/${board}/${name}.hex`) });
  else mcu.load({ format, bytes: readFixture(`fixtures/firmware/${board}/${name}.elf`) });
  const serial: { byte: number; cycle: number }[] = [];
  mcu.uart(0)?.onTransmit((byte) => serial.push({ byte, cycle: mcu.cycles }));
  const text = () => String.fromCharCode(...serial.map((s) => s.byte));
  const lines = () => text().split('\r\n').slice(0, -1);
  return { mcu, serial, text, lines };
}

/**
 * Records (cycle, level) whenever the pin's driven level changes while it is an output. Pins
 * start low, so becoming an output that drives 0 (pinMode OUTPUT) is not an edge.
 */
export function watch(mcu: AvrMcu, id: string) {
  const pin = mcu.pins.get(id);
  if (pin === undefined) throw new Error(`no pin ${id}`);
  const edges: { cycle: number; level: Level }[] = [];
  let last: Level = 0;
  pin.onOutputChange(() => {
    const mode = pin.mode();
    const level = pin.outputLevel();
    if ((mode === 'output' || mode === 'peripheral') && level !== last) {
      edges.push({ cycle: mcu.cycles, level });
      last = level;
    }
  });
  return edges;
}

export function volts(v: number, level: Level | null = v >= 2.5 ? 1 : 0): NetState {
  return { level, strength: Strength.strong, conflict: false, volts: v };
}

export function intervals(edges: readonly { cycle: number }[]): number[] {
  return edges.slice(1).map((e, i) => e.cycle - edges[i].cycle);
}

/** Fraction of [start, end) cycles that the edge list spends high. */
export function duty(edges: readonly { cycle: number; level: Level }[], start: number, end: number): number {
  let high = 0;
  let level: Level = 0;
  let at = start;
  for (const e of edges) {
    if (e.cycle <= start) {
      level = e.level;
      continue;
    }
    if (e.cycle >= end) break;
    if (level === 1) high += e.cycle - at;
    at = e.cycle;
    level = e.level;
  }
  if (level === 1) high += end - at;
  return high / (end - start);
}
