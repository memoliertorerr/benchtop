/**
 * An AVR chip as a Benchtop `Mcu`, on avr8js 0.21.1 — the part the ATmega328P (Uno, Nano) and
 * the ATmega2560 (Mega, BT46) share. A chip is a table (`AvrChip`: memory sizes, ports, and the
 * register addresses and interrupt vectors of its timers, USARTs, SPI, TWI, ADC, EEPROM and
 * watchdog); `AvrMcu` builds avr8js's peripherals from it. atmega328p.ts and atmega2560.ts hold
 * the tables.
 *
 * Pins are '<P><port letter><bit>' ('PB5') plus the chip's analog-only inputs ('ADC6'): no port
 * bit and no digital input buffer, so they only feed the ADC and never drive. A port pin's mode
 * comes from DDR/PORT through `AVRIOPort.pinState()`, so timer compare outputs (PWM) are
 * included; a USART's TX pin reports 'peripheral' (idle high) while its transmitter is enabled,
 * because avr8js's USART never drives the pin. Port listeners fire on PORT/DDR/PIN writes and on
 * timer overrides; the adapter turns them into per-pin `onOutputChange` calls only for pins
 * whose mode or level actually changed.
 *
 * Inputs: `setInput` applies VIH = 3.0 V / VIL = 1.5 V with hysteresis (in between, the last
 * level stays), and a floating net (level null) reads as the last level — deliberate: the
 * circuit checker reports floating reads instead of the emulator inventing noise. ADC pins also
 * feed the ADC their volts.
 *
 * `reset()` rebuilds the CPU and every peripheral from scratch but keeps the McuPin, UartPort,
 * I2C and SPI objects (and the EEPROM contents), so listeners the bench registered survive.
 *
 * Debugging (`debug()`, BT24, in debug.ts): breakpoints live in a per-word Uint8Array; while
 * none is set `runUntil` keeps its plain loop, so they cost nothing. A run that stops at one
 * returns `breakpoint` with PC on it, and the next run executes that instruction unchecked.
 * Breakpoints survive `reset()` and `load()`.
 */

import {
  type ADCConfig,
  AVRADC,
  AVRClock,
  type AVRClockConfig,
  AVREEPROM,
  type AVREEPROMConfig,
  avrInstruction,
  AVRIOPort,
  type AVRPortConfig,
  AVRSPI,
  AVRTimer,
  type AVRTimerConfig,
  AVRTWI,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  PinState,
  type SPIConfig,
  type TWIConfig,
  type TWIEventHandler,
  type usart0Config,
  type WatchdogConfig,
} from 'avr8js';
import {
  describeFirmwareFormat,
  EM_AVR,
  type FirmwareImage,
  type Debuggable,
  type I2cController,
  type I2cDevice,
  type Level,
  type Mcu,
  type McuDebug,
  type McuPin,
  type NetState,
  parseElf32,
  parseIntelHex,
  type PinMode,
  PT_LOAD,
  type RunResult,
  type SpiController,
  type SpiDevice,
  type UartPort,
} from '@benchtop/core';
import { AvrDebug } from './debug.ts';
import { fixFastPwmOrder } from './timer-fix.ts';

/** Input thresholds at 5 V (datasheets: VIH min 0.6 VCC, VIL max 0.3 VCC). */
export const AVR_VIH = 3.0;
export const AVR_VIL = 1.5;
/** Where AVR ELFs put the data space (`.data`'s vaddr); flash segments sit below it. */
const ELF_DATA_BASE = 0x800000;
/** ADEN in ADCSRA. */
const ADEN = 0x80;

const TARGET: RunResult = Object.freeze({ reason: 'target' });
const NO_FIRMWARE: RunResult = Object.freeze({ reason: 'halted', detail: 'no firmware loaded' });
const BREAKPOINT: RunResult = Object.freeze({ reason: 'breakpoint' });

/** One USART: avr8js's register/vector table and its TX/RX pins. */
export interface AvrUsart {
  config: typeof usart0Config;
  tx: string;
  rx: string;
}

/** Everything chip-specific: sizes, ports and the peripherals' register/vector tables. */
export interface AvrChip {
  kind: 'atmega328p' | 'atmega2560';
  /** For error messages: 'ATmega328P'. */
  name: string;
  clockHz: number;
  flashBytes: number;
  /**
   * What avr8js's CPU allocates above its 0x100-byte register file: SRAM, plus the extended I/O
   * past 0xFF where a chip has it (the 2560's reaches 0x1FF), so that SP starts at RAMEND.
   */
  cpuDataBytes: number;
  eepromBytes: number;
  ports: readonly { letter: string; config: AVRPortConfig; bits: number }[];
  timers: readonly AVRTimerConfig[];
  usarts: readonly AvrUsart[];
  spi: { config: SPIConfig; pins: { sck: string; mosi: string; miso: string } };
  twi: { config: TWIConfig; pins: { sda: string; scl: string } };
  adc: ADCConfig;
  /** ADC channel n's pin id: a port pin ('PC0') or an analog-only input ('ADC6'). */
  adcPins: readonly string[];
  eeprom: AVREEPROMConfig;
  watchdog: WatchdogConfig;
  clock: AVRClockConfig;
}

/** Everything rebuilt on reset. */
export interface AvrCore {
  cpu: CPU;
  ports: AVRIOPort[];
  usarts: AVRUSART[];
  spi: AVRSPI;
  twi: AVRTWI;
  adc: AVRADC;
}

class AvrPin implements McuPin {
  readonly id: string;
  readonly port: number;
  readonly bit: number;
  readonly listeners: (() => void)[] = [];
  /** What listeners last saw. */
  shownMode: PinMode = 'input';
  shownLevel: Level = 0;
  /** The digital level the pin reads (after thresholds and hysteresis). */
  inputLevel: Level = 0;
  inputVolts = 0;
  /** The ADC channel this pin feeds, or −1. */
  adcChannel = -1;
  /** The USART whose TX this pin is, or −1. */
  txOf = -1;
  private readonly mcu: AvrMcu;

  constructor(mcu: AvrMcu, port: number, bit: number, letter: string) {
    this.mcu = mcu;
    this.port = port;
    this.bit = bit;
    this.id = `P${letter}${bit}`;
  }

  mode(): PinMode {
    return this.mcu.pinMode(this);
  }

  outputLevel(): Level {
    return this.mcu.pinLevel(this);
  }

  setInput(state: NetState): void {
    this.mcu.applyInput(this, state);
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

/** An ADC channel with a package pin and nothing else (no port, no digital function). */
class AdcPin implements McuPin {
  readonly id: string;
  readonly channel: number;
  inputVolts = 0;
  private readonly mcu: AvrMcu;

  constructor(mcu: AvrMcu, id: string, channel: number) {
    this.mcu = mcu;
    this.id = id;
    this.channel = channel;
  }

  /** 'analog' while the ADC is enabled, as port ADC pins report; it never drives either way. */
  mode(): PinMode {
    return this.mcu.adcEnabled() ? 'analog' : 'input';
  }

  outputLevel(): Level {
    return 0;
  }

  setInput(state: NetState): void {
    this.inputVolts = state.volts;
    this.mcu.core.adc.channelValues[this.channel] = state.volts;
  }

  /** Its mode only follows ADEN, which no listener reports (as for port ADC pins): nothing to call. */
  onOutputChange(): void {}
}

class AvrUart implements UartPort {
  private readonly listeners: ((byte: number) => void)[] = [];
  private queue: number[] = [];
  private head = 0;
  private readonly mcu: AvrMcu;
  private readonly index: number;
  private readonly spec: AvrUsart;

  constructor(mcu: AvrMcu, index: number, spec: AvrUsart) {
    this.mcu = mcu;
    this.index = index;
    this.spec = spec;
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  /** Queues bytes; they arrive one per character time at the configured baud, never faster. */
  receive(bytes: Uint8Array): void {
    for (const byte of bytes) this.queue.push(byte);
    this.feed();
  }

  emit(byte: number): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](byte);
  }

  /** BT39: its TX pin while the transmitter is enabled, its RX pin while the receiver is. */
  pins(): { tx?: string; rx?: string } {
    const usart = this.mcu.core.usarts[this.index];
    const pins: { tx?: string; rx?: string } = {};
    if (usart.txEnable) pins.tx = this.spec.tx;
    if (usart.rxEnable) pins.rx = this.spec.rx;
    return pins;
  }

  /** BT39: UBRR and U2X's rate, once the firmware enabled the transmitter or receiver. */
  baud(): number | undefined {
    const usart = this.mcu.core.usarts[this.index];
    return usart.txEnable || usart.rxEnable ? usart.baudRate : undefined;
  }

  /** Starts the next queued byte if the receiver is idle. With RX disabled, bytes are lost. */
  feed(): void {
    const usart = this.mcu.core.usarts[this.index];
    while (this.head < this.queue.length && !usart.rxBusy) {
      const started = usart.writeByte(this.queue[this.head++]);
      if (started === true) break;
    }
    if (this.head === this.queue.length && this.head > 0) {
      this.queue = [];
      this.head = 0;
    }
  }

  clear(): void {
    this.queue = [];
    this.head = 0;
  }
}

class AvrI2c implements I2cController {
  private readonly devices: I2cDevice[] = [];
  private current: I2cDevice | null = null;
  private readonly mcu: AvrMcu;
  private readonly pinIds: { sda: string; scl: string };
  /** avr8js calls these; each must answer with the matching complete*() call. */
  readonly handler: TWIEventHandler;

  constructor(mcu: AvrMcu, pins: { sda: string; scl: string }) {
    this.mcu = mcu;
    this.pinIds = Object.freeze({ ...pins });
    this.handler = {
      start: () => this.mcu.core.twi.completeStart(),
      stop: () => {
        this.current?.stop();
        this.current = null;
        this.mcu.core.twi.completeStop();
      },
      connectToSlave: (address, write) => {
        // Addresses are read at every START, so a device may change its address (AD0 pins).
        let target: I2cDevice | null = null;
        for (let i = 0; i < this.devices.length; i++) {
          if (this.devices[i].address === address) {
            target = this.devices[i];
            break;
          }
        }
        if (this.current !== null && this.current !== target) this.current.stop();
        const ack = target !== null && target.start(!write);
        this.current = ack ? target : null;
        this.mcu.core.twi.completeConnect(ack);
      },
      writeByte: (value) => {
        const ack = this.current !== null && this.current.write(value);
        this.mcu.core.twi.completeWrite(ack);
      },
      readByte: (ack) => {
        const value = this.current === null ? 0xff : this.current.read(ack) & 0xff;
        this.mcu.core.twi.completeRead(value);
      },
    };
  }

  pins(): { sda: string; scl: string } {
    return this.pinIds;
  }

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices.push(device);
  }

  detach(device: I2cDevice): void {
    const i = this.devices.indexOf(device);
    if (i >= 0) this.devices.splice(i, 1);
    if (this.current === device) this.current = null;
  }

  reset(): void {
    this.current = null;
  }
}

class AvrSpi implements SpiController {
  private readonly devices: { device: SpiDevice; selected: () => boolean }[] = [];
  private result = 0xff;
  private readonly mcu: AvrMcu;
  private readonly pinIds: { sck: string; mosi: string; miso: string };

  constructor(mcu: AvrMcu, pins: { sck: string; mosi: string; miso: string }) {
    this.mcu = mcu;
    this.pinIds = Object.freeze({ ...pins });
  }

  pins(): { sck: string; mosi: string; miso: string } {
    return this.pinIds;
  }

  attach(device: SpiDevice, selected: () => boolean): void {
    if (!this.devices.some((d) => d.device === device)) this.devices.push({ device, selected });
  }

  detach(device: SpiDevice): void {
    const i = this.devices.findIndex((d) => d.device === device);
    if (i >= 0) this.devices.splice(i, 1);
  }

  /** avr8js's onByte: the selected device answers; the byte completes after transferCycles. */
  readonly onByte = (mosi: number): void => {
    let miso = 0xff;
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].selected()) {
        miso = this.devices[i].device.transfer(mosi) & 0xff;
        break;
      }
    }
    this.result = miso;
    const { cpu, spi } = this.mcu.core;
    cpu.addClockEvent(this.complete, spi.transferCycles);
  };

  private readonly complete = (): void => {
    this.mcu.core.spi.completeTransfer(this.result);
  };
}

export class AvrMcu implements Mcu, Debuggable {
  readonly kind: AvrChip['kind'];
  readonly clockHz: number;
  readonly pins: ReadonlyMap<string, McuPin>;
  readonly chip: AvrChip;
  /** The current CPU and peripherals; replaced on every reset. */
  core: AvrCore;
  private readonly pinList: AvrPin[] = [];
  private readonly portPins: AvrPin[][] = [];
  private readonly adcOnly: AdcPin[] = [];
  private readonly uarts: AvrUart[];
  private readonly i2c0: AvrI2c;
  private readonly spi0: AvrSpi;
  private readonly eeprom: EEPROMMemoryBackend;
  private flash: Uint16Array;
  private loaded = false;
  /** @internal Breakpoints by flash word (1 = set), and how many are set. */
  readonly breakpointWords: Uint8Array;
  breakpointCount = 0;
  /** @internal The word PC of the breakpoint the last run stopped at (−1: none). */
  resumeAt = -1;
  private debugView: AvrDebug | null = null;

  constructor(chip: AvrChip) {
    this.chip = chip;
    this.kind = chip.kind;
    this.clockHz = chip.clockHz;
    this.flash = new Uint16Array(chip.flashBytes / 2).fill(0xffff);
    this.breakpointWords = new Uint8Array(chip.flashBytes / 2);
    this.eeprom = new EEPROMMemoryBackend(chip.eepromBytes);
    for (let p = 0; p < chip.ports.length; p++) {
      const pins: AvrPin[] = [];
      for (let bit = 0; bit < chip.ports[p].bits; bit++) pins.push(new AvrPin(this, p, bit, chip.ports[p].letter));
      this.portPins.push(pins);
      this.pinList.push(...pins);
    }
    const byId = new Map<string, McuPin>(this.pinList.map((pin) => [pin.id, pin]));
    chip.adcPins.forEach((id, channel) => {
      const pin = byId.get(id);
      if (pin instanceof AvrPin) pin.adcChannel = channel;
      else if (pin === undefined) {
        const only = new AdcPin(this, id, channel);
        this.adcOnly.push(only);
        byId.set(id, only);
      }
    });
    chip.usarts.forEach((usart, index) => {
      const tx = byId.get(usart.tx);
      if (tx instanceof AvrPin) tx.txOf = index;
    });
    this.pins = byId;
    this.uarts = chip.usarts.map((spec, index) => new AvrUart(this, index, spec));
    this.i2c0 = new AvrI2c(this, chip.twi.pins);
    this.spi0 = new AvrSpi(this, chip.spi.pins);
    this.core = this.buildCore();
  }

  get cycles(): number {
    return this.core.cpu.cycles;
  }

  debug(): McuDebug {
    this.debugView ??= new AvrDebug(this);
    return this.debugView;
  }

  /** @internal The EEPROM bytes (kept across resets). */
  get eepromBytes(): Uint8Array {
    return this.eeprom.memory;
  }

  /**
   * Loads Intel HEX text or an AVR ELF (flash = PT_LOAD segments below the data space at
   * 0x800000), at most the chip's flash, then resets. Throws on anything else.
   */
  load(image: FirmwareImage): void {
    const { flashBytes, name } = this.chip;
    let bytes: Uint8Array;
    if (image.format === 'hex') bytes = parseIntelHex(image.text, { maxBytes: flashBytes }).bytes;
    else if (image.format === 'elf') bytes = flashFromElf(image.bytes, flashBytes);
    else throw new Error(`the ${name} runs .hex or .elf firmware; got ${describeFirmwareFormat(image.format)}`);
    const flash = new Uint16Array(flashBytes / 2).fill(0xffff);
    for (let i = 0; i < bytes.length; i += 2) {
      flash[i >> 1] = bytes[i] | ((i + 1 < bytes.length ? bytes[i + 1] : 0xff) << 8);
    }
    this.flash = flash;
    this.loaded = true;
    this.reset();
  }

  reset(): void {
    this.resumeAt = -1;
    for (const uart of this.uarts) uart.clear();
    this.i2c0.reset();
    this.core = this.buildCore();
    const { ports, adc } = this.core;
    for (const pin of this.pinList) {
      if (pin.inputLevel === 1) ports[pin.port].setPin(pin.bit, true);
      if (pin.adcChannel >= 0) adc.channelValues[pin.adcChannel] = pin.inputVolts;
    }
    for (const pin of this.adcOnly) adc.channelValues[pin.channel] = pin.inputVolts;
    for (const pin of this.pinList) this.refresh(pin);
  }

  runUntil(targetCycles: number): RunResult {
    if (!this.loaded) return NO_FIRMWARE;
    if (this.breakpointCount > 0) return this.runChecked(targetCycles);
    const cpu = this.core.cpu;
    while (cpu.cycles < targetCycles) {
      avrInstruction(cpu);
      cpu.tick();
    }
    return TARGET;
  }

  /** runUntil with a breakpoint check before each instruction. */
  private runChecked(targetCycles: number): RunResult {
    const cpu = this.core.cpu;
    const breakpoints = this.breakpointWords;
    // Resuming from a breakpoint: execute the instruction under it first.
    if (cpu.pc === this.resumeAt && cpu.cycles < targetCycles) {
      avrInstruction(cpu);
      cpu.tick();
    }
    this.resumeAt = -1;
    while (cpu.cycles < targetCycles) {
      if (breakpoints[cpu.pc] === 1) {
        this.resumeAt = cpu.pc;
        return BREAKPOINT;
      }
      avrInstruction(cpu);
      cpu.tick();
    }
    return TARGET;
  }

  /** @internal Exactly one instruction (plus the interrupt dispatch `tick()` may do after it). */
  stepInstruction(): RunResult {
    if (!this.loaded) return NO_FIRMWARE;
    const cpu = this.core.cpu;
    avrInstruction(cpu);
    cpu.tick();
    this.resumeAt = -1;
    return TARGET;
  }

  uart(index: number): UartPort | undefined {
    return this.uarts[index];
  }

  i2c(index: number): I2cController | undefined {
    return index === 0 ? this.i2c0 : undefined;
  }

  spi(index: number): SpiController | undefined {
    return index === 0 ? this.spi0 : undefined;
  }

  /** @internal ADCSRA.ADEN (Arduino's init() sets it). */
  adcEnabled(): boolean {
    return (this.core.cpu.data[this.chip.adc.ADCSRA] & ADEN) !== 0;
  }

  /** @internal */
  pinMode(pin: AvrPin): PinMode {
    if (pin.txOf >= 0 && this.core.usarts[pin.txOf].txEnable) return 'peripheral';
    switch (this.core.ports[pin.port].pinState(pin.bit)) {
      case PinState.High:
      case PinState.Low:
        return 'output';
      case PinState.InputPullUp:
        return 'input-pullup';
      default:
        // An ADC pin with the ADC enabled: 'analog'.
        return pin.adcChannel >= 0 && this.adcEnabled() ? 'analog' : 'input';
    }
  }

  /** @internal */
  pinLevel(pin: AvrPin): Level {
    if (pin.txOf >= 0 && this.core.usarts[pin.txOf].txEnable) return 1; // UART idle
    return this.core.ports[pin.port].pinState(pin.bit) === PinState.High ? 1 : 0;
  }

  /** @internal */
  applyInput(pin: AvrPin, state: NetState): void {
    pin.inputVolts = state.volts;
    if (pin.adcChannel >= 0) this.core.adc.channelValues[pin.adcChannel] = state.volts;
    let level = pin.inputLevel;
    if (state.level !== null) {
      if (state.volts >= AVR_VIH) level = 1;
      else if (state.volts <= AVR_VIL) level = 0;
    }
    if (level !== pin.inputLevel) {
      pin.inputLevel = level;
      this.core.ports[pin.port].setPin(pin.bit, level === 1);
    }
  }

  /** Fires a pin's listeners if its mode or level differs from what they last saw. */
  private refresh(pin: AvrPin): void {
    const mode = this.pinMode(pin);
    const level = this.pinLevel(pin);
    if (mode === pin.shownMode && level === pin.shownLevel) return;
    pin.shownMode = mode;
    pin.shownLevel = level;
    for (let i = 0; i < pin.listeners.length; i++) pin.listeners[i]();
  }

  private buildCore(): AvrCore {
    const chip = this.chip;
    const cpu = new CPU(this.flash, chip.cpuDataBytes);
    const ports = chip.ports.map(({ config }, p) => {
      const port = new AVRIOPort(cpu, config);
      const pins = this.portPins[p];
      let ddrSeen = 0;
      // Fires on PORT/DDR/PIN writes and timer overrides; refresh only the pins whose output
      // value or direction bit changed (a WS2812 bit-bang writes millions of times a second).
      port.addListener((value, oldValue) => {
        const ddr = cpu.data[config.DDR];
        const changed = (value ^ oldValue) | (ddr ^ ddrSeen);
        ddrSeen = ddr;
        for (let i = 0; i < pins.length; i++) if ((changed >> i) & 1) this.refresh(pins[i]);
      });
      return port;
    });
    for (const config of chip.timers) fixFastPwmOrder(new AVRTimer(cpu, config));
    const clock = new AVRClock(cpu, chip.clockHz, chip.clock);
    new AVRWatchdog(cpu, chip.watchdog, clock);
    new AVREEPROM(cpu, this.eeprom, chip.eeprom);
    const usarts = chip.usarts.map((spec, index) => {
      const usart = new AVRUSART(cpu, spec.config, chip.clockHz);
      const uart = this.uarts[index];
      const txPin = this.pins.get(spec.tx);
      usart.onByteTransmit = (byte) => uart.emit(byte);
      usart.onRxComplete = () => uart.feed();
      if (txPin instanceof AvrPin) usart.onConfigurationChange = () => this.refresh(txPin);
      return usart;
    });
    const spi = new AVRSPI(cpu, chip.spi.config, chip.clockHz);
    spi.onByte = this.spi0.onByte;
    const twi = new AVRTWI(cpu, chip.twi.config, chip.clockHz);
    twi.eventHandler = this.i2c0.handler;
    const adc = new AVRADC(cpu, chip.adc);
    return { cpu, ports, usarts, spi, twi, adc };
  }
}

/**
 * Flash bytes from an AVR ELF. AVR ELFs place .data's initial values (its load address, paddr)
 * in flash right after .text while its vaddr is 0x800100+ in the data space, so flash bytes
 * come from paddr, and only segments with paddr below the data space (0x800000) are flash.
 */
function flashFromElf(bytes: Uint8Array, flashBytes: number): Uint8Array {
  const elf = parseElf32(bytes);
  if (elf.machine !== EM_AVR) throw new Error(`not an AVR ELF (e_machine ${elf.machine}, expected ${EM_AVR})`);
  const image = new Uint8Array(flashBytes).fill(0xff);
  let end = 0;
  for (const segment of elf.segments) {
    if (segment.type !== PT_LOAD || segment.paddr >= ELF_DATA_BASE || segment.filesz === 0) continue;
    const segmentEnd = segment.paddr + segment.filesz;
    if (segmentEnd > flashBytes) {
      throw new Error(`ELF segment at 0x${segment.paddr.toString(16)} ends past the ${flashBytes / 1024} KiB flash`);
    }
    image.set(segment.data, segment.paddr);
    if (segmentEnd > end) end = segmentEnd;
  }
  if (end === 0) throw new Error('the ELF has no flash segments');
  return image.subarray(0, end);
}
