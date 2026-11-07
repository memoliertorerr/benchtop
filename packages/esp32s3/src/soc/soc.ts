/**
 * The ESP32-S3 SoC (BT124): two Xtensa LX7 cores (@benchtop/esp32's XtensaCore with the S3's decode
 * rows — `s3: true` — and a predecode cache that reaches its flash at 0x4200_0000), each on its own
 * S3Bus; the interrupt matrix (99 sources); the MMU table; and the peripheral models — SYSTEM,
 * EXTMEM, RTC_CNTL and eFuse of its own, SYSTIMER, the timer groups, the UARTs, SPI0/1 with the
 * flash chip and the SAR ADC shared with the ESP32-C3 (@benchtop/esp32c3), which share the S3's
 * register maps, at the S3's addresses and interrupt sources.
 *
 * Time: the unit is a 240 MHz reference cycle (REF_HZ: the S3's top clock), so an instruction
 * costs 1, 1.5, 3 or 6 of them at 240, 160, 80 and 40 MHz; SYSTIMER's 16 MHz tick is 15. The
 * cores interleave as the ESP32's do (its soc.ts): the core behind in time runs, a slice is SLICE
 * reference cycles or less and ends at the next event — or earlier when a model schedules one
 * inside it (`hurry`); a core touching a peripheral while the other is behind yields first
 * (BUS_YIELD), so peripherals see accesses in time order. WAITI skip-ahead: with both cores
 * asleep (WAITI with nothing deliverable, or the APP_CPU not started), the loop jumps over whole
 * slices to the next event, CCOMPARE match or the target.
 *
 * The APP_CPU starts held; the app releases it through SYSTEM's CORE_1_CONTROL_0 (system.ts),
 * and it starts at the ROM's reset vector, whose second-core path waits for the boot address
 * the app passes through `ets_set_appcpu_boot_addr`. A system reset (RTC_CNTL OPTIONS0.SW_SYS_RST,
 * a watchdog's reset stage) stops the run with `resetRequested` (the Mcu, BT126, boots a fresh
 * chip, as the C3's does).
 */

import type { RunResult } from '@benchtop/core';
import { EventTable, HALT, ProblemLog, XtensaCore } from '@benchtop/esp32';
import { ApbCtrl, FlashChip, I2c, I2C_BASE, Ledc, LEDC_BASE, RegisterFile, Rmt, RMT_BASE, S3_RMT_LAYOUT, type SocContext, Spi, SPI0_BASE, SPI1_BASE, SPI2_BASE, SpiMem, SARADC_BASE, Systimer, SYSTIMER_BASE, Timg, TIMG_BASES, S3_UART_FIELDS, Uart, UsbSerialJtag } from '@benchtop/esp32c3';
import { ANA_I2C_BASE, S3AnalogI2c } from './analog.ts';
import { S3_GPIO_BASE, S3_IDLE_HIGH_SIGNALS, S3_IO_MUX_BASE, S3_SIG, S3Gpio, S3IoMux, S3Pads } from './gpio.ts';
import { S3Bus, type S3BusParts } from './bus.ts';
import { INTERRUPT_BASE, S3_SRC, S3InterruptMatrix } from './intmatrix.ts';
import { IRAM_BASE, IRAM_END, IROM_BASE, S3Memory } from './memory.ts';
import { registerDefault, S3PeripheralMap } from './periph.ts';
import { EFUSE_BASE, REF_HZ, RTC_CNTL_BASE, S3_RESET_REASON, S3_WAKE, S3Efuse, S3RtcCntl } from './rtc-cntl.ts';
import { S3Psram } from './psram.ts';
import { S3_ADC_FULL_SCALE, S3Sens } from './sens.ts';
import { EXTMEM_BASE, S3Extmem, S3SystemRegs, SYSTEM_BASE, XTAL_HZ } from './system.ts';

/** Reference cycles per interleave slice (≈ 1.07 µs, as the ESP32's). */
export const S3_SLICE = 256;
export const DEFAULT_FLASH_SIZE = 4 * 1024 * 1024;
export const MMU_TABLE_BASE = 0x600c5000;
export const MMU_ENTRIES = 512;
export const MMU_INVALID = 1 << 14;
const MMU_SPIRAM = 1 << 15;
export const UART_BASES_S3 = [0x60000000, 0x60010000, 0x6002e000] as const;
export const S3_USB_SERIAL_JTAG_BASE = 0x60038000;
/** The block holding WDEV_RND_REG (+0x7C), the random number generator. */
export const S3_WDEV_BASE = 0x60035000;
export const S3_I2C_BASES = [I2C_BASE, 0x60027000] as const;
export const S3_LEDC_CHANNELS = 8;
/** RMT TX channels 0–3. */
export const S3_RMT_TX = 4;

export interface Esp32s3SocOptions {
  /** Flash size in bytes (a multiple of 64 KB; 4 MB by default — what the flash chip's JEDEC id says and Arduino's default build assumes). */
  flashSize?: number;
  /** The eFuse's factory MAC (S3_EFUSE_MAC by default). */
  mac?: readonly number[];
  /** Reference time to start at (a reset builds a fresh chip at the time the old one stopped). */
  time?: number;
}

/** The MMU table (0x600C_5000): 512 entries — the flash page (13:0), INVALID (14), SPIRAM (15). */
class MmuTable {
  readonly table = new Uint32Array(MMU_ENTRIES).fill(MMU_INVALID);
  onChange: ((entry: number) => void) | null = null;

  systemReset(): void {
    this.table.fill(MMU_INVALID);
    for (let i = 0; i < MMU_ENTRIES; i++) this.onChange?.(i);
  }

  read32(offset: number): number {
    const i = offset >>> 2;
    return i < MMU_ENTRIES ? this.table[i] : 0;
  }

  write32(offset: number, value: number): void {
    const i = offset >>> 2;
    if (i >= MMU_ENTRIES) return;
    this.table[i] = value & 0xffff;
    this.onChange?.(i);
  }
}

export class Esp32s3Soc implements SocContext, S3BusParts {
  readonly refHz = REF_HZ;
  readonly memory = new S3Memory();
  readonly problems = new ProblemLog();
  readonly events = new EventTable();
  readonly matrix = new S3InterruptMatrix();
  readonly periph = new S3PeripheralMap(this.problems);
  readonly mmu = new MmuTable();
  readonly flash: FlashChip;
  /** BT130: the PSRAM on SPI0/1's second chip select (quad 2 MB or octal 8 MB, as the build's driver asks). */
  readonly psram = new S3Psram();
  readonly system: S3SystemRegs;
  readonly extmem = new S3Extmem();
  readonly rtc: S3RtcCntl;
  readonly efuse: S3Efuse;
  readonly systimer: Systimer;
  readonly timg: readonly [Timg, Timg];
  readonly uarts: readonly [Uart, Uart, Uart];
  readonly spi1: SpiMem;
  /** BT125: SENS — the RTC controller's ADC conversions, analogRead's path in IDF 4.4. */
  readonly sens: S3Sens;
  /** BT125: GPIO, the matrix, IO_MUX and what each pad is doing. */
  readonly iomux = new S3IoMux(this.problems);
  readonly gpio: S3Gpio;
  readonly pads: S3Pads;
  /** The volts the bench puts on a pad (the ADC reads them). */
  padVolts: (gpio: number) => number = () => 0;
  readonly usb: UsbSerialJtag;
  readonly ledc: Ledc;
  readonly i2c: readonly [I2c, I2c];
  /** SPI2 (FSPI); SPI3 isn't modeled. */
  readonly spi2: Spi;
  readonly rmt: Rmt;
  readonly buses: readonly [S3Bus, S3Bus];
  readonly cores: readonly [XtensaCore, XtensaCore];

  /** Slice-boundary time, in reference cycles. */
  time: number;
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  /** WAITI skip-ahead (on by default). */
  skipIdle = true;
  /** Reference time the slices skipped by skip-ahead covered (reports). */
  skipped = 0;
  appRunning = false;
  /** A core halted (a fault). */
  stopped = false;
  stopReason = '';
  /** A system reset was asked for (RTC_CNTL SW_SYS_RST, a watchdog): the run stops; the Mcu reboots the chip. */
  resetRequested = false;
  /** BT128: the chip sleeps (RTC_CNTL STATE0.SLEEP_EN) until a wake source; `deep`: the wake is a reset. Null awake. */
  sleeping: { deep: boolean } | null = null;
  private wakeSlot = -1;
  private pinCause = 0;
  resetReason: number = S3_RESET_REASON.SW_SYS;
  /** Peripheral-order yields so far (reports). */
  yields = 0;
  /**
   * The core the debugger shows (BT125): the APP_CPU, where Arduino-ESP32 runs setup() and loop()
   * (CONFIG_ARDUINO_RUNNING_CORE 1), or the one that stopped at a breakpoint last.
   */
  debugCpu = 1;

  private cost = REF_HZ / XTAL_HZ;
  private readonly coreTime = new Float64Array(2);
  private active = -1;
  private activeCycles = 0;
  private yielded = false;
  private sliceEnd = 0;

  constructor(options: Esp32s3SocOptions = {}) {
    this.time = options.time ?? 0;
    this.coreTime.fill(this.time);
    this.flash = new FlashChip(options.flashSize ?? DEFAULT_FLASH_SIZE);
    this.system = new S3SystemRegs(this.matrix, this.memory.rtcFast);
    this.system.onClock = (cpu, apb) => this.setClock(cpu, apb);
    this.system.onAppCpu = (running) => this.setAppRunning(running);
    this.system.onAppCpuReset = () => this.cores[1].reset();
    this.rtc = new S3RtcCntl(() => this.now());
    this.rtc.onSoftwareReset = () => this.requestReset(S3_RESET_REASON.SW_SYS);
    this.efuse = options.mac === undefined ? new S3Efuse() : new S3Efuse(options.mac);
    this.systimer = new Systimer(this, [S3_SRC.SYSTIMER_TARGET0, S3_SRC.SYSTIMER_TARGET1, S3_SRC.SYSTIMER_TARGET2]);
    this.timg = [new Timg(this, 0, [S3_SRC.TG0_T0, S3_SRC.TG0_WDT]), new Timg(this, 1, [S3_SRC.TG1_T0, S3_SRC.TG1_WDT])];
    this.timg[0].onWdtReset = () => this.requestReset(S3_RESET_REASON.TG0WDT_SYS);
    this.timg[1].onWdtReset = () => this.requestReset(S3_RESET_REASON.TG1WDT_SYS);
    const uartSources = [S3_SRC.UART0, S3_SRC.UART1, S3_SRC.UART2];
    this.uarts = [0, 1, 2].map((i) => new Uart(this, i, uartSources[i], UART_BASES_S3[i], S3_UART_FIELDS)) as [Uart, Uart, Uart];
    this.spi1 = new SpiMem(SPI1_BASE, this.flash, registerDefault);
    this.spi1.cs1 = this.psram;
    this.sens = new S3Sens(this);
    this.sens.sample = (adc, channel, attenuation) => this.adcSample(adc, channel, attenuation);
    this.rtc.sens = this.sens;
    this.usb = new UsbSerialJtag(this, S3_USB_SERIAL_JTAG_BASE, S3_SRC.USB_SERIAL_JTAG);
    this.ledc = new Ledc(this, S3_LEDC_CHANNELS);
    this.i2c = [new I2c(this, S3_I2C_BASES[0], S3_SRC.I2C0), new I2c(this, S3_I2C_BASES[1], S3_SRC.I2C1)];
    this.spi2 = new Spi(this);
    this.rmt = new Rmt(this, S3_SRC.RMT, S3_RMT_LAYOUT);
    this.gpio = new S3Gpio(this, this.iomux);
    this.pads = new S3Pads(this.gpio, this.iomux);
    this.pads.signalLevel = (signal) => this.signalLevel(signal);
    this.gpio.onConfig = () => this.pads.update();
    // BT128: sleep — RTC pads take the RTC's pulls; the timer and pins wake the chip.
    this.pads.rtcPad = (g) => this.rtc.rtcPad(g);
    this.rtc.onRtcPads = () => this.pads.update();
    this.rtc.onSleep = (deep) => this.enterSleep(deep);
    this.wakeSlot = this.events.add(() => this.wake(S3_WAKE.TIMER));
    this.gpio.onInputs = () => {
      if (this.sleeping !== null) this.checkPinWake();
    };
    this.ledc.onOutput = () => this.pads.update();
    this.rmt.onOutput = () => this.pads.update();
    this.spi2.onCs = () => this.pads.update();
    this.iomux.onConfig = () => {
      this.gpio.inputsChanged();
      this.pads.update();
    };

    const periph = this.periph;
    periph.register(SYSTEM_BASE, this.system);
    periph.register(EXTMEM_BASE, this.extmem);
    periph.register(MMU_TABLE_BASE, this.mmu);
    periph.register(INTERRUPT_BASE, this.matrix);
    periph.register(RTC_CNTL_BASE, this.rtc);
    periph.register(EFUSE_BASE, this.efuse);
    periph.register(SYSTIMER_BASE, this.systimer);
    TIMG_BASES.forEach((base, i) => periph.register(base, this.timg[i]));
    UART_BASES_S3.forEach((base, i) => periph.register(base, this.uarts[i]));
    periph.register(SPI1_BASE, this.spi1);
    periph.register(SPI0_BASE, new SpiMem(SPI0_BASE, null, registerDefault));
    // APB_SARADC (the digital controller) is storage: IDF 4.4 converts through SENS, and only
    // configures ADC2's arbiter here. WDEV_RND_REG (0x6003507C) is the RNG.
    periph.register(SARADC_BASE, new RegisterFile(SARADC_BASE, registerDefault));
    periph.register(S3_WDEV_BASE, new ApbCtrl(0x2545f491, S3_WDEV_BASE, 0x7c, registerDefault));
    periph.register(ANA_I2C_BASE, new S3AnalogI2c());
    periph.register(S3_GPIO_BASE, this.gpio);
    periph.register(S3_USB_SERIAL_JTAG_BASE, this.usb);
    periph.register(LEDC_BASE, this.ledc);
    S3_I2C_BASES.forEach((base, i) => periph.register(base, this.i2c[i]));
    periph.register(SPI2_BASE, this.spi2);
    periph.register(RMT_BASE, this.rmt);
    periph.register(S3_IO_MUX_BASE, this.iomux);

    const pro = new S3Bus(this, 0);
    const app = new S3Bus(this, 1);
    this.buses = [pro, app];
    const coreOptions = { s3: true, icachePages: 0x4000, icacheFlashFrom: IROM_BASE } as const;
    this.cores = [new XtensaCore(pro, { prid: 0xcdcd, ...coreOptions }), new XtensaCore(app, { prid: 0xabab, ...coreOptions })];
    pro.core = this.cores[0];
    app.core = this.cores[1];
    this.matrix.cores = this.cores;
    this.mmu.onChange = (entry) => {
      for (const bus of this.buses) bus.mmuChanged(entry);
    };
    this.extmem.onInvalidate = () => {
      for (const bus of this.buses) bus.invalidateFlash();
    };
    this.flash.onWrite = (offset, length) => {
      for (const core of this.cores) core.icache.invalidateFlash(offset, offset + length);
    };
  }

  // ── SocContext (the shared C3 models) and S3BusParts ─────────────────────────────────────

  regDefault(address: number): number {
    return registerDefault(address);
  }

  now(): number {
    if (this.events.firing >= 0) return this.events.firing;
    if (this.active < 0) return this.time;
    return this.coreTime[this.active] + (this.cores[this.active].cycles - this.activeCycles) * this.cost;
  }

  /** A model scheduled an event inside the running slice: the slice ends there. */
  hurry(time: number): void {
    if (this.active < 0 || time >= this.sliceEnd) return;
    this.sliceEnd = Math.max(Math.ceil(time), this.time + 1);
    this.cores[this.active].requestStop();
  }

  flashBytes(): Uint8Array {
    return this.flash.data;
  }

  mmuPage(entry: number): number {
    const value = this.mmu.table[entry];
    if ((value & (MMU_INVALID | MMU_SPIRAM)) !== 0) return -1;
    return (value & 0x3fff) * 0x10000;
  }

  /** BT130: the PSRAM offset an MMU entry with SPIRAM set maps, within the chip's size; else −1. */
  mmuPsramPage(entry: number): number {
    const value = this.mmu.table[entry];
    if ((value & MMU_INVALID) !== 0 || (value & MMU_SPIRAM) === 0) return -1;
    const page = (value & 0x3fff) * 0x10000;
    return page + 0x10000 <= this.psram.size ? page : -1;
  }

  psramBytes(): Uint8Array {
    return this.psram.data;
  }

  psramWords(): Uint32Array {
    return this.psram.dataWords;
  }

  peripheralTurn(cpu: number): boolean {
    if (this.active !== cpu) return true; // not inside a run (boot, tests)
    const other = 1 - cpu;
    if (this.canRun(other) && this.cores[other].halt === HALT.RUNNING && this.coreTime[other] < this.now()) {
      this.yielded = true;
      this.yields++;
      return false;
    }
    // BT125: an event due before this access fires first. A core can run past an event the other
    // core scheduled inside the slice it had already run (`hurry` stops only the active core); a
    // model then saw a register write before its own pending event (LEDC lost a period that way).
    const now = this.now();
    if (this.events.next <= now) this.events.fireDue(now);
    return true;
  }

  /** A store hit SRAM holding predecoded code: both cores drop the instruction page. */
  codeWritten(offset: number): void {
    const page = offset & ~0xfff;
    for (const bus of this.buses) bus.code[page >>> 12] = 0;
    const address = IRAM_BASE + page;
    if (address < IRAM_END) for (const core of this.cores) core.icache.invalidatePage(address);
  }

  /** Replaces the flash contents (a board's kept flash; BT126). */
  setFlash(data: Uint8Array): void {
    this.flash.data = data;
    for (const bus of this.buses) bus.invalidateFlash();
  }

  /** The level of a peripheral output signal on its way to the pads. */
  /**
   * BT125: a SENS conversion — ADC1 channels 0–9 are GPIO1–10, ADC2's GPIO11–20; an idealized
   * linear 12-bit code over the attenuation's range (S3_ADC_FULL_SCALE). The pad reads as analog
   * from then on while its input and pulls are off.
   */
  private adcSample(adc: number, channel: number, attenuation: number): number {
    const g = (adc === 1 ? 1 : 11) + channel;
    if (channel > 9) return 0;
    if (this.pads.adcUsed[g] === 0) {
      this.pads.adcUsed[g] = 1;
      this.pads.update();
    }
    const code = Math.round((this.padVolts(g) / S3_ADC_FULL_SCALE[attenuation & 3]) * 4095);
    return code < 0 ? 0 : code > 4095 ? 4095 : code;
  }

  private signalLevel(signal: number): number {
    if (signal >= S3_SIG.LEDC0 && signal < S3_SIG.LEDC0 + S3_LEDC_CHANNELS) return this.ledc.level[signal - S3_SIG.LEDC0];
    if (signal >= S3_SIG.RMT0 && signal < S3_SIG.RMT0 + S3_RMT_TX) return this.rmt.level[signal - S3_SIG.RMT0];
    if (signal === S3_SIG.FSPICS0) return this.spi2.cs0;
    return S3_IDLE_HIGH_SIGNALS.has(signal) ? 1 : 0;
  }

  /** The reference time a core is at (tests, reports). */
  coreAt(cpu: number): number {
    return this.coreTime[cpu];
  }

  private requestReset(reason: number): void {
    if (this.resetRequested) return;
    this.resetRequested = true;
    this.resetReason = reason;
    if (this.active >= 0) this.cores[this.active].requestStop();
  }

  private setClock(cpu: number, apb: number): void {
    if (this.active >= 0) {
      // Settle the running core's time at the old clock.
      const core = this.cores[this.active];
      this.coreTime[this.active] += (core.cycles - this.activeCycles) * this.cost;
      this.activeCycles = core.cycles;
    }
    this.cpuHz = cpu;
    this.apbHz = apb;
    this.cost = REF_HZ / cpu;
  }

  private setAppRunning(running: boolean): void {
    if (running) {
      this.cores[1].reset();
      this.coreTime[1] = this.now();
    }
    this.appRunning = running;
  }

  private canRun(cpu: number): boolean {
    return this.sleeping === null && (cpu === 0 || this.appRunning);
  }

  // ── Sleep (BT128) ───────────────────────────────────────────────────────────────────────

  /** What wakes the sleeping chip — the timer's wake time (reference cycles, −1: none) and the pin wakes in words — or null awake. */
  sleepWakes(): { at: number; pins: string[] } | null {
    const sleep = this.sleeping;
    if (sleep === null) return null;
    const pins = this.rtc.wakePins();
    if (!sleep.deep && (this.rtc.wakeSources() & S3_WAKE.GPIO) !== 0) for (const pin of this.gpio.wakePins()) if (!pins.includes(pin)) pins.push(pin);
    return { at: this.rtc.wakeTime(), pins };
  }

  /**
   * STATE0.SLEEP_EN: both cores stop (IDF stalls the other one first; neither runs while the chip
   * sleeps — `canRun`). Deep: the digital domain is off, its timers with it. Light: APB is gated,
   * the timer groups wait.
   */
  private enterSleep(deep: boolean): void {
    if (this.sleeping !== null) return;
    this.sleeping = { deep };
    if (this.active >= 0) this.cores[this.active].requestStop();
    if (deep) this.events.clear();
    else for (const timg of this.timg) timg.gate();
    const at = this.rtc.wakeTime();
    if (at >= 0) this.events.schedule(this.wakeSlot, Math.max(this.now(), at));
    this.checkPinWake();
  }

  private checkPinWake(): void {
    const sleep = this.sleeping;
    if (sleep === null) return;
    let cause = this.rtc.pinWake((g) => this.gpio.padInput(g));
    if (!sleep.deep && (this.rtc.wakeSources() & S3_WAKE.GPIO) !== 0 && this.gpio.wakeLevel()) cause |= S3_WAKE.GPIO;
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
    if (sleep.deep) this.requestReset(S3_RESET_REASON.DEEPSLEEP);
    else for (const timg of this.timg) timg.ungate();
  }

  private asleep(cpu: number): boolean {
    return !this.canRun(cpu) || this.cores[cpu].asleep;
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /** Runs both cores until `target` reference cycles (or a halt, a breakpoint, a reset request). */
  runUntil(target: number): RunResult {
    const end = Math.ceil(target);
    this.breakpointStop = false;
    while (this.time < end && !this.stopped && !this.resetRequested) {
      this.events.fireDue(this.time);
      if (this.stopped || this.resetRequested) break;
      if (this.skipIdle && this.asleep(0) && this.asleep(1) && this.skipAhead(end)) {
        if (this.breakpointStop) return this.stopAtBreakpoint(end);
        continue;
      }
      this.sliceEnd = Math.min(this.time + S3_SLICE, end, this.events.next);
      for (;;) {
        let cpu = -1;
        for (let c = 0; c < 2; c++) {
          if (this.coreTime[c] < this.sliceEnd && this.canRun(c) && (cpu < 0 || this.coreTime[c] < this.coreTime[cpu])) cpu = c;
        }
        if (cpu < 0 || this.stopped || this.resetRequested) break;
        this.runCore(cpu);
        if (this.breakpointStop) return this.stopAtBreakpoint(end);
      }
      for (let cpu = 0; cpu < 2; cpu++) if (!this.canRun(cpu) && this.coreTime[cpu] < this.sliceEnd) this.coreTime[cpu] = this.sliceEnd;
      this.time = Math.max(this.time, this.sliceEnd);
    }
    if (!this.stopped && !this.resetRequested) this.events.fireDue(this.time);
    return this.stopped ? { reason: 'fault', detail: this.stopReason } : { reason: 'target' };
  }

  /**
   * BT125: one instruction on the debugger's core (at a breakpoint too), then the rest of the SoC
   * catches up to it. A peripheral access that must wait for the other core (BUS_YIELD) lets it
   * catch up first and tries again — as the ESP32's stepCore.
   */
  stepCore(cpu: number = this.debugCpu): RunResult {
    if (this.stopped) return { reason: 'fault', detail: this.stopReason };
    if (!this.canRun(cpu)) return { reason: 'target' };
    const core = this.cores[cpu];
    for (let attempt = 0; attempt < 4; attempt++) {
      core.resumePc = core.pc;
      this.active = cpu;
      this.activeCycles = core.cycles;
      const executed = core.run(1);
      this.coreTime[cpu] += (core.cycles - this.activeCycles) * this.cost;
      this.active = -1;
      if (core.halt !== HALT.RUNNING) {
        this.stopped = true;
        this.stopReason = `${cpu === 0 ? 'PRO' : 'APP'}_CPU at 0x${core.pc.toString(16)}: ${core.haltReason}`;
        return { reason: 'fault', detail: this.stopReason };
      }
      // Up to the stepped core's time, rounded down: runUntil rounds its target up, which would
      // leave this core a fraction of a cycle behind and run it one more instruction.
      const to = Math.floor(this.coreTime[cpu]);
      const caughtUp = to > this.time ? this.runUntil(to) : { reason: 'target' as const };
      if (caughtUp.reason === 'fault') return caughtUp;
      if (executed > 0 || core.waiting) break;
    }
    this.breakpointStop = false;
    this.debugCpu = cpu;
    return { reason: 'target' };
  }

  /** Runs for `seconds` of simulated time. */
  runFor(seconds: number): RunResult {
    return this.runUntil(this.time + seconds * REF_HZ);
  }

  /** Both cores asleep: jumps over the whole slices before the next thing that can wake one. */
  private skipAhead(end: number): boolean {
    let limit = Math.min(end, this.events.next);
    for (let cpu = 0; cpu < 2; cpu++) {
      if (!this.canRun(cpu)) continue;
      const core = this.cores[cpu];
      const wake = this.coreTime[cpu] + (core.nextTimer - core.cycles) * this.cost;
      if (wake < limit) limit = wake;
    }
    const slices = Math.floor((limit - this.time) / S3_SLICE);
    if (slices < 1) return false;
    const to = this.time + slices * S3_SLICE;
    this.sliceEnd = to;
    for (let cpu = 0; cpu < 2; cpu++) {
      if (this.canRun(cpu)) this.runCore(cpu);
      else if (this.coreTime[cpu] < to) this.coreTime[cpu] = to;
    }
    this.skipped += to - this.time;
    this.time = to;
    return true;
  }

  /** Runs core `cpu` up to the slice's end (which `hurry` may pull in), a peripheral yield or a stop. */
  private runCore(cpu: number): void {
    const core = this.cores[cpu];
    this.yielded = false;
    while (this.coreTime[cpu] < this.sliceEnd && core.halt === HALT.RUNNING && this.canRun(cpu) && !this.yielded && !this.resetRequested) {
      const n = Math.max(1, Math.ceil((this.sliceEnd - this.coreTime[cpu]) / this.cost));
      this.active = cpu;
      this.activeCycles = core.cycles;
      core.run(n);
      this.coreTime[cpu] += (core.cycles - this.activeCycles) * this.cost;
      this.active = -1;
      if (core.atBreakpoint) {
        this.breakpointStop = true;
        this.debugCpu = cpu;
        break;
      }
    }
    if (core.halt !== HALT.RUNNING && !this.stopped) {
      this.stopped = true;
      this.stopReason = `${cpu === 0 ? 'PRO' : 'APP'}_CPU at 0x${core.pc.toString(16)}: ${core.haltReason}`;
    }
  }

  // ── Breakpoints (BT125's debugger view) ─────────────────────────────────────────────────

  private breakpointStop = false;

  /** The bench sees the SoC at the stopped core's time (the other core catches up on the next run). */
  private stopAtBreakpoint(end: number): RunResult {
    this.breakpointStop = false;
    this.time = Math.max(this.time, Math.min(this.coreTime[this.debugCpu], end));
    return { reason: 'breakpoint' };
  }
}
