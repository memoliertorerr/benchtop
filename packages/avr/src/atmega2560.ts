/**
 * The ATmega2560 (Arduino Mega 2560, BT46) as a Benchtop `Mcu`: the shared AVR adapter
 * (avr-mcu.ts) over this chip's table. avr8js runs its core — 256 KiB flash, so a 22-bit PC with
 * 3-byte return addresses, EIND for EICALL/EIJMP and RAMPZ for ELPM — and ships its ports' PIN/
 * DDR/PORT addresses; everything else here is the 2560's own peripheral map.
 *
 * Sources: the ATmega640/1280/1281/2560/2561 datasheet — chapters "Interrupts" (the Reset and
 * Interrupt Vectors table: 57 vectors, two words each, so vector n is at word address 2n),
 * "External Interrupts" (INT0–3 on PD0–3 via EICRA, INT4–7 on PE4–7 via EICRB; PCINT0–7 on
 * PB0–7, PCINT8 on PE0, PCINT9–15 on PJ0–6, PCINT16–23 on PK0–7), the Timer/Counter chapters
 * (timers 0/2 8-bit, 1/3/4/5 16-bit with channels A/B/C; the OCnx and Tn pins in "I/O-Ports"),
 * "USART", "Analog to Digital Converter" (MUX5 in ADCSRB selects ADC8–15 on PK0–7; ADC0–7 are
 * PF0–7) and "Register Summary". Every address and vector below was cross-checked against
 * avr-libc's `iomxx0_1.h` (avr-gcc 7.3.0-atmel3.6.1, as shipped with Arduino AVR core 1.8.7 —
 * the toolchain the fixture firmware is compiled with).
 *
 * Pins: 'PA0'–'PA7', 'PB0'…'PL7' (no port I; port G has bits 0–5): 86 I/O pins. USART TX/RX:
 * PE1/PE0, PD3/PD2, PH1/PH0, PJ1/PJ0. SPI: SCK PB1, MOSI PB2, MISO PB3. TWI: SDA PD1, SCL PD0.
 * SRAM is 8 KiB at 0x200–0x21FF (extended I/O fills 0x60–0x1FF); EEPROM 4 KiB.
 */

import {
  ADCMuxInputType,
  ADCReference,
  type ADCConfig,
  type AVRExternalInterrupt,
  type AVRPinChangeInterrupt,
  type AVRPortConfig,
  type AVRTimerConfig,
  adcConfig,
  clockConfig,
  eepromConfig,
  portAConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  portEConfig,
  portFConfig,
  portGConfig,
  portHConfig,
  portJConfig,
  portKConfig,
  portLConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import { type AvrChip, AvrMcu } from './avr-mcu.ts';

/** The Mega's crystal. */
export const MEGA_CLOCK_HZ = 16_000_000;
export const ATMEGA2560_FLASH_BYTES = 256 * 1024;
export const ATMEGA2560_SRAM_BYTES = 8 * 1024;
export const ATMEGA2560_EEPROM_BYTES = 4 * 1024;
/** RAMEND: the last SRAM address (SP's reset value). */
export const ATMEGA2560_RAMEND = 0x21ff;

/** Vector n (Table 14-1) as avr8js wants it: its word address. */
const vector = (n: number): number => n * 2;

// External interrupts: EICRA (0x69) holds ISC0–3, EICRB (0x6A) ISC4–7; EIMSK 0x3D, EIFR 0x3C.
const int = (index: number): AVRExternalInterrupt => ({
  EICR: index < 4 ? 0x69 : 0x6a,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index,
  iscOffset: (index % 4) * 2,
  interrupt: vector(1 + index), // INT0_vect is vector 1 … INT7_vect vector 8
});
// Pin change interrupts: PCICR 0x68, PCIFR 0x3B, PCMSK0–2 at 0x6B–0x6D.
const pcint = (group: number, mask: number, offset: number): AVRPinChangeInterrupt => ({
  PCIE: group,
  PCICR: 0x68,
  PCIFR: 0x3b,
  PCMSK: 0x6b + group,
  pinChangeInterrupt: vector(9 + group), // PCINT0_vect is vector 9
  mask,
  offset,
});

/** A port at avr8js's PIN/DDR/PORT addresses, with only the 2560's interrupts (none of the 328P's). */
const port = (base: AVRPortConfig, extra: Partial<AVRPortConfig> = {}): AVRPortConfig => ({ PIN: base.PIN, DDR: base.DDR, PORT: base.PORT, externalInterrupts: [], ...extra });
const PORT_B = portBConfig.PORT;
const PORT_D = portDConfig.PORT;
const PORT_E = portEConfig.PORT;
const PORT_G = portGConfig.PORT;
const PORT_H = portHConfig.PORT;
const PORT_L = portLConfig.PORT;

const PORTS: AvrChip['ports'] = [
  { letter: 'A', config: port(portAConfig), bits: 8 },
  { letter: 'B', config: port(portBConfig, { pinChange: pcint(0, 0xff, 0) }), bits: 8 },
  { letter: 'C', config: port(portCConfig), bits: 8 },
  { letter: 'D', config: port(portDConfig, { externalInterrupts: [int(0), int(1), int(2), int(3)] }), bits: 8 },
  { letter: 'E', config: port(portEConfig, { pinChange: pcint(1, 0x01, 0), externalInterrupts: [null, null, null, null, int(4), int(5), int(6), int(7)] }), bits: 8 },
  { letter: 'F', config: port(portFConfig), bits: 8 },
  { letter: 'G', config: port(portGConfig), bits: 6 },
  { letter: 'H', config: port(portHConfig), bits: 8 },
  { letter: 'J', config: port(portJConfig, { pinChange: pcint(1, 0x7f, 1) }), bits: 8 },
  { letter: 'K', config: port(portKConfig, { pinChange: pcint(2, 0xff, 0) }), bits: 8 },
  { letter: 'L', config: port(portLConfig), bits: 8 },
];

// Timers. Timer 0/2 keep avr8js's 328P register addresses (identical on the 2560) with
// the 2560's vectors and output pins; timers 3/4/5 are timer 1's design at their own addresses.
const TIMERS: readonly AVRTimerConfig[] = [
  {
    ...timer0Config,
    compAInterrupt: vector(21),
    compBInterrupt: vector(22),
    ovfInterrupt: vector(23),
    compPortA: PORT_B, // OC0A PB7
    compPinA: 7,
    compPortB: PORT_G, // OC0B PG5
    compPinB: 5,
    externalClockPort: PORT_D, // T0 PD7
    externalClockPin: 7,
  },
  {
    ...timer1Config,
    captureInterrupt: vector(16),
    compAInterrupt: vector(17),
    compBInterrupt: vector(18),
    compCInterrupt: vector(19),
    ovfInterrupt: vector(20),
    OCRC: 0x8c,
    compPortA: PORT_B, // OC1A PB5, OC1B PB6, OC1C PB7
    compPinA: 5,
    compPortB: PORT_B,
    compPinB: 6,
    compPortC: PORT_B,
    compPinC: 7,
    externalClockPort: PORT_D, // T1 PD6
    externalClockPin: 6,
  },
  {
    ...timer2Config,
    compAInterrupt: vector(13),
    compBInterrupt: vector(14),
    ovfInterrupt: vector(15),
    compPortA: PORT_B, // OC2A PB4
    compPinA: 4,
    compPortB: PORT_H, // OC2B PH6
    compPinB: 6,
  },
  timer16({ capt: 31, regs: 0x90, tifr: 0x38, timsk: 0x71, port: PORT_E, pins: [3, 4, 5], clockPin: 6 }),
  timer16({ capt: 41, regs: 0xa0, tifr: 0x39, timsk: 0x72, port: PORT_H, pins: [3, 4, 5], clockPin: 7 }),
  timer16({ capt: 46, regs: 0x120, tifr: 0x3a, timsk: 0x73, port: PORT_L, pins: [3, 4, 5], clockPin: 2 }),
];

/**
 * Timer 3/4/5: TCCRnA at `regs`, then TCCRnB +1, TCCRnC +2, TCNTn +4, ICRn +6, OCRnA/B/C +8/+10/+12;
 * vectors CAPT, COMPA, COMPB, COMPC, OVF from `capt` on; OCnA/B/C and Tn on one port.
 */
function timer16(t: { capt: number; regs: number; tifr: number; timsk: number; port: number; pins: readonly [number, number, number]; clockPin: number }): AVRTimerConfig {
  return {
    ...timer1Config,
    captureInterrupt: vector(t.capt),
    compAInterrupt: vector(t.capt + 1),
    compBInterrupt: vector(t.capt + 2),
    compCInterrupt: vector(t.capt + 3),
    ovfInterrupt: vector(t.capt + 4),
    TIFR: t.tifr,
    TCCRA: t.regs,
    TCCRB: t.regs + 1,
    TCCRC: t.regs + 2,
    TCNT: t.regs + 4,
    ICR: t.regs + 6,
    OCRA: t.regs + 8,
    OCRB: t.regs + 10,
    OCRC: t.regs + 12,
    TIMSK: t.timsk,
    compPortA: t.port,
    compPinA: t.pins[0],
    compPortB: t.port,
    compPinB: t.pins[1],
    compPortC: t.port,
    compPinC: t.pins[2],
    externalClockPort: t.port,
    externalClockPin: t.clockPin,
  };
}

/** USART n's registers (UCSRnA at `base`; UBRRnL +4, UBRRnH +5, UDRn +6) and vectors (RX, UDRE, TX from `rx`). */
const usart = (base: number, rx: number): typeof usart0Config => ({
  rxCompleteInterrupt: vector(rx),
  dataRegisterEmptyInterrupt: vector(rx + 1),
  txCompleteInterrupt: vector(rx + 2),
  UCSRA: base,
  UCSRB: base + 1,
  UCSRC: base + 2,
  UBRRL: base + 4,
  UBRRH: base + 5,
  UDR: base + 6,
});

// ADC: MUX5:0 = 000000–000111 ADC0–7 (PF0–7), 011110 1.1 V bandgap, 011111 0 V (GND),
// 100000–100111 ADC8–15 (PK0–7); the differential and gain settings read 0 V here (Arduino never
// selects them). REFS1:0 = 00 AREF, 01 AVCC, 10 1.1 V, 11 2.56 V.
const muxChannels: ADCConfig['muxChannels'] = { 0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 }, 0x1f: { type: ADCMuxInputType.Constant, voltage: 0 } };
for (let c = 0; c < 8; c++) {
  muxChannels[c] = { type: ADCMuxInputType.SingleEnded, channel: c };
  muxChannels[0x20 + c] = { type: ADCMuxInputType.SingleEnded, channel: 8 + c };
}

export const ATMEGA2560: AvrChip = Object.freeze({
  kind: 'atmega2560',
  name: 'ATmega2560',
  clockHz: MEGA_CLOCK_HZ,
  flashBytes: ATMEGA2560_FLASH_BYTES,
  // avr8js allocates 0x100 bytes of registers and I/O, then this: the extended I/O 0x100–0x1FF
  // (ports H–L, timer 5, USART3) and the 8 KiB of SRAM, so SP starts at RAMEND 0x21FF.
  cpuDataBytes: ATMEGA2560_RAMEND + 1 - 0x100,
  eepromBytes: ATMEGA2560_EEPROM_BYTES,
  ports: PORTS,
  timers: TIMERS,
  usarts: [
    { config: usart(0xc0, 25), tx: 'PE1', rx: 'PE0' },
    { config: usart(0xc8, 36), tx: 'PD3', rx: 'PD2' },
    { config: usart(0xd0, 51), tx: 'PH1', rx: 'PH0' },
    { config: usart(0x130, 54), tx: 'PJ1', rx: 'PJ0' },
  ],
  spi: { config: { ...spiConfig, spiInterrupt: vector(24) }, pins: { sck: 'PB1', mosi: 'PB2', miso: 'PB3' } },
  twi: { config: { ...twiConfig, twiInterrupt: vector(39) }, pins: { sda: 'PD1', scl: 'PD0' } },
  adc: {
    ...adcConfig,
    adcInterrupt: vector(29),
    numChannels: 16,
    muxInputMask: 0x3f,
    muxChannels,
    adcReferences: [ADCReference.AREF, ADCReference.AVCC, ADCReference.Internal1V1, ADCReference.Internal2V56],
  },
  adcPins: [...Array.from({ length: 8 }, (_, i) => `PF${i}`), ...Array.from({ length: 8 }, (_, i) => `PK${i}`)],
  eeprom: { ...eepromConfig, eepromReadyInterrupt: vector(30) },
  watchdog: { ...watchdogConfig, watchdogInterrupt: vector(12) },
  clock: clockConfig,
});

export class Atmega2560 extends AvrMcu {
  constructor() {
    super(ATMEGA2560);
  }
}

/** A fresh Mega MCU. */
export function createAtmega2560(): Atmega2560 {
  return new Atmega2560();
}
