import type { McuPin, NetState } from '@benchtop/core';
import { Strength } from '@benchtop/core';
import type { SocProblem } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { CODE_S2_REBOOT, CODE_S2_ROM_MISSING, CODE_S2_SLEEP_UNSUPPORTED, CODE_S2_WIFI_UNSUPPORTED, createEsp32s2Mcu, type Esp32s2Mcu, S2_MCU_GPIOS } from './esp32s2-mcu.ts';
import { REF_HZ } from './soc/rtc-cntl.ts';
import { s2FixtureImage } from './test-support/boot.test-helper.ts';
import { loadCachedS2Rom } from './test-support/rom.test-helper.ts';

// BT150: the ESP32-S2 behind the Mcu contract, over BT148's and BT149's fixtures.
const ROM = loadCachedS2Rom();

function boot(name: string): { mcu: Esp32s2Mcu; serial: () => string; problems: SocProblem[] } {
  const mcu = createEsp32s2Mcu({ rom: ROM });
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  mcu.load({ format: 'esp32-bin', ...s2FixtureImage(name) });
  let text = '';
  mcu.uart(0)?.onTransmit((byte) => {
    text += String.fromCharCode(byte);
  });
  return { mcu, serial: () => text, problems };
}

function run(mcu: Esp32s2Mcu, seconds: number, until: () => boolean = () => false): void {
  const end = mcu.cycles + seconds * REF_HZ;
  while (mcu.cycles < end && !until()) {
    const result = mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    if (result.reason === 'halted') throw new Error(result.detail ?? 'halted');
  }
}

const net = (volts: number | null): NetState => ({ level: volts === null ? null : volts > 1.65 ? 1 : 0, volts: volts ?? 0, strength: volts === null ? Strength.hiz : Strength.strong }) as NetState;
const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

describe('the ESP32-S2 Mcu (BT150)', () => {
  it('is an esp32s2 with GPIO0–21, 26 and 33–46 (not the flash pads 27–32) and a 240 MHz reference clock; UART0 is the serial port', () => {
    const { mcu, serial, problems } = boot('serial-hello');
    expect(mcu.kind).toBe('esp32s2');
    expect(mcu.clockHz).toBe(240_000_000);
    const ids = [...mcu.pins.keys()];
    expect(ids).toHaveLength(37);
    for (const g of [0, 21, 26, 33, 46]) expect(ids).toContain(`GPIO${g}`);
    for (const g of [22, 25, 27, 32, 47]) expect(ids).not.toContain(`GPIO${g}`);
    expect(S2_MCU_GPIOS[22]).toBe(26);
    run(mcu, 1.3, () => serial().includes('tick 1'));
    expect(serial()).toBe('hello from esp32s2\r\ntick 1\n');
    expect(mcu.uart(0)?.pins?.()).toEqual({ tx: 'GPIO43', rx: 'GPIO44' });
    expect(Math.abs((mcu.uart(0)?.baud?.() ?? 0) / 115200 - 1)).toBeLessThan(0.0005);
    expect(mcu.uart(1)).toBeDefined();
    expect(mcu.uart(2)).toBeUndefined();
    expect(problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('a CDC-on-boot build: the bench\'s host opens the S2\'s own USB, port 0 shows it beside UART0, typed bytes go to it', () => {
    const { mcu, serial, problems } = boot('usb-cdc');
    run(mcu, 0.8, () => serial().includes('tick 0'));
    expect(serial()).toContain('uart0 here\r\n');
    expect(serial()).toContain('usb cdc up baud 115200\n');
    mcu.uart(0)?.receive(bytes('ping\n'));
    run(mcu, 0.1, () => serial().includes('echo ping'));
    expect(serial()).toContain('echo ping\n');
    const host = mcu.usbHost();
    expect(host?.device).toBe('ESP32S2_DEV');
    expect(host?.functions).toEqual(['serial (CDC-ACM)']);
    expect(problems.filter((p) => p.severity !== 'info')).toEqual([]);
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

  it('a pin’s volts reach the 13-bit ADC (adc-read: GPIO1 at 1.0 V, GPIO11 on ADC2 at 2.0 V)', () => {
    const { mcu, serial } = boot('adc-read');
    (mcu.pins.get('GPIO1') as McuPin).setInput(net(1.0));
    (mcu.pins.get('GPIO11') as McuPin).setInput(net(2.0));
    run(mcu, 0.4);
    const lines = serial().split('\n').filter((l) => l.startsWith('a='));
    expect(lines.at(-1)).toMatch(/^a=3276 z=8191 r=409 c=\d+,\d+,\d+,1638$/);
    expect(mcu.pins.get('GPIO1')?.mode()).toBe('analog');
  });

  it('I2C and SPI follow the firmware’s routing, with the Arduino defaults before it', () => {
    const fresh = createEsp32s2Mcu({ rom: ROM });
    expect(fresh.i2c(0)?.pins()).toEqual({ sda: 'GPIO8', scl: 'GPIO9' });
    expect(fresh.spi(2)?.pins()).toEqual({ sck: 'GPIO36', mosi: 'GPIO35', miso: 'GPIO37' });
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
    debug.setBreakpoint(0x40080020);
    mcu.reset();
    expect(debug.breakpoints()).toEqual([0x40080020]);
    expect(mcu.soc.core.breakpoints.has(0x40080020)).toBe(true);
    expect(mcu.nonVolatile()).not.toBeNull();
    mcu.soc.flash.data[0x3e0000] = 0x5a;
    mcu.reset();
    expect(mcu.soc.flash.data[0x3e0000]).toBe(0x5a);
  });

  it('a software reset boots a fresh chip at the same time and says so; RTC slow memory survives it', () => {
    const { mcu, problems, serial } = boot('serial-hello');
    run(mcu, 0.6, () => serial().includes('hello from esp32s2\r\n'));
    const before = mcu.soc;
    before.memory.rtcSlow[0x100] = 0xa5;
    const at = mcu.cycles;
    before.rtc.write32(0, 1 << 31); // OPTIONS0.SW_SYS_RST, as esp_restart does
    run(mcu, 0.6, () => serial().split('hello from esp32s2').length > 2);
    expect(mcu.soc).not.toBe(before);
    expect(mcu.soc.memory.rtcSlow[0x100]).toBe(0xa5);
    expect(mcu.cycles).toBeGreaterThan(at);
    expect(problems.some((p) => p.code === CODE_S2_REBOOT && /SW_SYS/.test(p.message))).toBe(true);
    expect(serial().split('hello from esp32s2').length).toBe(3);
  });

  it('not modeled yet, and said so: sleep halts the run; the radio\'s registers report WiFi once per boot', () => {
    const { mcu, problems, serial } = boot('serial-hello');
    run(mcu, 0.6, () => serial().includes('hello from esp32s2\r\n'));
    mcu.soc.periph.write32(0x3f41d100, 1, 0); // BB, not a power-down control
    mcu.soc.periph.write32(0x3f41d104, 1, 0);
    expect(problems.filter((p) => p.code === CODE_S2_WIFI_UNSUPPORTED)).toHaveLength(1);
    mcu.soc.rtc.write32(0x18, 1 << 31); // STATE0.SLEEP_EN, as esp_deep_sleep_start does
    expect(problems.filter((p) => p.code === CODE_S2_SLEEP_UNSUPPORTED)).toHaveLength(1);
    const result = mcu.runUntil(mcu.cycles + REF_HZ / 100);
    expect(result.reason).toBe('halted');
    expect(result.detail).toMatch(/sleep isn't modeled on the ESP32-S2 yet/);
  });

  it('without the ROM it exists, says how to get it, and won’t run', () => {
    const mcu = createEsp32s2Mcu();
    const problems: SocProblem[] = [];
    mcu.onProblem = (p) => problems.push(p);
    expect(problems.map((p) => p.code)).toEqual([CODE_S2_ROM_MISSING]);
    expect(problems[0].message).toMatch(/npm run fetch:esp32-rom/);
    expect(mcu.runUntil(1000).reason).toBe('halted');
    expect(() => createEsp32s2Mcu({ rom: ROM }).load({ format: 'intel-hex', data: new Uint8Array(0) } as never)).toThrow(/runs app images/);
  });
});
