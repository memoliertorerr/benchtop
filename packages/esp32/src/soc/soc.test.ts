import { describe, expect, it } from 'vitest';
import { BareMachine, symbolAddress } from '../test-support/bare-machine.test-helper.ts';
import { createTestSoc, runPro } from '../test-support/soc.test-helper.ts';
import { HALT } from '../xtensa/cpu.ts';
import { XtensaBusError } from '../xtensa/bus.ts';
import { EXCCAUSE } from '../xtensa/exceptions.ts';
import { CODE } from './bus.ts';
import { CACHE_ENABLE, CACHE_MASK, MMU_INVALID } from './mmu.ts';
import { CODE_UNIMPLEMENTED, registerDefault } from './periph.ts';

// BT31: the ESP32 address space per CPU — memories and aliases (TRM v5.8 §3.3), the flash cache
// MMU (§4.3.2.2), unknown registers, region protection and the instruction-bus width rule.

const hex = (v: number): string => `0x${(v >>> 0).toString(16)}`;
const hex8 = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** The bus error a call throws (or fails the test). */
function busError(f: () => unknown): XtensaBusError {
  try {
    f();
  } catch (error) {
    if (error instanceof XtensaBusError) return error;
    throw error;
  }
  throw new Error('no bus error');
}

describe('memory map and aliases', () => {
  it('RAM regions round-trip words, halfwords and bytes on the data bus; the instruction bus takes words', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    const dataRam: [number, number][] = [
      [0x3ffae000, 0x3ffdfffc], // SRAM2
      [0x3ffe0000, 0x3ffffffc], // SRAM1, data bus
      [0x3ff80000, 0x3ff81ffc], // RTC FAST, data bus
      [0x50000000, 0x50001ffc], // RTC SLOW
    ];
    for (const [first, last] of dataRam) {
      for (const a of [first, last]) {
        pro.write32(a, 0xa1b2c3d4);
        expect(hex(pro.read32(a)), hex(a)).toBe('0xa1b2c3d4');
        expect([hex(pro.read8(a)), hex(pro.read16(a + 2))]).toEqual(['0xd4', '0xa1b2']); // little-endian
        pro.write8(a + 1, 0x55);
        pro.write16(a + 2, 0x6677);
        expect(hex(pro.read32(a))).toBe('0x667755d4');
      }
    }
    // Unaligned on the data bus is done by the hardware (core-isa.h: no alignment exception).
    pro.write32(0x3ffb0001, 0x11223344);
    expect(hex(pro.read32(0x3ffb0001))).toBe('0x11223344');
    expect(hex(pro.read16(0x3ffb0003))).toBe('0x1122');
    // Instruction-bus RAM: SRAM0 (with and without its cache pool), SRAM1, RTC FAST.
    for (const a of [0x40070000, 0x4007fffc, 0x40080000, 0x4009fffc, 0x400a0000, 0x400bfffc, 0x400c0000, 0x400c1ffc]) {
      pro.write32(a, a ^ 0x5a5a5a5a);
      expect(hex(pro.read32(a)), hex(a)).toBe(hex(a ^ 0x5a5a5a5a));
    }
    expect(soc.problems.problems).toEqual([]);
  });

  it('SRAM1 is word-inverted between the buses: iram = 0x400A0000 + (0x40000000 − dram) − 4', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    for (let dram = 0x3ffe0000; dram < 0x40000000; dram += 0x1234 & ~3) {
      const iram = 0x400a0000 + (0x40000000 - dram) - 4;
      pro.write32(dram, dram);
      expect(hex(pro.read32(iram)), hex(dram)).toBe(hex(dram));
      pro.write32(iram, ~dram >>> 0);
      expect(hex(pro.read32(dram))).toBe(hex(~dram >>> 0));
    }
    // The TRM's examples, and bytes keep their order inside the word.
    pro.write32(0x400bfffc, 0x44332211);
    expect([hex(pro.read8(0x3ffe0000)), hex(pro.read8(0x3ffe0003))]).toEqual(['0x11', '0x44']);
    pro.write32(0x400a0000, 0xcafef00d);
    expect(hex(pro.read32(0x3ffffffc))).toBe('0xcafef00d');
  });

  it('RTC FAST is the same memory on both buses for the PRO_CPU; the APP_CPU reads 0 and gets a Problem', () => {
    const soc = createTestSoc();
    const [pro, app] = soc.buses;
    pro.write32(0x3ff80010, 0x12345678);
    expect(hex(pro.read32(0x400c0010))).toBe('0x12345678');
    expect(app.read32(0x3ff80010)).toBe(0);
    expect(app.read32(0x400c0010)).toBe(0);
    app.write32(0x3ff80010, 1);
    expect(hex(pro.read32(0x3ff80010))).toBe('0x12345678');
    expect(soc.problems.problems.map((p) => p.code)).toEqual([CODE.RTC_FAST_APP, CODE.RTC_FAST_APP]);
    // RTC SLOW is shared.
    app.write32(0x50000100, 0xabcdef);
    expect(pro.read32(0x50000100)).toBe(0xabcdef);
  });

  it('ROM0 and ROM1 are read-only: writes are ignored and reported', () => {
    const soc = createTestSoc({ rom: true });
    const [pro] = soc.buses;
    const rom0 = pro.read32(0x40000400); // _ResetVector
    expect(rom0).not.toBe(0);
    pro.write32(0x40000400, 0);
    expect(pro.read32(0x40000400)).toBe(rom0);
    expect(pro.read32(0x4005fffc)).toBe(pro.read32(0x4005fffc));
    const rom1 = pro.read32(0x3ff90000);
    pro.write8(0x3ff90000, 0x99);
    expect(pro.read32(0x3ff90000)).toBe(rom1);
    expect(pro.read8(0x3ff9ffff)).toBe(pro.read8(0x3ff9ffff)); // byte reads allowed on ROM1 (data bus)
    expect(soc.problems.problems.map((p) => [p.code, hex(p.address)])).toEqual([
      [CODE.ROM_WRITE, '0x40000400'],
      [CODE.ROM_WRITE, '0x3ff90000'],
    ]);
  });

  it('peripherals: the AHB alias 0x60000000–0x6003FFFF is 0x3FF40000–0x3FF7FFFF; sub-word accesses use the word', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    pro.write32(0x60000014, 0x1234); // UART0_CLKDIV through the alias
    expect(hex(pro.read32(0x3ff40014))).toBe('0x1234');
    pro.write32(0x3ff6e000 + 0x20, 0x11223344); // UART2 CONF0
    expect(hex(pro.read32(0x6002e020))).toBe('0x11223344');
    pro.write8(0x3ff6e021, 0xaa);
    expect(hex(pro.read32(0x3ff6e020))).toBe('0x1122aa44');
    expect(hex(pro.read16(0x6002e022))).toBe('0x1122');
    expect(hex(pro.read32(0x3ff5a000 + 0xffc))).toBe('0x0'); // the end of a block
  });

  it('unmapped addresses, PSRAM, and fetches from the data bus', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    expect(busError(() => pro.read32(0x3ffa0000)).exccause).toBe(EXCCAUSE.LOAD_STORE_ERROR); // below SRAM2
    expect(busError(() => pro.write8(0x20000000, 1)).exccause).toBe(EXCCAUSE.LOAD_STORE_ERROR);
    expect(busError(() => pro.fetch(0x3ffb0000)).exccause).toBe(EXCCAUSE.INSTRUCTION_FETCH_ERROR);
    expect(busError(() => pro.fetch(0x60000000)).exccause).toBe(EXCCAUSE.INSTRUCTION_FETCH_ERROR); // peripherals: not executable
    expect(() => pro.read32(0x3f800000)).toThrow(/PSRAM/);
    expect(soc.problems.problems.map((p) => p.code)).toEqual([CODE.PSRAM]);
  });

  it('ROM0 remap and the SRAM0 cache pools follow DPORT', () => {
    const soc = createTestSoc({ rom: true });
    const [pro, app] = soc.buses;
    pro.write32(0x400b0000, 0x0badcafe); // SRAM1's instruction-bus window that remaps to ROM0
    const rom = pro.read32(0x40000000);
    pro.write32(0x3ff00000, 1); // DPORT_PRO_BOOT_REMAP_CTRL
    expect(hex(pro.read32(0x40000000))).toBe('0xbadcafe');
    expect(hex(app.read32(0x40000000))).toBe(hex(rom)); // per CPU
    expect(busError(() => pro.read32(0x400b0000)).exccause).toBe(EXCCAUSE.LOAD_STORE_ERROR);
    pro.write32(0x3ff00000, 0);
    expect(pro.read32(0x40000000)).toBe(rom);
    // Cache pools (mux mode 0): POOL0 is the PRO cache's.
    pro.write32(0x40070000, 7);
    pro.write32(0x40078000, 9);
    pro.write32(0x3ff00040, pro.read32(0x3ff00040) | CACHE_ENABLE); // PRO cache on
    expect(pro.read32(0x40070000)).toBe(0);
    expect(app.read32(0x40078000)).toBe(9); // POOL1 (the APP cache's, which is off) is plain SRAM0
    expect(soc.problems.problems.map((p) => p.code)).toEqual([CODE.CACHE_SRAM]);
  });
});

describe('flash cache MMU', () => {
  function mapped() {
    const soc = createTestSoc();
    const flash = new Uint8Array(4 * 1024 * 1024);
    for (let page = 0; page < 64; page++) for (let i = 0; i < 0x10000; i += 4) new DataView(flash.buffer).setUint32(page * 0x10000 + i, page * 0x1000000 + i, true);
    soc.setFlash(flash);
    const [pro, app] = soc.buses;
    for (const [bus, ctrl, ctrl1] of [[pro, 0x3ff00040, 0x3ff00044], [app, 0x3ff00058, 0x3ff0005c]] as const) {
      bus.write32(ctrl, bus.read32(ctrl) | CACHE_ENABLE);
      bus.write32(ctrl1, bus.read32(ctrl1) & ~(CACHE_MASK.DROM0 | CACHE_MASK.IRAM0));
    }
    return { soc, pro, app };
  }

  it('PRO entry 0 = 1 maps 0x3F400000 to flash 0x10000; entry 77 = 2 maps the fetch at 0x400D0000 to 0x20000', () => {
    const { pro } = mapped();
    pro.write32(0x3ff10000, 1);
    expect(hex(pro.read32(0x3f400000))).toBe('0x1000000');
    expect(hex(pro.read32(0x3f40fffc))).toBe(hex(0x100fffc));
    expect(hex(pro.read8(0x3f400005))).toBe('0x0'); // byte 1 of word 0x01000004
    pro.write32(0x3ff10000 + 77 * 4, 2);
    expect(hex(pro.fetch(0x400d0000))).toBe(hex(0x02000000 & 0xffffff));
    expect(hex(pro.fetch(0x400d0004))).toBe('0x4');
    expect(hex(pro.read32(0x400d0008))).toBe('0x2000008');
    // A fetch straddling two flash pages reads both (entry 78 → page 3).
    pro.write32(0x3ff10000 + 78 * 4, 3);
    expect(hex(pro.fetch(0x400dfffe))).toBe(hex(((0x0200fffc >>> 16) & 0xffff) | ((0x03000000 & 0xff) << 16)));
  });

  it('the APP table at 0x3FF12000 is independent', () => {
    const { pro, app } = mapped();
    pro.write32(0x3ff10000, 1);
    app.write32(0x3ff12000, 5);
    expect(hex(pro.read32(0x3f400000))).toBe('0x1000000');
    expect(hex(app.read32(0x3f400000))).toBe('0x5000000');
  });

  it('an invalid entry, a disabled cache or a masked region faults with the reason; table writes after a mapped access are honored', () => {
    const { soc, pro } = mapped();
    pro.write32(0x3ff10000, 1);
    expect(pro.read32(0x3f400000)).toBe(0x1000000); // the page is now armed
    pro.write32(0x3ff10000, 4);
    expect(hex(pro.read32(0x3f400000))).toBe('0x4000000');
    pro.write32(0x3ff10000, MMU_INVALID);
    expect(() => pro.read32(0x3f400000)).toThrow(/PRO MMU entry 0 is invalid \(0x100\)/);
    pro.write32(0x3ff10000, 1);
    pro.write32(0x3ff00044, pro.read32(0x3ff00044) | CACHE_MASK.DROM0);
    expect(() => pro.read32(0x3f400000)).toThrow(/masked in DPORT_PRO_CACHE_CTRL1 \(bit 4\)/);
    pro.write32(0x3ff00044, pro.read32(0x3ff00044) & ~CACHE_MASK.DROM0);
    pro.write32(0x3ff00040, pro.read32(0x3ff00040) & ~CACHE_ENABLE);
    expect(() => pro.read32(0x3f400000)).toThrow(/PRO cache disabled \(DPORT_PRO_CACHE_CTRL bit 3 clear\)/);
    expect(() => pro.fetch(0x400d0000)).toThrow(/cache disabled/);
    // Through the core the fault halts it with that message.
    const core = soc.cores[0];
    core.pc = 0x400d0000;
    core.run(5);
    expect(core.haltReason).toMatch(/flash cache access to 0x400d0000 with the PRO cache disabled/);
    // Writes through the cache are ignored and reported.
    pro.write32(0x3ff00040, pro.read32(0x3ff00040) | CACHE_ENABLE);
    pro.write32(0x3f400000, 0);
    expect(pro.read32(0x3f400000)).toBe(0x1000000);
    expect(soc.problems.problems.map((p) => p.code)).toContain(CODE.FLASH_WRITE);
  });
});

describe('unimplemented registers', () => {
  it('reads give the header reset value and writes read back', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    expect(hex(pro.read32(0x3ff6e078))).toBe('0x15122500'); // UART2_DATE
    expect(hex(pro.read32(0x3ff40014))).toBe('0x2b6'); // UART0_CLKDIV
    expect(hex(registerDefault(0x3ff6e078))).toBe('0x15122500');
    pro.write32(0x3ff570b0, 0xdeadbeef);
    expect(hex(pro.read32(0x3ff570b0))).toBe('0xdeadbeef');
  });

  it('40 accesses to distinct unknown registers make exactly 32 Problems with R/W, value and PC; nothing throws', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    soc.cores[0].pc = 0x400d1234;
    for (let i = 0; i < 40; i++) {
      const a = 0x3ff57000 + i * 4; // PCNT (no model)
      if (i % 2 === 0) pro.read32(a);
      else pro.write32(a, i);
    }
    pro.read32(0x3ff57000); // again: deduplicated
    const problems = soc.problems.problems.filter((p) => p.code === CODE_UNIMPLEMENTED);
    expect(problems).toHaveLength(32);
    expect(soc.problems.totals.get(CODE_UNIMPLEMENTED)).toBe(41);
    expect(problems[0]).toMatchObject({ severity: 'warning', message: `read 0x3FF57000 (PCNT+0x000) = ${hex8(registerDefault(0x3ff57000))} at PC 0x400D1234` });
    expect(problems[1].message).toBe('write 0x3FF57004 (PCNT+0x004) = 0x00000001 at PC 0x400D1234');
    // The modeled DPORT cache registers and MMU tables are not unknown; other DPORT registers are.
    pro.write32(0x3ff00040, 0);
    pro.write32(0x3ff10000, 1);
    expect(soc.problems.totals.get(CODE_UNIMPLEMENTED)).toBe(41);
    pro.read32(0x3ff00008); // DPORT_ACCESS_CHECK: not modeled
    expect(soc.problems.totals.get(CODE_UNIMPLEMENTED)).toBe(42);
  });
});

describe('region protection and the instruction-bus width rule, through the core', () => {
  it('a byte load from IRAM is a LoadStoreError; after wdtlb 0xF on region 0, a load from 0 is LoadProhibited', () => {
    const soc = createTestSoc({ program: 'soc-protect' });
    const core = runPro(soc, 100_000);
    expect([core.halt, core.haltReason]).toEqual([HALT.BREAK, '1, 15']);
    const [pro] = soc.buses;
    const end = pro.read32(0x3ffb0000);
    const log: number[] = [];
    for (let a = 0x3ffb0100; a < end; a += 4) log.push(pro.read32(a));
    expect(log.map(hex)).toEqual(
      [EXCCAUSE.LOAD_STORE_ERROR, 0x40080000, symbolAddress('soc-protect', 'iram_byte_load'), EXCCAUSE.LOAD_PROHIBITED, 0, symbolAddress('soc-protect', 'prohibited_load')].map(hex),
    );
    expect(core.reg(6)).toBe(pro.read32(0x40080000)); // the word load in between worked
    expect(soc.cores[0].dtlb[0]).toBe(0xf);
    expect(busError(() => pro.read32(0x00000004)).exccause).toBe(EXCCAUSE.LOAD_PROHIBITED);
    expect(busError(() => pro.write32(0x00000004, 1)).exccause).toBe(EXCCAUSE.STORE_PROHIBITED);
  });

  it('fetches under a no-execute attribute raise InstFetchProhibited', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    const itlb = new Uint8Array(8).fill(2);
    itlb[2] = 0; // 0x40000000–0x5FFFFFFF: rw, no execute
    pro.protectionChanged(itlb, new Uint8Array(8).fill(2));
    expect(busError(() => pro.fetch(0x40080000)).exccause).toBe(EXCCAUSE.INST_FETCH_PROHIBITED);
    pro.write32(0x40080000, 5); // data access still allowed
    expect(pro.read32(0x40080000)).toBe(5);
  });
});

describe('speed', () => {
  it('bench-loop on the SoC bus is within 15 % of the bare machine', () => {
    // Short alternating runs, best of each: light on a machine running the rest of the suite.
    const STEPS = 4_000_000;
    const timed = (core: { run: (n: number) => number }): number => {
      const start = performance.now();
      const n = core.run(STEPS);
      return n / ((performance.now() - start) / 1000) / 1e6;
    };
    let bare = 0;
    let soc = 0;
    for (let i = 0; i < 5; i++) {
      bare = Math.max(bare, timed(BareMachine.load('bench-loop').core));
      soc = Math.max(soc, timed(createTestSoc({ program: 'bench-loop' }).cores[0]));
    }
    console.info(`bench-loop: bare machine ${bare.toFixed(1)} simulated MIPS, SoC bus ${soc.toFixed(1)} (${((soc / bare) * 100).toFixed(0)} %)`);
    expect(soc).toBeGreaterThan(bare * 0.85);
  }, 60_000);
});

describe('clocks, interleave and the interrupt matrix (BT32)', () => {
  it('derives the CPU and APB clocks from RTC_CNTL_CLK_CONF, CPU_PER_CONF and PRE_DIV_CNT', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    expect([soc.cpuHz, soc.apbHz]).toEqual([40e6, 40e6]); // power-on XTAL
    pro.write32(0x3ff66000, 1); // SYSCON PRE_DIV_CNT: XTAL / 2
    expect(soc.cpuHz).toBe(20e6);
    pro.write32(0x3ff0003c, 2); // CPUPERIOD_SEL 240
    pro.write32(0x3ff48070, (pro.read32(0x3ff48070) & ~(3 << 27)) | (1 << 27)); // SOC_CLK_SEL = PLL
    expect([soc.cpuHz, soc.apbHz]).toEqual([240e6, 80e6]);
    pro.write32(0x3ff0003c, 1);
    expect(soc.cpuHz).toBe(160e6);
  });

  it('interleaves the cores in slices and keeps their local time; APP_CPU waits in reset', () => {
    const soc = createTestSoc({ program: 'bench-loop' });
    soc.runUntil(240_000); // 1 ms of reference cycles at 40 MHz
    expect(soc.cores[0].instructions).toBeGreaterThanOrEqual(40_000 - 1);
    expect(soc.cores[0].instructions).toBeLessThanOrEqual(40_000 + 64);
    expect(soc.cores[1].instructions).toBe(0);
    expect(soc.seconds()).toBeCloseTo(0.001, 9);
  });

  it('routes a source to the CPU interrupt its map register names, per CPU; CPU-to-CPU interrupts are sources 24–27', () => {
    const soc = createTestSoc();
    const [pro] = soc.buses;
    const [proCore, appCore] = soc.cores;
    pro.write32(0x3ff00104 + 34 * 4, 13); // PRO: UART0 (34) → CPU interrupt 13 (level 1)
    pro.write32(0x3ff00218 + 24 * 4, 2); // APP: FROM_CPU_0 (24) → CPU interrupt 2
    soc.matrix.setSource(34, true);
    expect([(proCore.interrupt >>> 13) & 1, (appCore.interrupt >>> 13) & 1]).toEqual([1, 0]);
    expect(pro.read32(0x3ff000ec + 4) & (1 << 2)).toBe(1 << 2); // PRO_INTR_STATUS_1 bit 2 = source 34
    soc.matrix.setSource(34, false);
    expect(proCore.interrupt & (1 << 13)).toBe(0);
    pro.write32(0x3ff000dc, 1); // CPU_INTR_FROM_CPU_0
    expect((appCore.interrupt >>> 2) & 1).toBe(1);
    pro.write32(0x3ff000dc, 0);
    expect((appCore.interrupt >>> 2) & 1).toBe(0);
    pro.write32(0x3ff00104 + 34 * 4, 6); // to an internal interrupt (IDF's "disabled"): no effect
    soc.matrix.setSource(34, true);
    expect(proCore.interrupt & ~(1 << 6)).toBe(0);
  });
});
