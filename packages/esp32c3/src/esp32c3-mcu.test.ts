import type { McuPin, NetState } from '@benchtop/core';
import { Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { CODE_C3_ROM_MISSING, createEsp32c3Mcu, type Esp32c3Mcu } from './esp32c3-mcu.ts';
import { REF_HZ } from './soc/context.ts';
import type { SocProblem } from '@benchtop/esp32';
import { fixtureImage } from './test-support/boot.test-helper.ts';
import { loadCachedC3Rom } from './test-support/rom.test-helper.ts';

// BT94: the ESP32-C3 behind the Mcu contract, over BT93's fixtures.
const ROM = loadCachedC3Rom();

function boot(name: string): { mcu: Esp32c3Mcu; serial: () => string; problems: SocProblem[] } {
  const mcu = createEsp32c3Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...fixtureImage(name) });
  let text = '';
  mcu.uart(0)?.onTransmit((byte) => {
    text += String.fromCharCode(byte);
  });
  return { mcu, serial: () => text, problems };
}

function run(mcu: Esp32c3Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    if (result.reason === 'halted') throw new Error(result.detail ?? 'halted');
  }
}

const net = (volts: number | null): NetState => ({ level: volts === null ? null : volts > 1.65 ? 1 : 0, volts: volts ?? 0, strength: volts === null ? Strength.hiz : Strength.strong }) as NetState;

describe('the ESP32-C3 Mcu (BT94)', () => {
  it('is an esp32c3 with GPIO0–21 and a 160 MHz reference clock; its UART0 is the serial port', () => {
    const { mcu, serial } = boot('serial-hello');
    expect(mcu.kind).toBe('esp32c3');
    expect(mcu.clockHz).toBe(160_000_000);
    expect([...mcu.pins.keys()]).toEqual(Array.from({ length: 22 }, (_, i) => `GPIO${i}`));
    run(mcu, 1.2, () => serial().includes('tick 1'));
    expect(serial()).toBe('hello from esp32c3\r\ntick 1\n');
    expect(mcu.uart(0)?.pins?.()).toEqual({ tx: 'GPIO21', rx: 'GPIO20' });
    // IDF's fractional divider on the 80 MHz APB: within 0.05 % of 115200.
    expect(Math.abs((mcu.uart(0)?.baud?.() ?? 0) / 115200 - 1)).toBeLessThan(0.0005);
  });

  it('shows a CDC build’s USB-Serial-JTAG output on port 0, and sends typed bytes there', () => {
    const { mcu, serial } = boot('cdc-hello');
    run(mcu, 0.5, () => serial().includes('hello over usb'));
    expect(serial()).toContain('hello over usb');
    mcu.uart(0)?.receive(Uint8Array.from([...'ping\n'].map((c) => c.charCodeAt(0))));
    run(mcu, 0.3, () => serial().includes('> ping'));
    expect(serial()).toContain('> ping');
  });

  it('typed bytes reach UART0 for a UART build', () => {
    const { mcu, serial } = boot('serial-echo');
    run(mcu, 0.5, () => serial().includes('ready'));
    mcu.uart(0)?.receive(Uint8Array.from([...'abc\n'].map((c) => c.charCodeAt(0))));
    run(mcu, 0.2, () => serial().includes('> ABC\r\n'));
    expect(serial()).toContain('> ABC\r\n');
  });

  it('pins: inputs through 3.3 V thresholds, outputs with listeners (a button on GPIO9, the LED on GPIO3)', () => {
    const { mcu, serial } = boot('gpio-interrupt');
    const button = mcu.pins.get('GPIO9') as McuPin;
    const led = mcu.pins.get('GPIO3') as McuPin;
    let changes = 0;
    led.onOutputChange(() => changes++);
    button.setInput(net(3.3));
    run(mcu, 0.3);
    expect(button.mode()).toBe('input-pullup');
    expect(led.mode()).toBe('output');
    expect(led.outputLevel()).toBe(0);
    for (let i = 0; i < 3; i++) {
      button.setInput(net(0));
      run(mcu, 0.02);
      expect(led.outputLevel()).toBe(1);
      button.setInput(net(3.3));
      run(mcu, 0.02);
      expect(led.outputLevel()).toBe(0);
    }
    run(mcu, 0.1, () => serial().includes('count=3'));
    expect(serial()).toContain('count=3');
    expect(changes).toBeGreaterThanOrEqual(6);
    // 1.6 V sits between the thresholds: the pad keeps its last level.
    button.setInput(net(1.6));
    run(mcu, 0.02);
    expect(led.outputLevel()).toBe(0);
  });

  it('I2C and SPI follow the firmware’s routing, with the Arduino defaults before it', () => {
    const { mcu } = boot('i2c-scan');
    expect(mcu.i2c(0)?.pins()).toEqual({ sda: 'GPIO8', scl: 'GPIO9' });
    expect(mcu.spi(2)?.pins()).toEqual({ sck: 'GPIO4', mosi: 'GPIO6', miso: 'GPIO5' });
    expect(mcu.i2c(1)).toBeUndefined();
    expect(mcu.spi(3)).toBeUndefined();
  });

  it('breakpoints outlive a reset; the debugger reads the current SoC', () => {
    const { mcu } = boot('serial-hello');
    const debug = mcu.debug();
    debug.setBreakpoint(0x42000020);
    mcu.reset();
    expect(debug.breakpoints()).toEqual([0x42000020]);
    expect(mcu.soc.breakpoints.has(0x42000020)).toBe(true);
  });

  it('without its ROM it says how to get it and won’t run', () => {
    const mcu = createEsp32c3Mcu();
    const problems: SocProblem[] = [];
    mcu.onProblem = (p) => problems.push(p);
    expect(problems.map((p) => p.code)).toEqual([CODE_C3_ROM_MISSING]);
    expect(problems[0].message).toMatch(/fetch:esp32-rom/);
    mcu.load({ format: 'esp32-bin', ...fixtureImage('serial-hello') });
    expect(mcu.runUntil(1000)).toMatchObject({ reason: 'halted' });
    const bad = createEsp32c3Mcu({ rom: ROM.slice(1) });
    expect(bad.romProblem).toMatch(/isn't the pinned/);
    expect(() => createEsp32c3Mcu({ rom: ROM }).load({ format: 'hex', text: ':00000001FF' })).toThrow(/app images/);
  });
});
