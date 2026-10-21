/**
 * Transaction-level buses. MCU peripherals (TWI/I2C, SPI) talk to part models through these,
 * not through bit-level edges: avr8js's TWI is transaction-level, and edge-level I2C would cost
 * ~1 M net events per second for no visible gain. The bench attaches a device to a controller
 * when the device's pins share nets with the controller's current pins.
 *
 * Devices are implemented by part models (an SSD1306, a PCF8574 backpack) and registered with
 * `PartContext.attachI2c` / `attachSpi`. Controllers are implemented by MCU adapters and
 * exposed through `Mcu.i2c()` / `Mcu.spi()`. All calls happen inside the MCU's run, so
 * `PartContext.now()` is the transaction's time.
 */

/** An I2C target. The controller calls these in bus order: start, write/read…, stop. */
export interface I2cDevice {
  /** 7-bit address (0x00–0x7F). May be a getter: the controller reads it at every START. */
  readonly address: number;
  /** START (or repeated START) addressed to this device with R/W; return true to ACK. */
  start(read: boolean): boolean;
  /** The controller wrote one byte (0–255); return true to ACK. */
  write(byte: number): boolean;
  /**
   * The controller reads one byte; return it (0–255). `ack` = the controller will ACK it and
   * read another byte; false = this is the last byte.
   */
  read(ack: boolean): number;
  /** STOP: the transaction ended. */
  stop(): void;
}

/** An SPI target. Called by the controller once per byte while the device is selected. */
export interface SpiDevice {
  /** Shift one byte: `mosi` in (0–255), MISO byte out (0–255). */
  transfer(mosi: number): number;
}

/** An MCU's I2C peripheral (master), as the bench sees it. */
export interface I2cController {
  /** MCU pin ids (`McuPin.id`) currently routed to SDA and SCL; ESP32 can remap them at run time. */
  pins(): { sda: string; scl: string };
  /** Called by the bench: put `device` on this bus. */
  attach(device: I2cDevice): void;
  /** Called by the bench: take `device` off this bus. */
  detach(device: I2cDevice): void;
}

/** An MCU's SPI peripheral (master), as the bench sees it. */
export interface SpiController {
  /** MCU pin ids (`McuPin.id`) currently routed to SCK, MOSI and MISO. */
  pins(): { sck: string; mosi: string; miso: string };
  /**
   * Called by the bench: put `device` on this bus. `selected()` reads the device's CS net
   * (true while it is low); the controller transfers only to selected devices.
   */
  attach(device: SpiDevice, selected: () => boolean): void;
  /** Called by the bench: take `device` off this bus. */
  detach(device: SpiDevice): void;
}
