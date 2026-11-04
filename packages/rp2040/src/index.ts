/**
 * @benchtop/rp2040 — the Raspberry Pi RP2040 (BT60 onward): the `Mcu` adapter over rp2040js
 * (MIT, Wokwi) with Benchtop's clean-room bootrom, UF2 and ELF loading, USB serial and the bench
 * bus contracts. DOM-free.
 */
import type { BoardSpec, Mcu, Problem } from '@benchtop/core';
import { macFromName } from '@benchtop/core';
import { createRp2040Mcu } from './rp2040-mcu.ts';

export * from './bootrom/float.ts';
export * from './bootrom/layout.ts';
export * from './bridges.ts';
export * from './cyw43/cyw43.ts';
export * from './hle.ts';
export * from './micropython.ts';
export * from './micropython-manifest.ts';
export * from './rp2040-mcu.ts';

/**
 * The bench's MCU factory for RP2040 boards: one Problem per code on the board part, the first
 * three messages joined and the rest counted (as the ESP32 factory does). `micropython`: the
 * stock MicroPython UF2 for boards loaded with a MicroPython sketch (BT63).
 */
export function rp2040McuFactory(board: BoardSpec, partId: string, report?: (problem: Problem) => void, micropython?: Uint8Array): Mcu | undefined {
  if (board.mcu !== 'rp2040') return undefined;
  // BT110: a board that maps a pin to WL_GPIO0 is a Pico W — the RP2040 with the CYW43439, its
  // MAC Raspberry Pi's 28:CD:C1 and three bytes hashed from the part id (two boards differ).
  const picoW = Object.values(board.pinMap).includes('WL_GPIO0');
  const mcu = createRp2040Mcu({ ...(micropython === undefined ? {} : { micropython }), ...(picoW ? { cyw43: { mac: macFromName(partId, [0x28, 0xcd, 0xc1]) } } : {}) });
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
