/**
 * The ESP32 SoC: memories, the flash cache MMU, the peripheral map and its models, the interrupt
 * matrix, and two cores, each on its own SocBus — PRO_CPU (PRID 0xCDCD) and APP_CPU (PRID 0xABAB),
 * the latter held in reset until the app releases it through DPORT (BT32).
 *
 * Time (BT32): the unit is a 240 MHz reference cycle (REF_HZ). A core instruction costs
 * 240 / cpuMHz reference cycles (1, 1.5, 3 or 6 — exact in a double); CCOUNT still counts one per
 * instruction, so a CCOMPARE match lands at the right reference time whatever the clock was when
 * it was programmed. cpuMHz follows RTC_CNTL_CLK_CONF SOC_CLK_SEL (0 XTAL, 1 PLL, 2 8 MHz RC),
 * DPORT CPU_PER_CONF CPUPERIOD_SEL (80/160/240 under the PLL) and SYSCON PRE_DIV_CNT (XTAL / 8M
 * divider); APB is 80 MHz under the PLL and the CPU clock otherwise. A flash cache miss stalls
 * a core for one SPI block fill (bus.ts; `setFlashTiming`). The cores interleave
 * deterministically, the one behind in time running first (PRO on a tie); a slice is
 * SLICE_CYCLES reference cycles or less, ending at the next event. While a core runs, `now()` is that core's local time, so a
 * peripheral sees the time of the store. Events fire at slice boundaries — at their exact time
 * when they were pending as the slice began, ≤ one slice late when scheduled during it; either
 * way `now()` inside the callback is the event's own time (BT37), so what it does (an RMT edge,
 * the next edge it schedules) carries the exact timestamp.
 *
 * WAITI skip-ahead (BT33): a core in WAITI with nothing deliverable is asleep (so is a core held
 * in reset or stalled). When both are asleep as a slice begins, the run loop jumps over every
 * whole slice before the earliest of: the next event (timer and LACT alarms, watchdog stages,
 * UART byte ends, calibration, a reboot), either core's next CCOMPARE match, and the run's
 * target. Sleeping cores advance their cycles (and CCOUNT) by the elapsed CPU cycles exactly as
 * slice-by-slice sleeping would — the jump lands on a slice boundary a normal run would also
 * reach, and every time involved is an integer — so skipping on and off give bit-identical
 * state (`skipIdle`, default on).
 *
 * Peripheral order (BT33): within a slice the core that is behind in time runs (PRO first on a
 * tie). A core that touches a peripheral while the other runnable core is behind it yields
 * before the access (BUS_YIELD), and the other core runs until it catches up or yields in turn —
 * so peripherals see accesses in time order. Without it, a core running its slice first could
 * clear an interrupt status the other core's handler, entered at the same instant, had yet to
 * read (IDF's interrupt-watchdog handler does exactly that on both CPUs). Memory isn't ordered
 * this way: spinlocks and other shared variables see the other core up to one slice ahead.
 *
 * Resets (BT33, reset.ts): RTC_CNTL software resets and watchdog reset actions hold the CPUs and
 * reboot the chip through `bootLoader` (set by directBoot), with a rapid-reboot loop guard.
 *
 * Problems (unknown registers, ROM writes, reboots, …) collect in `problems`; set
 * `problems.listener` to forward them (Mcu has no report method — BT34's board model does).
 */

import type { RunResult } from '@benchtop/core';
import { placeRomData, type RomImage } from '../boot/rom.ts';
import { HALT, XtensaCore } from '../xtensa/cpu.ts';
import { RegI2c, REGI2C_BASE, Rng, RNG_BASE, Syscon, SYSCON_BASE } from './analog.ts';
import { SocBus, type SocParts } from './bus.ts';
import { REF_HZ, type SocContext, XTAL_HZ } from './context.ts';
import { Dport } from './dport.ts';
import { Efuse, EFUSE_BASE } from './efuse.ts';
import { EventTable } from './events.ts';
import { cacheFillTime, FlashChip } from './flash.ts';
import { Gpio, GPIO_BASE } from './gpio.ts';
import { I2c, I2C_BASES } from './i2c.ts';
import { InterruptMatrix } from './intmatrix.ts';
import { IO_MUX_BASE, IoMux } from './iomux.ts';
import { Ledc, LEDC_BASE, LEDC_SIGNAL_BASE } from './ledc.ts';
import { DEFAULT_FLASH_SIZE, EspMemory, ROM0, ROM1, ROM1_I_START, RTC_FAST, RTC_FAST_I_START, RTC_SLOW, SRAM0, SRAM1, SRAM1_I_START } from './memory.ts';
import { APP_TABLE, FlashMmu, MMU_INVALID, PRO_TABLE } from './mmu.ts';
import { IDLE_HIGH_SIGNALS, Pads } from './pads.ts';
import { PeripheralMap, ProblemLog } from './periph.ts';
import { RAPID_LIMIT, RAPID_REBOOT, RESET_REASON, RESET_SETTLE, type ResetSink, resetName } from './reset.ts';
import { RMT_BASE, RMT_SIGNAL_BASE, Rmt } from './rmt.ts';
import { RTC_CNTL_BASE, RtcCntl } from './rtc-cntl.ts';
import { SPI0_BASE, SPI1_BASE, SpiCacheController, SpiFlashController } from './spi-flash.ts';
import { Spi, SPI_BASES } from './spi.ts';
import { Timg, TIMG_BASES } from './timg.ts';
import { Uart, UART_BASES } from './uart.ts';

/** Reference cycles per interleave slice (≈ 1.07 µs) by default (`sliceCycles`). Tuned in BT37. */
export const SLICE_CYCLES = 256;
export const CODE_REBOOT = 'esp32-reboot';

export interface Esp32SocOptions {
  /** Flash size in bytes (a multiple of 64 KB; 4 MB by default). */
  flashSize?: number;
}

export class Esp32Soc implements SocParts, SocContext, ResetSink {
  readonly memory: EspMemory;
  readonly problems = new ProblemLog();
  readonly events = new EventTable();
  readonly matrix = new InterruptMatrix();
  readonly interrupts = this.matrix;
  readonly resets: ResetSink = this;
  readonly dport: Dport;
  readonly mmu: FlashMmu;
  readonly periph = new PeripheralMap(this.problems);
  readonly buses: readonly [SocBus, SocBus];
  readonly cores: readonly [XtensaCore, XtensaCore];
  readonly rtc: RtcCntl;
  readonly efuse = new Efuse();
  readonly regi2c = new RegI2c();
  readonly syscon: Syscon;
  readonly rng = new Rng();
  readonly timg: readonly [Timg, Timg];
  readonly uarts: readonly [Uart, Uart, Uart];
  readonly gpio: Gpio;
  readonly ledc: Ledc;
  readonly rmt: Rmt;
  readonly i2c: readonly [I2c, I2c];
  /** SPI2 (HSPI) and SPI3 (VSPI). */
  readonly spi2: Spi;
  readonly spi3: Spi;
  readonly iomux = new IoMux();
  /** What each pin is doing (BT34): mode and level per GPIO, with a change callback. */
  readonly pads: Pads;
  readonly flash: FlashChip;
  readonly spi1: SpiFlashController;
  readonly spi0 = new SpiCacheController();
  /** Each UART byte as its stop bit ends. */
  onUart: ((uart: number, byte: number) => void) | null = null;
  /** Reboots the loaded image after a reset with cause `reason` (direct boot sets it). */
  bootLoader: ((reason: number) => void) | null = null;

  /** Slice-boundary time, in reference cycles. */
  time = 0;
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  /** WAITI skip-ahead (on by default; off only for the A/B test). */
  skipIdle = true;
  /** Reference cycles per interleave slice (SLICE_CYCLES; the bench script measures others). */
  sliceCycles = SLICE_CYCLES;
  /** Reference time the slices skipped by skip-ahead covered (reports). */
  skipped = 0;
  /** Reference cycles per instruction. */
  private cost = REF_HZ / XTAL_HZ;
  /** Reference cycles a flash cache block fill takes (0: no flash timing yet). */
  private fillTime = 0;
  appRunning = false;
  /** Set when a core halts (fault or claimed BREAK) or a reboot loop ends the run. */
  stopped = false;
  stopReason = '';
  /** Boots so far (1 after the first direct boot) and when the latest began. */
  boots = 0;
  bootTime = 0;
  private rapidReboots = 0;
  private readonly coreTime = new Float64Array(2);
  private active = -1;
  private activeCycles = 0;
  /** The active core yielded on a peripheral access (runCore hands over to the other core). */
  private yielded = false;
  /** Peripheral-order yields so far (reports). */
  yields = 0;
  /** A reset in progress: the cause, whether both CPUs or only the PRO_CPU are held. */
  private resetReason = 0;
  private resetRtc = false;
  private systemHeld = false;
  private proHeld = false;
  private appResetPending = false;
  private readonly rebootSlot: number;

  constructor(options: Esp32SocOptions = {}) {
    this.memory = new EspMemory(options.flashSize ?? DEFAULT_FLASH_SIZE);
    this.dport = new Dport(this, this.matrix);
    this.mmu = new FlashMmu(this.dport);
    this.rtc = new RtcCntl(this);
    this.syscon = new Syscon(this);
    this.timg = [new Timg(this, 0), new Timg(this, 1)];
    this.uarts = [new Uart(this, 0), new Uart(this, 1), new Uart(this, 2)];
    this.gpio = new Gpio(this, this.matrix, this.iomux);
    this.ledc = new Ledc(this);
    this.rmt = new Rmt(this);
    this.i2c = [new I2c(this, 0), new I2c(this, 1)];
    this.spi2 = new Spi(this, 2);
    this.spi3 = new Spi(this, 3);
    const ledcLevel = this.ledc.level;
    const rmtLevel = this.rmt.level;
    const spi2 = this.spi2;
    const spi3 = this.spi3;
    this.pads = new Pads(this.gpio, this.iomux, this.rtc.rtcio, this.problems, (signal) => {
      if (signal >= LEDC_SIGNAL_BASE && signal < LEDC_SIGNAL_BASE + 16) return ledcLevel[signal - LEDC_SIGNAL_BASE];
      if (signal >= RMT_SIGNAL_BASE && signal < RMT_SIGNAL_BASE + 8) return rmtLevel[signal - RMT_SIGNAL_BASE];
      if (signal === 11) return spi2.cs0; // HSPICS0
      if (signal === 68) return spi3.cs0; // VSPICS0
      return IDLE_HIGH_SIGNALS.has(signal) ? 1 : 0;
    });
    this.ledc.onOutput = () => this.pads.update();
    this.rmt.onOutput = () => this.pads.update();
    spi2.onCs = () => this.pads.update();
    spi3.onCs = () => this.pads.update();
    this.gpio.onConfig = () => this.pads.update();
    this.rtc.rtcio.onChange = () => this.pads.update();
    this.iomux.onChange = () => {
      this.pads.update();
      this.gpio.inputsChanged(); // FUN_IE gates GPIO_IN
    };
    this.flash = new FlashChip(() => this.memory.flash, this.problems);
    this.flash.onWrite = (start, end) => {
      for (const core of this.cores) core.icache.invalidateFlash(start, end);
    };
    this.memory.codeWritten = (offset) => this.codeWritten(offset);
    this.spi1 = new SpiFlashController(this.flash);
    this.rebootSlot = this.events.add(() => this.reboot());

    const periph = this.periph;
    periph.register(0x3ff00000, this.dport);
    for (let base = PRO_TABLE; base < APP_TABLE + 0x2000; base += 0x1000) periph.register(base, this.mmu.block(base));
    periph.register(RTC_CNTL_BASE, this.rtc);
    periph.register(EFUSE_BASE, this.efuse);
    periph.register(REGI2C_BASE, this.regi2c);
    periph.register(SYSCON_BASE, this.syscon);
    periph.register(RNG_BASE, this.rng);
    periph.register(TIMG_BASES[0], this.timg[0]);
    periph.register(TIMG_BASES[1], this.timg[1]);
    for (let i = 0; i < 3; i++) {
      periph.register(UART_BASES[i], this.uarts[i]);
      this.uarts[i].onByte = (uart, byte) => this.onUart?.(uart, byte);
    }
    periph.register(GPIO_BASE, this.gpio);
    periph.register(IO_MUX_BASE, this.iomux);
    periph.register(LEDC_BASE, this.ledc);
    periph.register(RMT_BASE, this.rmt);
    periph.register(I2C_BASES[0], this.i2c[0]);
    periph.register(I2C_BASES[1], this.i2c[1]);
    periph.register(SPI_BASES[2], this.spi2);
    periph.register(SPI_BASES[3], this.spi3);
    periph.register(SPI1_BASE, this.spi1);
    periph.register(SPI0_BASE, this.spi0);

    const pro = new SocBus(this, 0);
    const app = new SocBus(this, 1);
    this.buses = [pro, app];
    this.cores = [new XtensaCore(pro, { prid: 0xcdcd }), new XtensaCore(app, { prid: 0xabab })];
    pro.core = this.cores[0];
    app.core = this.cores[1];
    this.matrix.cores = this.cores;
    this.dport.onChange = (cpu) => {
      for (const bus of this.buses) if (cpu < 0 || cpu === bus.cpu) bus.rebuild();
    };
    this.dport.onAppCpu = (running) => this.setAppRunning(running);
    this.mmu.onChange = (cpu, entry) => this.buses[cpu].mmuChanged(entry);
    this.dport.onFlush = (cpu) => this.buses[cpu].flushCache();
    this.clockChanged();
  }

  // ── SocContext ──────────────────────────────────────────────────────────────────────────

  now(): number {
    if (this.active < 0) return this.events.firing >= 0 ? this.events.firing : this.time;
    return this.coreTime[this.active] + (this.cores[this.active].cycles - this.activeCycles) * this.cost;
  }

  pc(): number {
    return this.active < 0 ? 0 : this.cores[this.active].pc;
  }

  /** Simulated seconds. */
  seconds(): number {
    return this.now() / REF_HZ;
  }

  clockChanged(): void {
    const sel = this.rtc.socClockSelect();
    let cpuHz: number;
    let apbHz: number;
    if (sel === 1 || sel === 3) {
      cpuHz = [80e6, 160e6, 240e6, 240e6][this.dport.cpuPeriodSel()];
      apbHz = 80e6;
    } else {
      cpuHz = (sel === 2 ? 8e6 : XTAL_HZ) / (this.syscon.preDivider() + 1);
      apbHz = cpuHz;
    }
    if (cpuHz === this.cpuHz && apbHz === this.apbHz) return;
    // Settle the running core's time at the old rate, and the timers at the old APB clock.
    if (this.active >= 0) {
      const core = this.cores[this.active];
      this.coreTime[this.active] += (core.cycles - this.activeCycles) * this.cost;
      this.activeCycles = core.cycles;
    }
    for (const t of this.timg) t.rebase();
    const apbChanged = apbHz !== this.apbHz;
    this.cpuHz = cpuHz;
    this.apbHz = apbHz;
    this.cost = REF_HZ / cpuHz;
    this.updateMissCycles();
    if (apbChanged) {
      for (const t of this.timg) t.clockChanged();
      this.ledc?.clockChanged();
    }
  }

  /**
   * The SPI flash timing the cache fills at (BT33): the image header's mode and frequency nibble
   * (see cacheFillTime). Direct boot sets it, as the bootloader configures SPI0 from the header.
   */
  setFlashTiming(mode: number, speed: number): void {
    this.fillTime = cacheFillTime(mode, speed);
    this.updateMissCycles();
  }

  /** A cache miss stalls a core for the fill time in CPU cycles (rounded; exact for 80/160/240/40 MHz). */
  private updateMissCycles(): void {
    const cycles = Math.round(this.fillTime / this.cost);
    for (const bus of this.buses ?? []) bus.missCycles = cycles;
  }

  // ── ResetSink ───────────────────────────────────────────────────────────────────────────

  systemReset(reason: number, rtcDomain = false): void {
    if (this.systemHeld) return;
    this.systemHeld = true;
    this.resetReason = reason;
    this.resetRtc = rtcDomain;
    this.stopActive();
    this.events.schedule(this.rebootSlot, this.now() + RESET_SETTLE);
  }

  proCpuReset(): void {
    if (this.systemHeld) return;
    this.proHeld = true;
    this.resetReason = RESET_REASON.SW_CPU;
    if (this.active === 0) this.cores[0].requestStop();
    this.armProReboot();
  }

  appCpuReset(): void {
    if (!this.appRunning) return;
    if (this.active === 1) {
      // The APP_CPU resetting itself: restart it once its run() has returned.
      this.appResetPending = true;
      this.cores[1].requestStop();
    } else this.restartApp();
  }

  stallChanged(): void {
    if (this.active >= 0 && this.rtc.stalled(this.active)) this.cores[this.active].requestStop();
    if (this.proHeld && !this.systemHeld) this.armProReboot();
  }

  /** The held PRO_CPU reboots the chip after RESET_SETTLE out of stall; a stall puts it off. */
  private armProReboot(): void {
    if (this.rtc.stalled(0)) this.events.cancel(this.rebootSlot);
    else this.events.schedule(this.rebootSlot, this.now() + RESET_SETTLE);
  }

  private stopActive(): void {
    if (this.active >= 0) this.cores[this.active].requestStop();
  }

  /** May core `cpu` execute now? */
  private canRun(cpu: number): boolean {
    if (this.systemHeld || this.rtc.stalled(cpu)) return false;
    return cpu === 0 ? !this.proHeld : this.appRunning;
  }

  peripheralTurn(cpu: number): boolean {
    if (this.active !== cpu) return true; // not inside a run (boot, tests)
    const other = 1 - cpu;
    if (!this.canRun(other) || this.cores[other].halt !== HALT.RUNNING || this.coreTime[other] >= this.now()) return true;
    this.yielded = true;
    this.yields++;
    return false;
  }

  /** Asleep for skip-ahead: held, stalled, in reset, or in WAITI with nothing deliverable. */
  private asleep(cpu: number): boolean {
    return !this.canRun(cpu) || this.cores[cpu].asleep;
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /** Runs both cores until `target` reference cycles (or a halt / reboot loop). */
  runUntil(target: number): RunResult {
    const end = Math.ceil(target);
    while (this.time < end && !this.stopped) {
      this.events.fireDue(this.time);
      if (this.stopped) break;
      if (this.skipIdle && this.asleep(0) && this.asleep(1) && this.skipAhead(end)) continue;
      const sliceEnd = Math.min(this.time + this.sliceCycles, end, this.events.next);
      // The core behind in time runs (PRO on a tie) until the slice end or a peripheral yield.
      for (;;) {
        let cpu = -1;
        for (let c = 0; c < 2; c++) {
          if (this.coreTime[c] < sliceEnd && this.canRun(c) && (cpu < 0 || this.coreTime[c] < this.coreTime[cpu])) cpu = c;
        }
        if (cpu < 0 || this.stopped) break;
        this.runCore(cpu, sliceEnd);
      }
      for (let cpu = 0; cpu < 2; cpu++) if (!this.canRun(cpu) && this.coreTime[cpu] < sliceEnd) this.coreTime[cpu] = sliceEnd;
      this.time = sliceEnd;
    }
    if (!this.stopped) this.events.fireDue(this.time);
    return this.stopped ? { reason: 'fault', detail: this.stopReason } : { reason: 'target' };
  }

  /** Runs for `seconds` of simulated time. */
  runFor(seconds: number): RunResult {
    return this.runUntil(this.time + seconds * REF_HZ);
  }

  /**
   * Both cores asleep: jumps over the whole slices before the next thing that can wake one.
   * Returns false when not even one slice can be skipped.
   */
  private skipAhead(end: number): boolean {
    let limit = Math.min(end, this.events.next);
    for (let cpu = 0; cpu < 2; cpu++) {
      if (!this.canRun(cpu)) continue;
      const core = this.cores[cpu];
      const wake = this.coreTime[cpu] + (core.nextTimer - core.cycles) * this.cost;
      if (wake < limit) limit = wake;
    }
    const slices = Math.floor((limit - this.time) / this.sliceCycles);
    if (slices < 1) return false;
    const to = this.time + slices * this.sliceCycles;
    for (let cpu = 0; cpu < 2; cpu++) {
      if (this.canRun(cpu)) this.runCore(cpu, to);
      else if (this.coreTime[cpu] < to) this.coreTime[cpu] = to;
    }
    this.skipped += to - this.time;
    this.time = to;
    return true;
  }

  private runCore(cpu: number, end: number): void {
    const core = this.cores[cpu];
    this.yielded = false;
    while (this.coreTime[cpu] < end && core.halt === HALT.RUNNING && this.canRun(cpu) && !this.yielded) {
      const n = Math.max(1, Math.ceil((end - this.coreTime[cpu]) / this.cost));
      this.active = cpu;
      this.activeCycles = core.cycles;
      core.run(n);
      this.coreTime[cpu] += (core.cycles - this.activeCycles) * this.cost;
      this.active = -1;
      if (this.appResetPending) {
        this.appResetPending = false;
        this.restartApp();
      }
    }
    if (core.halt !== HALT.RUNNING && !this.stopped) {
      this.stopped = true;
      this.stopReason = `${cpu === 0 ? 'PRO' : 'APP'}_CPU at 0x${core.pc.toString(16)}: ${core.haltReason}`;
    }
  }

  private setAppRunning(running: boolean): void {
    if (running) {
      this.cores[1].reset();
      this.coreTime[1] = this.now();
    }
    this.appRunning = running;
  }

  /** RTC_CNTL_SW_APPCPU_RST: the APP_CPU restarts at the ROM reset vector. */
  private restartApp(): void {
    this.cores[1].reset();
  }

  // ── Reboot ──────────────────────────────────────────────────────────────────────────────

  /** The reboot event: the chip comes out of reset and the image boots again. */
  private reboot(): void {
    if (!this.systemHeld && !this.proHeld) return;
    if (!this.systemHeld && this.rtc.stalled(0)) return; // re-armed when unstalled
    const reason = this.resetReason;
    const now = this.time;
    const rapid = now - this.bootTime < RAPID_REBOOT;
    if (rapid && this.rapidReboots >= RAPID_LIMIT) {
      this.stopped = true;
      this.stopReason = `reboot loop: ${resetName(reason)} after ${RAPID_LIMIT} reboots in a row less than 1 s apart`;
      return;
    }
    this.rapidReboots = rapid ? this.rapidReboots + 1 : 0;
    this.problems.report('info', CODE_REBOOT, this.boots, `reboot after ${resetName(reason)} at ${(now / REF_HZ).toFixed(6)} s`);
    this.resetChip(this.resetRtc);
    this.boots++;
    this.bootTime = now;
    if (this.bootLoader !== null) this.bootLoader(reason);
    else this.rtc.setResetCause(reason);
  }

  /** Every digital block to its reset state (RAM, flash and — unless `rtcDomain` — RTC state kept). */
  private resetChip(rtcDomain: boolean): void {
    const now = this.time;
    this.events.clear();
    this.periph.systemReset(rtcDomain);
    this.matrix.reset();
    this.mmu.table.fill(MMU_INVALID);
    this.flash.status &= ~3; // WIP, WEL
    if (rtcDomain) {
      this.memory.bytes.fill(0, RTC_FAST.offset, RTC_FAST.offset + RTC_FAST.size);
      this.memory.bytes.fill(0, RTC_SLOW.offset, RTC_SLOW.offset + RTC_SLOW.size);
    }
    this.systemHeld = false;
    this.proHeld = false;
    this.appResetPending = false;
    this.resetReason = 0;
    this.resetRtc = false;
    this.appRunning = false;
    for (const core of this.cores) core.reset();
    this.coreTime[0] = now;
    this.coreTime[1] = now;
    for (const bus of this.buses) {
      bus.rebuild();
      bus.invalidateFlash();
    }
    this.memory.code.fill(0);
    this.clockChanged();
  }

  // ── Predecode cache (BT37) ──────────────────────────────────────────────────────────────

  /** Runs both cores through their predecode caches (default) or fetch and decode every instruction. */
  setPredecode(on: boolean): void {
    for (const core of this.cores) core.predecode = on;
  }

  /**
   * A store hit a 4 KB page of the memory buffer that holds predecoded code: both cores drop
   * the instruction-bus page it is — SRAM0 1:1, SRAM1 through its word-inverted alias (data page
   * n is instruction page 31 − n), RTC FAST at 0x400C0000.
   */
  private codeWritten(offset: number): void {
    const page = offset & ~0xfff;
    this.memory.code[page >>> 12] = 0;
    let address = -1;
    if (page >= SRAM0.offset && page < SRAM0.offset + SRAM0.size) address = SRAM0.start + (page - SRAM0.offset);
    else if (page >= SRAM1.offset && page < SRAM1.offset + SRAM1.size) address = SRAM1_I_START + ((31 - ((page - SRAM1.offset) >>> 12)) << 12);
    else if (page >= RTC_FAST.offset && page < RTC_FAST.offset + RTC_FAST.size) address = RTC_FAST_I_START + (page - RTC_FAST.offset);
    if (address >= 0) for (const core of this.cores) core.icache.invalidatePage(address);
  }

  // ── Loading ─────────────────────────────────────────────────────────────────────────────

  /**
   * The ROM's sections in ROM0 (0x40000000–0x4005FFFF) and ROM1 (instruction view 0x40060000…,
   * data view 0x3FF90000…), plus its initial RAM data at the unpack table's source addresses
   * (placeRomData).
   */
  loadRom(rom: RomImage): void {
    for (const segment of rom.segments) {
      const end = segment.address + segment.data.length;
      const inRom = (segment.address >= ROM0.start && end <= ROM1_I_START + ROM1.size) || (segment.address >= ROM1.start && end <= ROM1.start + ROM1.size);
      if (!inRom) continue;
      // A section may straddle ROM0's end into ROM1's instruction-bus view: load it in pieces.
      for (let at = 0; at < segment.data.length; ) {
        const address = segment.address + at;
        const room = address < ROM1_I_START ? ROM1_I_START - address : segment.data.length - at;
        const piece = Math.min(room, segment.data.length - at);
        this.memory.load(address, segment.data.subarray(at, at + piece));
        at += piece;
      }
    }
    const bytes = this.memory.bytes;
    placeRomData(this.buses[0], rom, (address, value) => {
      if (address >= ROM0.start && address < ROM0.start + ROM0.size) bytes[ROM0.offset + (address - ROM0.start)] = value;
    });
  }

  /** Replaces the flash contents (BT32 sizes it from the image). */
  setFlash(flash: Uint8Array): void {
    this.memory.setFlash(flash);
    for (const bus of this.buses) bus.flashChanged();
  }
}
