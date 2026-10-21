import { type I2cDevice, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { avrMcuFactory } from './index.ts';
import { createAtmega328p, UNO_CLOCK_HZ } from './atmega328p.ts';
import { bootFixture, duty, intervals, volts, watch } from './avr.test-helper.ts';

// Real firmware from fixtures/firmware/uno/ (built by `npm run fixtures`), run on the Mcu with no
// bench. Timing is measured in CPU cycles: 16,000 cycles per millisecond.

const MS = UNO_CLOCK_HZ / 1000;

function boot(name: string, format: 'hex' | 'elf' = 'hex', board = 'uno') {
  return bootFixture(createAtmega328p, board, name, format);
}

describe('ATmega328P on avr8js', () => {
  it('blink: PB5 toggles every 8,000,000 cycles ±0.5% and UART0 says "hello"', () => {
    const { mcu, text } = boot('blink');
    const edges = watch(mcu, 'PB5');
    const start = performance.now();
    mcu.runUntil(2100 * MS);
    const wallMs = performance.now() - start;
    console.info(`uno blink: ${(mcu.cycles / 1e6).toFixed(1)} M cycles in ${wallMs.toFixed(0)} ms = ${(mcu.cycles / wallMs / 1000).toFixed(1)} simulated MHz`);
    expect(edges.map((e) => e.level)).toEqual([1, 0, 1, 0, 1]);
    for (const gap of intervals(edges)) expect(Math.abs(gap - 8_000_000)).toBeLessThanOrEqual(40_000);
    expect(text()).toBe('hello\r\n');
    // The USART transmitter owns TX (PD1) once Serial.begin ran: a peripheral pin, idle high.
    expect(mcu.pins.get('PD1')?.mode()).toBe('peripheral');
    expect(mcu.pins.get('PD1')?.outputLevel()).toBe(1);
  });

  it('runs the same blink from the ELF', () => {
    const { mcu, text } = boot('blink', 'elf');
    const edges = watch(mcu, 'PB5');
    mcu.runUntil(1100 * MS);
    expect(edges.map((e) => e.level)).toEqual([1, 0, 1]);
    expect(text()).toBe('hello\r\n');
  });

  it('serial-echo: "abc" comes back, never faster than one byte per character time', () => {
    const { mcu, text, serial } = boot('serial-echo');
    mcu.runUntil(20 * MS);
    mcu.uart(0)?.receive(new Uint8Array([0x61, 0x62, 0x63]));
    mcu.runUntil(60 * MS);
    expect(text()).toBe('abc');
    // 9600 baud, UBRR 103: (103 + 1) × 16 × 10 bits = 16,640 cycles per byte.
    for (const gap of intervals(serial)) expect(gap).toBeGreaterThanOrEqual(16_640);
  });

  it('analog-read: PC0 at 2.5 V prints 511 or 512, 0 V prints 0, 5 V prints 1023', () => {
    const { mcu, lines } = boot('analog-read');
    const a0 = mcu.pins.get('PC0');
    a0?.setInput(volts(2.5));
    mcu.runUntil(150 * MS);
    expect(['511', '512']).toContain(lines().at(-1));
    a0?.setInput(volts(0));
    mcu.runUntil(300 * MS);
    expect(lines().at(-1)).toBe('0');
    a0?.setInput(volts(5));
    mcu.runUntil(450 * MS);
    expect(lines().at(-1)).toBe('1023');
  });

  it('ADC6/ADC7 (BT45, the Nano\'s A6/A7): feed the ADC, never drive, keep their volts across reset', () => {
    const { mcu, lines } = boot('analog-a6', 'hex', 'nano');
    const a6 = mcu.pins.get('ADC6');
    const a7 = mcu.pins.get('ADC7');
    const changes: string[] = [];
    a6?.onOutputChange(() => changes.push('a6'));
    a6?.setInput(volts(1.25, null));
    a7?.setInput(volts(3.75, null));
    mcu.runUntil(250 * MS);
    const reading = () => (lines().at(-1) ?? '').split(' ').map(Number);
    const [r6, r7] = reading();
    expect(Math.abs(r6 - 256)).toBeLessThanOrEqual(2);
    expect(Math.abs(r7 - 768)).toBeLessThanOrEqual(2);
    expect([a6?.mode(), a7?.mode()]).toEqual(['analog', 'analog']); // init() enabled the ADC
    expect([a6?.outputLevel(), a7?.outputLevel()]).toEqual([0, 0]);
    expect(changes).toEqual([]);
    mcu.reset();
    expect(a6?.mode()).toBe('input'); // ADC off until init() runs again
    mcu.runUntil(mcu.cycles + 250 * MS);
    const [s6, s7] = reading();
    expect(Math.abs(s6 - 256)).toBeLessThanOrEqual(2);
    expect(Math.abs(s7 - 768)).toBeLessThanOrEqual(2);
  });

  it('pwm-fade: PB1 duty over 20 ms rises across the first second', () => {
    const { mcu } = boot('pwm-fade');
    const edges = watch(mcu, 'PB1');
    mcu.runUntil(1020 * MS);
    const duties = [200, 400, 600, 800, 1000].map((t) => duty(edges, t * MS, (t + 20) * MS));
    for (let i = 1; i < duties.length; i++) expect(duties[i]).toBeGreaterThan(duties[i - 1]);
    expect(duties[0]).toBeGreaterThan(0);
    expect(duties[4]).toBeLessThan(0.5);
  });

  it('tone: PB0 is a 440 Hz ±1% square wave', () => {
    const { mcu } = boot('tone');
    const edges = watch(mcu, 'PB0');
    mcu.runUntil(300 * MS);
    const rising = edges.filter((e) => e.level === 1 && e.cycle > 50 * MS);
    const period = (rising.at(-1)!.cycle - rising[0].cycle) / (rising.length - 1);
    expect(Math.abs(UNO_CLOCK_HZ / period - 440)).toBeLessThan(4.4);
  });

  it('interrupt: 5 falling edges on PD2 print a count of 5', () => {
    const { mcu, lines } = boot('interrupt');
    const d2 = mcu.pins.get('PD2');
    d2?.setInput(volts(5)); // the INPUT_PULLUP idle level a bench would report
    mcu.runUntil(50 * MS);
    let t = 50;
    for (let i = 0; i < 5; i++) {
      d2?.setInput(volts(0));
      mcu.runUntil((t += 2) * MS);
      d2?.setInput(volts(5));
      mcu.runUntil((t += 2) * MS);
    }
    mcu.runUntil(300 * MS);
    expect(lines().at(-1)).toBe('5');
  });

  it('timer1-ctc: PB4 toggles at 1 kHz ±0.1%', () => {
    const { mcu } = boot('timer1-ctc');
    const edges = watch(mcu, 'PB4');
    mcu.runUntil(50 * MS);
    const gaps = intervals(edges.slice(2));
    expect(gaps.length).toBeGreaterThan(40);
    for (const gap of gaps) expect(Math.abs(gap - 16_000)).toBeLessThanOrEqual(16);
  });

  it('eeprom: writes 0..15, reads them back and prints "ok"', () => {
    const { mcu, text } = boot('eeprom');
    mcu.runUntil(200 * MS);
    expect(text()).toBe('ok\r\n');
  });

  it('i2c-scan: a device at 0x3C is found', () => {
    const { mcu, text } = boot('i2c-scan');
    const seen: string[] = [];
    const device: I2cDevice = {
      address: 0x3c,
      start: (read) => {
        seen.push(`start ${read ? 'read' : 'write'}`);
        return true;
      },
      write: () => true,
      read: () => 0xff,
      stop: () => seen.push('stop'),
    };
    mcu.i2c(0)?.attach(device);
    expect(mcu.i2c(0)?.pins()).toEqual({ sda: 'PC4', scl: 'PC5' });
    mcu.runUntil(300 * MS);
    expect(text()).toBe('0x3C\r\ndone\r\n');
    expect(seen).toEqual(['start write', 'stop']);
  });

  it('SPI: the selected device answers a byte (hand-assembled program)', () => {
    // ldi r16,0x50; out SPCR,r16; ldi r16,0xA5; out SPDR,r16; 1: in r17,SPSR; sbrs r17,7;
    // rjmp 1b; in r18,SPDR; ldi r19,0xFF; out DDRD,r19; out PORTD,r18; rjmp .  (checked with
    // avr-objdump -D -b binary -m avr5)
    const words = [0xe500, 0xbd0c, 0xea05, 0xbd0e, 0xb51d, 0xff17, 0xcffd, 0xb52e, 0xef3f, 0xb93a, 0xb92b, 0xcfff];
    const mcu = createAtmega328p();
    mcu.load({ format: 'hex', text: hexOf(words) });
    const received: number[] = [];
    mcu.spi(0)?.attach({ transfer: (mosi) => (received.push(mosi), 0x3c) }, () => true);
    mcu.runUntil(1000);
    expect(received).toEqual([0xa5]);
    const portD = [...Array(8).keys()].reduce((v, bit) => v | (mcu.pins.get(`PD${bit}`)!.outputLevel() << bit), 0);
    expect(portD).toBe(0x3c);
  });

  it('applies input thresholds with hysteresis, and floating inputs keep their last level', () => {
    const { mcu } = boot('button-pullup');
    const led = mcu.pins.get('PB5')!;
    const button = mcu.pins.get('PD2')!;
    button.setInput(volts(5));
    mcu.runUntil(5 * MS);
    expect(button.mode()).toBe('input-pullup');
    expect(led.outputLevel()).toBe(0);
    button.setInput(volts(0)); // pressed
    mcu.runUntil(6 * MS);
    expect(led.outputLevel()).toBe(1);
    button.setInput(volts(2.0, 0)); // between VIL and VIH: stays low
    mcu.runUntil(7 * MS);
    expect(led.outputLevel()).toBe(1);
    button.setInput(volts(3.5)); // above VIH
    mcu.runUntil(8 * MS);
    expect(led.outputLevel()).toBe(0);
    button.setInput({ level: null, strength: Strength.hiz, conflict: false, volts: 0 }); // floating
    mcu.runUntil(9 * MS);
    expect(led.outputLevel()).toBe(0);
  });

  it('keeps pin and UART objects (and their listeners) across reset, and halts without firmware', () => {
    expect(createAtmega328p().runUntil(1000)).toEqual({ reason: 'halted', detail: 'no firmware loaded' });
    const { mcu, text } = boot('blink');
    const edges = watch(mcu, 'PB5');
    const pinsBefore = [...mcu.pins.values()];
    mcu.runUntil(600 * MS);
    mcu.reset();
    expect(mcu.cycles).toBe(0);
    expect([...mcu.pins.values()]).toEqual(pinsBefore);
    mcu.runUntil(600 * MS);
    expect(edges.map((e) => e.level)).toEqual([1, 0, 1, 0]);
    expect(text()).toBe('hello\r\nhello\r\n');
    expect(mcu.pins.size).toBe(25); // ports B, C (7 bits), D, plus ADC6/ADC7
    expect(mcu.pins.has('PC6')).toBe(true);
    expect(mcu.pins.has('ADC7')).toBe(true);
  });

  it('rejects firmware it cannot run', () => {
    const mcu = createAtmega328p();
    expect(() => mcu.load({ format: 'esp32-bin', app: new Uint8Array(16) })).toThrow(/ESP32/);
    const elf = readFixture('fixtures/firmware/uno/blink.elf').slice();
    elf[18] = 94; // e_machine = Xtensa
    expect(() => mcu.load({ format: 'elf', bytes: elf })).toThrow(/not an AVR ELF/);
    expect(() => mcu.load({ format: 'hex', text: `${hexRecord(0x8000 - 2, [1, 2, 3, 4])}\n:00000001FF` })).toThrow(/beyond/);
  });

  it('is what avrMcuFactory makes for an atmega328p board', () => {
    expect(avrMcuFactory({ mcu: 'atmega328p', pinMap: {} })?.kind).toBe('atmega328p');
    expect(avrMcuFactory({ mcu: 'esp32', pinMap: {} })).toBeUndefined();
  });
});

function hexRecord(address: number, data: readonly number[]): string {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, 0, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0);
  bytes.push((0x100 - (sum & 0xff)) & 0xff);
  return `:${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Program words → Intel HEX (little-endian words, 16 bytes per record). */
function hexOf(words: readonly number[]): string {
  const bytes = words.flatMap((w) => [w & 0xff, w >> 8]);
  const records: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) records.push(hexRecord(i, bytes.slice(i, i + 16)));
  return `${records.join('\n')}\n:00000001FF\n`;
}
