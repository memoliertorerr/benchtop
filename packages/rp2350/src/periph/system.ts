/**
 * The RP2350's system-control blocks as far as the SDK's start-up and the bootrom need them
 * (BT65), registers from the pico-sdk headers (RP2350 datasheet §6–§8):
 *
 * - RESETS: RESET_DONE reads back every block not held in RESET (blocks leave reset at once).
 * - CLOCKS: each glitchless mux's SELECTED is one-hot of its CTRL.SRC (clk_ref, clk_sys);
 *   `sysHz`/`periHz`/`refHz` follow the tree — clk_ref from the ROSC (nominal 11 MHz), the XOSC
 *   (12 MHz on the Pico 2) or its aux source; clk_sys from clk_ref or its aux (pll_sys,
 *   pll_usb, ROSC, XOSC); clk_peri from its aux; each divided by its DIV (16.16 for clk_sys).
 * - XOSC, ROSC: STATUS.STABLE while enabled. PLL_SYS/PLL_USB: CS.LOCK once powered up;
 *   output = 12 MHz / REFDIV × FBDIV / POSTDIV1 / POSTDIV2.
 * - PSM: core 1 is held in reset while FRCE_OFF.proc1 is set and restarts (in the bootrom) when it
 *   clears (`onCore1Reset`); DONE reads every domain ready except those forced off.
 * - TICKS, SYSINFO, WATCHDOG and the rest: their registers keep what is written (the tick
 *   generators aren't modelled: TIMER0/1 count microseconds and the RISC-V timer follows its
 *   tick at 1 µs, which is what the SDK programs them for).
 */

import { ALIAS_CLR, ALIAS_SET, applyAlias, Periph, type PeriphHost } from './block.ts';

export const XOSC_HZ = 12_000_000;
export const ROSC_HZ = 11_000_000;

export class Resets extends Periph {
  override read(offset: number): number {
    if (offset === 0x8) return ~this.regs[0] & 0x1fffffff; // RESET_DONE
    if (offset === 0x0 || offset === 0x4) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset === 0x0 || offset === 0x4) this.store(offset, value, alias);
    else if (offset !== 0x8) this.writeStored(offset, value, alias);
  }
}

export class Xosc extends Periph {
  override read(offset: number): number {
    if (offset === 0x4) {
      const enabled = ((this.regs[0] >>> 12) & 0xfff) === 0xfab;
      return (this.regs[1] & 0x7fffffff & ~0x1000) | (enabled ? 0x80001000 : 0); // STABLE, ENABLED
    }
    if (offset <= 0x10) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset <= 0x10) this.store(offset, value, alias);
    else this.writeStored(offset, value, alias);
  }

  get running(): boolean {
    return ((this.regs[0] >>> 12) & 0xfff) === 0xfab;
  }
}

export class Rosc extends Periph {
  constructor(name: string, base: number, host: PeriphHost) {
    super(name, base, host);
    this.quiet = true;
  }

  override read(offset: number): number {
    if (offset === 0x1c) return (this.regs[7] | 0x80001000) >>> 0; // STATUS: STABLE, ENABLED
    if (offset === 0x0c || offset === 0x20) return (Math.random() * 0x100000000) >>> 0; // RANDOM, RANDOMBIT
    return this.regs[offset >>> 2];
  }
}

export class Pll extends Periph {
  override read(offset: number): number {
    if (offset === 0x0) return ((this.regs[0] & 0x7fffffff) | (this.locked ? 0x80000000 : 0)) >>> 0;
    if (offset <= 0x1c) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset <= 0x1c) this.store(offset, value, alias);
    else this.writeStored(offset, value, alias);
  }

  get locked(): boolean {
    return (this.regs[1] & 0x21) === 0 && this.regs[2] !== 0; // PWR.PD and VCOPD clear, FBDIV set
  }

  /** The PLL's output, Hz (0 while powered down). */
  hz(refHz: number): number {
    if (!this.locked || (this.regs[1] & 0x8) !== 0) return 0;
    const refdiv = this.regs[0] & 0x3f || 1;
    const post1 = (this.regs[3] >>> 16) & 7 || 1;
    const post2 = (this.regs[3] >>> 12) & 7 || 1;
    return ((refHz / refdiv) * (this.regs[2] & 0xfff)) / post1 / post2;
  }
}

export class Clocks extends Periph {
  private readonly xosc: Xosc;
  private readonly pllSys: Pll;
  private readonly pllUsb: Pll;
  /** Called when clk_sys's frequency may have changed. */
  onSysChange: (() => void) | null = null;

  constructor(name: string, base: number, host: PeriphHost, xosc: Xosc, pllSys: Pll, pllUsb: Pll) {
    super(name, base, host);
    this.xosc = xosc;
    this.pllSys = pllSys;
    this.pllUsb = pllUsb;
  }

  override read(offset: number): number {
    if (offset === 0x38) return 1 << (this.regs[0x30 >>> 2] & 3); // CLK_REF_SELECTED
    if (offset === 0x44) return 1 << (this.regs[0x3c >>> 2] & 1); // CLK_SYS_SELECTED
    if (offset >= 0x30 && offset <= 0x74 && (offset - 0x30) % 12 === 8) return 1; // other SELECTED
    if (offset < 0x80) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset < 0x80) {
      this.store(offset, value, alias);
      if (offset >= 0x30 && offset <= 0x44) this.onSysChange?.();
    } else this.writeStored(offset, value, alias);
  }

  private div(offset: number): number {
    const raw = this.regs[offset >>> 2];
    const value = (raw >>> 16) + (raw & 0xffff) / 65536;
    return value === 0 ? 65536 : value;
  }

  /** The crystal's output: 12 MHz while the XOSC runs. */
  private get xoscHz(): number {
    return this.xosc.running ? XOSC_HZ : 0;
  }

  get refHz(): number {
    const ctrl = this.regs[0x30 >>> 2];
    const src = ctrl & 3;
    const aux = (ctrl >>> 5) & 3;
    const hz = src === 2 ? this.xoscHz : src === 1 ? (aux === 0 ? this.pllUsb.hz(this.xoscHz) : 0) : src === 3 ? 32_768 : ROSC_HZ;
    return hz / (((this.regs[0x34 >>> 2] >>> 16) & 0xff) || 1);
  }

  get sysHz(): number {
    const ctrl = this.regs[0x3c >>> 2];
    if ((ctrl & 1) === 0) return this.refHz / this.div(0x40);
    const aux = (ctrl >>> 5) & 7;
    const hz = aux === 0 ? this.pllSys.hz(this.xoscHz) : aux === 1 ? this.pllUsb.hz(this.xoscHz) : aux === 2 ? ROSC_HZ : aux === 3 ? this.xoscHz : 0;
    return hz / this.div(0x40);
  }

  get periHz(): number {
    const ctrl = this.regs[0x48 >>> 2];
    if ((ctrl & 0x800) === 0) return 0;
    const aux = (ctrl >>> 5) & 7;
    const hz = aux === 0 ? this.sysHz : aux === 1 ? this.pllSys.hz(this.xoscHz) : aux === 2 ? this.pllUsb.hz(this.xoscHz) : aux === 3 ? ROSC_HZ : aux === 4 ? this.xoscHz : 0;
    return hz / (((this.regs[0x4c >>> 2] >>> 16) & 3) || 1);
  }
}

/** PSM_FRCE_OFF.proc1 (datasheet §7.4). */
const PSM_PROC1 = 0x01000000;

export class Psm extends Periph {
  /** Core 1 entered (true) or left (false) its forced-off reset — the SDK's multicore_reset_core1. */
  onCore1Reset: ((held: boolean) => void) | null = null;

  override read(offset: number): number {
    if (offset === 0xc) return (0x01ffffff & ~this.regs[1]) | (this.regs[0] & this.regs[1]); // DONE
    if (offset <= 0x8) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset > 0x8) {
      this.writeStored(offset, value, alias);
      return;
    }
    const before = this.regs[1] & PSM_PROC1;
    this.store(offset, value, alias);
    const after = this.regs[1] & PSM_PROC1;
    if (offset === 0x4 && before !== after) this.onCore1Reset?.(after !== 0);
  }
}

/** A block whose registers only keep what is written (TICKS, ACCESSCTRL, QMI, …). */
export class Quiet extends Periph {
  constructor(name: string, base: number, host: PeriphHost) {
    super(name, base, host);
    this.quiet = true;
  }
}

/** A block that isn't there yet as far as software can tell: reads 0, writes are dropped (USB until BT66). */
export class Inert extends Periph {
  constructor(name: string, base: number, host: PeriphHost) {
    super(name, base, host);
    this.quiet = true;
  }

  override read(): number {
    return 0;
  }

  override write(): void {}
}

/**
 * OTP's control registers (the rows themselves are the bus's: unprogrammed, they read 0). The
 * cores are RISC-V here and nothing else: ARCHSEL resets to 3 (both RISC-V) and ARCHSEL_STATUS
 * — the architecture the cores booted in — always reads 3, so the bootrom sees no reason to
 * switch architectures. The rest keeps what is written.
 */
export class Otp extends Quiet {
  override reset(): void {
    super.reset();
    this.regs[0x158 >>> 2] = 3;
  }

  override read(offset: number): number {
    if (offset === 0x15c) return 3; // ARCHSEL_STATUS
    return this.regs[offset >>> 2];
  }
}

/** SYSINFO: CHIP_ID (A4 silicon, the bootrom this runs; the headers give A3), PACKAGE_SEL, PLATFORM (ASIC). */
export class Sysinfo extends Periph {
  override read(offset: number): number {
    switch (offset) {
      case 0x0:
        return 0x80004927; // REVISION 8 = A4 (the SDK reads (rev & 3) | (rev & 8) >> 1), PART 4, MANUFACTURER 0x493, stop bit
      case 0x4:
        return 1; // PACKAGE_SEL: the QFN60 package (RP2350A, the Pico 2's)
      case 0x8:
        return 0x2; // PLATFORM: ASIC
      default:
        return this.readStored(offset);
    }
  }

  override write(offset: number, value: number, alias: number): void {
    this.writeStored(offset, value, alias);
  }
}

/** WATCHDOG: CTRL, LOAD, REASON, SCRATCH0–7 keep what is written; the countdown isn't modelled. */
export class Watchdog extends Periph {
  override read(offset: number): number {
    if (offset <= 0x2c) return this.regs[offset >>> 2];
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset <= 0x2c) this.store(offset, value, alias);
    else this.writeStored(offset, value, alias);
  }
}

/**
 * BOOTRAM's registers (its 1 KB of RAM is the bus's): WRITE_ONCE0/1 OR every write in (cleared by
 * reset only); BOOTLOCK0–7 work as the SIO spinlocks — a read claims the lock and returns 1 << n
 * if it was free, else 0; any write releases it — and BOOTLOCK_STAT shows them, 1 = unclaimed.
 */
export class Bootram extends Periph {
  private locks = 0xff;

  override reset(): void {
    super.reset();
    this.locks = 0xff;
  }

  override read(offset: number): number {
    if (offset === 0x800 || offset === 0x804) return this.regs[offset >>> 2];
    if (offset === 0x808) return this.locks;
    if (offset >= 0x80c && offset <= 0x828) {
      const bit = 1 << ((offset - 0x80c) >>> 2);
      if ((this.locks & bit) === 0) return 0;
      this.locks &= ~bit;
      return bit;
    }
    return this.readStored(offset);
  }

  override write(offset: number, value: number, alias: number): void {
    if (offset === 0x800 || offset === 0x804) this.regs[offset >>> 2] |= applyAlias(0, value, alias);
    else if (offset === 0x808) this.locks = applyAlias(this.locks, value, alias) & 0xff;
    else if (offset >= 0x80c && offset <= 0x828) this.locks |= 1 << ((offset - 0x80c) >>> 2);
    else this.writeStored(offset, value, alias);
  }
}

export { ALIAS_CLR, ALIAS_SET, applyAlias };
