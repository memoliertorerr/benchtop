import { describe, expect, it } from 'vitest';
import type { RiscvBus } from './bus.ts';
import { RiscvCore } from './cpu.ts';
import { RV32IMAC } from './isa.ts';

// BT92: interrupts a SoC's own controller presents as a cause (the ESP32-C3's 31 lines), taken
// through vectored mtvec when mstatus.MIE allows, and waking WFI either way.

class Ram implements RiscvBus {
  readonly bytes = new Uint8Array(0x1000);
  read8 = (a: number): number => this.bytes[a];
  read16 = (a: number): number => this.bytes[a] | (this.bytes[a + 1] << 8);
  read32 = (a: number): number => (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0;
  write8 = (a: number, v: number): void => {
    this.bytes[a] = v;
  };
  write16 = (a: number, v: number): void => {
    this.write8(a, v & 0xff);
    this.write8(a + 1, (v >>> 8) & 0xff);
  };
  write32 = (a: number, v: number): void => {
    this.write16(a, v & 0xffff);
    this.write16(a + 2, v >>> 16);
  };
  fetch16 = (a: number): number => this.read16(a);
}

const CSRSI_MSTATUS_MIE = 0x30046073; // csrsi mstatus, 8
const WFI = 0x10500073;
const LOOP = 0x0000006f; // j .

function machine(enable: boolean): { core: RiscvCore; ram: Ram } {
  const ram = new Ram();
  ram.write32(0, enable ? CSRSI_MSTATUS_MIE : 0x00000013); // or a nop
  ram.write32(4, WFI);
  ram.write32(8, LOOP);
  ram.write32(0x100 + 4 * 5, LOOP); // vector 5
  const core = new RiscvCore(ram, { profile: RV32IMAC });
  core.mtvec = 0x101; // vectored, base 0x100
  return { core, ram };
}

describe('controller-presented interrupt causes (BT92)', () => {
  it('a ready cause wakes WFI and is taken at base + 4n with mcause 0x8000000n', () => {
    const { core } = machine(true);
    core.run(100);
    expect(core.waiting).toBe(true);
    core.setInterruptCause(5);
    core.run(core.cycles + 10);
    expect(core.mcause).toBe(0x80000005);
    expect(core.mepc).toBe(8);
    expect(core.pc).toBe(0x114);
    expect((core.mstatus & 8) === 0).toBe(true); // MIE cleared on entry, as for any trap
  });

  it('with mstatus.MIE clear a cause only wakes WFI; 0 withdraws it', () => {
    const { core } = machine(false);
    core.run(100);
    expect(core.waiting).toBe(true);
    core.setInterruptCause(5);
    core.run(core.cycles + 10);
    expect(core.waiting).toBe(false);
    expect(core.pc).toBe(8);
    expect(core.mcause).toBe(0);
    core.setInterruptCause(0);
    core.run(core.cycles + 10);
    expect(core.pc).toBe(8);
  });
});
