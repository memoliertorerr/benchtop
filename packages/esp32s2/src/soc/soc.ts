/**
 * The ESP32-S2 SoC (BT148): one Xtensa LX7 core (@benchtop/esp32's XtensaCore with the S2's decode
 * set — `s2: true`: no loops, MAC16, FPU, booleans or S32C1I — and a predecode cache over its
 * instruction bus, flash from 0x4008_0000) on an S2Bus; the interrupt matrix (95 sources); the
 * cache MMU; and the peripheral models, chosen by measured register layout — SYSTEM, EXTMEM,
 * RTC_CNTL, eFuse and SYSTIMER of its own, the original ESP32's timer groups (@benchtop/esp32),
 * the ESP32-C3's UARTs (with the S2's offsets) and SPI0/1 with the flash chip (@benchtop/esp32c3),
 * the S3's analog I2C master (@benchtop/esp32s3) — at the S2's PeriBus1 addresses (PeriBus2 reaches
 * the same blocks) and interrupt sources. SENSITIVE (memory protection) and APB_CTRL are storage:
 * the protection IDF sets up isn't enforced.
 *
 * Time: the unit is a 240 MHz reference cycle (REF_HZ), so an instruction costs 1, 1.5, 3 or 6 of
 * them at 240, 160, 80 and 40 MHz. The core runs in slices of SLICE reference cycles or less,
 * ending at the next event — or earlier when a model schedules one inside it (`hurry`); before
 * a peripheral access, events due by then fire. WAITI skip-ahead: with the core in WAITI and
 * nothing deliverable, the loop jumps over whole slices to the next event, CCOMPARE match or the
 * target. A system reset (RTC_CNTL OPTIONS0.SW_SYS_RST, a watchdog's reset stage) stops the run
 * with `resetRequested` (the Mcu, BT150, boots a fresh chip, as the S3's does).
 */

import type { RunResult } from '@benchtop/core';
import { Esp32I2c, Esp32Rmt, type Esp32SocContext, Esp32Spi, EventTable, HALT, type Peripheral, ProblemLog, QuadPsram, type ResetSink, type RmtLayout32, type SpiLayout, Timg, XtensaCore } from '@benchtop/esp32';
import { ApbCtrl, FlashChip, Ledc, RegisterFile, type SocContext, SpiMem, S2_UART_FIELDS, Uart } from '@benchtop/esp32c3';
import { S3AnalogI2c, S3Gpio, S3IoMux, S3Pads, S3Sens, S3UsbOtg, S3_USB_OTG_BLOCKS } from '@benchtop/esp32s3';
import { S2_GPIO_BASE, S2_GPIO_CHIP, S2_IO_MUX_BASE, S2_SIG } from './gpio.ts';
import { S2Bus, type S2BusParts } from './bus.ts';
import { INTERRUPT_BASE, S2_SRC, S2InterruptMatrix } from './intmatrix.ts';
import { IRAM_BASE, IRAM_END, S2Memory } from './memory.ts';
import { registerDefault, S2PeripheralMap } from './periph.ts';
import { EFUSE_BASE, REF_HZ, RTC_CNTL_BASE, S2_RESET_REASON, S2_WAKE, S2Efuse, S2RtcCntl, SLOW_CLOCK_HZ } from './rtc-cntl.ts';
import { S2Systimer, SYSTIMER_BASE } from './systimer.ts';
import { S2Touch, TOUCH_SCAN_CTRL } from './touch.ts';
import { S2Extmem, S2SystemRegs, SYSTEM_BASE, XTAL_HZ } from './system.ts';

/** Reference cycles per slice (≈ 1.07 µs, as the other chips'). */
export const S2_SLICE = 256;
export const DEFAULT_FLASH_SIZE = 4 * 1024 * 1024;
/** The MMU table (cache_memory.h): 6 windows × 64 entries at 0x6180_1000. */
export const MMU_TABLE_BASE = 0x61801000;
export const MMU_ENTRIES = 384;
export const MMU_INVALID = 1 << 14;
export const MMU_ACCESS_FLASH = 1 << 15;
export const MMU_ACCESS_SPIRAM = 1 << 16;
export const UART_BASES_S2 = [0x3f400000, 0x3f410000] as const;
export const SPI1_BASE_S2 = 0x3f402000;
export const SPI0_BASE_S2 = 0x3f403000;
export const TIMG_BASES_S2 = [0x3f41f000, 0x3f420000] as const;
export const ANA_I2C_BASE_S2 = 0x3f40e000;
/** The block holding WDEV_RND_REG (+0x110, BT151), the random number generator. */
export const S2_WDEV_BASE = 0x3f435000;
export const S2_LEDC_BASE = 0x3f419000;
export const S2_LEDC_CHANNELS = 8;
export const S2_RMT_BASE = 0x3f416000;
export const S2_I2C_BASES = [0x3f413000, 0x3f427000] as const;
/** BT149: the S2's RMT — the ESP32's at tighter offsets, 4 channels (rmt_reg.h; RMTMEM 0x3F41_6400). */
export const S2_RMT_LAYOUT: RmtLayout32 = { base: S2_RMT_BASE, channels: 4, conf0: 0x10, status: 0x30, intRaw: 0x50, txLim: 0x70, apbConf: 0x80, ram: 0x400, thrBit: 12, source: S2_SRC.RMT, defaults: registerDefault, unsupportedCode: 'esp32s2-rmt-unsupported' };
export const S2_SPI2_BASE = 0x3f424000;
/** BT149: GPSPI2 (FSPI) — the ESP32's SPI model at the S2's offsets (spi_reg.h). */
export const S2_SPI2_LAYOUT: SpiLayout = {
  base: S2_SPI2_BASE,
  usr: 1 << 24,
  clock: 0x14,
  user: 0x18,
  user1: 0x1c,
  user2: 0x20,
  mosiDlen: 0x24,
  misoDlen: 0x28,
  slave: 0x30,
  w0: 0x98,
  addrShift: 27,
  addrMask: 0x1f,
  native: 0,
  dmaEnables: [0x50, 0x54],
  last: 0x94,
  name: 'SPI2',
  unsupportedCode: 'esp32s2-spi-unsupported-mode',
};
export const S2_SENS_BASE = 0x3f408800;
export const S2_APB_SARADC_BASE = 0x3f440000;
/** USB0 (DR_REG_USB_BASE 0x6008_0000 on PeriBus2) and its wrapper (PHY, pads, pulls). */
export const S2_USB_OTG_BASE = 0x3f480000;
export const S2_USB_WRAP_BASE = 0x3f439000;
/** The S2's ADC input ranges per attenuation (0, 2.5, 6, 11 dB; its datasheet), in volts. */
export const S2_ADC_FULL_SCALE = [0.75, 1.05, 1.3, 2.5] as const;
/** SENSITIVE (the memory protection IDF configures at startup) and APB_CTRL: storage here. */
export const S2_SENSITIVE_BASE = 0x3f4c1000;
export const S2_APB_CTRL_BASE = 0x3f426000;
/** BT154: the S2's PSRAM — 2 MB (16 Mbit), as in an ESP32-S2FN4R2 (the MINI-2) or on a WROVER. */
export const S2_PSRAM_BYTES = 2 * 1024 * 1024;
/** Its ID bytes: MFID 0x0D, KGD 0x5D, EID density bits 7:5 = 0 (16 Mbit). */
export const S2_PSRAM_ID = [0x0d, 0x5d, 0x00] as const;

export interface Esp32s2SocOptions {
  /** Flash size in bytes (a multiple of 64 KB; 4 MB by default). */
  flashSize?: number;
  /** The flash chip's size as its ID says (the board's module); default: the flash's own. */
  flashChipBytes?: number;
  /** The eFuse's factory MAC (S2_EFUSE_MAC by default). */
  mac?: readonly number[];
  /** Reference time to start at (a reset builds a fresh chip at the time the old one stopped). */
  time?: number;
  /** BT154: the module has PSRAM (true by default — a PSRAM build finds it). */
  psram?: boolean;
}

/** The MMU table: 384 entries — the flash page (13:0), INVALID (14), ACCESS_FLASH (15), ACCESS_SPIRAM (16). */
class MmuTable implements Peripheral {
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
    this.table[i] = value & 0x1ffff;
    this.onChange?.(i);
  }
}

/** EXTMEM (0x0000) and the MMU table (0x1000) as the bus's one 8 KB block. */
class CacheRegs implements Peripheral {
  private readonly extmem: Peripheral;
  private readonly mmu: Peripheral;

  constructor(extmem: Peripheral, mmu: Peripheral) {
    this.extmem = extmem;
    this.mmu = mmu;
  }

  read32(offset: number): number {
    return offset < 0x1000 ? this.extmem.read32(offset) : this.mmu.read32(offset - 0x1000);
  }

  write32(offset: number, value: number): void {
    if (offset < 0x1000) this.extmem.write32(offset, value);
    else this.mmu.write32(offset - 0x1000, value);
  }
}

export class Esp32s2Soc implements SocContext, Esp32SocContext, S2BusParts {
  readonly refHz = REF_HZ;
  readonly memory = new S2Memory();
  readonly problems = new ProblemLog();
  readonly events = new EventTable();
  readonly matrix = new S2InterruptMatrix();
  /** The ESP32 models' name for the matrix. */
  readonly interrupts = this.matrix;
  readonly periph = new S2PeripheralMap(this.problems);
  readonly mmu = new MmuTable();
  readonly extmem = new S2Extmem();
  readonly cacheRegs: Peripheral;
  readonly flash: FlashChip;
  readonly system: S2SystemRegs;
  readonly rtc: S2RtcCntl;
  readonly efuse: S2Efuse;
  readonly systimer: S2Systimer;
  readonly timg: readonly [Timg, Timg];
  /** BT152: the chip sleeps (RTC_CNTL STATE0.SLEEP_EN) until a wake source; `deep`: the wake is a reset. Null awake. */
  sleeping: { deep: boolean } | null = null;
  private wakeSlot = -1;
  private pinCause = 0;
  readonly uarts: readonly [Uart, Uart];
  readonly spi1: SpiMem;
  /** BT154: the PSRAM chip on SPI1's CS1 (the bytes allocated on first use). */
  readonly psram = new QuadPsram(S2_PSRAM_BYTES, S2_PSRAM_ID);
  /** BT149: GPIO, the matrix, IO_MUX and what each pad is doing (the S3's model over the S2's pads). */
  readonly iomux: S3IoMux;
  readonly gpio: S3Gpio;
  readonly pads: S3Pads;
  /** The volts the bench puts on a pad (the ADC reads them). */
  padVolts: (gpio: number) => number = () => 0;
  readonly ledc: Ledc;
  readonly rmt: Esp32Rmt;
  readonly i2c: readonly [Esp32I2c, Esp32I2c];
  readonly spi2: Esp32Spi;
  /** SENS: the RTC-controlled SAR ADC (13-bit codes). */
  readonly sens: S3Sens;
  /** BT155: the touch sensor (TOUCH1–14 on GPIO1–14), in RTC_CNTL, SENS and RTC_IO. */
  readonly touch: S2Touch;
  /** The USB-OTG controller (the S3's model; the S2 has no other USB, so its PHY is always the OTG's). */
  readonly usbOtg: S3UsbOtg;
  readonly usbWrap = new RegisterFile(S2_USB_WRAP_BASE, registerDefault);
  readonly bus: S2Bus;
  readonly core: XtensaCore;
  /** For the ESP32 models (the timer groups' watchdogs). */
  readonly resets: ResetSink;

  /** Slice-boundary time, in reference cycles. */
  time: number;
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  /** WAITI skip-ahead (on by default). */
  skipIdle = true;
  /** Reference time the slices skipped by skip-ahead covered (reports). */
  skipped = 0;
  /** The core halted (a fault). */
  stopped = false;
  stopReason = '';
  /** A system reset was asked for (RTC_CNTL SW_SYS_RST, a watchdog): the run stops; the Mcu reboots the chip. */
  resetRequested = false;
  resetReason: number = S2_RESET_REASON.SW_SYS;

  private cost = REF_HZ / XTAL_HZ;
  private coreTime: number;
  private running = false;
  private runCycles = 0;
  private sliceEnd = 0;
  private breakpointStop = false;

  constructor(options: Esp32s2SocOptions = {}) {
    this.time = options.time ?? 0;
    this.coreTime = this.time;
    this.flash = new FlashChip(options.flashSize ?? DEFAULT_FLASH_SIZE);
    this.flash.chipBytes = options.flashChipBytes ?? null;
    this.cacheRegs = new CacheRegs(this.extmem, this.mmu);
    this.system = new S2SystemRegs(this.matrix, this.memory.rtcFast);
    this.system.onClock = (cpu, apb) => this.setClock(cpu, apb);
    this.rtc = new S2RtcCntl(() => this.now());
    this.rtc.onSoftwareReset = () => this.requestReset(S2_RESET_REASON.SW_SYS);
    // BT152: sleep — the timer and pins wake the chip (RTC pads take the RTC's pulls: below).
    this.rtc.onSleep = (deep) => this.enterSleep(deep);
    this.wakeSlot = this.events.add(() => this.wake(S2_WAKE.TIMER));
    this.efuse = options.mac === undefined ? new S2Efuse() : new S2Efuse(options.mac);
    this.systimer = new S2Systimer(this);
    this.resets = {
      systemReset: (reason) => this.requestReset(reason),
      proCpuReset: () => this.requestReset(S2_RESET_REASON.SW_CPU),
      appCpuReset: () => {},
      stallChanged: () => {},
    };
    // BT152: calibration measures the S2's slow clocks (RTC_MUX = RC_SLOW 90 kHz, RC_FAST/256; no 32 kHz crystal).
    const slowClocks = [SLOW_CLOCK_HZ[0], SLOW_CLOCK_HZ[2], 0];
    this.timg = [new Timg(this, 0, { level: S2_SRC.TG0_T0, edge: S2_SRC.TG0_T0_EDGE, slowClocks }), new Timg(this, 1, { level: S2_SRC.TG1_T0, edge: S2_SRC.TG1_T0_EDGE, slowClocks })];
    this.uarts = [new Uart(this, 0, S2_SRC.UART0, UART_BASES_S2[0], S2_UART_FIELDS), new Uart(this, 1, S2_SRC.UART1, UART_BASES_S2[1], S2_UART_FIELDS)];
    this.spi1 = new SpiMem(SPI1_BASE_S2, this.flash, registerDefault);
    this.spi1.cs1 = this.psram;
    this.psram.present = options.psram !== false;
    this.iomux = new S3IoMux(this.problems, S2_GPIO_CHIP);
    this.iomux.psramCs = () => this.psram.identified; // BT154
    this.gpio = new S3Gpio(this, this.iomux);
    this.pads = new S3Pads(this.gpio, this.iomux);
    this.pads.signalLevel = (signal) => this.signalLevel(signal);
    this.gpio.onConfig = () => this.pads.update();
    this.pads.rtcPad = (g) => this.rtc.rtcPad(g);
    this.pads.analogPad = (g) => (this.touch as S2Touch | undefined)?.uses(g) === true; // BT155 (built below)
    this.rtc.onRtcPads = () => this.pads.update();
    this.gpio.onInputs = () => {
      if (this.sleeping !== null) this.checkPinWake();
    };
    this.iomux.onConfig = () => {
      this.gpio.inputsChanged();
      this.pads.update();
    };
    this.ledc = new Ledc(this, S2_LEDC_CHANNELS);
    this.ledc.onOutput = () => this.pads.update();
    this.rmt = new Esp32Rmt(this, S2_RMT_LAYOUT);
    this.rmt.onOutput = () => this.pads.update();
    this.i2c = [
      new Esp32I2c(this, 0, { base: S2_I2C_BASES[0], source: S2_SRC.I2C0, defaults: registerDefault, last: 0xa4 }),
      new Esp32I2c(this, 1, { base: S2_I2C_BASES[1], source: S2_SRC.I2C1, defaults: registerDefault, last: 0xa4 }),
    ];
    this.spi2 = new Esp32Spi(this, 2, S2_SPI2_LAYOUT, registerDefault);
    this.spi2.onCs = () => this.pads.update();
    this.sens = new S3Sens(this, { base: S2_SENS_BASE, defaults: registerDefault, bits: 13 });
    this.sens.sample = (adc, channel, attenuation) => this.adcSample(adc, channel, attenuation);
    // BT155: the touch sensor — its controls in RTC_CNTL and RTC_IO, its data in SENS (0x5C–0x118),
    // its interrupts through RTC_CNTL's to the matrix (ETS_RTC_CORE_INTR_SOURCE).
    this.touch = new S2Touch(this, { read32: (offset) => this.rtc.read32(offset), slowHz: () => this.rtc.slowHz(), raise: (bits) => this.rtc.raise(bits) }, REF_HZ);
    const sens = this.sens;
    const touch = this.touch;
    this.rtc.sens = {
      read32: (offset) => (touch.owns(offset) ? touch.read32(offset) : sens.read32(offset)),
      write32: (offset, value) => (touch.owns(offset) ? touch.write32(offset, value) : sens.write32(offset, value)),
    };
    this.rtc.onWrite = (offset, value, before) => {
      touch.rtcWritten(offset, value, before);
      if (offset === TOUCH_SCAN_CTRL && ((value ^ before) >>> 10) !== 0) this.pads.update(); // a touch channel's pad reads as analog
    };
    this.rtc.onInterrupt = (on) => this.matrix.setSource(S2_SRC.RTC_CORE, on);
    this.usbOtg = new S3UsbOtg(this, S2_SRC.USB, () => 3 << 19, () => this.usbWrap.regs[0]);

    const periph = this.periph;
    periph.register(SYSTEM_BASE, this.system);
    periph.register(INTERRUPT_BASE, this.matrix);
    periph.register(RTC_CNTL_BASE, this.rtc);
    periph.register(EFUSE_BASE, this.efuse);
    periph.register(SYSTIMER_BASE, this.systimer);
    TIMG_BASES_S2.forEach((base, i) => periph.register(base, this.timg[i]));
    UART_BASES_S2.forEach((base, i) => periph.register(base, this.uarts[i]));
    periph.register(SPI1_BASE_S2, this.spi1);
    periph.register(SPI0_BASE_S2, new SpiMem(SPI0_BASE_S2, null, registerDefault));
    periph.register(ANA_I2C_BASE_S2, new S3AnalogI2c());
    // BT151: the S2's RNG is WDEV_RND_REG 0x6003_5110 (wdev_reg.h), not the S3's +0x7C.
    periph.register(S2_WDEV_BASE, new ApbCtrl(0x2545f491, S2_WDEV_BASE, 0x110, registerDefault));
    // Memory protection (esp_memprot_set_prot) isn't enforced; its registers read back. APB_CTRL's
    // radio and memory power controls are storage, as on the S3.
    periph.register(S2_GPIO_BASE, this.gpio);
    periph.register(S2_IO_MUX_BASE, this.iomux);
    periph.register(S2_LEDC_BASE, this.ledc);
    periph.register(S2_RMT_BASE, this.rmt);
    S2_I2C_BASES.forEach((base, i) => periph.register(base, this.i2c[i]));
    periph.register(S2_SPI2_BASE, this.spi2);
    // APB_SARADC (the digital controller) is storage, as on the S3: IDF 4.4's one-shot reads go
    // through SENS, and only the arbiter's settings are written here.
    periph.register(S2_APB_SARADC_BASE, new RegisterFile(S2_APB_SARADC_BASE, registerDefault));
    periph.register(S2_USB_WRAP_BASE, this.usbWrap);
    for (let i = 0; i < S3_USB_OTG_BLOCKS; i++) periph.register(S2_USB_OTG_BASE + i * 0x1000, this.usbOtg.blocks[i]);
    periph.register(S2_SENSITIVE_BASE, new RegisterFile(S2_SENSITIVE_BASE, registerDefault));
    periph.register(S2_APB_CTRL_BASE, new RegisterFile(S2_APB_CTRL_BASE, registerDefault));

    this.bus = new S2Bus(this);
    this.core = new XtensaCore(this.bus, { prid: 0xcdcd, s2: true, icachePages: 0x800, icacheFlashFrom: 0x40080000 });
    this.bus.core = this.core;
    this.matrix.cores = [this.core];
    this.mmu.onChange = (entry) => this.bus.mmuChanged(entry);
    this.extmem.onInvalidate = () => this.bus.invalidateFlash();
    this.flash.onWrite = (offset, length) => this.core.icache.invalidateFlash(offset, offset + length);
  }

  // ── The models' contexts and the bus's parts ─────────────────────────────────────────────

  regDefault(address: number): number {
    return registerDefault(address);
  }

  now(): number {
    if (this.events.firing >= 0) return this.events.firing;
    if (!this.running) return this.time;
    return this.coreTime + (this.core.cycles - this.runCycles) * this.cost;
  }

  pc(): number {
    return this.core.pc;
  }

  /** A clock register changed (the ESP32 models call this; SYSTEM's `onClock` does the work). */
  clockChanged(): void {}

  /** A model scheduled an event inside the running slice: the slice ends there. */
  hurry(time: number): void {
    if (!this.running || time >= this.sliceEnd) return;
    this.sliceEnd = Math.max(Math.ceil(time), this.time + 1);
    this.core.requestStop();
  }

  flashBytes(): Uint8Array {
    return this.flash.data;
  }

  mmuPage(entry: number): number {
    const value = this.mmu.table[entry];
    if ((value & MMU_INVALID) !== 0 || (value & MMU_ACCESS_FLASH) === 0) return -1;
    return (value & 0x3fff) * 0x10000;
  }

  mmuPsram(entry: number): boolean {
    const value = this.mmu.table[entry];
    return (value & MMU_INVALID) === 0 && (value & MMU_ACCESS_SPIRAM) !== 0;
  }

  /** BT154: the PSRAM offset an MMU entry with ACCESS_SPIRAM maps, within the chip's size; else −1. */
  mmuPsramPage(entry: number): number {
    const value = this.mmu.table[entry];
    if ((value & MMU_INVALID) !== 0 || (value & MMU_ACCESS_SPIRAM) === 0) return -1;
    const page = (value & 0x3fff) * 0x10000;
    return page + 0x10000 <= this.psram.size ? page : -1;
  }

  psramBytes(): Uint8Array {
    return this.psram.data;
  }

  psramWords(): Uint32Array {
    return this.psram.dataWords;
  }

  peripheralTurn(): void {
    const now = this.now();
    if (this.events.next <= now) this.events.fireDue(now);
  }

  /** A store hit SRAM holding predecoded code: the core drops the instruction page. */
  codeWritten(offset: number): void {
    const page = offset & ~0xfff;
    this.bus.code[page >>> 12] = 0;
    const address = IRAM_BASE + page;
    if (address < IRAM_END) this.core.icache.invalidatePage(address);
  }

  /** Replaces the flash contents (a board's kept flash, a bigger image). */
  setFlash(data: Uint8Array): void {
    this.flash.data = data;
    this.bus.invalidateFlash();
  }

  /**
   * BT149: a SENS conversion — ADC1 channels 0–9 are GPIO1–10, ADC2's GPIO11–20 (the S3's map); an
   * idealized linear 13-bit code over the attenuation's range (S2_ADC_FULL_SCALE). The pad reads as
   * analog from then on while its input and pulls are off.
   */
  private adcSample(adc: number, channel: number, attenuation: number): number {
    if (channel > 9) return 0;
    const g = (adc === 1 ? 1 : 11) + channel;
    if (this.pads.adcUsed[g] === 0) {
      this.pads.adcUsed[g] = 1;
      this.pads.update();
    }
    const code = Math.round((this.padVolts(g) / S2_ADC_FULL_SCALE[attenuation & 3]) * 8191);
    return code < 0 ? 0 : code > 8191 ? 8191 : code;
  }

  /** BT149: the level of a peripheral output signal on its way to the pads. */
  private signalLevel(signal: number): number {
    if (signal >= S2_SIG.LEDC0 && signal < S2_SIG.LEDC0 + S2_LEDC_CHANNELS) return this.ledc.level[signal - S2_SIG.LEDC0];
    if (signal >= S2_SIG.RMT0 && signal < S2_SIG.RMT0 + S2_RMT_LAYOUT.channels) return this.rmt.level[signal - S2_SIG.RMT0];
    if (signal === S2_SIG.FSPICS0) return this.spi2.cs0;
    return signal === S2_SIG.U0TXD || signal === S2_SIG.U1TXD || signal === S2_SIG.I2C0_SCL || signal === S2_SIG.I2C0_SDA || signal === S2_SIG.I2C1_SCL || signal === S2_SIG.I2C1_SDA ? 1 : 0;
  }

  // ── Sleep (BT152) ───────────────────────────────────────────────────────────────────────

  /** What wakes the sleeping chip — the timer's wake time (reference cycles, −1: none) and the pin wakes in words — or null awake. */
  sleepWakes(): { at: number; pins: string[] } | null {
    const sleep = this.sleeping;
    if (sleep === null) return null;
    const pins = this.rtc.wakePins();
    if (!sleep.deep && (this.rtc.wakeSources() & S2_WAKE.GPIO) !== 0) for (const pin of this.gpio.wakePins()) if (!pins.includes(pin)) pins.push(pin);
    return { at: this.rtc.wakeTime(), pins };
  }

  /**
   * STATE0.SLEEP_EN: the core stops until a wake. Deep: the digital domain is off, its timers with
   * it. Light: APB is gated, the timer groups wait.
   */
  private enterSleep(deep: boolean): void {
    if (this.sleeping !== null) return;
    this.sleeping = { deep };
    if (this.running) this.core.requestStop();
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
    if (!sleep.deep && (this.rtc.wakeSources() & S2_WAKE.GPIO) !== 0 && this.gpio.wakeLevel()) cause |= S2_WAKE.GPIO;
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
    if (sleep.deep) this.requestReset(S2_RESET_REASON.DEEPSLEEP);
    else for (const timg of this.timg) timg.ungate();
  }

  private requestReset(reason: number): void {
    if (this.resetRequested) return;
    this.resetRequested = true;
    this.resetReason = reason;
    if (this.running) this.core.requestStop();
  }

  private setClock(cpu: number, apb: number): void {
    if (this.running) {
      // Settle the core's time at the old clock.
      this.coreTime += (this.core.cycles - this.runCycles) * this.cost;
      this.runCycles = this.core.cycles;
    }
    this.cpuHz = cpu;
    this.apbHz = apb;
    this.cost = REF_HZ / cpu;
    this.systimer.clockChanged();
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /** Runs the core until `target` reference cycles (or a halt, a breakpoint, a reset request). */
  runUntil(target: number): RunResult {
    const end = Math.ceil(target);
    this.breakpointStop = false;
    while (this.time < end && !this.stopped && !this.resetRequested) {
      this.events.fireDue(this.time);
      if (this.stopped || this.resetRequested) break;
      if (this.skipIdle && (this.core.asleep || this.sleeping !== null) && this.skipAhead(end)) {
        if (this.breakpointStop) return this.stopAtBreakpoint(end);
        continue;
      }
      this.sliceEnd = Math.min(this.time + S2_SLICE, end, this.events.next);
      this.runCore();
      if (this.breakpointStop) return this.stopAtBreakpoint(end);
      this.time = Math.max(this.time, this.sliceEnd, Math.min(this.coreTime, end));
    }
    if (!this.stopped && !this.resetRequested) this.events.fireDue(this.time);
    return this.stopped ? { reason: 'fault', detail: this.stopReason } : { reason: 'target' };
  }

  /** Runs for `seconds` of simulated time. */
  runFor(seconds: number): RunResult {
    return this.runUntil(this.time + seconds * REF_HZ);
  }

  /** One instruction (the debugger's step), then the rest of the SoC catches up to it. */
  stepCore(): RunResult {
    if (this.stopped) return { reason: 'fault', detail: this.stopReason };
    const core = this.core;
    core.resumePc = core.pc;
    this.running = true;
    this.runCycles = core.cycles;
    core.run(1);
    this.coreTime += (core.cycles - this.runCycles) * this.cost;
    this.running = false;
    if (core.halt !== HALT.RUNNING) {
      this.stopped = true;
      this.stopReason = `CPU at 0x${core.pc.toString(16)}: ${core.haltReason}`;
      return { reason: 'fault', detail: this.stopReason };
    }
    const to = Math.floor(this.coreTime);
    if (to > this.time) {
      const caughtUp = this.runUntil(to);
      if (caughtUp.reason === 'fault') return caughtUp;
    }
    this.breakpointStop = false;
    return { reason: 'target' };
  }

  /** The core asleep (WAITI, or the chip sleeping): jumps over the whole slices before the next thing that can wake it. */
  private skipAhead(end: number): boolean {
    let limit = Math.min(end, this.events.next);
    if (this.sleeping === null) {
      const wake = this.coreTime + (this.core.nextTimer - this.core.cycles) * this.cost;
      if (wake < limit) limit = wake;
    }
    const slices = Math.floor((limit - this.time) / S2_SLICE);
    if (slices < 1) return false;
    const to = this.time + slices * S2_SLICE;
    this.sliceEnd = to;
    this.runCore();
    this.skipped += to - this.time;
    this.time = to;
    return true;
  }

  /** Runs the core up to the slice's end (which `hurry` may pull in), a breakpoint or a stop; a sleeping chip's core waits it out (BT152). */
  private runCore(): void {
    const core = this.core;
    while (this.coreTime < this.sliceEnd && core.halt === HALT.RUNNING && !this.resetRequested && !this.stopped && this.sleeping === null) {
      const n = Math.max(1, Math.ceil((this.sliceEnd - this.coreTime) / this.cost));
      this.running = true;
      this.runCycles = core.cycles;
      core.run(n);
      this.coreTime += (core.cycles - this.runCycles) * this.cost;
      this.running = false;
      if (core.atBreakpoint) {
        this.breakpointStop = true;
        break;
      }
    }
    if (this.sleeping !== null && this.coreTime < this.sliceEnd) this.coreTime = this.sliceEnd;
    if (core.halt !== HALT.RUNNING && !this.stopped) {
      this.stopped = true;
      this.stopReason = `CPU at 0x${core.pc.toString(16)}: ${core.haltReason}`;
    }
  }

  /** The bench sees the SoC at the stopped core's time. */
  private stopAtBreakpoint(end: number): RunResult {
    this.breakpointStop = false;
    this.time = Math.max(this.time, Math.min(this.coreTime, end));
    return { reason: 'breakpoint' };
  }
}
