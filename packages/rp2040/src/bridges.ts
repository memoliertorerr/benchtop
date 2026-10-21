/**
 * The bench's bus contracts over Raspberry Pi chips' peripherals (BT60–BT63; shared since BT66 by
 * the RP2040 and the RP2350, whose I2C, SPI and USB blocks are the same IP):
 *
 * - `I2cBridge`: an I2C controller (rp2040js's RPI2C, DW_apb_i2c) as the bench's I2cController —
 *   its callbacks completed at once by the attached devices.
 * - `SpiBridge`: an SPI controller (PL022) as the bench's SpiController — a frame of up to 16 bits
 *   (SSPCR0.DSS) reaches the byte-wide devices MSB first: one byte for ≤ 8 bits, two above.
 * - `UsbSerialBridge`: USB serial (arduino-pico's `Serial`, MicroPython's REPL) as a UartPort —
 *   rp2040js's CDC host enumerates the device; bytes sent before that are lost, as on a board.
 *   rp2040js's host answers every OUT endpoint the device arms at once, with an empty packet when
 *   it has nothing to send — TinyUSB re-arms, and the USB interrupt fires every few microseconds
 *   (an idle MicroPython REPL never slept). A real host sends OUT data only when it has some: arms
 *   are held here until bytes are queued. While a MicroPython sketch is being put on the board
 *   (micropython.ts) the installer owns the line.
 *
 * Pin roles follow the function select both chips share: I2C n on GPIOs whose (n >> 1) & 1 is
 * the controller, SDA even, SCL odd; SPI n where (n >> 3) & 1 is the controller, the low two bits
 * RX, CSn, SCK, TX.
 */

import type { I2cController, I2cDevice, SpiController, SpiDevice, UartPort } from '@benchtop/core';
import { I2CMode, type RPI2C, type RPUSBController, USBCDC } from 'rp2040js';
import type { MicroPythonInstaller } from './micropython.ts';

export const FUNC_SPI = 1;
export const FUNC_I2C = 3;
/** How often a MicroPython install's timeouts and REPL pokes are checked (simulated ns). */
const INSTALL_TICK_NANOS = 50_000_000;

/** What the bridges see of a chip's pins: how many, and each one's function select. */
export interface PinFunctions {
  readonly count: number;
  funcsel(n: number): number;
}

/** rp2040js's clock interface: nanoseconds and alarms. */
export interface BridgeClock {
  readonly nanos: number;
  createAlarm(callback: () => void): { schedule(deltaNanos: number): void; cancel(): void };
}

export class I2cBridge implements I2cController {
  readonly index: number;
  private readonly peripheral: () => RPI2C;
  private readonly gpio: PinFunctions;
  private readonly devices: I2cDevice[] = [];
  private current: I2cDevice | null = null;

  constructor(index: number, peripheral: () => RPI2C, gpio: PinFunctions) {
    this.index = index;
    this.peripheral = peripheral;
    this.gpio = gpio;
  }

  /** Hooks the current chip's controller. */
  wire(): void {
    const i2c = this.peripheral();
    this.current = null;
    i2c.onStart = () => {
      this.current = null;
      i2c.completeStart();
    };
    i2c.onConnect = (address, mode) => {
      const device = this.devices.find((d) => d.address === address);
      this.current = device ?? null;
      i2c.completeConnect(device !== undefined && device.start(mode === I2CMode.Read));
    };
    i2c.onWriteByte = (value) => {
      i2c.completeWrite(this.current !== null && this.current.write(value));
    };
    i2c.onReadByte = (ack) => {
      i2c.completeRead(this.current === null ? 0xff : this.current.read(ack) & 0xff);
    };
    i2c.onStop = () => {
      this.current?.stop();
      this.current = null;
      i2c.completeStop();
    };
  }

  pins(): { sda: string; scl: string } {
    let sda = '';
    let scl = '';
    for (let n = 0; n < this.gpio.count; n++) {
      if (this.gpio.funcsel(n) !== FUNC_I2C || ((n >> 1) & 1) !== this.index) continue;
      if ((n & 1) === 0) sda ||= `GPIO${n}`;
      else scl ||= `GPIO${n}`;
    }
    // Before the firmware routes them: arduino-pico's Wire (GP4/GP5) and Wire1 (GP26/GP27).
    if (sda === '' && scl === '') return this.index === 0 ? { sda: 'GPIO4', scl: 'GPIO5' } : { sda: 'GPIO26', scl: 'GPIO27' };
    return { sda, scl };
  }

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices.push(device);
  }

  detach(device: I2cDevice): void {
    const i = this.devices.indexOf(device);
    if (i >= 0) this.devices.splice(i, 1);
  }
}

/** What SpiBridge needs of a PL022 model (rp2040js's RPSPI has it; so does the RP2350's). */
export interface SpiPeripheral {
  onTransmit: (value: number) => void;
  completeTransmit(rx: number): void;
  readonly dataBits: number;
}

export class SpiBridge implements SpiController {
  readonly index: number;
  private readonly peripheral: () => SpiPeripheral;
  private readonly gpio: PinFunctions;
  private readonly devices: { device: SpiDevice; selected: () => boolean }[] = [];

  constructor(index: number, peripheral: () => SpiPeripheral, gpio: PinFunctions) {
    this.index = index;
    this.peripheral = peripheral;
    this.gpio = gpio;
  }

  wire(): void {
    const spi = this.peripheral();
    spi.onTransmit = (value) => {
      const wide = spi.dataBits > 8;
      let rx = wide ? 0xffff : 0xff;
      for (const { device, selected } of this.devices) {
        if (!selected()) continue;
        rx = wide ? ((device.transfer((value >> 8) & 0xff) & 0xff) << 8) | (device.transfer(value & 0xff) & 0xff) : device.transfer(value & 0xff) & 0xff;
      }
      spi.completeTransmit(rx);
    };
  }

  pins(): { sck: string; mosi: string; miso: string } {
    let sck = '';
    let mosi = '';
    let miso = '';
    for (let n = 0; n < this.gpio.count; n++) {
      if (this.gpio.funcsel(n) !== FUNC_SPI || ((n >> 3) & 1) !== this.index) continue;
      const role = n & 3; // RX, CSn, SCK, TX
      if (role === 0) miso ||= `GPIO${n}`;
      else if (role === 2) sck ||= `GPIO${n}`;
      else if (role === 3) mosi ||= `GPIO${n}`;
    }
    // Before the firmware routes them: arduino-pico's SPI (GP16–19) and SPI1 (GP12–15).
    if (sck === '' && mosi === '' && miso === '') return this.index === 0 ? { sck: 'GPIO18', mosi: 'GPIO19', miso: 'GPIO16' } : { sck: 'GPIO14', mosi: 'GPIO15', miso: 'GPIO12' };
    return { sck, mosi, miso };
  }

  attach(device: SpiDevice, selected: () => boolean): void {
    if (!this.devices.some((d) => d.device === device)) this.devices.push({ device, selected });
  }

  detach(device: SpiDevice): void {
    const i = this.devices.findIndex((d) => d.device === device);
    if (i >= 0) this.devices.splice(i, 1);
  }
}

export class UsbSerialBridge implements UartPort {
  readonly listeners: ((byte: number) => void)[] = [];
  /**
   * BT63: while a MicroPython sketch is being put on the board, the installer owns the line —
   * the device's output goes to it, and bytes the bench sends wait in `held` until main.py runs.
   */
  installer: MicroPythonInstaller | null = null;
  private readonly usb: () => RPUSBController;
  private readonly clock: () => BridgeClock;
  private cdc: USBCDC | null = null;
  private connected = false;
  private readonly pending: number[] = [];
  private readonly held: number[] = [];
  /** Per endpoint: the byte count of an OUT arm held while the host had nothing to send (−1: none). */
  private readonly heldReads = new Int32Array(16).fill(-1);
  private hostRead: ((endpoint: number, size: number) => void) | undefined;

  constructor(usb: () => RPUSBController, clock: () => BridgeClock) {
    this.usb = usb;
    this.clock = clock;
  }

  /** Hooks the current chip's USB controller (a new one after each reset). */
  wire(installer: MicroPythonInstaller | null): void {
    const usb = this.usb();
    const cdc = new USBCDC(usb);
    this.cdc = cdc;
    this.connected = false;
    this.pending.length = 0;
    this.held.length = 0;
    this.heldReads.fill(-1);
    this.installer = installer;
    const clock = this.clock();
    const ticker = clock.createAlarm(() => {
      const active = this.installer;
      if (active === null || !active.active) return;
      active.tick(clock.nanos / 1e6);
      this.release();
      if (active.active) ticker.schedule(INSTALL_TICK_NANOS);
    });
    const hostRead = usb.onEndpointRead;
    this.hostRead = hostRead;
    usb.onEndpointRead = (endpoint, size) => {
      if (cdc.txFIFO.empty) this.heldReads[endpoint & 15] = size;
      else hostRead?.(endpoint, size);
    };
    cdc.onDeviceConnected = () => {
      this.connected = true;
      this.flush();
      if (this.installer !== null) ticker.schedule(0);
    };
    cdc.onSerialData = (buffer) => {
      for (const byte of buffer) {
        if (this.installer?.output(byte, clock.nanos / 1e6) === true) continue;
        for (const listener of this.listeners) listener(byte);
      }
      this.release();
    };
  }

  /** Bytes from the installer (the raw REPL conversation). */
  send(bytes: readonly number[]): void {
    for (const b of bytes) this.pending.push(b);
    this.flush();
  }

  /** Once the installer is done, the bench's held bytes go to the device. */
  private release(): void {
    if (this.installer === null || this.installer.active) return;
    this.installer = null;
    this.send(this.held.splice(0));
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  receive(bytes: Uint8Array): void {
    if (this.installer !== null) {
      for (const b of bytes) this.held.push(b);
      return;
    }
    for (const b of bytes) this.pending.push(b);
    this.flush();
  }

  /** Moves pending bytes into the CDC host's FIFO while it has room (the firmware drains it). */
  flush(): void {
    const cdc = this.cdc;
    if (cdc === null || !this.connected) return;
    while (this.pending.length > 0 && !cdc.txFIFO.full) cdc.sendSerialByte(this.pending.shift() as number);
    if (cdc.txFIFO.empty) return;
    for (let endpoint = 0; endpoint < 16; endpoint++) {
      const size = this.heldReads[endpoint];
      if (size < 0) continue;
      this.heldReads[endpoint] = -1;
      this.hostRead?.(endpoint, size);
    }
  }

  pins(): { tx?: string; rx?: string } {
    return {};
  }

  baud(): number | undefined {
    return undefined;
  }
}
