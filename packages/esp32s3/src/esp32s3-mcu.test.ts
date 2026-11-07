import type { McuPin, NetState } from '@benchtop/core';
import { Strength } from '@benchtop/core';
import type { SocProblem } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { CODE_S3_REBOOT, CODE_S3_ROM_MISSING, createEsp32s3Mcu, type Esp32s3Mcu, S3_MCU_GPIOS } from './esp32s3-mcu.ts';
import { REF_HZ } from './soc/rtc-cntl.ts';
import { s3FixtureImage } from './test-support/boot.test-helper.ts';
import { loadCachedS3Rom } from './test-support/rom.test-helper.ts';

// BT126: the ESP32-S3 behind the Mcu contract, over BT125's fixtures.
const ROM = loadCachedS3Rom();

function boot(name: string): { mcu: Esp32s3Mcu; serial: () => string; problems: SocProblem[] } {
  const mcu = createEsp32s3Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...s3FixtureImage(name) });
  let text = '';
  mcu.uart(0)?.onTransmit((byte) => {
    text += String.fromCharCode(byte);
  });
  return { mcu, serial: () => text, problems };
}

function run(mcu: Esp32s3Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    if (result.reason === 'halted') throw new Error(result.detail ?? 'halted');
  }
}

const net = (volts: number | null): NetState => ({ level: volts === null ? null : volts > 1.65 ? 1 : 0, volts: volts ?? 0, strength: volts === null ? Strength.hiz : Strength.strong }) as NetState;
const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

describe('the ESP32-S3 Mcu (BT126)', () => {
  it('is an esp32s3 with GPIO0–21 and 33–48 (not the flash pads) and a 240 MHz reference clock; UART0 is the serial port', () => {
    const { mcu, serial, problems } = boot('serial-hello');
    expect(mcu.kind).toBe('esp32s3');
    expect(mcu.clockHz).toBe(240_000_000);
    const ids = [...mcu.pins.keys()];
    expect(ids).toHaveLength(38);
    expect(ids).toContain('GPIO0');
    expect(ids).toContain('GPIO48');
    for (const g of [22, 26, 32]) expect(ids).not.toContain(`GPIO${g}`);
    expect(S3_MCU_GPIOS[22]).toBe(33);
    run(mcu, 1.3, () => serial().includes('tick 1'));
    expect(serial()).toBe('hello from esp32s3\r\ntick 1\n');
    expect(mcu.uart(0)?.pins?.()).toEqual({ tx: 'GPIO43', rx: 'GPIO44' });
    expect(Math.abs((mcu.uart(0)?.baud?.() ?? 0) / 115200 - 1)).toBeLessThan(0.0005);
    expect(problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('shows a CDC build’s USB-Serial-JTAG output on port 0, and sends typed bytes there', () => {
    const { mcu, serial } = boot('cdc-hello');
    run(mcu, 0.6, () => serial().includes('hello over usb'));
    expect(serial()).toContain('hello over usb');
    mcu.uart(0)?.receive(bytes('ping\n'));
    run(mcu, 0.3, () => serial().includes('> ping'));
    expect(serial()).toContain('> ping');
  });

  it('typed bytes reach UART0 for a UART build; UART1 is uart(1) on its routed pins', () => {
    const { mcu, serial } = boot('serial-echo');
    run(mcu, 0.6, () => serial().includes('ready'));
    mcu.uart(0)?.receive(bytes('abc\n'));
    run(mcu, 0.2, () => serial().includes('> ABC\r\n'));
    expect(serial()).toContain('> ABC\r\n');
    let one = '';
    mcu.uart(1)?.onTransmit((b) => (one += String.fromCharCode(b)));
    expect(mcu.uart(1)?.pins?.()).toEqual({ tx: 'GPIO17', rx: 'GPIO18' });
    mcu.uart(1)?.receive(bytes('xyz\n'));
    run(mcu, 0.2, () => one.includes('> XYZ\r\n'));
    expect(one).toBe('> XYZ\r\n');
    expect(mcu.uart(2)).toBeDefined();
    expect(mcu.uart(3)).toBeUndefined();
  });

  it('pins: inputs through 3.3 V thresholds, outputs with listeners (a button on GPIO41, the LED on GPIO38)', () => {
    const { mcu, serial } = boot('gpio-interrupt');
    const button = mcu.pins.get('GPIO41') as McuPin;
    const led = mcu.pins.get('GPIO38') as McuPin;
    let changes = 0;
    led.onOutputChange(() => changes++);
    button.setInput(net(3.3));
    run(mcu, 0.4);
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

  it('a pin’s volts reach the ADC (adc-read: GPIO1 at 1.24 V, GPIO11 on ADC2 at 2.48 V)', () => {
    const { mcu, serial } = boot('adc-read');
    (mcu.pins.get('GPIO1') as McuPin).setInput(net(1.24));
    (mcu.pins.get('GPIO11') as McuPin).setInput(net(2.48));
    run(mcu, 0.4);
    const lines = serial().split('\n').filter((l) => l.startsWith('a='));
    expect(lines.at(-1)).toMatch(/^a=1638 z=4095 r=409 c=\d+,\d+,\d+,3276$/);
    expect(mcu.pins.get('GPIO1')?.mode()).toBe('analog');
  });

  it('I2C and SPI follow the firmware’s routing, with the Arduino defaults before it', () => {
    const fresh = createEsp32s3Mcu({ rom: ROM });
    expect(fresh.i2c(0)?.pins()).toEqual({ sda: 'GPIO8', scl: 'GPIO9' });
    expect(fresh.spi(2)?.pins()).toEqual({ sck: 'GPIO12', mosi: 'GPIO11', miso: 'GPIO13' });
    const { mcu } = boot('i2c-scan');
    run(mcu, 0.4);
    expect(mcu.i2c(0)?.pins()).toEqual({ sda: 'GPIO8', scl: 'GPIO9' });
    expect(mcu.i2c(1)?.pins()).toEqual({ sda: 'GPIO39', scl: 'GPIO40' });
    expect(mcu.i2c(2)).toBeUndefined();
    expect(mcu.spi(3)).toBeUndefined();
  });

  it('breakpoints outlive a reset; the debugger reads the current SoC; the flash outlives resets', () => {
    const { mcu } = boot('serial-hello');
    const debug = mcu.debug();
    debug.setBreakpoint(0x42000020);
    mcu.reset();
    expect(debug.breakpoints()).toEqual([0x42000020]);
    expect(mcu.soc.cores[0].breakpoints.has(0x42000020)).toBe(true);
    expect(mcu.soc.cores[1].breakpoints.has(0x42000020)).toBe(true);
    const nvm = mcu.nonVolatile();
    expect(nvm).not.toBeNull();
    const flash = mcu.soc.flash.data;
    flash[0x3e0000] = 0x5a;
    mcu.reset();
    expect(mcu.soc.flash.data[0x3e0000]).toBe(0x5a);
  });

  it('a software reset boots a fresh chip at the same time and says so; RTC slow memory survives it', () => {
    const { mcu, problems, serial } = boot('serial-hello');
    run(mcu, 0.6, () => serial().includes('hello from esp32s3\r\n'));
    const before = mcu.soc;
    before.memory.rtcSlow[0x100] = 0xa5;
    const at = mcu.cycles;
    before.rtc.write32(0, 1 << 31); // OPTIONS0.SW_SYS_RST, as esp_restart does
    run(mcu, 0.6, () => serial().split('hello from esp32s3').length > 2);
    expect(mcu.soc).not.toBe(before);
    expect(mcu.soc.memory.rtcSlow[0x100]).toBe(0xa5);
    expect(mcu.cycles).toBeGreaterThan(at);
    expect(problems.some((p) => p.code === CODE_S3_REBOOT && /SW_SYS/.test(p.message))).toBe(true);
    expect(serial().split('hello from esp32s3').length).toBe(3);
  });

  it('BT128: sleepState says how it sleeps and what wakes it; the ext pins hold their RTC pulls', () => {
    const { mcu, serial } = boot('deep-sleep-pins');
    // No bench here to apply the RTC pulls to the nets: the pins read as those pulls would hold them.
    (mcu.pins.get('GPIO4') as McuPin).setInput(net(3.3));
    (mcu.pins.get('GPIO5') as McuPin).setInput(net(0));
    run(mcu, 0.8);
    expect(serial()).toContain('boot 1 cause 0');
    expect(mcu.sleepState()).toEqual({ deep: true, wakeIn: null, pins: ['GPIO4 low', 'GPIO5 high (any)'] });
    expect(mcu.pins.get('GPIO4')?.mode()).toBe('input-pullup');
    expect(mcu.pins.get('GPIO5')?.mode()).toBe('input-pulldown');
    const timer = boot('deep-sleep-timer');
    run(timer.mcu, 0.8);
    const state = timer.mcu.sleepState();
    expect(state?.deep).toBe(true);
    expect(state?.pins).toEqual([]);
    expect(state?.wakeIn ?? 0).toBeGreaterThan(1.2e9);
    expect(state?.wakeIn ?? 0).toBeLessThanOrEqual(2e9);
    const awake = boot('serial-hello');
    run(awake.mcu, 0.5);
    expect(awake.mcu.sleepState()).toBeNull();
  });

  it('without its ROM it says how to get it and won’t run', () => {
    const mcu = createEsp32s3Mcu();
    const problems: SocProblem[] = [];
    mcu.onProblem = (p) => problems.push(p);
    expect(problems.map((p) => p.code)).toEqual([CODE_S3_ROM_MISSING]);
    expect(problems[0].message).toMatch(/fetch:esp32-rom/);
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage('serial-hello') });
    expect(mcu.runUntil(1000)).toMatchObject({ reason: 'halted' });
    const bad = createEsp32s3Mcu({ rom: ROM.slice(1) });
    expect(bad.romProblem).toMatch(/isn't the pinned/);
    expect(() => createEsp32s3Mcu({ rom: ROM }).load({ format: 'hex', text: ':00000001FF' })).toThrow(/app images/);
    // An ESP32 image is refused at load, and the Mcu keeps what it had.
    const s3 = createEsp32s3Mcu({ rom: ROM });
    expect(() => s3.load({ format: 'esp32-bin', ...s3FixtureImage('serial-hello'), app: new Uint8Array(0) })).toThrow(/can't boot/);
  });
});
