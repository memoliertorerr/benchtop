/**
 * Timer group TIMG0/TIMG1 (0x3FF5F000 / 0x3FF60000; timer_group_reg.h, TRM v5.8 "Timer Group").
 *
 * Counters T0, T1 and LACT (64-bit; LACT is what esp_timer runs on — CONFIG_ESP_TIMER_IMPL_TG0_LAC,
 * esp_timer_impl_lac.c): CONFIG EN (31), INCREASE (30), AUTORELOAD (29), DIVIDER (28:13, 0 meaning
 * 65536) over the APB clock, EDGE_INT_EN (12), LEVEL_INT_EN (11), ALARM_EN (10). A counter isn't
 * ticked: its value is computed from simulated time when read (value at an anchor time + elapsed
 * APB cycles / divider). UPDATE latches it into LO/HI; LOAD sets it from LOADLO/LOADHI; ALARMLO/HI
 * hold the alarm. An enabled alarm is a timed event at the moment the counter reaches the alarm
 * value (at once if it already has): INT_RAW gets the counter's bit (T0 0, T1 1, LACT 3), ALARM_EN
 * clears (TRM), and with AUTORELOAD the counter restarts from the load value at the alarm time.
 * LACT's RTC_ONLY/USE_REFTICK clock options aren't modeled (APB only).
 *
 * MWDT (WDTCONFIG0–5, WDTFEED, WDTWPROTECT; wdt.ts): stages with actions off / interrupt (INT_RAW
 * bit 2) / reset CPU / reset system, ticking at APB / CLK_PRESCALE (WDTCONFIG1 31:16). While
 * WDTWPROTECT isn't 0x50D83AA1, writes to WDTCONFIG0–5 and WDTFEED are ignored. Reset actions
 * reboot the chip (reset.ts): TG0WDT_SYS_RESET / TG1WDT_SYS_RESET for "reset system",
 * TGWDT_CPU_RESET for "reset CPU". The flash-boot mode (FLASHBOOT_MOD_EN) isn't modeled: direct
 * boot clears it, as the bootloader does.
 *
 * Interrupts: INT_ST = INT_RAW & INT_ENA; INT_CLR clears INT_RAW. Each of T0, T1, WDT and LACT
 * drives its level source (TG0 14–17, TG1 18–21) while its raw bit is set and either INT_ENA or
 * its LEVEL_INT_EN bit is (IDF's watchdog code sets only LEVEL_INT_EN, its timer drivers both),
 * and pulses its edge source (TG0 58–61, TG1 62–65) when the raw bit rises with EDGE_INT_EN set.
 *
 * RTC calibration (RTCCALICFG): START (bit 31) counts XTAL cycles over RTC_CALI_MAX cycles (0:
 * until the next edge) of the selected slow clock (CLK_SEL 0: RC 150 kHz, 1: 8MD256 = 8.5 MHz /
 * 256, 2: 32 kHz crystal — absent, so it never completes) and sets RDY (bit 15) and RTCCALICFG1
 * VALUE (bits 31:7) after that much simulated time.
 */

import type { SocContext } from './context.ts';
import { REF_HZ, XTAL_HZ } from './context.ts';
import { RegisterFile } from './periph.ts';
import { RESET_REASON } from './reset.ts';
import { RTC_SLOW_HZ } from './rtc-cntl.ts';
import { Watchdog } from './wdt.ts';

export const TIMG_BASES = [0x3ff5f000, 0x3ff60000] as const;
/** Counter register blocks: T0 at 0x00, T1 at 0x24, LACT at 0x70 (CONFIG, …, LOAD). */
const COUNTERS = [0x00, 0x24, 0x70] as const;
/** Each counter's INT_RAW bit. */
const COUNTER_BIT = [0, 1, 3] as const;
const WDT_BIT = 2;
const LO = 0x04;
const HI = 0x08;
const UPDATE = 0x0c;
const ALARMLO = 0x10;
const ALARMHI = 0x14;
const LOADLO = 0x18;
const LOADHI = 0x1c;
const LOAD = 0x20;
const LACT_RTC = 0x74; // LACT has an extra RTC register before LO: its offsets are shifted by 4
const WDTCONFIG0 = 0x48;
const WDTCONFIG1 = 0x4c;
const WDTCONFIG2 = 0x50;
const WDTCONFIG5 = 0x5c;
const WDTFEED = 0x60;
const WDTWPROTECT = 0x64;
const WDT_WKEY = 0x50d83aa1;
const RTCCALICFG = 0x68;
const RTCCALICFG1 = 0x6c;
const INT_ENA = 0x98;
const INT_RAW = 0x9c;
const INT_ST = 0xa0;
const INT_CLR = 0xa4;
const CALI_RDY = 1 << 15;
const CALI_START = 1 << 31;
const SLOW_CLOCKS = [RTC_SLOW_HZ, 8_500_000 / 256, 0];
const EN = 1 << 31;
const INCREASE = 1 << 30;
const AUTORELOAD = 1 << 29;
const EDGE_INT_EN = 1 << 12;
const LEVEL_INT_EN = 1 << 11;
const ALARM_EN = 1 << 10;
const WDT_EN = 1 << 31;
const WDT_EDGE_INT_EN = 1 << 22;
const WDT_LEVEL_INT_EN = 1 << 21;
const TWO_64 = 2 ** 64;

export class Timg extends RegisterFile {
  readonly index: number;
  readonly watchdog: Watchdog;
  private readonly context: SocContext;
  /** Per counter: value at `anchor` (reference cycles), as a double (exact to 2^53). */
  private readonly value = new Float64Array(3);
  private readonly anchor = new Float64Array(3);
  /** Per counter: its alarm event slot and the time it was scheduled for. */
  private readonly alarmSlots: number[] = [];
  private readonly alarmAt = new Float64Array(3);
  private readonly calibrationSlot: number;
  private calibrationValue = 0;
  /** The level source lines as last driven (bits as in INT_RAW). */
  private levels = 0;
  private readonly levelBase: number;
  private readonly edgeBase: number;

  constructor(context: SocContext, index: number) {
    super(TIMG_BASES[index]);
    this.index = index;
    this.context = context;
    this.levelBase = 14 + 4 * index;
    this.edgeBase = 58 + 4 * index;
    for (let c = 0; c < 3; c++) this.alarmSlots.push(context.events.add(() => this.alarm(c)));
    this.calibrationSlot = context.events.add(() => {
      this.regs[RTCCALICFG >>> 2] |= CALI_RDY;
      this.regs[RTCCALICFG1 >>> 2] = (this.calibrationValue & 0x1ffffff) << 7;
    });
    this.watchdog = new Watchdog(
      context,
      {
        enabled: () => (this.regs[WDTCONFIG0 >>> 2] & WDT_EN) !== 0,
        action: (n) => (this.regs[WDTCONFIG0 >>> 2] >>> (29 - 2 * n)) & 3,
        hold: (n) => this.regs[(WDTCONFIG2 >>> 2) + n],
        tickCycles: () => ((this.regs[WDTCONFIG1 >>> 2] >>> 16) || 0x10000) * (REF_HZ / this.context.apbHz),
      },
      (action) => this.watchdogAction(action),
    );
  }

  implements(offset: number): boolean {
    return offset < 0x98 + 16 || offset === 0xf8;
  }

  override systemReset(_rtcDomain: boolean): void {
    this.reset();
    this.value.fill(0);
    this.anchor.fill(this.context.now());
    for (const slot of this.alarmSlots) this.context.events.cancel(slot);
    this.context.events.cancel(this.calibrationSlot);
    this.watchdog.stop();
    this.updateInterrupts();
  }

  /** The offset of register `reg` (a T0-relative offset) of counter `c`. */
  private static at(c: number, reg: number): number {
    return COUNTERS[c] + (c === 2 && reg !== 0 ? reg + 4 : reg);
  }

  private config(c: number): number {
    return this.regs[COUNTERS[c] >>> 2];
  }

  /** Reference cycles per counter tick. */
  private tickCycles(c: number): number {
    const divider = ((this.config(c) >>> 13) & 0xffff) || 0x10000;
    return (divider * REF_HZ) / this.context.apbHz;
  }

  /** The counter's value now. */
  count(c: number): number {
    const cfg = this.config(c);
    if ((cfg & EN) === 0) return this.value[c];
    const ticks = Math.floor((this.context.now() - this.anchor[c]) / this.tickCycles(c));
    const v = (cfg & INCREASE) !== 0 ? this.value[c] + ticks : this.value[c] - ticks;
    // Wrap without adding 2^64 to a small value (a double would lose its low bits).
    return v < 0 ? v + TWO_64 : v >= TWO_64 ? v - TWO_64 : v;
  }

  /** Re-anchors every counter at the current time and re-times what depends on the APB clock. */
  rebase(): void {
    for (let c = 0; c < 3; c++) this.rebaseCounter(c);
  }

  /** After an APB clock change (rebase ran before it). */
  clockChanged(): void {
    for (let c = 0; c < 3; c++) this.scheduleAlarm(c);
    this.watchdog.update();
  }

  private rebaseCounter(c: number): void {
    this.value[c] = this.count(c);
    this.anchor[c] = this.context.now();
  }

  private alarmValue(c: number): number {
    return this.regs[Timg.at(c, ALARMHI) >>> 2] * 0x100000000 + this.regs[Timg.at(c, ALARMLO) >>> 2];
  }

  /** (Re)schedules counter c's alarm event, or cancels it. */
  private scheduleAlarm(c: number): void {
    const slot = this.alarmSlots[c];
    const cfg = this.config(c);
    if ((cfg & ALARM_EN) === 0 || (cfg & EN) === 0) {
      this.context.events.cancel(slot);
      return;
    }
    const now = this.context.now();
    const count = this.count(c);
    const alarm = this.alarmValue(c);
    const up = (cfg & INCREASE) !== 0;
    let at: number;
    if (up ? count >= alarm : count <= alarm) at = now;
    else {
      // The tick at which the counter reaches the alarm, counted from the anchor.
      const ticks = up ? alarm - this.value[c] : this.value[c] - alarm;
      at = this.anchor[c] + ticks * this.tickCycles(c);
    }
    this.alarmAt[c] = Math.ceil(at);
    this.context.events.schedule(slot, at);
  }

  private alarm(c: number): void {
    const cfg = this.config(c);
    if ((cfg & ALARM_EN) === 0 || (cfg & EN) === 0) return;
    this.regs[COUNTERS[c] >>> 2] = cfg & ~ALARM_EN;
    if ((cfg & AUTORELOAD) !== 0) {
      this.value[c] = this.regs[Timg.at(c, LOADHI) >>> 2] * 0x100000000 + this.regs[Timg.at(c, LOADLO) >>> 2];
      this.anchor[c] = this.alarmAt[c];
    }
    this.raise(COUNTER_BIT[c], (cfg & EDGE_INT_EN) !== 0);
  }

  private watchdogAction(action: number): void {
    if (action === 1) this.raise(WDT_BIT, (this.regs[WDTCONFIG0 >>> 2] & WDT_EDGE_INT_EN) !== 0);
    else if (action === 2) this.context.resets.systemReset(RESET_REASON.TGWDT_CPU);
    else if (action === 3) this.context.resets.systemReset(this.index === 0 ? RESET_REASON.TG0WDT_SYS : RESET_REASON.TG1WDT_SYS);
  }

  /** Sets INT_RAW bit `bit`; pulses its edge source when `edge`. */
  private raise(bit: number, edge: boolean): void {
    this.regs[INT_RAW >>> 2] |= 1 << bit;
    if (edge) {
      this.context.interrupts.setSource(this.edgeBase + bit, true);
      this.context.interrupts.setSource(this.edgeBase + bit, false);
    }
    this.updateInterrupts();
  }

  private levelEnabled(bit: number): boolean {
    if (((this.regs[INT_ENA >>> 2] >>> bit) & 1) !== 0) return true;
    if (bit === WDT_BIT) return (this.regs[WDTCONFIG0 >>> 2] & WDT_LEVEL_INT_EN) !== 0;
    return (this.config(bit === 3 ? 2 : bit) & LEVEL_INT_EN) !== 0;
  }

  private updateInterrupts(): void {
    const raw = this.regs[INT_RAW >>> 2];
    let levels = 0;
    for (let bit = 0; bit < 4; bit++) if (((raw >>> bit) & 1) !== 0 && this.levelEnabled(bit)) levels |= 1 << bit;
    const changed = levels ^ this.levels;
    if (changed === 0) return;
    this.levels = levels;
    for (let bit = 0; bit < 4; bit++) if (((changed >>> bit) & 1) !== 0) this.context.interrupts.setSource(this.levelBase + bit, ((levels >>> bit) & 1) !== 0);
  }

  override read32(offset: number): number {
    if (offset === INT_ST) return this.regs[INT_RAW >>> 2] & this.regs[INT_ENA >>> 2];
    return super.read32(offset);
  }

  override write32(offset: number, value: number): void {
    for (let c = 0; c < 3; c++) {
      if (offset === COUNTERS[c]) {
        this.rebaseCounter(c);
        super.write32(offset, value);
        this.scheduleAlarm(c);
        this.updateInterrupts();
        return;
      }
      if (offset === Timg.at(c, UPDATE)) {
        const v = this.count(c);
        this.regs[Timg.at(c, LO) >>> 2] = v % 0x100000000;
        this.regs[Timg.at(c, HI) >>> 2] = Math.floor(v / 0x100000000);
        return;
      }
      if (offset === Timg.at(c, LOAD)) {
        this.value[c] = this.regs[Timg.at(c, LOADHI) >>> 2] * 0x100000000 + this.regs[Timg.at(c, LOADLO) >>> 2];
        this.anchor[c] = this.context.now();
        this.scheduleAlarm(c);
        return;
      }
      if (offset === Timg.at(c, LO) || offset === Timg.at(c, HI)) return; // read-only
      if (offset === Timg.at(c, ALARMLO) || offset === Timg.at(c, ALARMHI)) {
        super.write32(offset, value);
        this.scheduleAlarm(c);
        return;
      }
    }
    if (offset >= WDTCONFIG0 && offset <= WDTFEED) {
      if (this.regs[WDTWPROTECT >>> 2] !== WDT_WKEY) return; // write-protected
      if (offset === WDTFEED) {
        this.watchdog.feed();
        return;
      }
      super.write32(offset, value);
      if (offset === WDTCONFIG0 || offset === WDTCONFIG1 || (offset >= WDTCONFIG2 && offset <= WDTCONFIG5)) this.watchdog.update();
      if (offset === WDTCONFIG0) this.updateInterrupts();
      return;
    }
    if (offset === RTCCALICFG) {
      const before = this.regs[offset >>> 2];
      super.write32(offset, value & ~CALI_RDY);
      if ((value & CALI_START) !== 0 && (before & CALI_START) === 0) this.startCalibration(value);
      else if ((value & CALI_START) === 0) this.context.events.cancel(this.calibrationSlot);
      return;
    }
    if (offset === INT_CLR) {
      this.regs[INT_RAW >>> 2] &= ~value;
      this.updateInterrupts();
      return;
    }
    if (offset === INT_ENA) {
      super.write32(offset, value);
      this.updateInterrupts();
      return;
    }
    if (offset === RTCCALICFG1 || offset === INT_RAW || offset === INT_ST) return;
    if (offset === LACT_RTC) {
      super.write32(offset, value);
      return;
    }
    super.write32(offset, value);
  }

  private startCalibration(cfg: number): void {
    const cycles = (cfg >>> 16) & 0x7fff;
    const slowHz = SLOW_CLOCKS[(cfg >>> 13) & 3] ?? 0;
    if (slowHz === 0) return; // no 32 kHz crystal: never ready
    // 0 cycles (rtc_clk_wait_for_slow_cycle) completes at the next slow-clock edge.
    const seconds = cycles === 0 ? 1 / slowHz : cycles / slowHz;
    this.calibrationValue = Math.round(seconds * XTAL_HZ);
    this.context.events.schedule(this.calibrationSlot, this.context.now() + seconds * REF_HZ);
  }
}
