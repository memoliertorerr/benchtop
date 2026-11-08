/**
 * The ESP32-S3 as a bench `Mcu` (BT126): an Esp32s3Soc behind the frozen contract, built like the
 * ESP32-C3's adapter (@benchtop/esp32c3's esp32c3-mcu.ts), whose peripheral models the S3 shares.
 *
 * - `clockHz` is the SoC's 240 MHz reference clock; `cycles` its time since the last reset.
 * - Pins: `GPIO0`–`GPIO21` and `GPIO33`–`GPIO48` — not GPIO26–32, the module's SPI flash (the SoC
 *   refuses them: gpio.ts). Mode and level come from the pad resolver; listeners fire when either
 *   changes. Inputs apply 3.3 V CMOS thresholds with hysteresis (VIH 0.75·VDD, VIL 0.25·VDD — the
 *   S3 datasheet's DC characteristics, as the ESP32's and the C3's); a floating net keeps the pad
 *   at 0, and the firmware reading such a pad — one it configured itself — is reported once per
 *   pin (`esp32s3-floating-input`). The pin's volts feed the ADC (GPIO1–20). No DAC.
 * - `load` takes `esp32-bin` images (app + optional partition table) and boots them directly
 *   (boot/direct-boot.ts); `reset` builds a fresh SoC and boots again. The board's flash outlives
 *   resets (`nonVolatile()`), as on the ESP32 and the C3.
 * - Serial: `uart(0)` is what the serial monitor shows — UART0 (TX GPIO43 / RX GPIO44, the
 *   DevKitC-1's USB-UART port), the USB-Serial-JTAG port (its USB port: a `CDCOnBoot=cdc`
 *   build's `Serial`) and, BT134, the USB-OTG controller's CDC-ACM port the bench's host opened
 *   (a "USB-OTG (TinyUSB)" build's `Serial`) together; typed bytes go to the OTG port while it is
 *   open, else to the USB-Serial-JTAG port once the firmware has sent on it, else to UART0. What
 *   the host can't drive (a HID, MSC or MIDI interface) is named once (`esp32s3-usb-device`, info). `uart(1)`, `uart(2)` are UART1 and UART2. `i2c(0)`, `i2c(1)` the two I2C
 *   controllers, `spi(2)` SPI2 (FSPI). A bus's `pins()` follow the firmware's routing, and before
 *   that the Arduino variant's defaults (SDA 8, SCL 9; SCK 12, MOSI 11, MISO 13).
 * - The ROM: `createEsp32s3Mcu({ rom })` checks the bytes against rom-manifest's SHA-256 and parses
 *   them once per byte array. Without a valid ROM the Mcu still exists, reports
 *   `esp32s3-rom-missing` with the command that fetches it, and `runUntil` returns `halted`.
 * - A system reset the firmware asks for (ESP.restart(), a panic, a timer group's watchdog) boots a
 *   fresh chip at the same time, keeping the flash, RTC memory and the RTC timer; five less than a
 *   second apart end the run (a reboot loop), as on the C3.
 * - `debug()` is Esp32s3Debug (the APP_CPU unless the PRO_CPU stopped last); breakpoints outlive
 *   resets. Outside the contract: `onProblem` hears the SoC's Problems one by one;
 *   `esp32s3McuFactory` folds them into one bench Problem per code.
 * - WiFi (BT127), as the ESP32's (@benchtop/esp32's esp32.ts): `useSymbols(table)` gives the Mcu
 *   the firmware's symbols, and the WiFi driver's API is answered by @benchtop/esp32's WifiDriver
 *   through its Xtensa Hle on both cores (on every SoC a reset builds); `wifi` is that driver.
 *   `joinWifi(radio)` is what the station sees. A firmware that drives the radio's registers
 *   without symbols gets `esp32s3-wifi-no-symbols` (once per boot). The HLE's resume and return
 *   ops and the WiFi task's entry sit in the S3 ROM's unused gap between .text and .rodata.
 * - `mac`: the eFuse's factory MAC; the factory gives each board one from its part id
 *   (Espressif's 34:85:18 and three bytes of a hash), so two boards on one LAN differ.
 * - Sleep (BT128): deep and light sleep run as IDF drives RTC_CNTL (soc.ts); a deep sleep's wake
 *   boots a fresh chip like a system reset, keeping the RTC domain, and doesn't count toward the
 *   reboot-loop guard. `sleepState()` (the bench's `Sleeper`) says how the chip sleeps and what wakes it.
 * - PSRAM (BT130) is the build's: soc.ts's `psram` answers the quad or octal driver.
 */

import type { BoardSpec, PartProps, Debuggable, FirmwareImage, I2cController, I2cDevice, Level, Mcu, McuDebug, McuPin, McuSleep, NetState, NonVolatile, NvMemory, PinMode, Problem, RunResult, Sleeper, SpiController, SpiDevice, SymbolTable, UartPort, WifiRadio, WifiStation } from '@benchtop/core';
import { describeFirmwareFormat, macFromName, SectorMemory } from '@benchtop/core';
import { Hle, sha256Hex, type SocProblem, WifiDriver } from '@benchtop/esp32';
import type { SpiAttachment } from '@benchtop/esp32c3';
import { directBootS3 } from './boot/direct-boot.ts';
import { parseS3Rom, type S3Rom } from './boot/rom.ts';
import { Esp32s3Debug } from './debug.ts';
import { S3_ROM_CACHE_DIR, S3_ROM_ELF_NAME, S3_ROM_ELF_SHA256 } from './rom-manifest.ts';
import { isS3FlashPad, isS3Pad, S3_PAD_MODE, S3_PADS, S3_SIG } from './soc/gpio.ts';
import { REF_HZ, S3_RESET_REASON } from './soc/rtc-cntl.ts';
import { Esp32s3Soc } from './soc/soc.ts';

export const CODE_S3_ROM_MISSING = 'esp32s3-rom-missing';
export const CODE_S3_FLOATING_INPUT = 'esp32s3-floating-input';
/** A system reset the firmware asked for (ESP.restart(), a panic's restart) or a watchdog's. */
export const CODE_S3_REBOOT = 'esp32s3-reboot';
export const CODE_S3_WIFI_NO_SYMBOLS = 'esp32s3-wifi-no-symbols';
/** BT134: the bench's USB host on the OTG port — an interface it doesn't drive, a failed enumeration. */
export const CODE_S3_USB_DEVICE = 'esp32s3-usb-device';
export const CODE_S3_WIFI_UNSUPPORTED = 'esp32s3-wifi-unsupported';

/**
 * BT127: where the WiFi HLE's generators run (Hle's resumePc), where their RETW is (returnPc), and
 * the simulated WiFi driver's task entry — in the S3 ROM's unused gap after .text (which ends at
 * 0x400577A8), before .rodata (0x40058C00 on IBUS): zeros the firmware never executes, in the
 * 1 GB region RETW needs.
 */
export const S3_HLE_RESUME_PC = 0x40058a00;
export const S3_HLE_RETURN_PC = 0x40058a04;
export const S3_WIFI_TASK_PC = 0x40058a08;

/** Reboots less than a second apart that end the run (a crash loop), as the ESP32's and C3's guard. */
const RAPID_REBOOT_LIMIT = 5;
export const S3_ROM_MISSING_MESSAGE = `ESP32-S3 ROM not installed — run npm run fetch:esp32-rom (it unpacks ${S3_ROM_ELF_NAME} into ${S3_ROM_CACHE_DIR} from the ESP32 ROM's tarball, with no new download when that is cached).`;
/** Input thresholds at VDD 3.3 V (datasheet: VIH ≥ 0.75·VDD, VIL ≤ 0.25·VDD). */
export const S3_VIH = 2.475;
export const S3_VIL = 0.825;

/** The GPIOs the Mcu has as pins: every pad but the module's flash (GPIO26–32). */
export const S3_MCU_GPIOS: readonly number[] = Object.freeze(Array.from({ length: S3_PADS }, (_, g) => g).filter((g) => isS3Pad(g) && !isS3FlashPad(g)));

const MODES: readonly PinMode[] = ['input', 'input-pullup', 'input-pulldown', 'output', 'analog', 'peripheral'];

export interface Esp32s3McuOptions {
  /** `esp32s3_rev0_rom.elf` (rom-manifest). Missing or wrong: the Mcu reports it and won't run. */
  rom?: Uint8Array;
  /** The eFuse's factory MAC (34:85:18:00:53:01 by default). */
  mac?: readonly number[];
  /** BT135: the module's PSRAM (soc.ts's Esp32s3SocOptions.psram; 'auto' by default). */
  psram?: 'auto' | 'none' | 'quad' | 'octal';
}

/**
 * BT135: the modules an ESP32-S3 board can carry (its `module` prop): `auto` — the build decides
 * (BT130) —, `N8` (no PSRAM), `N8R2` (2 MB quad), `N8R8` (8 MB octal), and the PSRAM each has.
 */
export const S3_MODULES = { auto: 'auto', N8: 'none', N8R2: 'quad', N8R8: 'octal' } as const;
export const CODE_S3_MODULE = 'esp32s3-module';

const parsedRoms = new WeakMap<Uint8Array, S3Rom | string>();

function romFrom(bytes: Uint8Array | undefined): S3Rom | string {
  if (bytes === undefined || bytes.length === 0) return S3_ROM_MISSING_MESSAGE;
  const cached = parsedRoms.get(bytes);
  if (cached !== undefined) return cached;
  let result: S3Rom | string;
  const hash = sha256Hex(bytes);
  if (hash !== S3_ROM_ELF_SHA256) result = `The ESP32-S3 ROM isn't the pinned ${S3_ROM_ELF_NAME} (SHA-256 ${hash}); run npm run fetch:esp32-rom.`;
  else {
    try {
      result = parseS3Rom(bytes);
    } catch (error) {
      result = `The ESP32-S3 ROM ELF can't be read: ${(error as Error).message}`;
    }
  }
  parsedRoms.set(bytes, result);
  return result;
}

class S3Pin implements McuPin {
  readonly id: string;
  readonly gpio: number;
  inputLevel = 0;
  floating = true;
  volts = 0;
  readonly listeners: (() => void)[] = [];
  private readonly mcu: Esp32s3Mcu;

  constructor(mcu: Esp32s3Mcu, gpio: number) {
    this.mcu = mcu;
    this.gpio = gpio;
    this.id = `GPIO${gpio}`;
  }

  mode(): PinMode {
    return MODES[this.mcu.soc.pads.mode[this.gpio]];
  }

  outputLevel(): Level {
    return this.mcu.soc.pads.level[this.gpio] === 1 ? 1 : 0;
  }

  outputVolts(): number | undefined {
    return undefined;
  }

  setInput(state: NetState): void {
    this.volts = state.volts;
    this.floating = state.level === null;
    let level = this.inputLevel;
    if (state.level === null) level = 0;
    else if (state.volts >= S3_VIH) level = 1;
    else if (state.volts <= S3_VIL) level = 0;
    this.inputLevel = level;
    this.mcu.soc.gpio.setPadFloating(this.gpio, this.floating);
    this.mcu.soc.gpio.setPadInput(this.gpio, level);
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

/** I2CEXTn's SDA/SCL signals and the variant's default pins (Wire uses controller 0). */
const I2C_SIGNALS = [
  { sda: S3_SIG.I2C0_SDA, scl: S3_SIG.I2C0_SCL },
  { sda: S3_SIG.I2C1_SDA, scl: S3_SIG.I2C1_SCL },
] as const;

class S3I2c implements I2cController {
  devices: I2cDevice[] = [];
  private readonly mcu: Esp32s3Mcu;
  private readonly index: number;

  constructor(mcu: Esp32s3Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  pins(): { sda: string; scl: string } {
    const pads = this.mcu.soc.pads;
    const sda = pads.pinOfOutSignal(I2C_SIGNALS[this.index].sda);
    const scl = pads.pinOfOutSignal(I2C_SIGNALS[this.index].scl);
    if (sda < 0 || scl < 0) return { sda: 'GPIO8', scl: 'GPIO9' };
    return { sda: `GPIO${sda}`, scl: `GPIO${scl}` };
  }

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices = [...this.devices, device];
    this.mcu.soc.i2c[this.index].devices = this.devices;
  }

  detach(device: I2cDevice): void {
    this.devices = this.devices.filter((d) => d !== device);
    this.mcu.soc.i2c[this.index].devices = this.devices;
  }
}

class S3Spi implements SpiController {
  devices: SpiAttachment[] = [];
  private readonly mcu: Esp32s3Mcu;

  constructor(mcu: Esp32s3Mcu) {
    this.mcu = mcu;
  }

  pins(): { sck: string; mosi: string; miso: string } {
    const pads = this.mcu.soc.pads;
    const sck = pads.pinOfOutSignal(S3_SIG.FSPICLK);
    const mosi = pads.pinOfOutSignal(S3_SIG.FSPID);
    const miso = pads.pinOfInSignal(S3_SIG.FSPIQ);
    if (sck < 0 || mosi < 0 || miso < 0) return { sck: 'GPIO12', mosi: 'GPIO11', miso: 'GPIO13' };
    return { sck: `GPIO${sck}`, mosi: `GPIO${mosi}`, miso: `GPIO${miso}` };
  }

  attach(device: SpiDevice, selected: () => boolean): void {
    if (!this.devices.some((a) => a.device === device)) this.devices = [...this.devices, { device, selected }];
    this.mcu.soc.spi2.devices = this.devices;
  }

  detach(device: SpiDevice): void {
    this.devices = this.devices.filter((a) => a.device !== device);
    this.mcu.soc.spi2.devices = this.devices;
  }
}

/** UnTXD_OUT_IDX = UnRXD_IN_IDX per UART (gpio_sig_map.h: U0 12, U1 15, U2 18). */
const UART_SIGNALS = [S3_SIG.U0TXD, S3_SIG.U1TXD, S3_SIG.U2TXD] as const;

class S3Uart implements UartPort {
  readonly listeners: ((byte: number) => void)[] = [];
  private readonly mcu: Esp32s3Mcu;
  private readonly index: number;

  constructor(mcu: Esp32s3Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  /** Bytes for the firmware: port 0 feeds the open USB-OTG CDC port, else the USB-Serial-JTAG port once the firmware has sent on it, else UART0. */
  receive(bytes: Uint8Array): void {
    const soc = this.mcu.soc;
    if (this.index === 0 && soc.usbOtg.host.ports.length > 0) soc.usbOtg.send(bytes);
    else if (this.index === 0 && this.mcu.usbTalked) soc.usb.receive(bytes);
    else soc.uarts[this.index].receive(bytes);
  }

  pins(): { tx?: string; rx?: string } {
    const signal = UART_SIGNALS[this.index];
    const pads = this.mcu.soc.pads;
    const tx = pads.pinOfOutSignal(signal);
    const rx = pads.pinOfInSignal(signal);
    const pins: { tx?: string; rx?: string } = {};
    if (tx >= 0) pins.tx = `GPIO${tx}`;
    if (rx >= 0) pins.rx = `GPIO${rx}`;
    return pins;
  }

  baud(): number {
    return this.mcu.soc.uarts[this.index].baud();
  }

  emit(byte: number): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](byte);
  }
}

export class Esp32s3Mcu implements Mcu, Debuggable, NonVolatile, WifiStation, Sleeper {
  readonly kind = 'esp32s3' as const;
  readonly clockHz = REF_HZ;
  readonly pins: ReadonlyMap<string, McuPin>;
  /** The SoC of the current boot (a reset replaces it). */
  soc: Esp32s3Soc;
  private problemListener: ((problem: SocProblem) => void) | null = null;
  private readonly rom: S3Rom | string;
  private image: { app: Uint8Array; partitions?: Uint8Array } | null = null;
  private bootError = '';
  /** Pins by GPIO (undefined for the flash pads and the missing 22–25). */
  private readonly byGpio: (S3Pin | undefined)[] = [];
  private readonly uarts = [new S3Uart(this, 0), new S3Uart(this, 1), new S3Uart(this, 2)];
  private readonly i2cs = [new S3I2c(this, 0), new S3I2c(this, 1)];
  private readonly spi2 = new S3Spi(this);
  private readonly seenMode = new Uint8Array(S3_PADS);
  private readonly seenLevel = new Uint8Array(S3_PADS);
  private readonly floatingReported = new Uint8Array(S3_PADS);
  /** The firmware sent on the USB-Serial-JTAG port since the last reset (typed bytes go there then). */
  usbTalked = false;
  /** Breakpoints, handed to both cores of every SoC built (they outlive resets). */
  private readonly breakpoints = new Set<number>();
  private debugView: Esp32s3Debug | null = null;
  /** BT127: the firmware's symbols by exact name (useSymbols; functions win over objects). */
  private symbols: Map<string, number> | null = null;
  /** BT127: the simulated WiFi driver of the current SoC, when the firmware's symbols name its API. */
  wifi: WifiDriver | null = null;
  /** BT127: the bench's radio (joinWifi). */
  private radio: WifiRadio | null = null;
  private radioReported = false;
  private readonly mac: readonly number[] | undefined;
  /** BT135: the module's PSRAM. */
  private readonly psram: 'auto' | 'none' | 'quad' | 'octal';
  /** The board's SPI flash, kept across resets (null until an image boots), and the view hosts get of it. */
  private flashBytes: Uint8Array | null = null;
  private nvm: SectorMemory | null = null;
  /** A load waits for its upload (the next boot also erases the OTA data). */
  private uploading = false;
  /** When the chip last booted (reference cycles), reboots in a row less than 1 s apart, and why a reboot loop ended the run. */
  private bootTime = 0;
  private rapidReboots = 0;
  private rebootLoop = '';

  constructor(options: Esp32s3McuOptions = {}) {
    this.rom = romFrom(options.rom);
    this.mac = options.mac;
    this.psram = options.psram ?? 'auto';
    const pins = new Map<string, McuPin>();
    for (let g = 0; g < S3_PADS; g++) this.byGpio.push(undefined);
    for (const g of S3_MCU_GPIOS) {
      const pin = new S3Pin(this, g);
      this.byGpio[g] = pin;
      pins.set(pin.id, pin);
    }
    this.pins = pins;
    this.soc = this.buildSoc();
    for (let g = 0; g < S3_PADS; g++) {
      this.seenMode[g] = this.soc.pads.mode[g];
      this.seenLevel[g] = this.soc.pads.level[g];
    }
  }

  /** The SoC's Problems and the adapter's own; setting it reports a missing or bad ROM at once. */
  get onProblem(): ((problem: SocProblem) => void) | null {
    return this.problemListener;
  }

  set onProblem(listener: ((problem: SocProblem) => void) | null) {
    this.problemListener = listener;
    if (typeof this.rom === 'string') this.report('error', CODE_S3_ROM_MISSING, 0, this.rom);
  }

  get cycles(): number {
    return this.soc.now();
  }

  /** The ROM problem, or '' when the ROM is installed and valid. */
  get romProblem(): string {
    return typeof this.rom === 'string' ? this.rom : '';
  }

  load(image: FirmwareImage): void {
    if (image.format !== 'esp32-bin') throw new Error(`The ESP32-S3 runs app images (.bin); got ${describeFirmwareFormat(image.format)}.`);
    const previous = this.image;
    this.image = image.partitions === undefined ? { app: image.app } : { app: image.app, partitions: image.partitions };
    this.uploading = true;
    this.reset();
    if (this.bootError !== '') {
      const error = this.bootError;
      this.image = previous;
      this.reset();
      throw new Error(error);
    }
  }

  reset(): void {
    this.rebootLoop = '';
    this.rapidReboots = 0;
    this.soc = this.buildSoc();
    this.boot(S3_RESET_REASON.POWERON);
  }

  /** Boots the image on the SoC just built, for `reason` (RTC_CNTL's reset cause), and syncs the pads. */
  private boot(reason: number): void {
    this.bootError = '';
    this.radioReported = false;
    this.bootTime = this.soc.time;
    if (typeof this.rom === 'string') {
      this.report('error', CODE_S3_ROM_MISSING, 0, this.rom);
    } else if (this.image !== null) {
      // The chip's flash is the board's, kept across resets; the boot writes the image into it as an upload would.
      if (this.flashBytes !== null && this.flashBytes.length === this.soc.flash.data.length) this.soc.flash.data = this.flashBytes;
      const boot = directBootS3(this.soc, { app: this.image.app, ...(this.image.partitions === undefined ? {} : { partitions: this.image.partitions }), rom: this.rom, flash: { flash: this.soc.flash.data, upload: this.uploading }, reason });
      if (!boot.ok) this.bootError = `The ESP32-S3 image can't boot: ${boot.error}`;
      else this.keepFlash(this.soc.flash.data, boot.layout.written);
      this.uploading = false;
    }
    this.floatingReported.fill(0);
    for (const pin of this.byGpio) {
      if (pin === undefined) continue;
      this.soc.gpio.setPadFloating(pin.gpio, pin.floating);
      this.soc.gpio.setPadInput(pin.gpio, pin.inputLevel);
    }
    for (const g of S3_MCU_GPIOS) this.pinChanged(g);
  }

  runUntil(targetCycles: number): RunResult {
    if (typeof this.rom === 'string') return { reason: 'halted', detail: this.rom };
    if (this.image === null) return { reason: 'halted', detail: 'No firmware loaded.' };
    if (this.bootError !== '') return { reason: 'halted', detail: this.bootError };
    if (this.rebootLoop !== '') return { reason: 'halted', detail: this.rebootLoop };
    let result: RunResult;
    for (;;) {
      result = this.soc.runUntil(targetCycles);
      if (!this.soc.resetRequested) break;
      if (!this.softwareReset(this.soc.resetReason)) return { reason: 'halted', detail: this.rebootLoop };
    }
    if (this.soc.stopped) return { reason: 'halted', detail: this.soc.stopReason };
    if (result.reason === 'breakpoint') return { reason: 'breakpoint' };
    return { reason: 'target' };
  }

  uart(index: number): UartPort | undefined {
    return this.uarts[index];
  }

  i2c(index: number): I2cController | undefined {
    return this.i2cs[index];
  }

  /** SPI2 (FSPI) is `spi(2)`; SPI0/1 run the flash, SPI3 isn't modeled. */
  spi(index: number): SpiController | undefined {
    return index === 2 ? this.spi2 : undefined;
  }

  debug(): McuDebug {
    this.debugView ??= new Esp32s3Debug(() => this.soc, this.breakpoints);
    return this.debugView;
  }

  /**
   * BT127: the firmware's symbols, for what the simulator answers by function name (WiFi). Hosts
   * call it after `load` and before running; it applies to the current SoC and every later one.
   */
  useSymbols(table: SymbolTable | null): void {
    if (table === null) this.symbols = null;
    else {
      const byName = new Map<string, number>();
      for (let i = 0; i < table.size; i++) {
        const entry = table.entry(i);
        if (!byName.has(entry.name) || entry.kind === 'func') byName.set(entry.name, entry.address);
      }
      this.symbols = byName;
    }
    this.installHle(this.soc);
  }

  /** BT127: the bench's access points and LANs (null: none); an association moves to a rebuilt bench's. */
  joinWifi(radio: WifiRadio | null): void {
    this.radio = radio;
    this.wifi?.radioChanged();
  }

  /**
   * The board's flash as hosts keep it (NVS, file systems, the EEPROM library's partition): every
   * reset keeps it, a load writes only the partition table and the app. Null until an image boots.
   */
  nonVolatile(): NvMemory | null {
    return this.nvm;
  }

  /** BT128: the chip's light or deep sleep and what wakes it (the timer in ns from now), or null awake. */
  sleepState(): McuSleep | null {
    const wakes = this.soc.sleepWakes();
    if (wakes === null || this.soc.sleeping === null) return null;
    return { deep: this.soc.sleeping.deep, wakeIn: wakes.at < 0 ? null : (Math.max(0, wakes.at - this.soc.now()) / REF_HZ) * 1e9, pins: wakes.pins };
  }

  /** The flash a boot ran from becomes the board's; what it wrote is the program's. */
  private keepFlash(flash: Uint8Array, written: readonly { offset: number; length: number }[]): void {
    if (this.flashBytes !== flash || this.nvm === null) {
      this.flashBytes = flash;
      this.nvm = new SectorMemory('flash', 0x1000, () => this.flashBytes ?? new Uint8Array(0));
    }
    for (const range of written) this.nvm.markProgram(range.offset, range.length);
  }

  /**
   * A system reset (OPTIONS0.SW_SYS_RST — ESP.restart(), a panic's restart — or a timer group's
   * watchdog): a fresh chip at the same time — the bench's clock runs on — keeping what survives
   * one (flash, RTC fast and slow memory, the RTC timer), booting for `reason`. False when resets
   * less than a second apart end the run.
   */
  private softwareReset(reason: number): boolean {
    const old = this.soc;
    const now = old.time;
    const deepSleep = reason === S3_RESET_REASON.DEEPSLEEP;
    this.rapidReboots = deepSleep ? 0 : now - this.bootTime < REF_HZ ? this.rapidReboots + 1 : 0;
    if (this.rapidReboots >= RAPID_REBOOT_LIMIT) {
      this.rebootLoop = `reboot loop: ${RAPID_REBOOT_LIMIT} system resets in a row less than 1 s apart`;
      return false;
    }
    const rtcDomain = old.rtc.rtcDomain();
    this.soc = this.buildSoc(now);
    this.soc.rtc.origin = old.rtc.origin;
    this.soc.rtc.keepRtcDomain(rtcDomain);
    this.soc.memory.rtcFast.set(old.memory.rtcFast);
    this.soc.memory.rtcSlow.set(old.memory.rtcSlow);
    this.boot(reason);
    const why = deepSleep ? "a deep sleep's wake (DEEPSLEEP)" : reason === S3_RESET_REASON.TG0WDT_SYS || reason === S3_RESET_REASON.TG1WDT_SYS ? `a timer group's watchdog (TG${reason === S3_RESET_REASON.TG0WDT_SYS ? 0 : 1}WDT_SYS)` : 'a software reset (SW_SYS)';
    this.report('info', CODE_S3_REBOOT, 0, `reboot after ${why} at ${(now / REF_HZ).toFixed(6)} s`);
    return true;
  }

  private buildSoc(time?: number): Esp32s3Soc {
    const soc = new Esp32s3Soc({ ...(this.mac === undefined ? {} : { mac: this.mac }), ...(time === undefined ? {} : { time }), psram: this.psram });
    soc.cores[0].breakpoints = this.breakpoints;
    soc.cores[1].breakpoints = this.breakpoints;
    soc.uarts[0].onTx = (byte) => this.uarts[0].emit(byte);
    soc.uarts[1].onTx = (byte) => this.uarts[1].emit(byte);
    soc.uarts[2].onTx = (byte) => this.uarts[2].emit(byte);
    this.usbTalked = false;
    soc.usb.onTx = (byte) => {
      this.usbTalked = true;
      this.uarts[0].emit(byte);
    };
    soc.usbOtg.host.onData = (bytes, length) => {
      for (let i = 0; i < length; i++) this.uarts[0].emit(bytes[i]);
    };
    soc.usbOtg.host.onNote = (message) => this.report('info', CODE_S3_USB_DEVICE, 0, message);
    soc.problems.listener = (problem) => this.problemListener?.(problem);
    soc.pads.onPin = (g) => this.pinChanged(g);
    soc.gpio.onFloatingRead = (g) => this.floatingRead(g);
    soc.padVolts = (g) => this.byGpio[g]?.volts ?? 0;
    // The bus devices outlive the SoC; during construction the lists are empty.
    if (this.i2cs !== undefined) {
      soc.i2c[0].devices = this.i2cs[0].devices;
      soc.i2c[1].devices = this.i2cs[1].devices;
      soc.spi2.devices = this.spi2.devices;
    }
    soc.periph.onRadio = (address, pc) => this.radioAccess(address, pc);
    this.installHle(soc);
    return soc;
  }

  /** BT127: answers the firmware's WiFi calls on `soc` (both cores) when its symbols name them. */
  private installHle(soc: Esp32s3Soc): void {
    // The old driver's association and soft-AP end with it (a reset: the firmware starts again).
    this.wifi?.dispose();
    this.wifi = null;
    soc.cores[0].setHle(null);
    soc.cores[1].setHle(null);
    const table = this.symbols;
    if (table === null || table === undefined) return;
    const hle = new Hle({ resumePc: S3_HLE_RESUME_PC, returnPc: S3_HLE_RETURN_PC });
    // The S3's WiFi structs are laid out as the ESP32's (wifi-layout), wifi_sta_list_t included: the driver's defaults.
    const wifi = new WifiDriver({ now: () => soc.now(), refHz: REF_HZ, mac: soc.efuse.mac, radio: () => this.radio, taskPc: S3_WIFI_TASK_PC });
    const { installed, missing } = wifi.install(hle, (name) => table.get(name));
    if (missing.length > 0) this.report('error', CODE_S3_WIFI_UNSUPPORTED, 0, `This firmware uses WiFi, but it lacks ${missing.join(', ')}, which the simulated WiFi driver calls: WiFi won't run.`);
    if (!installed) return;
    soc.cores[0].setHle(hle);
    soc.cores[1].setHle(hle);
    this.wifi = wifi;
  }

  /** BT127: the firmware touched the radio's registers (the closed WiFi driver is running). */
  private radioAccess(address: number, pc: number): void {
    if (this.radioReported) return;
    this.radioReported = true;
    const where = `0x${address.toString(16).toUpperCase()} at PC 0x${pc.toString(16).toUpperCase()}`;
    if (this.wifi === null) {
      this.report('error', CODE_S3_WIFI_NO_SYMBOLS, address, `This firmware drives the WiFi radio (${where}). The simulator answers WiFi at the driver's API by function name, so it needs the firmware's symbols: run the sketch's .elf beside its .bin (arduino-cli builds both; Compile & Run passes it), or a .syms.tsv as the fixtures keep.`);
    } else {
      this.report('warning', CODE_S3_WIFI_UNSUPPORTED, address, `The firmware touched the radio's registers (${where}) outside the WiFi API the simulator answers: that part of it doesn't run.`);
    }
  }

  private pinChanged(g: number): void {
    const pin = this.byGpio[g];
    if (pin === undefined) return;
    const mode = this.soc.pads.mode[g];
    const level = this.soc.pads.level[g];
    if (mode === this.seenMode[g] && level === this.seenLevel[g]) return;
    this.seenMode[g] = mode;
    this.seenLevel[g] = level;
    for (let i = 0; i < pin.listeners.length; i++) pin.listeners[i]();
  }

  /** The firmware read GPIO_IN while pad `g` was floating with its input on — a pad it configured itself. */
  private floatingRead(g: number): void {
    const pin = this.byGpio[g];
    if (pin === undefined || !pin.floating || this.floatingReported[g] !== 0) return;
    if (this.soc.pads.mode[g] !== S3_PAD_MODE.INPUT || this.soc.iomux.configured[g] === 0) return;
    this.floatingReported[g] = 1;
    this.report('warning', CODE_S3_FLOATING_INPUT, g, `GPIO${g} is read while floating (nothing drives it and it has no pull): it reads 0. Add a pull-up/pull-down or drive it.`);
  }

  private report(severity: SocProblem['severity'], code: string, address: number, message: string): void {
    this.problemListener?.({ severity, code, message, address });
  }
}

/** The bench's MCU factory for ESP32-S3 boards (`BenchEnv.createMcu`), as esp32c3McuFactory is for the C3. */
export function esp32s3McuFactory(rom: Uint8Array | undefined): (board: BoardSpec, partId: string, report?: (problem: Problem) => void, props?: PartProps) => Mcu | undefined {
  return (board, partId, report, props) => {
    if (board.mcu !== 'esp32s3') return undefined;
    const mac = macFromName(partId, [0x34, 0x85, 0x18]);
    const module = props?.module ?? 'auto';
    const psram = typeof module === 'string' && Object.hasOwn(S3_MODULES, module) ? S3_MODULES[module as keyof typeof S3_MODULES] : undefined;
    if (psram === undefined) report?.({ severity: 'warning', code: CODE_S3_MODULE, message: `Unknown ESP32-S3 module ${JSON.stringify(module)}: one of ${Object.keys(S3_MODULES).join(', ')}. Running as auto.`, parts: [partId] });
    const mcu = createEsp32s3Mcu(rom === undefined ? { mac, psram: psram ?? 'auto' } : { rom, mac, psram: psram ?? 'auto' });
    if (report !== undefined) {
      const seen = new Map<string, { messages: string[]; count: number }>();
      let soc = mcu.soc;
      mcu.onProblem = (problem) => {
        if (mcu.soc !== soc) {
          soc = mcu.soc;
          seen.clear();
        }
        let entry = seen.get(problem.code);
        if (entry === undefined) seen.set(problem.code, (entry = { messages: [], count: 0 }));
        entry.count++;
        if (entry.messages.length < 3 && !entry.messages.includes(problem.message)) entry.messages.push(problem.message);
        const more = entry.count - entry.messages.length;
        report({ severity: problem.severity, code: problem.code, message: entry.messages.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), parts: [partId] });
      };
    }
    return mcu;
  };
}

export function createEsp32s3Mcu(options: Esp32s3McuOptions = {}): Esp32s3Mcu {
  return new Esp32s3Mcu(options);
}
