import { Bench, EM_AVR, NS_PER_MS, parseElf32, parseProject } from '@benchtop/core';
import { fakeBoard, makeBenchEnv } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { ATMEGA2560_RAMEND, Atmega2560, createAtmega2560, MEGA_CLOCK_HZ } from './atmega2560.ts';
import { bootFixture, duty, intervals, volts, watch } from './avr.test-helper.ts';
import { avrMcuFactory } from './index.ts';

// BT46: real firmware built with arduino:avr:mega (fixtures/firmware/mega/) on the ATmega2560,
// no bench. Timing in CPU cycles: 16,000 per millisecond.

const MS = MEGA_CLOCK_HZ / 1000;
const boot = (name: string, format: 'hex' | 'elf' = 'hex') => bootFixture(createAtmega2560, 'mega', name, format);

describe('ATmega2560 on avr8js', () => {
  it('is what avrMcuFactory makes for an atmega2560 board: 86 I/O pins, SP at RAMEND 0x21FF', () => {
    const mcu = avrMcuFactory({ mcu: 'atmega2560', pinMap: {} });
    expect(mcu).toBeInstanceOf(Atmega2560);
    expect(mcu?.kind).toBe('atmega2560');
    expect(mcu?.pins.size).toBe(86);
    for (const id of ['PA0', 'PG5', 'PL7', 'PK7', 'PF0']) expect(mcu?.pins.has(id), id).toBe(true);
    for (const id of ['PG6', 'PI0', 'ADC6']) expect(mcu?.pins.has(id), id).toBe(false);
    const regs = new Uint32Array(35);
    if (mcu instanceof Atmega2560) mcu.debug().readRegisters(regs);
    expect(regs[33]).toBe(ATMEGA2560_RAMEND);
  });

  it('blink: PB7 (D13) toggles every 16,000,000 cycles ±1 % and USART0 says "mega"', () => {
    const { mcu, lines } = boot('blink');
    const edges = watch(mcu, 'PB7');
    mcu.runUntil(2100 * MS);
    expect(edges.map((e) => e.level)).toEqual([1, 0, 1]);
    for (const gap of intervals(edges)) expect(Math.abs(gap / (1000 * MS) - 1)).toBeLessThan(0.01);
    expect(lines()).toEqual(['mega']);
  });

  it('serial-ports: USART1–3 looped back each hear their byte; all four at ~115200 baud on their pins', () => {
    const { mcu, lines } = boot('serial-ports');
    for (const i of [1, 2, 3]) {
      const port = mcu.uart(i);
      port?.onTransmit((byte) => port.receive(Uint8Array.of(byte)));
    }
    mcu.runUntil(1500 * MS);
    // Two rounds (startup and 1 s). The three bytes land within microseconds of each other, so the
    // order the loop reports them in depends on where it is — as on the chip.
    expect(lines()[0]).toBe('ports');
    expect(lines().slice(1).sort()).toEqual(['S1 1', 'S1 1', 'S2 2', 'S2 2', 'S3 3', 'S3 3']);
    expect([0, 1, 2, 3].map((i) => mcu.uart(i)?.pins?.())).toEqual([
      { tx: 'PE1', rx: 'PE0' },
      { tx: 'PD3', rx: 'PD2' },
      { tx: 'PH1', rx: 'PH0' },
      { tx: 'PJ1', rx: 'PJ0' },
    ]);
    for (const i of [0, 1, 2, 3]) expect(Math.abs((mcu.uart(i)?.baud?.() ?? 0) / 115200 - 1)).toBeLessThan(0.03);
    expect(mcu.uart(4)).toBeUndefined();
    expect(mcu.pins.get('PJ1')?.mode()).toBe('peripheral'); // TX3 idles high while enabled
  });

  it('serial-ports on a bench: wires TX→RX loop Serial1–3 back (the bench links all four UARTs)', () => {
    const pins = ['PD3', 'PD2', 'PH1', 'PH0', 'PJ1', 'PJ0'];
    const parsed = parseProject({
      format: 1,
      name: 'mega loopback',
      parts: [{ id: 'mega', type: 'test-mega', x: 0, y: 0, rotation: 0, props: {} }],
      wires: [
        ['PD3', 'PD2'],
        ['PH1', 'PH0'],
        ['PJ1', 'PJ0'],
      ].map(([a, b], i) => ({ id: `w${i}`, from: { part: 'mega', pin: a }, to: { part: 'mega', pin: b }, waypoints: [], color: 'green' })),
      firmware: {},
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bench = new Bench(parsed.doc, makeBenchEnv([fakeBoard('test-mega', pins, 'atmega2560')], avrMcuFactory));
    bench.attachFirmware('mega', { format: 'hex', text: readFixtureText('fixtures/firmware/mega/serial-ports.hex') });
    const serial: number[] = [];
    bench.onSerial('mega', (bytes) => serial.push(...bytes));
    bench.runUntil(1200 * NS_PER_MS);
    const lines = String.fromCharCode(...serial).split('\r\n').slice(0, -1);
    expect(lines[0]).toBe('ports');
    expect(lines.slice(1).sort()).toEqual(['S1 1', 'S1 1', 'S2 2', 'S2 2', 'S3 3', 'S3 3']);
  });

  it('timers: 490 Hz PWM at 25 / 50 / 75 % from timers 3, 4 and 1; Timer5 CTC toggles PA0 every 1 ms', () => {
    const { mcu } = boot('timers');
    const pwm = { PE4: watch(mcu, 'PE4'), PH3: watch(mcu, 'PH3'), PB5: watch(mcu, 'PB5') };
    const d22 = watch(mcu, 'PA0');
    mcu.runUntil(120 * MS);
    for (const [pin, expected] of [
      ['PE4', 64 / 255],
      ['PH3', 128 / 255],
      ['PB5', 191 / 255],
    ] as const) {
      const edges = pwm[pin];
      const rising = edges.filter((e) => e.level === 1 && e.cycle > 20 * MS);
      const period = (rising.at(-1)!.cycle - rising[0].cycle) / (rising.length - 1);
      expect(Math.abs(MEGA_CLOCK_HZ / period / 490.196 - 1), `${pin} frequency`).toBeLessThan(0.01);
      expect(Math.abs(duty(edges, 20 * MS, 100 * MS) - expected), `${pin} duty`).toBeLessThan(0.01);
    }
    const toggles = intervals(d22.filter((e) => e.cycle > 10 * MS));
    expect(toggles.length).toBeGreaterThan(100);
    for (const gap of toggles) expect(Math.abs(gap - MS)).toBeLessThanOrEqual(20); // ±20 cycles of ISR latency
  });

  it('interrupts: INT5 (EICRB), INT2 (EICRA) and PCINT16 (PK0) fire on their edges', () => {
    const { mcu, lines } = boot('interrupts');
    const pins = ['PE5', 'PD2', 'PK0'].map((id) => mcu.pins.get(id));
    for (const pin of pins) pin?.setInput(volts(5)); // the INPUT_PULLUP idle level
    mcu.runUntil(50 * MS);
    let t = 50;
    const pulse = (index: number): void => {
      pins[index]?.setInput(volts(0));
      mcu.runUntil((t += 2) * MS);
      pins[index]?.setInput(volts(5));
      mcu.runUntil((t += 2) * MS);
    };
    for (let i = 0; i < 5; i++) pulse(0);
    for (let i = 0; i < 3; i++) pulse(1);
    for (let i = 0; i < 2; i++) pulse(2); // two pulses: four changes
    mcu.runUntil((t + 150) * MS);
    expect(lines().at(-1)).toBe('int5=5 int2=3 pcint=4');
  });

  it('analog-hi: A0–A7 (PF0–7) and A8–A15 (PK0–7, MUX5) read their volts', () => {
    const { mcu, text } = boot('analog-hi');
    const v = (i: number): number => 0.3 * (i + 1); // 0.3 … 4.8 V
    for (let i = 0; i < 8; i++) {
      mcu.pins.get(`PF${i}`)?.setInput(volts(v(i)));
      mcu.pins.get(`PK${i}`)?.setInput(volts(v(8 + i)));
    }
    mcu.runUntil(250 * MS);
    const readings = text().trimEnd().split('\n').at(-1)?.split(' ').map(Number) ?? [];
    expect(readings).toHaveLength(16);
    readings.forEach((r, i) => expect(Math.abs(r - Math.floor((v(i) / 5) * 1024)), `A${i}`).toBeLessThanOrEqual(2));
    expect(mcu.pins.get('PK3')?.mode()).toBe('analog');
  });

  it('eeprom: 4 KiB, writes at 0, 1024 and 4095 read back (no 1 KiB aliasing)', () => {
    const { mcu, lines } = boot('eeprom');
    mcu.runUntil(100 * MS);
    expect(lines()).toEqual(['4096', 'eeprom ok']);
    expect([mcu.eepromBytes[0], mcu.eepromBytes[1024], mcu.eepromBytes[4095], mcu.eepromBytes[1023]]).toEqual([0x11, 0x22, 0x33, 0xff]);
  });

  it('far-code: ELPM reads past 64 KiB, and code past 128 KiB runs, called directly and through a trampoline', () => {
    const { mcu, lines } = boot('far-code', 'elf');
    const elf = parseElf32(readFixture('fixtures/firmware/mega/far-code.elf'));
    expect(elf.machine).toBe(EM_AVR);
    const far = elf.symbols.find((s) => s.name === 'farFunction')?.value ?? 0;
    expect(far).toBeGreaterThan(0x20000);
    // The PC reaches it: a breakpoint there stops the run with PC = its byte address.
    const debug = mcu.debug();
    debug.setBreakpoint(far);
    expect(mcu.runUntil(100 * MS).reason).toBe('breakpoint');
    const regs = new Uint32Array(35);
    debug.readRegisters(regs);
    expect(regs[34]).toBe(far);
    debug.clearBreakpoint(far);
    mcu.runUntil(100 * MS);
    expect(lines()).toEqual(['tables 10 1F 20 2F 30 3F 40 4F 50 5F', 'direct 43', 'pointer 301', 'far ok']);
  });

  it('rejects firmware larger than its 256 KiB flash', () => {
    const mcu = createAtmega2560();
    const record = (address: number): string => {
      const bytes = [1, (address >> 8) & 0xff, address & 0xff, 0, 0];
      const sum = (0x100 - (bytes.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
      return `:${[...bytes, sum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    };
    // An extended linear address record for 0x40000 (256 KiB), then one byte there.
    const text = [':020000040004F6', record(0), ':00000001FF'].join('\n');
    expect(() => mcu.load({ format: 'hex', text })).toThrow();
  });
});
