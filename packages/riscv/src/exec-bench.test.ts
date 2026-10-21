import { describe, expect, it } from 'vitest';
import { IN_BASE, OUT_BASE, RiscvBareMachine } from './test-support/bare-machine.test-helper.ts';

// BT64 (d): simulated MIPS of the core in plain Node on bench-loop.S (a bitwise CRC-32), with
// and without the predecode cache. Reported, not asserted: wall time varies with the machine
// and with what runs beside it.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('bench-loop', () => {
  for (const predecode of [true, false]) {
    it(`computes CRC-32 rounds and reports simulated MIPS (${predecode ? 'predecoded' : 'decoded every time'})`, () => {
      const machine = new RiscvBareMachine();
      machine.core.predecode = predecode;
      machine.loadProgram('bench-loop').writeWords(IN_BASE, [100]);
      const start = performance.now();
      machine.run(100_000_000);
      const seconds = (performance.now() - start) / 1000;
      expect(machine.exitCode).toBe(0);
      const buffer = Uint8Array.from({ length: 4096 }, (_, i) => (7 * i) & 0xff);
      expect(machine.readWords(OUT_BASE, 1)[0]).toBe(crc32(buffer));
      const instructions = machine.core.instructions;
      expect(instructions).toBeGreaterThan(15_000_000);
      console.info(`riscv bench-loop (${predecode ? 'predecoded' : 'no cache'}): ${instructions.toLocaleString('en-US')} instructions in ${seconds.toFixed(2)} s = ${(instructions / seconds / 1e6).toFixed(1)} simulated MIPS`);
    }, 60_000);
  }
});
