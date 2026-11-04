/**
 * The ESP32-C3 as a bench `Mcu` (BT94): an Esp32c3Soc behind the frozen contract, built like the
 * ESP32's adapter (@benchtop/esp32's esp32.ts).
 *
 * - `clockHz` is the SoC's 160 MHz reference clock; `cycles` its time since the last reset.
 * - Pins: `GPIO0`–`GPIO21`. Mode and level come from the pad resolver (soc/gpio.ts); listeners
 *   fire when either changes. Inputs apply 3.3 V CMOS thresholds with hysteresis (VIH 0.75·VDD,
 *   VIL 0.25·VDD — the C3 datasheet's DC characteristics, as the ESP32's); a floating net keeps
 *   the pad at 0, and the firmware reading such a pad — one it configured itself — is reported
 *   once per pin (`esp32c3-floating-input`). No DAC.
 * - `load` takes `esp32-bin` images (app + optional partition table) and boots them directly
 *   (boot/direct-boot.ts); `reset` builds a fresh SoC and boots again.
 * - Serial: `uart(0)` is what the serial monitor shows — UART0 (TX GPIO21 / RX GPIO20 through the
 *   DevKitM-1's USB-UART bridge) and the USB-Serial-JTAG port (a `CDCOnBoot=cdc` build's
 *   `Serial`) together; bytes typed go to the USB port once the firmware has sent on it, else to
 *   UART0 (Arduino's core touches the USB port's registers in every build, so only output tells).
 *   `uart(1)` is UART1. `i2c(0)` is the I2C controller, `spi(2)` SPI2 (FSPI). A bus's `pins()`
 *   follow the firmware's routing, and before that the Arduino defaults (SDA 8, SCL 9; SCK 4,
 *   MOSI 6, MISO 5).
 * - The ROM: `createEsp32c3Mcu({ rom })` checks the bytes against rom-manifest's SHA-256 and parses
 *   them once per byte array. Without a valid ROM the Mcu still exists, reports
 *   `esp32c3-rom-missing` with the command that fetches it, and `runUntil` returns `halted`.
 * - `debug()` is Esp32c3Debug; breakpoints outlive resets. Outside the contract: `onProblem` hears
 *   the SoC's Problems one by one; `esp32c3McuFactory` folds them into one bench Problem per code.
 * - WiFi (BT107), as the ESP32's (@benchtop/esp32's esp32.ts): `useSymbols(table)` gives the Mcu
 *   the firmware's symbols, and the WiFi driver's API is answered by @benchtop/esp32's WifiDriver
 *   through @benchtop/riscv's RiscvHle (on every SoC a reset builds); `wifi` is that driver.
 *   `joinWifi(radio)` is what the station sees. A firmware that drives the radio's registers
 *   without symbols gets `esp32c3-wifi-no-symbols` (once per boot). HLE_RESUME_PC and
 *   WIFI_TASK_PC sit in the ROM's unused gap between .text and .rodata.
 * - `mac` (BT107): the eFuse's factory MAC; the factory gives each board one from its part id
 *   (Espressif's 34:85:18 and three bytes of a hash), so two boards on one LAN differ.
 */

import type { BoardSpec, Debuggable, FirmwareImage, I2cController, I2cDevice, Level, Mcu, McuDebug, McuPin, McuSleep, NetState, NonVolatile, NvMemory, Sleeper, PinMode, Problem, RunResult, SpiController, SpiDevice, SymbolTable, UartPort, WifiRadio, WifiStation } from '@benchtop/core';
import { describeFirmwareFormat, macFromName, SectorMemory } from '@benchtop/core';
import { STA_LIST_C3, sha256Hex, WifiDriver } from '@benchtop/esp32';
import { RiscvHle } from '@benchtop/riscv';
import { directBoot } from './boot/direct-boot.ts';
import { type C3Rom, parseC3Rom } from './boot/rom.ts';
import { Esp32c3Debug } from './debug.ts';
import { C3_ROM_CACHE_DIR, C3_ROM_ELF_NAME, C3_ROM_ELF_SHA256 } from './rom-manifest.ts';
import { REF_HZ } from './soc/context.ts';
import { PAD_MODE, PIN_COUNT, SIG } from './soc/gpio.ts';
import type { SocProblem } from '@benchtop/esp32';
import { RESET_REASON } from './soc/rtc-cntl.ts';
import { Esp32c3Soc } from './soc/soc.ts';
import type { SpiAttachment } from './soc/spi.ts';

export const CODE_C3_ROM_MISSING = 'esp32c3-rom-missing';
export const CODE_C3_FLOATING_INPUT = 'esp32c3-floating-input';
export const CODE_C3_WIFI_NO_SYMBOLS = 'esp32c3-wifi-no-symbols';
export const CODE_C3_WIFI_UNSUPPORTED = 'esp32c3-wifi-unsupported';
/** BT118: a system reset the firmware asked for (ESP.restart(), a panic's restart). */
export const CODE_C3_REBOOT = 'esp32c3-reboot';

/** BT118: reboots less than a second apart that end the run (a crash loop), as the ESP32's guard. */
const RAPID_REBOOT_LIMIT = 5;
/** BT107: where HLE generators run (hle.ts's resumePc) — in the ROM's gap after .text (ends 0x40059590), before .rodata (0x40059C00 on IBUS). */
export const C3_HLE_RESUME_PC = 0x40059a00;
/** BT107: the simulated WiFi driver's task entry, in the same gap. */
export const C3_WIFI_TASK_PC = 0x40059a08;
export const C3_ROM_MISSING_MESSAGE = `ESP32-C3 ROM not installed — run npm run fetch:esp32-rom (it unpacks ${C3_ROM_ELF_NAME} into ${C3_ROM_CACHE_DIR} from the ESP32 ROM's tarball, with no new download when that is cached).`;
/** Input thresholds at VDD 3.3 V (datasheet: VIH ≥ 0.75·VDD, VIL ≤ 0.25·VDD). */
export const C3_VIH = 2.475;
export const C3_VIL = 0.825;

const MODES: readonly PinMode[] = ['input', 'input-pullup', 'input-pulldown', 'output', 'analog', 'peripheral'];

export interface Esp32c3McuOptions {
  /** `esp32c3_rev3_rom.elf` (rom-manifest). Missing or wrong: the Mcu reports it and won't run. */
  rom?: Uint8Array;
  /** BT107: the eFuse's factory MAC (34:85:18:00:C3:01 by default). */
  mac?: readonly number[];
}

const parsedRoms = new WeakMap<Uint8Array, C3Rom | string>();

function romFrom(bytes: Uint8Array | undefined): C3Rom | string {
  if (bytes === undefined || bytes.length === 0) return C3_ROM_MISSING_MESSAGE;
  const cached = parsedRoms.get(bytes);
  if (cached !== undefined) return cached;
  let result: C3Rom | string;
  const hash = sha256Hex(bytes);
  if (hash !== C3_ROM_ELF_SHA256) result = `The ESP32-C3 ROM isn't the pinned ${C3_ROM_ELF_NAME} (SHA-256 ${hash}); run npm run fetch:esp32-rom.`;
  else {
    try {
      result = parseC3Rom(bytes);
    } catch (error) {
      result = `The ESP32-C3 ROM ELF can't be read: ${(error as Error).message}`;
    }
  }
  parsedRoms.set(bytes, result);
  return result;
}

class C3Pin implements McuPin {
  readonly id: string;
  readonly gpio: number;
  inputLevel = 0;
  floating = true;
  volts = 0;
  readonly listeners: (() => void)[] = [];
  private readonly mcu: Esp32c3Mcu;

  constructor(mcu: Esp32c3Mcu, gpio: number) {
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
    else if (state.volts >= C3_VIH) level = 1;
    else if (state.volts <= C3_VIL) level = 0;
    this.inputLevel = level;
    this.mcu.soc.gpio.setPadFloating(this.gpio, this.floating);
    this.mcu.soc.gpio.setPadInput(this.gpio, level);
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

class C3I2c implements I2cController {
  devices: I2cDevice[] = [];
  private readonly mcu: Esp32c3Mcu;

  constructor(mcu: Esp32c3Mcu) {
    this.mcu = mcu;
  }

  pins(): { sda: string; scl: string } {
    const pads = this.mcu.soc.pads;
    const sda = pads.pinOfOutSignal(SIG.I2C_SDA);
    const scl = pads.pinOfOutSignal(SIG.I2C_SCL);
    if (sda < 0 || scl < 0) return { sda: 'GPIO8', scl: 'GPIO9' };
    return { sda: `GPIO${sda}`, scl: `GPIO${scl}` };
  }

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices = [...this.devices, device];
    this.mcu.soc.i2c.devices = this.devices;
  }

  detach(device: I2cDevice): void {
    this.devices = this.devices.filter((d) => d !== device);
    this.mcu.soc.i2c.devices = this.devices;
  }
}

class C3Spi implements SpiController {
  devices: SpiAttachment[] = [];
  private readonly mcu: Esp32c3Mcu;

  constructor(mcu: Esp32c3Mcu) {
    this.mcu = mcu;
  }

  pins(): { sck: string; mosi: string; miso: string } {
    const pads = this.mcu.soc.pads;
    const sck = pads.pinOfOutSignal(SIG.FSPICLK);
    const mosi = pads.pinOfOutSignal(SIG.FSPID);
    const miso = pads.pinOfInSignal(SIG.FSPIQ);
    if (sck < 0 || mosi < 0 || miso < 0) return { sck: 'GPIO4', mosi: 'GPIO6', miso: 'GPIO5' };
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

/** UnTXD_OUT_IDX = UnRXD_IN_IDX per UART (gpio_sig_map.h: U0 6, U1 9). */
const UART_SIGNALS = [SIG.U0TXD, SIG.U1TXD] as const;

class C3Uart implements UartPort {
  readonly listeners: ((byte: number) => void)[] = [];
  private readonly mcu: Esp32c3Mcu;
  private readonly index: number;

  constructor(mcu: Esp32c3Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  /** Bytes for the firmware: port 0 feeds the USB-Serial-JTAG port once the firmware has sent on it, else UART0. */
  receive(bytes: Uint8Array): void {
    const soc = this.mcu.soc;
    if (this.index === 0 && this.mcu.usbTalked) soc.usb.receive(bytes);
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

export class Esp32c3Mcu implements Mcu, Debuggable, WifiStation, NonVolatile, Sleeper {
  readonly kind = 'esp32c3' as const;
  readonly clockHz = REF_HZ;
  readonly pins: ReadonlyMap<string, McuPin>;
  /** The SoC of the current boot (a reset replaces it). */
  soc: Esp32c3Soc;
  private problemListener: ((problem: SocProblem) => void) | null = null;
  private readonly rom: C3Rom | string;
  private image: { app: Uint8Array; partitions?: Uint8Array } | null = null;
  private bootError = '';
  private readonly byGpio: C3Pin[] = [];
  private readonly uarts = [new C3Uart(this, 0), new C3Uart(this, 1)];
  private readonly i2c0 = new C3I2c(this);
  private readonly spi2 = new C3Spi(this);
  private readonly seenMode = new Uint8Array(PIN_COUNT);
  private readonly seenLevel = new Uint8Array(PIN_COUNT);
  private readonly floatingReported = new Uint8Array(PIN_COUNT);
  /** The firmware sent on the USB-Serial-JTAG port since the last reset (typed bytes go there then). */
  usbTalked = false;
  /** Breakpoints, handed to every SoC built (they outlive resets). */
  private readonly breakpoints = new Set<number>();
  private debugView: Esp32c3Debug | null = null;
  /** BT107: the firmware's symbols by exact name (useSymbols; functions win over objects). */
  private symbols: Map<string, number> | null = null;
  /** BT107: the simulated WiFi driver of the current SoC, when the firmware's symbols name its API. */
  wifi: WifiDriver | null = null;
  /** BT107: the bench's radio (joinWifi). */
  private radio: WifiRadio | null = null;
  private readonly mac: readonly number[] | undefined;
  private radioReported = false;
  /** BT118: the board's SPI flash, kept across resets (null until an image boots), and the view hosts get of it. */
  private flashBytes: Uint8Array | null = null;
  private nvm: SectorMemory | null = null;
  /** A load waits for its upload (the next boot also erases the OTA data). */
  private uploading = false;
  /** BT118: when the chip last booted (reference cycles), reboots in a row less than 1 s apart, and why a reboot loop ended the run. */
  private bootTime = 0;
  private rapidReboots = 0;
  private rebootLoop = '';

  constructor(options: Esp32c3McuOptions = {}) {
    this.rom = romFrom(options.rom);
    this.mac = options.mac;
    const pins = new Map<string, McuPin>();
    for (let g = 0; g < PIN_COUNT; g++) {
      const pin = new C3Pin(this, g);
      this.byGpio.push(pin);
      pins.set(pin.id, pin);
    }
    this.pins = pins;
    this.soc = this.buildSoc();
    for (let g = 0; g < PIN_COUNT; g++) {
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
    if (typeof this.rom === 'string') this.report('error', CODE_C3_ROM_MISSING, 0, this.rom);
  }

  get cycles(): number {
    return this.soc.now();
  }

  /** The ROM problem, or '' when the ROM is installed and valid. */
  get romProblem(): string {
    return typeof this.rom === 'string' ? this.rom : '';
  }

  load(image: FirmwareImage): void {
    if (image.format !== 'esp32-bin') throw new Error(`The ESP32-C3 runs app images (.bin); got ${describeFirmwareFormat(image.format)}.`);
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
    this.boot(RESET_REASON.POWERON);
  }

  /** Boots the image on the SoC just built, for `reason` (RTC_CNTL's reset cause), and syncs the pads. */
  private boot(reason: number): void {
    this.bootError = '';
    this.radioReported = false;
    this.bootTime = this.soc.time;
    if (typeof this.rom === 'string') {
      this.report('error', CODE_C3_ROM_MISSING, 0, this.rom);
    } else if (this.image !== null) {
      // BT118: the chip's flash is the board's, kept across resets; the boot writes the image into it as an upload would.
      if (this.flashBytes !== null && this.flashBytes.length === this.soc.flash.data.length) this.soc.flash.data = this.flashBytes;
      const boot = directBoot(this.soc, { app: this.image.app, ...(this.image.partitions === undefined ? {} : { partitions: this.image.partitions }), rom: this.rom, flash: { flash: this.soc.flash.data, upload: this.uploading }, reason });
      if (!boot.ok) this.bootError = `The ESP32-C3 image can't boot: ${boot.error}`;
      else this.keepFlash(this.soc.flash.data, boot.layout.written);
      this.uploading = false;
    }
    this.floatingReported.fill(0);
    for (const pin of this.byGpio) {
      this.soc.gpio.setPadFloating(pin.gpio, pin.floating);
      this.soc.gpio.setPadInput(pin.gpio, pin.inputLevel);
    }
    for (let g = 0; g < PIN_COUNT; g++) this.pinChanged(g);
  }

  runUntil(targetCycles: number): RunResult {
    if (typeof this.rom === 'string') return { reason: 'halted', detail: this.rom };
    if (this.image === null) return { reason: 'halted', detail: 'No firmware loaded.' };
    if (this.bootError !== '') return { reason: 'halted', detail: this.bootError };
    if (this.rebootLoop !== '') return { reason: 'halted', detail: this.rebootLoop };
    for (;;) {
      this.soc.runUntil(targetCycles);
      if (!this.soc.resetRequested) break;
      if (!this.softwareReset(this.soc.resetReason)) return { reason: 'halted', detail: this.rebootLoop };
    }
    if (this.soc.stopped) return { reason: 'halted', detail: this.soc.stopReason };
    if (this.soc.atBreakpoint) return { reason: 'breakpoint' };
    return { reason: 'target' };
  }

  uart(index: number): UartPort | undefined {
    return this.uarts[index];
  }

  i2c(index: number): I2cController | undefined {
    return index === 0 ? this.i2c0 : undefined;
  }

  /** SPI2 (FSPI) is `spi(2)`; SPI0/1 run the flash. */
  spi(index: number): SpiController | undefined {
    return index === 2 ? this.spi2 : undefined;
  }

  debug(): McuDebug {
    this.debugView ??= new Esp32c3Debug(() => this.soc);
    return this.debugView;
  }

  /**
   * BT107: the firmware's symbols, for what the simulator answers by function name (WiFi). Hosts
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

  /**
   * BT118: the board's flash as hosts keep it (NVS, file systems, the EEPROM library's partition):
   * every reset keeps it, a load writes only the partition table and the app. Null until an image boots.
   */
  nonVolatile(): NvMemory | null {
    return this.nvm;
  }

  /** BT123: the chip's light or deep sleep and what wakes it (the timer in ns from now), or null awake. */
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

  /** BT107: the bench's access points and LANs (null: none); an association moves to a rebuilt bench's. */
  joinWifi(radio: WifiRadio | null): void {
    this.radio = radio;
    this.wifi?.radioChanged();
  }

  /**
   * BT118: the system reset the firmware asked for (OPTIONS0.SW_SYS_RST — ESP.restart(), a panic's
   * restart), or (BT122) a deep sleep's wake (DEEPSLEEP): a fresh chip at the same time — the
   * bench's clock runs on — keeping what survives a system reset (flash, RTC fast memory, the RTC
   * timer and the RTC domain's registers: the wake cause, the sleep timer), booting for `reason`.
   * False when software resets less than a second apart end the run (a deep sleep's wakes don't count).
   */
  private softwareReset(reason: number): boolean {
    const old = this.soc;
    const now = old.time;
    const deepSleep = reason === RESET_REASON.DEEPSLEEP;
    this.rapidReboots = deepSleep ? 0 : now - this.bootTime < REF_HZ ? this.rapidReboots + 1 : 0;
    if (this.rapidReboots >= RAPID_REBOOT_LIMIT) {
      this.rebootLoop = `reboot loop: ${RAPID_REBOOT_LIMIT} software resets in a row less than 1 s apart`;
      return false;
    }
    const rtcFast = old.memory.rtcFast;
    const powerOn = old.rtc.powerOn;
    const rtcDomain = old.rtc.rtcDomain();
    this.soc = this.buildSoc(now);
    this.soc.rtc.powerOn = powerOn;
    this.soc.rtc.keepRtcDomain(rtcDomain);
    this.soc.memory.rtcFast.set(rtcFast);
    this.boot(reason);
    this.report('info', CODE_C3_REBOOT, 0, `reboot after ${deepSleep ? "a deep sleep's wake (DEEPSLEEP)" : 'a software reset (SW_SYS)'} at ${(now / REF_HZ).toFixed(6)} s`);
    return true;
  }

  private buildSoc(time?: number): Esp32c3Soc {
    const soc = new Esp32c3Soc({ ...(this.mac === undefined ? {} : { mac: this.mac }), ...(time === undefined ? {} : { time }) });
    soc.breakpoints = this.breakpoints;
    soc.uarts[0].onTx = (byte) => this.uarts[0].emit(byte);
    soc.uarts[1].onTx = (byte) => this.uarts[1].emit(byte);
    this.usbTalked = false;
    soc.usb.onTx = (byte) => {
      this.usbTalked = true;
      this.uarts[0].emit(byte);
    };
    soc.problems.listener = (problem) => this.problemListener?.(problem);
    soc.pads.onPin = (g) => this.pinChanged(g);
    soc.gpio.onFloatingRead = (g) => this.floatingRead(g);
    soc.padVolts = (g) => this.byGpio[g]?.volts ?? 0;
    // The bus devices outlive the SoC; during construction the lists are empty.
    if (this.i2c0 !== undefined) {
      soc.i2c.devices = this.i2c0.devices;
      soc.spi2.devices = this.spi2.devices;
    }
    soc.periph.onRadio = (address, pc) => this.radioAccess(address, pc);
    this.installHle(soc);
    return soc;
  }

  /** BT107: answers the firmware's WiFi calls on `soc` when its symbols name them. */
  private installHle(soc: Esp32c3Soc): void {
    // BT116: the old driver's association and soft-AP end with it (a reset: the firmware starts again).
    this.wifi?.dispose();
    this.wifi = null;
    soc.core.setHle(null);
    const table = this.symbols;
    if (table === null) return;
    const hle = new RiscvHle(C3_HLE_RESUME_PC);
    const wifi = new WifiDriver({ now: () => soc.now(), refHz: REF_HZ, mac: soc.rtc.mac, radio: () => this.radio, taskPc: C3_WIFI_TASK_PC, staListSize: STA_LIST_C3.SIZE });
    const { installed, missing } = wifi.install(hle, (name) => table.get(name));
    if (missing.length > 0) this.report('error', CODE_C3_WIFI_UNSUPPORTED, 0, `This firmware uses WiFi, but it lacks ${missing.join(', ')}, which the simulated WiFi driver calls: WiFi won't run.`);
    if (!installed) return;
    soc.core.setHle(hle);
    this.wifi = wifi;
  }

  /** BT107: the firmware touched the radio's registers (the closed WiFi driver is running). */
  private radioAccess(address: number, pc: number): void {
    if (this.radioReported) return;
    this.radioReported = true;
    const where = `0x${address.toString(16).toUpperCase()} at PC 0x${pc.toString(16).toUpperCase()}`;
    if (this.wifi === null) {
      this.report('error', CODE_C3_WIFI_NO_SYMBOLS, address, `This firmware drives the WiFi radio (${where}). The simulator answers WiFi at the driver's API by function name, so it needs the firmware's symbols: run the sketch's .elf beside its .bin (arduino-cli builds both; Compile & Run passes it), or a .syms.tsv as the fixtures keep.`);
    } else {
      this.report('warning', CODE_C3_WIFI_UNSUPPORTED, address, `The firmware touched the radio's registers (${where}) outside the WiFi API the simulator answers: that part of it doesn't run.`);
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
    if (this.soc.pads.mode[g] !== PAD_MODE.INPUT || this.soc.iomux.configured[g] === 0) return;
    this.floatingReported[g] = 1;
    this.report('warning', CODE_C3_FLOATING_INPUT, g, `GPIO${g} is read while floating (nothing drives it and it has no pull): it reads 0. Add a pull-up/pull-down or drive it.`);
  }

  private report(severity: SocProblem['severity'], code: string, address: number, message: string): void {
    this.problemListener?.({ severity, code, message, address });
  }
}

/** The bench's MCU factory for ESP32-C3 boards (`BenchEnv.createMcu`), as esp32McuFactory is for the ESP32. */
export function esp32c3McuFactory(rom: Uint8Array | undefined): (board: BoardSpec, partId: string, report?: (problem: Problem) => void) => Mcu | undefined {
  return (board, partId, report) => {
    if (board.mcu !== 'esp32c3') return undefined;
    const mac = macFromName(partId, [0x34, 0x85, 0x18]);
    const mcu = createEsp32c3Mcu(rom === undefined ? { mac } : { rom, mac });
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

export function createEsp32c3Mcu(options: Esp32c3McuOptions = {}): Esp32c3Mcu {
  return new Esp32c3Mcu(options);
}
