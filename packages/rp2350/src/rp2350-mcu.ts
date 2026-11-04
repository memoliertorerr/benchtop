/**
 * The RP2350 `Mcu` (BT65), RISC-V side: the SoC (soc.ts) behind the bench contract.
 *
 * - Time: `cycles` count a 150 MHz reference clock (6.67 ns), whatever clk_sys runs at.
 * - Firmware: a UF2 for the RP2350's RISC-V cores (family 0xe48bff5a; picotool's lone
 *   ABSOLUTE-family block, the RP2350-E10 workaround, is skipped) or a RISC-V ELF (PT_LOAD segments
 *   at their physical addresses), into the 4 MB flash; flash keeps what the firmware programs
 *   across `reset()`. Arm images are refused (this SoC has only its Hazard3 cores), as are images
 *   with nothing in flash. A reset boots through the real bootrom (≈ 15 ms of simulated time).
 * - The bootrom: `createRp2350Mcu({ rom })` takes bootrom-combined.bin (rom-manifest.ts,
 *   `npm run fetch:rp2350-rom`). Without it the Mcu still exists, reports `rp2350-rom-missing`
 *   with the command that fetches it, and `runUntil` returns `halted`.
 * - Pins: GPIO0–29 (the Pico 2's RP2350A). Inputs pass a Schmitt trigger (high ≥ 2.0 V, low
 *   ≤ 0.8 V, datasheet §14.9) into the pad, which software sees while its input is enabled.
 * - UARTs: 0 is USB serial (BT66: rp2040js's CDC host on the RP2350's USB controller — the
 *   RP2040's bridge, bridges.ts), 1 and 2 are UART0 and UART1; `pins()` follows the GPIO function
 *   select, `baud()` the divisors and clk_peri.
 * - I2C 0/1 and SPI 0/1 (BT66): the bench's bus contracts through the same bridges as the RP2040.
 * - The ADC (BT66): GPIO26–29's voltages feed channels 0–3.
 * - MicroPython (BT67): a `{ format: 'micropython' }` sketch runs on the stock RPI_PICO2-RISCV
 *   UF2 (`micropython` option; without it the sketch reports `micropython-missing`), installed
 *   over USB serial through the raw REPL exactly as on the Pico (@benchtop/rp2040's
 *   MicroPythonInstaller); every reset starts from the interpreter's image with an empty
 *   filesystem and writes the sketch again.
 * - The Pico 2 W (BT113): `{ cyw43 }` attaches the CYW43439 as on the Pico W (@benchtop/rp2040's
 *   cyw43/, the same model behind its chip-neutral call view): `useSymbols` answers its driver's
 *   ll layer through @benchtop/riscv's RiscvHle (a fresh table each boot; generators resume at
 *   RP2350_HLE_RESUME_PC, Arm code in the bootrom the harts never execute), the pin `WL_GPIO0` is
 *   the chip's GPIO 0 (the LED), GP24 its host-wake; bring-up leaves GP23/24/25 as the real gSPI
 *   setup does, at the RP2350's IO_BANK0, PADS (isolation cleared) and SIO offsets. Without
 *   symbols, the firmware raising WL_REG_ON (GP23) reports `rp2350-cyw43-no-symbols` once.
 */

import type { Debuggable, FirmwareImage, I2cController, Level, Mcu, McuDebug, McuPin, NetState, NonVolatile, NvMemory, PinMode, Problem, RunResult, SpiController, SymbolTable, UartPort, WifiRadio, WifiStation } from '@benchtop/core';
import { RiscvHle } from '@benchtop/riscv';
import {
  CODE_MICROPYTHON_INSTALL,
  Cyw43,
  Cyw43Pin,
  PICO_W_MAC,
  CODE_MICROPYTHON_MISSING,
  I2cBridge,
  MICROPYTHON_MISSING_MESSAGE,
  MicroPythonInstaller,
  type MicroPythonSketch,
  SpiBridge,
  UsbSerialBridge,
} from '@benchtop/rp2040';
import { describeFirmwareFormat, parseElf32, parseUf2, SectorMemory, UF2_FAMILY } from '@benchtop/core';
import { FUNC_NULL, FUNC_UART, FUNC_UART_AUX, PAD_IE, PAD_ISO, PAD_PDE, PAD_PUE, type PinDrive } from './periph/gpio.ts';
import type { Uart } from './periph/uart.ts';
import { NoSocDebug, Rp2350Debug } from './debug.ts';
import { ROM_IMAGE, ROM_RELEASE } from './rom-manifest.ts';
import { FLASH_SIZE, REFERENCE_HZ, Rp2350Soc } from './soc.ts';

export const RP2350_CLOCK_HZ = REFERENCE_HZ;
export const CODE_ROM_MISSING = 'rp2350-rom-missing';
export const ROM_MISSING_MESSAGE = `RP2350 bootrom not installed — run npm run fetch:rp2350-rom (it downloads pico-bootrom-rp2350 ${ROM_RELEASE}, ≈ 110 KB, into .cache/rp2350-rom after you approve it).`;
const PIN_COUNT = 30;
const FLASH_BASE = 0x10000000;
const EM_RISCV = 243;
const VIH = 2.0;
const VIL = 0.8;

export const CODE_CYW43_NO_SYMBOLS = 'rp2350-cyw43-no-symbols';
export const CODE_CYW43_UNSUPPORTED = 'rp2350-cyw43-unsupported';
/**
 * BT113: where RISC-V HLE generators run and their calls out return — in the bootrom's Arm code
 * (0x7E00–0x7FFF lies past the RISC-V bootrom's .text, .romtable and .entry, which end at 0x7E00),
 * which the harts never execute.
 */
export const RP2350_HLE_RESUME_PC = 0x7ff0;
/** GP23 powers the CYW43 (WL_REG_ON), GP24 is its host-wake, GP25 its chip select. */
const WL_REG_ON = 23;
const WL_HOST_WAKE = 24;
const WL_CS = 25;

export interface Rp2350McuOptions {
  /** bootrom-combined.bin (32 KB). */
  rom?: Uint8Array;
  /** BT67: the stock MicroPython UF2 for the Pico 2's RISC-V cores (@benchtop/rp2040's MICROPYTHON_PICO2_RISCV). */
  micropython?: Uint8Array;
  onProblem?: (problem: Problem) => void;
  /** BT113: a Pico 2 W's RP2350, with the CYW43439 (its MAC: 28:CD:C1:00:00:01 by default). */
  cyw43?: { mac?: readonly number[] };
}

class Rp2350Pin implements McuPin {
  readonly id: string;
  readonly index: number;
  readonly listeners: (() => void)[] = [];
  private readonly mcu: Rp2350Mcu;
  private inputLevel = 0;
  private readonly drive: PinDrive = { kind: 0, level: 0 };
  /** What the bench last saw: the drive, the level, the pad's pulls and input enable, NULL function. */
  seen = -1;

  constructor(mcu: Rp2350Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
    this.id = `GPIO${index}`;
  }

  private refresh(): PinDrive {
    this.mcu.soc?.drive(this.index, this.drive);
    return this.drive;
  }

  mode(): PinMode {
    const soc = this.mcu.soc;
    if (soc === null) return 'input';
    const drive = this.refresh();
    if (drive.kind === 1) return 'output';
    if (drive.kind === 2) return 'peripheral';
    const pad = soc.pads.pad(this.index);
    if (this.index >= 26 && (pad & PAD_IE) === 0 && soc.io.funcsel(this.index) === FUNC_NULL) return 'analog';
    if ((pad & PAD_ISO) !== 0) return 'input';
    const up = (pad & PAD_PUE) !== 0;
    const down = (pad & PAD_PDE) !== 0;
    return up && !down ? 'input-pullup' : down && !up ? 'input-pulldown' : 'input';
  }

  outputLevel(): Level {
    return this.refresh().level as Level;
  }

  setInput(state: NetState): void {
    let level = this.inputLevel;
    if (state.level === null) level = 0;
    else if (state.volts >= VIH) level = 1;
    else if (state.volts <= VIL) level = 0;
    this.inputLevel = level;
    this.volts = state.volts; // an analog net (a pot's wiper) has volts without a digital level
    this.apply();
  }

  private volts = 0;

  /** BT113: an input the board drives itself (the CYW43's host-wake on GP24). */
  force(level: number): void {
    this.inputLevel = level;
    this.apply();
  }

  /** Pushes the input level and, on GPIO26–29, the ADC input to the SoC (again after a reset). */
  apply(): void {
    const soc = this.mcu.soc;
    if (soc === null) return;
    soc.setInput(this.index, this.inputLevel);
    if (this.index >= 26) soc.adc.volts[this.index - 26] = this.volts;
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Tells the bench when this pin's drive or mode changed since it last looked. */
  check(): void {
    const soc = this.mcu.soc;
    const drive = this.refresh();
    const pad = soc === null ? 0 : soc.pads.pad(this.index) & (PAD_ISO | PAD_IE | PAD_PUE | PAD_PDE);
    const isNull = soc !== null && soc.io.funcsel(this.index) === FUNC_NULL ? 1 : 0;
    const state = drive.kind * 2 + drive.level + pad * 16 + isNull * 0x10000;
    if (state === this.seen) return;
    this.seen = state;
    for (const listener of this.listeners) listener();
  }
}

class Rp2350Uart implements UartPort {
  private readonly mcu: Rp2350Mcu;
  private readonly index: number;
  readonly listeners: ((byte: number) => void)[] = [];

  constructor(mcu: Rp2350Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  private get uart(): Uart | undefined {
    return this.mcu.soc?.uarts[this.index];
  }

  /** Re-attaches to the current SoC's UART. */
  wire(): void {
    this.uart?.listeners.push((byte) => {
      for (const listener of this.listeners) listener(byte);
    });
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  receive(bytes: Uint8Array): void {
    this.uart?.receive(bytes);
  }

  /** TX and RX: the first GPIO with this UART's function (aux pins included). */
  pins(): { tx?: string; rx?: string } {
    const soc = this.mcu.soc;
    const out: { tx?: string; rx?: string } = {};
    if (soc === null) return out;
    for (let n = 0; n < PIN_COUNT; n++) {
      if (((n >>> 2) & 1) !== this.index) continue;
      const f = soc.io.funcsel(n);
      const role = n & 3;
      if (f === FUNC_UART && role === 0 && out.tx === undefined) out.tx = `GPIO${n}`;
      if (f === FUNC_UART && role === 1 && out.rx === undefined) out.rx = `GPIO${n}`;
      if (f === FUNC_UART_AUX && role === 2 && out.tx === undefined) out.tx = `GPIO${n}`;
      if (f === FUNC_UART_AUX && role === 3 && out.rx === undefined) out.rx = `GPIO${n}`;
    }
    return out;
  }

  baud(): number | undefined {
    const b = this.uart?.baud();
    return b === undefined ? undefined : Math.round(b);
  }
}

export class Rp2350Mcu implements Mcu, Debuggable, WifiStation, NonVolatile {
  readonly kind = 'rp2350' as const;
  readonly clockHz = RP2350_CLOCK_HZ;
  readonly pins: ReadonlyMap<string, McuPin>;
  /** The SoC (null without a bootrom). */
  readonly soc: Rp2350Soc | null;
  onProblem: ((problem: Problem) => void) | null;
  private readonly pinList: Rp2350Pin[] = [];
  private readonly uarts: Rp2350Uart[];
  private readonly usb: UsbSerialBridge | null;
  private readonly i2cs: I2cBridge[];
  private readonly spis: SpiBridge[];
  private loaded = false;
  /** BT118: the flash as hosts keep it (EEPROM emulation, LittleFS): what loads wrote is the program's. */
  private readonly nvm = new SectorMemory('flash', 0x1000, () => this.soc?.flash ?? new Uint8Array(0), () => this.soc?.flashChanged());
  /** BT67: the interpreter UF2, the MicroPython sketch it runs (null: native firmware) and the flash the interpreter's image makes. */
  private readonly micropython: Uint8Array | undefined;
  private sketch: MicroPythonSketch | null = null;
  private interpreterFlash: Uint8Array | null = null;
  /** BT113: the Pico 2 W's CYW43439 (null: a Pico 2), its LED pin, and the firmware's symbols. */
  readonly cyw43: Cyw43 | null = null;
  private readonly wlPin: Cyw43Pin | null = null;
  private symbols: Map<string, number> | null = null;
  private cyw43Answered = false;
  private cyw43Reported = false;

  constructor(options: Rp2350McuOptions = {}) {
    this.onProblem = options.onProblem ?? null;
    this.micropython = options.micropython;
    const pins = new Map<string, McuPin>();
    for (let n = 0; n < PIN_COUNT; n++) {
      const pin = new Rp2350Pin(this, n);
      this.pinList.push(pin);
      pins.set(pin.id, pin);
    }
    this.pins = pins;
    this.uarts = [new Rp2350Uart(this, 0), new Rp2350Uart(this, 1)];
    const rom = options.rom;
    this.soc = rom !== undefined && rom.length === ROM_IMAGE.bytes ? new Rp2350Soc({ rom, onProblem: (p) => this.problem(p.severity, p.code, p.message) }) : null;
    const soc = this.soc;
    if (options.cyw43 !== undefined && soc !== null) {
      const chip = new Cyw43({
        mac: options.cyw43.mac ?? PICO_W_MAC,
        hostWake: (level) => this.pinList[WL_HOST_WAKE].force(level ? 1 : 0),
        gpioChanged: (gpio) => {
          if (gpio === 0) this.wlPin?.fire();
        },
        now: () => soc.now(),
        createAlarm: (callback) => soc.rpjsClock.createAlarm(callback),
        unsupported: (what) => this.problem('warning', CODE_CYW43_UNSUPPORTED, what),
        busUp: () => this.cyw43Pins(),
      });
      this.cyw43 = chip;
      this.wlPin = new Cyw43Pin(chip);
      pins.set(this.wlPin.id, this.wlPin);
    }
    const gpio = { count: PIN_COUNT, funcsel: (n: number) => soc?.io.funcsel(n) ?? 0x1f };
    this.usb = soc === null ? null : new UsbSerialBridge(() => soc.usb as NonNullable<typeof soc.usb>, () => soc.rpjsClock);
    this.i2cs = soc === null ? [] : [0, 1].map((i) => new I2cBridge(i, () => soc.i2c[i], gpio));
    this.spis = soc === null ? [] : [0, 1].map((i) => new SpiBridge(i, () => soc.spi[i], gpio));
    if (soc !== null) {
      soc.onPinsChanged = () => {
        for (const pin of this.pinList) pin.check();
        if (this.cyw43 !== null) this.wlRegOn();
      };
      for (const uart of this.uarts) uart.wire();
      for (const spi of this.spis) spi.wire();
    }
  }

  get cycles(): number {
    return this.soc?.cycles ?? 0;
  }

  load(image: FirmwareImage): void {
    if (image.format === 'micropython') {
      this.sketch = image;
      this.interpreterFlash = this.micropython === undefined ? null : flashImage({ format: 'uf2', bytes: this.micropython });
      this.writeFlash(this.interpreterFlash);
    } else {
      const regions = imageRegions(image);
      this.sketch = null;
      this.interpreterFlash = null;
      this.programFlash(regions);
    }
    this.loaded = true;
    this.reset();
  }

  /**
   * BT118: an upload — the image's sectors erased and programmed, the rest keeping what the
   * firmware stored (EEPROM emulation, LittleFS), as a UF2 copy does.
   */
  private programFlash(regions: readonly { offset: number; data: Uint8Array }[]): void {
    if (this.soc === null) return;
    for (const { offset, data } of regions) this.nvm.eraseSectors(offset, data.length);
    for (const { offset, data } of regions) {
      this.soc.flash.set(data, offset);
      this.nvm.markProgram(offset, data.length);
    }
    this.soc.flashChanged();
  }

  /**
   * BT118: the flash as hosts keep it — every reset keeps it, a load programs only the image's
   * sectors. Null for a MicroPython sketch (its interpreter starts on erased flash each run) or
   * without the bootrom.
   */
  nonVolatile(): NvMemory | null {
    return this.sketch === null && this.soc !== null ? this.nvm : null;
  }

  /** Flash as an image leaves it (null: erased) — a MicroPython interpreter's, every reset. */
  private writeFlash(flash: Uint8Array | null): void {
    if (this.soc === null) return;
    this.soc.flash.fill(0xff);
    if (flash !== null) this.soc.flash.set(flash.subarray(0, Math.min(flash.length, FLASH_SIZE)));
    this.soc.flashChanged();
  }

  /** Whether a MicroPython sketch is loaded without its interpreter. */
  private get micropythonMissing(): boolean {
    return this.sketch !== null && this.interpreterFlash === null;
  }

  /**
   * Hardware reset. A MicroPython sketch starts from the interpreter's image with an empty
   * filesystem each time and is written again over USB serial, so main.py runs with the serial
   * monitor attached, as an IDE's Run does.
   */
  reset(): void {
    const soc = this.soc;
    if (soc === null) {
      this.problem('error', CODE_ROM_MISSING, ROM_MISSING_MESSAGE);
      return;
    }
    if (this.sketch !== null) this.writeFlash(this.interpreterFlash);
    soc.reset();
    if (this.micropythonMissing) this.problem('error', CODE_MICROPYTHON_MISSING, MICROPYTHON_MISSING_MESSAGE);
    // rp2040js's I2C and USB are new after a reset: hook them again.
    const usb = this.usb;
    const sketch = this.sketch;
    usb?.wire(
      sketch === null || this.interpreterFlash === null
        ? null
        : new MicroPythonInstaller(sketch, {
            send: (bytes) => usb.send(bytes),
            fail: (message) => this.problem('error', CODE_MICROPYTHON_INSTALL, message),
          }),
    );
    for (const i2c of this.i2cs) i2c.wire();
    for (const pin of this.pinList) {
      pin.apply();
      pin.seen = -1;
      pin.check();
    }
    this.cyw43Reported = false;
    if (this.cyw43 !== null) {
      this.cyw43.reset();
      this.wlPin?.fire();
      this.installCyw43();
    }
  }

  /**
   * BT113: the firmware's symbols, for what the simulator answers by function name (the Pico 2
   * W's CYW43). Hosts call it after `load`; it holds for every later reset. A Pico 2 ignores it.
   */
  useSymbols(table: SymbolTable | null): void {
    if (this.cyw43 === null) return;
    if (table === null) this.symbols = null;
    else {
      const byName = new Map<string, number>();
      for (let i = 0; i < table.size; i++) {
        const entry = table.entry(i);
        if (!byName.has(entry.name) || entry.kind === 'func') byName.set(entry.name, entry.address);
      }
      this.symbols = byName;
    }
    this.installCyw43();
  }

  /** BT111/BT113: the bench's access points and LANs for a Pico 2 W's station (a Pico 2 has none). */
  joinWifi(radio: WifiRadio | null): void {
    this.cyw43?.setRadio(radio);
  }

  /** BT113: a fresh HLE table on both harts answering the CYW43 driver, when the symbols name it. */
  private installCyw43(): void {
    const soc = this.soc;
    if (soc === null || this.cyw43 === null) return;
    this.cyw43Answered = false;
    for (const hart of soc.harts) hart.setHle(null);
    const symbols = this.symbols;
    if (symbols === null) return;
    const hle = new RiscvHle(RP2350_HLE_RESUME_PC);
    const { installed, missing } = this.cyw43.install(hle, (name) => symbols.get(name));
    if (missing.length > 0) this.problem('error', CODE_CYW43_UNSUPPORTED, `This firmware uses the Pico 2 W's WiFi chip, but it lacks ${missing.join(', ')}, which the simulated chip calls: WiFi won't run.`);
    if (!installed) return;
    for (const hart of soc.harts) hart.setHle(hle);
    this.cyw43Answered = true;
  }

  /** BT113: GP23 (WL_REG_ON) driven high: the real driver powering the chip, with nothing to answer it. */
  private wlRegOn(): void {
    if (this.cyw43Answered || this.cyw43Reported || this.soc === null) return;
    const drive: PinDrive = { kind: 0, level: 0 };
    this.soc.drive(WL_REG_ON, drive);
    if (drive.kind !== 1 || drive.level !== 1) return;
    this.cyw43Reported = true;
    this.problem('error', CODE_CYW43_NO_SYMBOLS, "This firmware powers the Pico 2 W's WiFi chip (GP23, WL_REG_ON). The simulator answers the chip at its driver's API by function name, so it needs the firmware's symbols: run the sketch's .elf beside its .uf2 (arduino-cli builds both; Compile & Run passes it), or a .syms.tsv as the fixtures keep. Until then the chip doesn't answer: no WiFi, and the LED stays dark.");
  }

  /**
   * BT113: the pins as the CYW43's real bus bring-up leaves them (which the model answers in its
   * place), through the RP2350's registers as the SDK writes them: GP23 and GP25 SIO outputs
   * driven high (GP23 pulled up), GP24 a SIO input — pads with input enabled and isolation off.
   */
  private cyw43Pins(): void {
    const soc = this.soc;
    if (soc === null) return;
    const IO_BANK0 = 0x40028000;
    const PADS_BANK0 = 0x40038000;
    const SIO = 0xd0000000;
    const F_SIO = 5;
    for (const [pin, output] of [[WL_REG_ON, true], [WL_HOST_WAKE, false], [WL_CS, true]] as const) {
      soc.write(0, IO_BANK0 + 8 * pin + 4, F_SIO, 4);
      let pad = (soc.pads.pad(pin) | PAD_IE) & ~(0x80 | PAD_ISO); // IE on, OD and ISO off
      if (pin === WL_REG_ON) pad = (pad | PAD_PUE) & ~PAD_PDE;
      soc.write(0, PADS_BANK0 + 4 + 4 * pin, pad, 4);
      soc.write(0, SIO + (output ? 0x038 : 0x040), 1 << pin, 4); // GPIO_OE_SET / _CLR
      if (output) soc.write(0, SIO + 0x018, 1 << pin, 4); // GPIO_OUT_SET
    }
    this.pinList[WL_HOST_WAKE].apply();
  }

  runUntil(targetCycles: number): RunResult {
    const soc = this.soc;
    if (soc === null) return { reason: 'halted', detail: ROM_MISSING_MESSAGE };
    if (!this.loaded) return { reason: 'halted', detail: 'no firmware loaded' };
    if (this.micropythonMissing) return { reason: 'halted', detail: MICROPYTHON_MISSING_MESSAGE };
    this.usb?.flush();
    const halt = soc.runUntilNanos((targetCycles * 1e9) / RP2350_CLOCK_HZ);
    if (halt === null && soc.atBreakpoint) {
      soc.atBreakpoint = false;
      return { reason: 'breakpoint' };
    }
    if (halt === null) return { reason: 'target' };
    if (soc.bootError !== null) return { reason: 'halted', detail: halt };
    this.problem('error', 'rp2350-fault', halt);
    return { reason: 'fault', detail: halt };
  }

  private debugView: McuDebug | null = null;

  /** BT71: hart 0's debugger view (without a bootrom there is no SoC: a view that sees nothing). */
  debug(): McuDebug {
    this.debugView ??= this.soc === null ? new NoSocDebug() : new Rp2350Debug(this.soc);
    return this.debugView;
  }

  uart(index: number): UartPort | undefined {
    if (index === 0) return this.usb ?? undefined;
    return index === 1 || index === 2 ? this.uarts[index - 1] : undefined;
  }

  i2c(index: number): I2cController | undefined {
    return this.i2cs[index];
  }

  spi(index: number): SpiController | undefined {
    return this.spis[index];
  }

  private problem(severity: Problem['severity'], code: string, message: string): void {
    this.onProblem?.({ severity, code, message, parts: [] });
  }
}

/** The flash contents an image makes (bytes from 0x10000000, 0xff where nothing is written). Throws on anything else. */
function flashImage(image: FirmwareImage): Uint8Array {
  const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  for (const { offset, data } of imageRegions(image)) flash.set(data, offset);
  return flash;
}

/** BT118: what an image writes into flash, by offset from 0x10000000. Throws on anything else. */
function imageRegions(image: FirmwareImage): { offset: number; data: Uint8Array }[] {
  const regions: { offset: number; data: Uint8Array }[] = [];
  const place = (address: number, data: Uint8Array): void => {
    const offset = address - FLASH_BASE;
    if (offset < 0 || offset + data.length > FLASH_SIZE) {
      if (address >= 0x20000000 && address < 0x20082000) throw new Error('RAM-only images are not supported on the RP2350 yet: build the sketch to run from flash');
      throw new Error(`firmware data at 0x${address.toString(16)} is outside the RP2350's 4 MB flash`);
    }
    regions.push({ offset, data });
  };
  if (image.format === 'uf2') {
    const uf2 = parseUf2(image.bytes);
    if (uf2.familyId === UF2_FAMILY.RP2040) throw new Error('this UF2 is for the RP2040 (Pico), not the RP2350 (Pico 2)');
    if (uf2.familyId === UF2_FAMILY.RP2350_ARM_S || uf2.familyId === UF2_FAMILY.RP2350_ARM_NS) throw new Error("this UF2 is for the RP2350's Arm cores; Benchtop runs its RISC-V cores (build with arch=riscv)");
    if (uf2.familyId !== undefined && uf2.familyId !== UF2_FAMILY.RP2350_RISCV) throw new Error(`this UF2 is for family 0x${uf2.familyId.toString(16)}, not the RP2350's RISC-V cores (0xe48bff5a)`);
    for (const block of uf2.blocks) if (block.family !== UF2_FAMILY.ABSOLUTE) place(block.address, block.data);
  } else if (image.format === 'elf') {
    const elf = parseElf32(image.bytes);
    if (elf.machine !== EM_RISCV) throw new Error(`this ELF is for machine ${elf.machine}, not RISC-V (243)`);
    for (const segment of elf.segments) if (segment.data.length > 0) place(segment.paddr, segment.data);
  } else throw new Error(`the RP2350 runs UF2 and ELF images (and MicroPython sketches); got ${describeFirmwareFormat(image.format)}`);
  if (regions.length === 0) throw new Error('the image has no data to load');
  return regions;
}

export function createRp2350Mcu(options: Rp2350McuOptions = {}): Rp2350Mcu {
  return new Rp2350Mcu(options);
}
