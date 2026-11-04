/**
 * The ESP32-C3 SoC (BT92): one RV32IMC core (@benchtop/riscv) on the chip's address map
 * (memory.ts), the flash cache's MMU, the interrupt matrix and the peripheral models, with time.
 *
 * Time: reference cycles of 160 MHz (context.ts). An instruction costs REF_HZ / cpuHz of them
 * (SYSTEM sets the clock: the crystal at power-on, 160 MHz once esp_clk_init runs). The run loop
 * runs the core in slices up to the next event (at most SLICE reference cycles, or the whole wait
 * while it sleeps in WFI), firing events between slices at their exact times; an event scheduled
 * inside a slice stops the core at its next instruction (`hurry`).
 *
 * Peripherals see exact time: a load or store to the peripheral space first yields
 * (RISCV_BUS_YIELD — the instruction hasn't happened), and the loop then runs that one
 * instruction with the core's cycle count current, so `now()` is the instruction's own time.
 *
 * Flash: the IBUS (0x4200_0000) and DBUS (0x3C00_0000) windows map 64 KB pages through the
 * 128-entry table at 0x600C5000 (bits 7:0 the flash page, bit 8 invalid — an access through an
 * invalid entry is a bus error). Predecoded code is dropped when the table or the flash changes,
 * and when SRAM it came from is written through either bus.
 *
 * CSRs beyond the core's: the C3's performance counter (mpcer 0x7E0, mpcmr 0x7E1, mpccr 0x7E2 —
 * IDF's cycle count reads mpccr, which counts CPU cycles; 0x802 is its user-mode view, what the
 * ROM's ets_delay_us reads), the debug trigger registers
 * (0x7A0–0x7A5) and the dedicated-GPIO CSRs (0x803–0x805) read back as written.
 */

import { EventTable } from '@benchtop/esp32';
import { HALT, RISCV_BUS_YIELD, type RiscvBus, RiscvBusError, type RiscvCodeBus, RiscvCore, type RiscvCsrHook, RV32IMAC } from '@benchtop/riscv';
import { REF_HZ, type SocContext, XTAL_HZ } from './context.ts';
import { InterruptMatrix, INTMATRIX_BASE, SRC } from './intmatrix.ts';
import { ADC_PADS, Gpio, GPIO_BASE, IDLE_HIGH_SIGNALS, IO_MUX_BASE, IoMux, Pads, SIG } from './gpio.ts';
import { I2c, I2C_BASE } from './i2c.ts';
import { Ledc, LEDC_BASE, LEDC_CHANNELS, LEDC_SIGNAL_BASE } from './ledc.ts';
import { C3Memory, DROM_FLASH_BASE, FLASH_WINDOW, IRAM_BASE, IRAM_END, IROM_BASE, MEM, PERIPH_BASE, PERIPH_END, ROM_BASE, ROM_SIZE, DRAM_BASE, DRAM_END, DRAM_TO_IRAM, RTC_FAST_BASE } from './memory.ts';
import { PeripheralMap, ProblemLog } from './periph.ts';
import { Rmt, RMT_BASE, RMT_SIGNAL_BASE, RMT_TX_CHANNELS } from './rmt.ts';
import { RESET_REASON, RTC_CNTL_BASE, RtcCntl, WAKE } from './rtc-cntl.ts';
import { SarAdc, SARADC_BASE } from './saradc.ts';
import { APB_CTRL_BASE, ApbCtrl } from './apb-ctrl.ts';
import { FlashChip, SPI0_BASE, SPI1_BASE, SpiMem } from './spi-mem.ts';
import { Spi, SPI2_BASE } from './spi.ts';
import { Extmem, EXTMEM_BASE, SYSTEM_BASE, SystemRegs } from './system.ts';
import { Systimer, SYSTIMER_BASE } from './systimer.ts';
import { Timg, TIMG_BASES } from './timg.ts';
import { Uart, UART_BASES } from './uart.ts';
import { USB_SERIAL_JTAG_BASE, UsbSerialJtag } from './usb-serial-jtag.ts';

export const MMU_TABLE_BASE = 0x600c5000;
export const MMU_ENTRIES = 128;
export const MMU_INVALID = 0x100;
/** Longest uninterrupted run, reference cycles (1.6 µs). */
export const SLICE = 256;
export const DEFAULT_FLASH_SIZE = 4 * 1024 * 1024;
/** The SAR ADC's input range per attenuation (0, 2.5, 6, 11 dB), volts. */
export const ADC_FULL_SCALE = [0.75, 1.05, 1.3, 2.5] as const;
/** RV32IMC: the core's misa (no A). */
const MISA_RV32IMC = (1 << 30) | (1 << 2) | (1 << 8) | (1 << 12);

const CODE_ROM_WRITE = 'esp32c3-rom-write';
const CODE_BUS = 'esp32c3-bus-error';

class C3Bus implements RiscvBus, RiscvCodeBus {
  private readonly soc: Esp32c3Soc;
  private readonly mem: C3Memory;
  /** Peripheral accesses go through (else they yield first). */
  exact = false;
  /** 1 for each 4 KB IRAM page the core has predecoded (writes to it drop the predecode). */
  readonly codePages = new Uint8Array((IRAM_END - IRAM_BASE) >>> 12);

  constructor(soc: Esp32c3Soc) {
    this.soc = soc;
    this.mem = soc.memory;
  }

  /** The flash byte offset behind a cache-window address, or -1. */
  private flashOffset(address: number): number {
    let offset: number;
    if (address >= IROM_BASE && address < IROM_BASE + FLASH_WINDOW) offset = address - IROM_BASE;
    else if (address >= DROM_FLASH_BASE && address < DROM_FLASH_BASE + FLASH_WINDOW) offset = address - DROM_FLASH_BASE;
    else return -1;
    const entry = this.soc.mmu[offset >>> 16];
    if ((entry & MMU_INVALID) !== 0) throw new RiscvBusError('read through an invalid MMU entry', address);
    return (((entry & 0xff) << 16) | (offset & 0xffff)) % this.soc.flash.data.length;
  }

  private periph(address: number): boolean {
    if (address < PERIPH_BASE || address >= PERIPH_END) return false;
    if (!this.exact) {
      this.soc.yielded = true;
      throw RISCV_BUS_YIELD;
    }
    return true;
  }

  read8(address: number): number {
    const kind = this.mem.region(address);
    if (kind !== MEM.NONE) return this.mem.array(kind)[this.mem.index];
    return (this.read32Slow(address & ~3) >>> ((address & 3) * 8)) & 0xff;
  }

  read16(address: number): number {
    const kind = this.mem.region(address);
    if (kind !== MEM.NONE) {
      const a = this.mem.array(kind);
      const i = this.mem.index;
      return a[i] | (a[i + 1] << 8);
    }
    return (this.read32Slow(address & ~3) >>> ((address & 2) * 8)) & 0xffff;
  }

  read32(address: number): number {
    const kind = this.mem.region(address);
    if (kind !== MEM.NONE) {
      const a = this.mem.array(kind);
      const i = this.mem.index;
      return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
    }
    return this.read32Slow(address);
  }

  private read32Slow(address: number): number {
    const f = this.flashOffset(address);
    if (f >= 0) {
      const d = this.soc.flash.data;
      return (d[f] | (d[f + 1] << 8) | (d[f + 2] << 16) | (d[f + 3] << 24)) >>> 0;
    }
    if (address >= MMU_TABLE_BASE && address < MMU_TABLE_BASE + 0x1000) return (address - MMU_TABLE_BASE) >>> 2 < MMU_ENTRIES ? this.soc.mmu[(address - MMU_TABLE_BASE) >>> 2] : 0;
    if (this.periph(address)) return this.soc.periph.read32(address, this.soc.core.pc);
    return this.fault('read', address);
  }

  write8(address: number, value: number): void {
    const kind = this.mem.region(address);
    if (kind === MEM.SRAM || kind === MEM.RTC) {
      this.mem.array(kind)[this.mem.index] = value;
      if (kind === MEM.SRAM) this.wroteSram(this.mem.index, 1);
      return;
    }
    this.write32Slow(address & ~3, (value & 0xff) * 0x01010101, kind);
  }

  write16(address: number, value: number): void {
    const kind = this.mem.region(address);
    if (kind === MEM.SRAM || kind === MEM.RTC) {
      const a = this.mem.array(kind);
      const i = this.mem.index;
      a[i] = value;
      a[i + 1] = value >>> 8;
      if (kind === MEM.SRAM) this.wroteSram(i, 2);
      return;
    }
    this.write32Slow(address & ~3, (value & 0xffff) * 0x10001, kind);
  }

  write32(address: number, value: number): void {
    const kind = this.mem.region(address);
    if (kind === MEM.SRAM || kind === MEM.RTC) {
      const a = this.mem.array(kind);
      const i = this.mem.index;
      a[i] = value;
      a[i + 1] = value >>> 8;
      a[i + 2] = value >>> 16;
      a[i + 3] = value >>> 24;
      if (kind === MEM.SRAM) this.wroteSram(i, 4);
      return;
    }
    this.write32Slow(address, value, kind);
  }

  private write32Slow(address: number, value: number, kind: number): void {
    if (kind === MEM.ROM) {
      this.soc.problems.report('warning', CODE_ROM_WRITE, address, `write to ROM 0x${(address >>> 0).toString(16)} at PC 0x${this.soc.core.pc.toString(16)} ignored`);
      return;
    }
    if (address >= MMU_TABLE_BASE && address < MMU_TABLE_BASE + 0x1000) {
      const entry = (address - MMU_TABLE_BASE) >>> 2;
      if (entry < MMU_ENTRIES && this.soc.mmu[entry] !== (value & 0x1ff)) {
        this.soc.mmu[entry] = value & 0x1ff;
        this.soc.core.invalidateCode(IROM_BASE + entry * 0x10000, 0x10000);
      }
      return;
    }
    if (this.flashOffset(address) >= 0) return; // the cache is read-only
    if (this.periph(address)) {
      this.soc.periph.write32(address, value >>> 0, this.soc.core.pc);
      return;
    }
    this.fault('write', address);
  }

  private wroteSram(index: number, size: number): void {
    if (this.codePages[index >>> 12] !== 0) this.soc.core.invalidateCode(IRAM_BASE + index, size);
  }

  private fault(access: string, address: number): never {
    this.soc.problems.report('warning', CODE_BUS, address, `${access} at 0x${(address >>> 0).toString(16)} (no memory or peripheral there) at PC 0x${this.soc.core.pc.toString(16)}`);
    throw new RiscvBusError(access, address);
  }

  fetch16(address: number): number {
    return this.read16(address);
  }

  codePage(address: number): boolean {
    if (address >= IRAM_BASE && address < IRAM_END) {
      this.codePages[(address - IRAM_BASE) >>> 12] = 1;
      return true;
    }
    if (address >= ROM_BASE && address < ROM_BASE + ROM_SIZE) return true;
    if (address >= IROM_BASE && address < IROM_BASE + FLASH_WINDOW) return (this.soc.mmu[(address - IROM_BASE) >>> 16] & MMU_INVALID) === 0;
    return false;
  }

  codeHalf(address: number): number {
    return this.read16(address);
  }
}

export interface Esp32c3SocOptions {
  flashSize?: number;
  /** BT118: the reference time the chip starts at (a system reset's new chip: the old one's time). */
  time?: number;
  /** BT107: the eFuse's factory MAC (default EFUSE_MAC, 34:85:18:00:C3:01). */
  mac?: readonly number[];
}

export class Esp32c3Soc implements SocContext {
  readonly memory = new C3Memory();
  readonly problems = new ProblemLog();
  readonly events = new EventTable();
  readonly matrix = new InterruptMatrix();
  readonly periph = new PeripheralMap(this.problems);
  readonly mmu = new Uint16Array(MMU_ENTRIES).fill(MMU_INVALID);
  readonly flash: FlashChip;
  readonly bus: C3Bus;
  readonly core: RiscvCore;
  readonly system: SystemRegs;
  readonly rtc: RtcCntl;
  readonly systimer: Systimer;
  readonly timg: readonly [Timg, Timg];
  readonly uarts: readonly [Uart, Uart];
  readonly spi1: SpiMem;
  readonly adc: SarAdc;
  readonly iomux: IoMux;
  readonly gpio: Gpio;
  readonly pads: Pads;
  readonly ledc: Ledc;
  readonly usb: UsbSerialJtag;
  readonly i2c: I2c;
  readonly spi2: Spi;
  readonly rmt: Rmt;
  /** A pad's volts as the bench sees them (the SAR ADC samples them; the Mcu adapter sets it). */
  padVolts: (gpio: number) => number = () => 0;
  /** Slice-boundary time (reference cycles). */
  time = 0;
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  /** Reference cycles per instruction. */
  private cost = REF_HZ / XTAL_HZ;
  /** The bus yielded on a peripheral access (the loop runs that instruction exactly). */
  yielded = false;
  private running = false;
  private sliceStart = 0;
  private sliceCycles = 0;
  private sliceEnd = 0;
  /** Set when the core halts (a fault) — the run stops. */
  stopped = false;
  stopReason = '';
  private readonly csrs = new Map<number, number>();
  private pccrOffset = 0;

  /**
   * BT118: the firmware asked for a system reset (RTC_CNTL OPTIONS0.SW_SYS_RST — esp_restart): the
   * run stops there, and the Mcu boots a fresh chip at this time, for `resetReason` (BT122: or a
   * deep sleep's wake, DEEPSLEEP).
   */
  resetRequested = false;
  resetReason: number = RESET_REASON.SW_SYS;
  /** BT122: the chip sleeps (STATE0.SLEEP_EN) until a wake source; `deep`: the wake is a reset. Null awake. */
  sleeping: { deep: boolean } | null = null;
  private wakeSlot = -1;
  private pinCause = 0;

  constructor(options: Esp32c3SocOptions = {}) {
    this.time = options.time ?? 0;
    this.flash = new FlashChip(options.flashSize ?? DEFAULT_FLASH_SIZE);
    this.bus = new C3Bus(this);
    this.core = new RiscvCore(this.bus, { profile: RV32IMAC, misa: MISA_RV32IMC, resetPc: ROM_BASE, mvendorid: 0x612, marchid: 0, mimpid: 0, pmpEntries: 16 });
    this.core.csrHook = this.csrHook();
    this.matrix.onCause = (cause) => this.core.setInterruptCause(cause);
    this.periph.register(INTMATRIX_BASE, this.matrix);
    this.system = new SystemRegs(this, this.memory.rtcFast);
    this.system.onClock = (cpu, apb) => this.setClock(cpu, apb);
    this.periph.register(SYSTEM_BASE, this.system);
    this.periph.register(EXTMEM_BASE, new Extmem());
    this.rtc = options.mac === undefined ? new RtcCntl(this) : new RtcCntl(this, options.mac);
    this.periph.register(RTC_CNTL_BASE, this.rtc);
    this.rtc.onSoftwareReset = () => {
      this.resetRequested = true;
      this.resetReason = RESET_REASON.SW_SYS;
      if (this.running) this.core.requestStop();
    };
    this.rtc.onSleep = (deep) => this.enterSleep(deep);
    this.wakeSlot = this.events.add(() => this.wake(WAKE.TIMER));
    this.systimer = new Systimer(this);
    this.periph.register(SYSTIMER_BASE, this.systimer);
    this.timg = [new Timg(this, 0, [SRC.TG0_T0, SRC.TG0_WDT]), new Timg(this, 1, [SRC.TG1_T0, SRC.TG1_WDT])];
    TIMG_BASES.forEach((base, i) => this.periph.register(base, this.timg[i]));
    this.uarts = [new Uart(this, 0, SRC.UART0), new Uart(this, 1, SRC.UART1)];
    UART_BASES.forEach((base, i) => this.periph.register(base, this.uarts[i]));
    this.spi1 = new SpiMem(SPI1_BASE, this.flash);
    this.periph.register(SPI1_BASE, this.spi1);
    this.periph.register(SPI0_BASE, new SpiMem(SPI0_BASE, null));
    this.adc = new SarAdc(this);
    this.periph.register(SARADC_BASE, this.adc);
    this.iomux = new IoMux();
    this.periph.register(IO_MUX_BASE, this.iomux);
    this.gpio = new Gpio(this, this.iomux);
    this.periph.register(GPIO_BASE, this.gpio);
    this.pads = new Pads(this.gpio, this.iomux);
    this.gpio.onConfig = () => this.pads.update();
    this.iomux.onConfig = () => {
      this.gpio.inputsChanged();
      this.pads.update();
    };
    this.ledc = new Ledc(this);
    this.periph.register(LEDC_BASE, this.ledc);
    this.ledc.onOutput = () => this.pads.update();
    this.pads.signalLevel = (signal) => this.signalLevel(signal);
    this.usb = new UsbSerialJtag(this);
    this.periph.register(USB_SERIAL_JTAG_BASE, this.usb);
    this.i2c = new I2c(this);
    this.periph.register(I2C_BASE, this.i2c);
    this.spi2 = new Spi(this);
    this.periph.register(SPI2_BASE, this.spi2);
    this.spi2.onCs = () => this.pads.update();
    this.rmt = new Rmt(this);
    this.periph.register(RMT_BASE, this.rmt);
    this.rmt.onOutput = () => this.pads.update();
    this.periph.register(APB_CTRL_BASE, new ApbCtrl());
    this.adc.sample = (adc, channel, attenuation) => this.adcSample(adc, channel, attenuation);
    this.flash.onWrite = () => this.core.invalidateCode(IROM_BASE, FLASH_WINDOW);
    this.gpio.onInputs = () => {
      if (this.sleeping !== null) this.checkPinWake();
    };
  }

  // ── Sleep (BT122) ───────────────────────────────────────────────────────────────────────

  /** BT123: what wakes the sleeping chip — the timer's wake time (reference cycles, −1: none) and the pin wakes in words — or null awake. */
  sleepWakes(): { at: number; pins: string[] } | null {
    const sleep = this.sleeping;
    if (sleep === null) return null;
    const pins = this.rtc.wakePins();
    if (!sleep.deep && (this.rtc.wakeSources() & WAKE.GPIO) !== 0) for (const pin of this.gpio.wakePins()) if (!pins.includes(pin)) pins.push(pin);
    return { at: this.rtc.wakeTime(), pins };
  }

  private enterSleep(deep: boolean): void {
    if (this.sleeping !== null) return;
    this.sleeping = { deep };
    if (this.running) this.core.requestStop();
    // Deep: the digital domain is off — its timers stop with it. Light: APB is gated — the watchdogs wait.
    if (deep) this.events.clear();
    else for (const timg of this.timg) timg.gate();
    const at = this.rtc.wakeTime();
    if (at >= 0) this.events.schedule(this.wakeSlot, Math.max(this.now(), at));
    this.checkPinWake();
  }

  private checkPinWake(): void {
    const sleep = this.sleeping;
    if (sleep === null) return;
    let cause = 0;
    if (this.rtc.gpioWake((g) => this.gpio.padInput(g))) cause |= WAKE.GPIO;
    if (!sleep.deep && (this.rtc.wakeSources() & WAKE.GPIO) !== 0 && this.gpio.wakeLevel()) cause |= WAKE.GPIO;
    if (cause === 0) return;
    this.pinCause = cause;
    this.events.schedule(this.wakeSlot, this.now());
  }

  private wake(timerCause: number): void {
    const sleep = this.sleeping;
    if (sleep === null) return;
    const cause = this.pinCause !== 0 ? this.pinCause : timerCause;
    this.pinCause = 0;
    this.sleeping = null;
    this.rtc.woke(cause);
    if (sleep.deep) {
      this.resetRequested = true;
      this.resetReason = RESET_REASON.DEEPSLEEP;
    } else for (const timg of this.timg) timg.ungate();
  }

  /** The level of a peripheral output signal on its way to the pads. */
  private signalLevel(signal: number): number {
    if (signal >= LEDC_SIGNAL_BASE && signal < LEDC_SIGNAL_BASE + LEDC_CHANNELS) return this.ledc.level[signal - LEDC_SIGNAL_BASE];
    if (signal >= RMT_SIGNAL_BASE && signal < RMT_SIGNAL_BASE + RMT_TX_CHANNELS) return this.rmt.level[signal - RMT_SIGNAL_BASE];
    if (signal === SIG.FSPICS0) return this.spi2.cs0;
    return IDLE_HIGH_SIGNALS.has(signal) ? 1 : 0;
  }

  /**
   * A one-shot conversion: ADC1 channels 0–4 are GPIO0–4, ADC2 channel 0 GPIO5; an idealized
   * linear 12-bit code over the attenuation's range (the C3 datasheet's: 0.75, 1.05, 1.3, 2.5 V).
   */
  private adcSample(adc: number, channel: number, attenuation: number): number {
    const g = adc === 1 ? channel : channel === 0 ? 5 : -1;
    if (g < 0 || g >= ADC_PADS) return 0;
    if (((this.pads.adcUsed >>> g) & 1) === 0) {
      this.pads.adcUsed |= 1 << g;
      this.pads.update();
    }
    const code = Math.round((this.padVolts(g) / ADC_FULL_SCALE[attenuation & 3]) * 4095);
    return code < 0 ? 0 : code > 4095 ? 4095 : code;
  }

  /** Now in reference cycles: an event's own time while it fires, the instruction's inside a run. */
  now(): number {
    if (this.events.firing >= 0) return this.events.firing;
    if (this.running) return this.sliceStart + (this.core.cycles - this.sliceCycles) * this.cost;
    return this.time;
  }

  hurry(time: number): void {
    if (this.running && time < this.sliceEnd) {
      this.core.requestStop();
      this.cut = true;
    }
  }

  private setClock(cpu: number, apb: number): void {
    if (this.running) {
      // Account the slice so far at the old clock, then end it so the loop budgets afresh.
      this.sliceStart += (this.core.cycles - this.sliceCycles) * this.cost;
      this.sliceCycles = this.core.cycles;
      this.core.requestStop();
    }
    this.cpuHz = cpu;
    this.apbHz = apb;
    this.cost = REF_HZ / cpu;
    this.ledc?.clockChanged();
  }

  /** Runs until reference time `target` (or a halt, or a breakpoint: `atBreakpoint`). */
  runUntil(target: number): void {
    const core = this.core;
    this.atBreakpoint = false;
    while (this.time < target && !this.stopped && !this.resetRequested) {
      this.events.fireDue(this.time);
      if (this.resetRequested) break;
      if (this.sleeping !== null) {
        // BT122: asleep: nothing runs; time goes to the next event (a wake, a timer) or the target.
        this.time = Math.max(this.time, Math.min(target, this.events.next));
        continue;
      }
      let end = Math.min(target, this.events.next);
      if (!core.waiting) end = Math.min(end, this.time + SLICE);
      if (end <= this.time) end = this.time + this.cost;
      this.sliceStart = this.time;
      this.sliceCycles = core.cycles;
      this.sliceEnd = end;
      this.running = true;
      this.yielded = false;
      let hit = false;
      try {
        const budget = Math.max(1, Math.ceil((end - this.time) / this.cost));
        if (this.breakpoints.size > 0) hit = this.runChecked(budget);
        else {
          core.run(budget);
          if (this.yielded) {
            this.yielded = false;
            this.bus.exact = true;
            core.run(1);
          }
        }
      } finally {
        this.bus.exact = false;
        this.running = false;
      }
      this.time = this.sliceStart + (core.cycles - this.sliceCycles) * this.cost;
      if (core.halt !== HALT.RUNNING) {
        this.stopped = true;
        this.stopReason = core.haltReason || 'halted';
      }
      if (hit) {
        this.atBreakpoint = true;
        return;
      }
    }
    if (!this.stopped && !this.resetRequested) this.events.fireDue(this.time);
  }

  // ── Debugging (BT93): the one core ─────────────────────────────────────────────────────

  /** Breakpoints (byte addresses). While there are any, the core runs one instruction at a time. */
  breakpoints = new Set<number>();
  /** The breakpoint the core stopped at, which its next run executes (−1: none). */
  private resumePc = -1;
  /** The last run stopped before an instruction at a breakpoint (the next runUntil clears it). */
  atBreakpoint = false;
  /** An event earlier than the slice's end was scheduled during it. */
  private cut = false;

  /**
   * Up to `budget` instructions one at a time, stopping before one at a breakpoint (true). Asleep
   * in WFI the core sleeps as usual; an interrupt it takes stops right after the entry
   * (`stopOnTrap`), so a breakpoint on a handler's first instruction is seen.
   */
  private runChecked(budget: number): boolean {
    const core = this.core;
    const end = core.cycles + budget;
    this.cut = false;
    core.stopOnTrap = true;
    try {
      while (core.cycles < end && core.halt === HALT.RUNNING && !this.cut) {
        const pc = core.pc >>> 0;
        if (pc !== this.resumePc && this.breakpoints.has(pc)) {
          this.resumePc = pc;
          return true;
        }
        this.resumePc = -1;
        this.yielded = false;
        core.run(core.waiting ? end - core.cycles : 1);
        if (this.yielded) {
          this.yielded = false;
          this.bus.exact = true;
          core.run(1);
          this.bus.exact = false;
        }
      }
      return false;
    } finally {
      core.stopOnTrap = false;
    }
  }

  /** One instruction (or, asleep, up to the next event; an interrupt entry counts as the step), events caught up. */
  step(): string | null {
    if (this.stopped) return this.stopReason;
    const core = this.core;
    this.resumePc = -1;
    this.sliceStart = this.time;
    this.sliceCycles = core.cycles;
    this.sliceEnd = this.waitingEnd();
    this.running = true;
    this.yielded = false;
    core.stopOnTrap = true;
    try {
      core.run(core.waiting ? Math.max(1, Math.ceil((this.sliceEnd - this.time) / this.cost)) : 1);
      if (this.yielded) {
        this.yielded = false;
        this.bus.exact = true;
        core.run(1);
      }
    } finally {
      core.stopOnTrap = false;
      this.bus.exact = false;
      this.running = false;
    }
    this.time = this.sliceStart + (core.cycles - this.sliceCycles) * this.cost;
    this.events.fireDue(this.time);
    this.atBreakpoint = false;
    if (core.halt !== HALT.RUNNING) {
      this.stopped = true;
      this.stopReason = core.haltReason || 'halted';
      return this.stopReason;
    }
    return null;
  }

  private waitingEnd(): number {
    return Number.isFinite(this.events.next) ? Math.max(this.events.next, this.time + this.cost) : this.time + 1_000 * this.cost;
  }

  /** One byte as the bus would read it, without side effects: memory, the flash through the MMU, a block's stored register, else 0. */
  peek(address: number): number {
    const a = address >>> 0;
    const kind = this.memory.region(a);
    if (kind !== MEM.NONE) return this.memory.array(kind)[this.memory.index];
    let offset = -1;
    if (a >= IROM_BASE && a < IROM_BASE + FLASH_WINDOW) offset = a - IROM_BASE;
    else if (a >= DROM_FLASH_BASE && a < DROM_FLASH_BASE + FLASH_WINDOW) offset = a - DROM_FLASH_BASE;
    if (offset >= 0) {
      const entry = this.mmu[offset >>> 16];
      return (entry & MMU_INVALID) !== 0 ? 0 : this.flash.data[(((entry & 0xff) << 16) | (offset & 0xffff)) % this.flash.data.length];
    }
    if (a >= MMU_TABLE_BASE && a < MMU_TABLE_BASE + MMU_ENTRIES * 4) return (this.mmu[(a - MMU_TABLE_BASE) >>> 2] >>> ((a & 3) * 8)) & 0xff;
    if (a >= PERIPH_BASE && a < PERIPH_END) {
      const block = this.periph.blocks[(a - PERIPH_BASE) >>> 12] as { regs?: unknown };
      if (block.regs instanceof Uint32Array) return (block.regs[(a & 0xffc) >>> 2] >>> ((a & 3) * 8)) & 0xff;
    }
    return 0;
  }

  /** Writes one byte of SRAM or RTC fast memory (dropping predecoded code there); false elsewhere. */
  poke(address: number, value: number): boolean {
    const a = address >>> 0;
    const kind = this.memory.region(a);
    if (kind !== MEM.SRAM && kind !== MEM.RTC) return false;
    this.memory.array(kind)[this.memory.index] = value & 0xff;
    this.core.invalidateCode(kind === MEM.SRAM ? IRAM_BASE + this.memory.index : a, 1);
    return true;
  }

  private csrHook(): RiscvCsrHook {
    return {
      readCsr: (csr) => {
        if (csr === 0x7e2 || csr === 0x802) return (this.core.cycles + this.pccrOffset) >>> 0;
        if ((csr >= 0x7a0 && csr <= 0x7a5) || csr === 0x7e0 || csr === 0x7e1 || (csr >= 0x803 && csr <= 0x805)) return this.csrs.get(csr) ?? 0;
        return undefined;
      },
      writeCsr: (csr, value) => {
        if (csr === 0x7e2) {
          this.pccrOffset = value - this.core.cycles;
          return true;
        }
        if ((csr >= 0x7a0 && csr <= 0x7a5) || csr === 0x7e0 || csr === 0x7e1 || (csr >= 0x803 && csr <= 0x805)) {
          this.csrs.set(csr, value >>> 0);
          return true;
        }
        return false;
      },
    };
  }

  /** The time in seconds (tests and reports). */
  get seconds(): number {
    return this.time / REF_HZ;
  }

  /** A DRAM address's IRAM alias (and back), for tools. */
  static iramOf(dram: number): number {
    return dram >= DRAM_BASE && dram < DRAM_END ? dram + DRAM_TO_IRAM : dram;
  }
}

export { RTC_FAST_BASE };
