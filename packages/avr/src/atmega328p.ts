/**
 * The ATmega328P (Arduino Uno, Nano) as a Benchtop `Mcu`: the shared AVR adapter (avr-mcu.ts)
 * over this chip's table — CPU with 32 KiB flash and 2 KiB SRAM, ports B/C/D, timers 0/1/2 (with
 * timer-fix.ts's fast-PWM ordering fix), USART0, SPI, TWI, ADC, 1 KiB EEPROM, watchdog and clock,
 * all at avr8js's own 328P register/vector tables.
 *
 * Pins are 'PB0'–'PB7', 'PC0'–'PC6', 'PD0'–'PD7', plus 'ADC6'/'ADC7' (BT45): the analog-only
 * inputs of the TQFP/QFN packages (the Nano's A6/A7; the Uno's DIP has none, and its pin map
 * names neither). PC0–PC5 are ADC0–ADC5. PD1 (TXD) reports 'peripheral' while USART0 transmits.
 */

import {
  adcConfig,
  clockConfig,
  eepromConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import { type AvrChip, AvrMcu, AVR_VIH, AVR_VIL } from './avr-mcu.ts';

/** The Uno's crystal. */
export const UNO_CLOCK_HZ = 16_000_000;
export const ATMEGA328P_FLASH_BYTES = 32 * 1024;
export const ATMEGA328P_SRAM_BYTES = 2048;
export const ATMEGA328P_EEPROM_BYTES = 1024;
/** Input thresholds at 5 V (datasheet VIH min 0.6 VCC, VIL max 0.3 VCC). */
export const ATMEGA328P_VIH = AVR_VIH;
export const ATMEGA328P_VIL = AVR_VIL;

export const ATMEGA328P: AvrChip = Object.freeze({
  kind: 'atmega328p',
  name: 'ATmega328P',
  clockHz: UNO_CLOCK_HZ,
  flashBytes: ATMEGA328P_FLASH_BYTES,
  cpuDataBytes: ATMEGA328P_SRAM_BYTES,
  eepromBytes: ATMEGA328P_EEPROM_BYTES,
  ports: [
    { letter: 'B', config: portBConfig, bits: 8 },
    { letter: 'C', config: portCConfig, bits: 7 },
    { letter: 'D', config: portDConfig, bits: 8 },
  ],
  timers: [timer0Config, timer1Config, timer2Config],
  usarts: [{ config: usart0Config, tx: 'PD1', rx: 'PD0' }],
  spi: { config: spiConfig, pins: { sck: 'PB5', mosi: 'PB3', miso: 'PB4' } },
  twi: { config: twiConfig, pins: { sda: 'PC4', scl: 'PC5' } },
  adc: adcConfig,
  adcPins: ['PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5', 'ADC6', 'ADC7'],
  eeprom: eepromConfig,
  watchdog: watchdogConfig,
  clock: clockConfig,
});

export class Atmega328p extends AvrMcu {
  constructor() {
    super(ATMEGA328P);
  }
}

/** A fresh Uno (or Nano) MCU. */
export function createAtmega328p(): Atmega328p {
  return new Atmega328p();
}
