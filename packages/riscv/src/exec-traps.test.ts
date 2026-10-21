import { describe, expect, it } from 'vitest';
import { RiscvBusError } from './bus.ts';
import { RiscvCore } from './cpu.ts';
import { RV32IMAC } from './isa.ts';
import { IRQ } from './traps.ts';
import { OUT_BASE, programSymbols, RiscvBareMachine } from './test-support/bare-machine.test-helper.ts';

// BT64: machine and user mode on traps.S (expected values from the privileged spec; each
// line says why), plus the core's API corners the program can't reach.

const BUF = 0x80030000;

function runTraps(predecode: boolean): { out: number[]; at: (name: string) => number; bits: (name: string) => number; machine: RiscvBareMachine } {
  let custom = 0xabc;
  const machine = new RiscvBareMachine({
    csrHook: {
      readCsr: (csr) => (csr === 0xbc0 ? custom : undefined),
      writeCsr: (csr, value) => {
        if (csr !== 0xbc0) return false;
        custom = value;
        return true;
      },
    },
  });
  machine.core.predecode = predecode;
  machine.loadProgram('traps');
  const symbols = programSymbols('traps');
  const at = (name: string): number => {
    const address = symbols.get(name);
    if (address === undefined) throw new Error(`no symbol ${name}`);
    return address;
  };
  const bits = (name: string): number => {
    const lo = machine.half(at(name));
    return (lo & 3) === 3 ? (lo | (machine.half(at(name) + 2) << 16)) >>> 0 : lo;
  };
  // Each time the core sleeps in WFI, raise the machine timer interrupt.
  machine.run(1_000_000, () => machine.core.setInterruptLine(IRQ.MTI, true));
  expect(machine.exitCode).toBe(0);
  return { out: machine.readWords(OUT_BASE, 120), at, bits, machine };
}

describe('machine and user mode (traps.S)', () => {
  for (const predecode of [true, false]) {
    it(`exceptions, user mode, counters, CSRs, PMP storage, the CSR hook, interrupts and WFI (${predecode ? 'predecoded' : 'decoded every time'})`, () => {
      const { out, at, bits, machine } = runTraps(predecode);
      const trap = (cause: number, epc: number, tval: number): number[] => [cause, epc, tval];
      const want = [
        ...trap(11, at('t_ecall'), 0), // ecall from M
        ...trap(3, at('t_ebreak'), at('t_ebreak')), // ebreak: mtval = its pc
        ...trap(3, at('t_cebreak'), at('t_cebreak')), // c.ebreak
        ...trap(2, at('t_unimp'), 0xc0001073), // unimp = csrrw zero, cycle, zero: a write to a read-only CSR
        ...trap(2, at('t_cunimp'), 0), // c.unimp: the all-zero halfword
        ...trap(2, at('t_sret'), 0x10200073), // no supervisor mode
        ...trap(2, at('t_ro'), bits('t_ro')), // csrw mvendorid: read-only
        ...trap(2, at('t_nocsr'), bits('t_nocsr')), // 0x7c0: neither the core's nor the hook's
        ...trap(4, at('t_lmis'), BUF + 1), // lw at +1
        ...trap(4, at('t_hmis'), BUF + 3), // lh at +3
        ...trap(6, at('t_smis'), BUF + 2), // sw at +2
        ...trap(6, at('t_shmis'), BUF + 1), // sh at +1
        ...trap(6, at('t_amomis'), BUF + 2), // an AMO is a store/AMO misalignment
        ...trap(4, at('t_lrmis'), BUF + 2), // lr.w is a load
        ...trap(5, at('t_lfault'), 0), // load from unmapped 0
        ...trap(7, at('t_sfault'), 4), // store to unmapped 4
        ...trap(7, at('t_amofault'), 4), // AMO: store/AMO access fault
        ...trap(5, at('t_lrfault'), 4), // lr.w: load access fault
        ...trap(1, 0x100, 0x100), // jalr to unmapped 0x100: instruction access fault there
        ...trap(8, at('t_uecall'), 0), // ecall from U
        0x88, // mstatus back in M: MIE = MPIE (1, from the first mret), MPIE = 1, MPP = U
        ...trap(2, at('t_umstatus'), bits('t_umstatus')), // a machine CSR from U
        ...trap(2, at('t_ucycle'), bits('t_ucycle')), // cycle from U without mcounteren.CY
        ...trap(2, at('t_uwfi'), bits('t_uwfi')), // wfi in U with mstatus.TW
        ...trap(2, at('t_umret'), 0x30200073), // mret in U
        ...trap(8, at('t_uecall2'), 0),
        0x600d, // U reads cycle and instret with mcounteren = CY | IR
        ...trap(8, at('t_uecall3'), 0),
        11, // minstret across 10 nops (the first read retires too)
        11, // mcycle across 10 nops (one cycle each)
        100, // minstret written: the next instruction reads the value
        1000, // mcycle written
        7, // minstreth written
        0, // minstret with mcountinhibit.IR
        0, // mcycle with mcountinhibit.CY
        0x5a5a, // mscratch
        machine.core.misa, // misa
        0, // mhartid
        0x80000000, // mepc clears bit 0
        0x80000001, // mtvec keeps mode 1 (vectored), drops bit 1
        0x888, // mie: MSIE, MTIE, MEIE only
        0, // mip: no lines
        0x3fffffff, // pmpaddr0: 30 bits
        0x1f1f1f1f, // pmpcfg0: R, W, X, A per entry
        0, // R = 0, W = 1 is reserved: W cleared
        0x3fffffff, // pmpaddr0 of a locked entry ignores writes
        0x81, // and so does its pmpcfg byte
        0xabc, // the hook's CSR
        0x77, // written through the hook
        0x80000007, at('t_after_mti'), // MTI, vectored, taken after the store that raised it
        0x1111,
        0x8000000b, at('t_after_mei'), // MEI before MSI
        0x80000003, at('t_after_mei'), // then MSI
        0x2222,
        0x3333, // MTI pending with MIE clear: not taken
        0x80, // mip shows it
        0x4444, // WFI ends on a pending enabled interrupt even with MIE clear
        0x80, // the test raised MTI while the core slept
        0x80000007, at('t_after_wfi2'), // WFI with MIE: taken, mepc after the WFI
        0x5555,
      ];
      expect(out.slice(0, want.length).map((v) => v.toString(16))).toEqual(want.map((v) => (v >>> 0).toString(16)));
      expect(machine.core.mode).toBe(3);
      expect(machine.core.slept).toBeGreaterThan(0);
    });
  }

  it('reports traps to trapHook and keeps minstret apart from trap entries and sleep', () => {
    const { machine } = runTraps(true);
    const core = machine.core;
    expect(core.instructions).toBe(core.cycles - core.slept - core.trapCycles);
    expect(core.trapCycles).toBeGreaterThan(20);
  });

  it('hands an indexed CSR instruction to accessCsr whole (operand, kind, writes), and reports MRET (BT65)', () => {
    const calls: [number, number, number, boolean][] = [];
    let mrets = 0;
    const machine = new RiscvBareMachine({
      csrHook: {
        readCsr: () => undefined,
        writeCsr: () => false,
        accessCsr: (csr, kind, operand, writes) => {
          calls.push([csr, kind, operand, writes]);
          return csr === 0xbe0 ? (0x1234 << 16) | operand : undefined;
        },
      },
    });
    machine.core.mretHook = () => mrets++;
    const word = (w: number): number[] => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24];
    const csr = (c: number, rs1OrImm: number, funct3: number, rd: number): number => ((c << 20) | (rs1OrImm << 15) | (funct3 << 12) | (rd << 7) | 0x73) >>> 0;
    machine.load(
      Uint8Array.from([
        ...word(csr(0xbe0, 3, 6, 10)), // csrrsi a0, meiea, 3: read the window at index 3
        ...word(csr(0xbe0, 0, 2, 12)), // csrrs a2, meiea, x0: a read with no write
        ...word(csr(0xbe0, 11, 1, 0)), // csrrw x0, meiea, a1
        ...word(0x30200073), // mret
      ]),
    );
    machine.core.x[11] = 0x00ff0002;
    machine.core.mepc = 0x80000010;
    machine.core.run(4);
    expect(calls).toEqual([
      [0xbe0, 1, 3, true],
      [0xbe0, 1, 0, false],
      [0xbe0, 0, 0x00ff0002, true],
    ]);
    expect(machine.core.x[10] >>> 0).toBe(0x12340003);
    expect(machine.core.x[12] >>> 0).toBe(0x12340000);
    expect(mrets).toBe(1);
    expect(machine.core.pc).toBe(0x80000010);
  });

  it('halts on EBREAK when the hook claims it, without a trap', () => {
    const machine = new RiscvBareMachine({ ebreakHalts: true });
    machine.load(Uint8Array.of(0x13, 0x05, 0x50, 0x00, 0x73, 0x00, 0x10, 0x00)); // li a0, 5; ebreak
    machine.core.run(100);
    expect(machine.core.halt).toBe(1);
    expect(machine.core.x[10]).toBe(5);
    expect(machine.core.pc).toBe(0x80000004);
    expect(machine.core.trapCycles).toBe(0);
  });

  it('without user mode: MPP stays M, mcounteren does not exist, mret returns to M', () => {
    const core = new RiscvCore(new RiscvBareMachine().bus, { profile: RV32IMAC });
    expect(core.writeCsr(0x300, 0)).toBe(true);
    expect((core.mstatus >>> 11) & 3).toBe(3);
    expect(core.readCsr(0x306)).toBeUndefined();
    expect(core.misa).toBe(0x40001105); // RV32 A C I M
  });

  it('turns a bus error on the second halfword of a 32-bit instruction into an instruction access fault there', () => {
    const machine = new RiscvBareMachine();
    const end = 0x80000000 + 256 * 1024;
    machine.core.predecode = false;
    machine.load(Uint8Array.of(0x13, 0x00), end - 2); // the low half of addi zero, zero, 0
    machine.core.pc = end - 2;
    machine.core.step();
    expect(machine.core.mcause).toBe(1);
    expect(machine.core.mtval).toBe(end >>> 0);
    expect(machine.core.mepc).toBe((end - 2) >>> 0);
  });

  it('RiscvBusError carries the address', () => {
    expect(new RiscvBusError('load', -4).address).toBe(0xfffffffc);
  });
});
