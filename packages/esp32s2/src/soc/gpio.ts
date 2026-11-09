/**
 * The ESP32-S2's GPIO, GPIO matrix and IO_MUX (BT149): @benchtop/esp32s3's model (S3Gpio, S3IoMux,
 * S3Pads), whose registers the S2 has at the same offsets (gpio_reg.h: 397 of 397), over the S2's
 * 47 pads — GPIO0–21 and 26–46; 27–32 are the module's flash (refused, as on the S3; BT150: GPIO26,
 * SPICS1 — the PSRAM's chip select — is a GPIO here: the DevKitM-1's S2FH4 has no PSRAM and breaks
 * it out; BT154: an N4R2's PSRAM holds it, and the firmware taking it from a running PSRAM is
 * `pin-reserved`) — with the S2's signal numbers (gpio_sig_map.h) and interrupt sources. IO_MUX's functions sit where the
 * S3's do: U0TXD/U0RXD on 43/44 (function 0), U1TXD/U1RXD on 17/18 (2), FSPI on 10–13 (4) and
 * 34–37 (2).
 */

import { type GpioChip } from '@benchtop/esp32s3';
import { S2_SRC } from './intmatrix.ts';

export const S2_GPIO_BASE = 0x3f404000;
export const S2_IO_MUX_BASE = 0x3f409000;
/** GPIO0–46 (indexes 22–25 are no pads). */
export const S2_PADS = 47;
/** gpio_sig_map.h signals the models use (the S2 has no UART2: −1). */
export const S2_SIG = {
  U0TXD: 14,
  U0RXD: 14,
  U1TXD: 17,
  U1RXD: 17,
  U2TXD: -1,
  U2RXD: -1,
  LEDC0: 79,
  RMT0: 87,
  I2C0_SCL: 29,
  I2C0_SDA: 30,
  I2C1_SCL: 95,
  I2C1_SDA: 96,
  FSPICLK: 108,
  FSPIQ: 109,
  FSPID: 110,
  FSPICS0: 117,
} as const;
export const CODE_S2_FLASH_PIN = 'esp32s2-flash-pin';

export const S2_GPIO_CHIP: GpioChip = { pads: S2_PADS, sig: S2_SIG, gpioSource: S2_SRC.GPIO, nmiSource: S2_SRC.GPIO_NMI, gpioBase: S2_GPIO_BASE, ioMuxBase: S2_IO_MUX_BASE, flashPinCode: CODE_S2_FLASH_PIN, firstFlashPad: 27, psramCsPad: 26 };

/** Is `g` a pad (GPIO0–21, 26–46)? */
export const isS2Pad = (g: number): boolean => g >= 0 && g < S2_PADS && (g < 22 || g > 25);
/** Is `g` one of the module's flash pads (GPIO27–32; GPIO26, SPICS1, is free without PSRAM — BT150)? */
export const isS2FlashPad = (g: number): boolean => g >= 27 && g <= 32;
