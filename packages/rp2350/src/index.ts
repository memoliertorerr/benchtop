/**
 * @benchtop/rp2350 — the Raspberry Pi RP2350, RISC-V side (BT65 onward): the SoC on Benchtop's
 * Hazard3 core (@benchtop/riscv), the real bootrom (fetched, never committed), and the `Mcu`
 * adapter over it. DOM-free.
 */
import type { BoardSpec, Mcu, Problem } from '@benchtop/core';
import { createRp2350Mcu } from './rp2350-mcu.ts';

export * from './boot.ts';
export * from './rom-manifest.ts';
export * from './rp2350-mcu.ts';
export * from './soc.ts';

/** The downloaded files an RP2350 board runs on (each undefined when not cached: the board says so). */
export interface Rp2350Files {
  /** bootrom-combined.bin (`rp2350-rom-missing` without it). */
  rom?: Uint8Array | undefined;
  /** BT67: the stock RPI_PICO2-RISCV MicroPython UF2 (`micropython-missing` for a MicroPython sketch without it). */
  micropython?: Uint8Array | undefined;
}

/**
 * The bench's MCU factory for RP2350 boards. One Problem per code on the board part, the first
 * three messages joined and the rest counted (as the other factories do).
 */
export function rp2350McuFactory(board: BoardSpec, partId: string, report?: (problem: Problem) => void, files: Rp2350Files = {}): Mcu | undefined {
  if (board.mcu !== 'rp2350') return undefined;
  const mcu = createRp2350Mcu({ ...(files.rom === undefined ? {} : { rom: files.rom }), ...(files.micropython === undefined ? {} : { micropython: files.micropython }) });
  if (report !== undefined) {
    const seen = new Map<string, { messages: string[]; count: number }>();
    mcu.onProblem = (problem) => {
      let entry = seen.get(problem.code);
      if (entry === undefined) seen.set(problem.code, (entry = { messages: [], count: 0 }));
      entry.count++;
      if (entry.messages.length < 3 && !entry.messages.includes(problem.message)) entry.messages.push(problem.message);
      const more = entry.count - entry.messages.length;
      report({ severity: problem.severity, code: problem.code, message: entry.messages.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), parts: [partId] });
    };
  }
  return mcu;
}
