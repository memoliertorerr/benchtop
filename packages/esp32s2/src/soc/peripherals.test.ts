import type { I2cDevice } from '@benchtop/core';
import { S3_PAD_MODE } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { bootS2Fixture } from '../test-support/boot.test-helper.ts';
import { S2_SIG } from './gpio.ts';
import { REF_HZ } from './rtc-cntl.ts';
import type { Esp32s2Soc } from './soc.ts';

// BT149: the S2's peripherals under real firmware (fixtures/sketches/esp32s2/*) — the S3's GPIO,
// LEDC, SENS and USB-OTG models, the ESP32's I2C, SPI and RMT, at the S2's addresses.

const ms = (cycles: number): number => (cycles / REF_HZ) * 1000;
const ns = (cycles: number): number => (cycles / REF_HZ) * 1e9;
const run = (soc: Esp32s2Soc, seconds: number): void => {
  soc.runUntil(soc.time + seconds * REF_HZ);
};
const quiet = (soc: Esp32s2Soc) => soc.problems.problems.filter((p) => p.severity !== 'info');

/** Frequency (Hz) and duty (0–1) of a pin's edges between two times (seconds). */
function pwm(edges: [number, number][], from: number, to: number): { hz: number; duty: number } {
  const e = edges.filter(([t]) => t >= from * REF_HZ && t < to * REF_HZ);
  const rises = e.filter(([, l]) => l === 1).map(([t]) => t);
  const first = rises[0];
  const last = rises[rises.length - 1];
  let high = 0;
  for (let i = 0; i + 1 < e.length; i++) if (e[i][1] === 1 && e[i][0] >= first && e[i + 1][0] <= last) high += e[i + 1][0] - e[i][0];
  return { hz: ((rises.length - 1) * REF_HZ) / (last - first), duty: high / (last - first) };
}

/** GPIO `g`'s level changes as [time, level]. */
function recordEdges(soc: Esp32s2Soc, g: number): [number, number][] {
  const edges: [number, number][] = [];
  let level = soc.pads.level[g];
  soc.pads.onPin = (pin) => {
    if (pin !== g || soc.pads.level[g] === level) return;
    level = soc.pads.level[g];
    edges.push([soc.now(), level]);
  };
  return edges;
}

describe('ESP32-S2 GPIO (BT149)', () => {
  it('blink: GPIO2 toggles every 500 ms; the loop task\'s 5-tick yield every 2 s shows as one 505 ms interval', () => {
    const { soc } = bootS2Fixture('blink');
    const edges = recordEdges(soc, 2);
    run(soc, 10.2);
    expect(soc.pads.mode[2]).toBe(S3_PAD_MODE.OUTPUT);
    // From the second interval on: the first delay starts part-way into a tick.
    const intervals = edges.slice(2).map(([t], i) => ms(t - edges[i + 1][0]));
    expect(intervals.length).toBeGreaterThanOrEqual(18);
    // Arduino-ESP32 2.0.17 on a single core: loopTask calls yieldIfNecessary(), a vTaskDelay(5)
    // whenever 2 s have passed — as on the C3 and on real S2 boards.
    const long = intervals.filter((v) => Math.abs(v - 505) < 0.01);
    expect(intervals.every((v) => Math.abs(v - 500) < 0.01 || Math.abs(v - 505) < 0.01)).toBe(true);
    expect(long.length).toBeGreaterThanOrEqual(4);
    expect(long.length).toBeLessThanOrEqual(5);
    expect(quiet(soc)).toEqual([]);
  });

  it('gpio-interrupt: five FALLING presses on GPIO41 count to five; the LED on GPIO38 follows within 2 ms (the second GPIO word)', () => {
    const { soc, uart } = bootS2Fixture('gpio-interrupt');
    soc.gpio.setPadInput(41, 1); // released: the pull-up
    run(soc, 0.1);
    expect(soc.pads.mode[41]).toBe(S3_PAD_MODE.PULLUP);
    const led = recordEdges(soc, 38);
    for (let i = 0; i < 5; i++) {
      const pressed = soc.time;
      soc.gpio.setPadInput(41, 0);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(1);
      expect(ms(led[led.length - 1][0] - pressed)).toBeLessThan(2);
      soc.gpio.setPadInput(41, 1);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(0);
    }
    expect(uart[0]).toBe('count=1\ncount=2\ncount=3\ncount=4\ncount=5\n');
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S2 ADC (BT149)', () => {
  it('adc-read: ADC1 and ADC2 one-shot conversions through SENS — 13-bit codes, attenuation ranges, resolution, a voltage change', () => {
    const { soc, uart } = bootS2Fixture('adc-read');
    const volts: Record<number, number> = { 1: 1.0, 2: 0.5, 3: 3.3, 4: 0, 11: 2.0 };
    soc.padVolts = (g) => volts[g] ?? 0;
    run(soc, 0.3);
    const lines = uart[0].split('\n').filter((l) => l.startsWith('a='));
    expect(lines.length).toBeGreaterThan(5);
    // 1.0 V of 2.5 V (11 dB) is 0.4 of 8191; 0 dB's 0.75 V saturates; 10 bits drop the low three;
    // at 12 bits GPIO2 0.5 V, GPIO3 above the range, GPIO4 0 V, GPIO11 (ADC2 channel 0) 2.0 V —
    // 6553, which core 2.0.17 maps to the resolution twice (__analogReadRaw, then __analogRead),
    // so ADC2 drops two bits where ADC1 drops one, as on a real S2.
    expect(lines[lines.length - 1]).toBe('a=3276 z=8191 r=409 c=819,4095,0,1638');
    for (const g of [1, 2, 3, 4, 11]) expect(soc.pads.mode[g]).toBe(S3_PAD_MODE.ANALOG);
    volts[1] = 0.3;
    volts[11] = 0;
    const before = uart[0].length;
    run(soc, 0.1);
    const after = uart[0].slice(before).split('\n').filter((l) => l.startsWith('a='));
    expect(after[after.length - 1]).toBe('a=983 z=3276 r=122 c=819,4095,0,0');
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S2 LEDC (BT149)', () => {
  it('ledc-fade: analogWrite at 1 kHz / 25 %, a 5 kHz channel at 50 % then 25 % from a period boundary', () => {
    const { soc, uart } = bootS2Fixture('ledc-fade');
    const a = recordEdges(soc, 4);
    run(soc, 0.4);
    const b = recordEdges(soc, 5);
    expect(uart[0]).toBe('ready\r\n');
    const fast = pwm(a, 0.3, 0.4);
    expect(fast.hz).toBeCloseTo(1000, 0);
    expect(Math.abs(fast.duty - 0.25)).toBeLessThan(0.005);
    run(soc, 0.6);
    const half = pwm(b, 0.5, 0.95);
    expect(half.hz).toBeCloseTo(5000, 0);
    expect(Math.abs(half.duty - 0.5)).toBeLessThan(0.005);
    run(soc, 0.3);
    const quarter = pwm(b, 1.05, 1.3);
    expect(Math.abs(quarter.duty - 0.25)).toBeLessThan(0.005);
    const rises = b.filter(([, l]) => l === 1).map(([t]) => t);
    for (let i = 1; i < rises.length; i++) expect(Math.abs(ns(rises[i] - rises[i - 1]) - 200_000)).toBeLessThan(30);
    expect(soc.pads.mode[4]).toBe(S3_PAD_MODE.PERIPHERAL);
    expect(quiet(soc)).toEqual([]);
  });
});

/** An I2C device that ACKs everything; reads give `value`. */
function device(address: number, read: () => number = () => 0xff): I2cDevice & { written: number[] } {
  const written: number[] = [];
  return { address, written, start: () => true, write: (b) => (written.push(b), true), read: () => read(), stop: () => {} };
}

describe('ESP32-S2 I2C (BT149)', () => {
  it('i2c-scan: each controller finds exactly its bus\'s devices, then reads a register back', () => {
    const { soc, uart } = bootS2Fixture('i2c-scan');
    const rtc = device(0x68, () => 0x42);
    soc.i2c[0].devices = [device(0x3c), rtc];
    soc.i2c[1].devices = [device(0x27)];
    for (const g of [8, 9, 39, 40]) soc.gpio.setPadInput(g, 1);
    run(soc, 1.3);
    expect(uart[0]).toBe('found 0x3C\nfound 0x68\nfound1 0x27\ndone\r\nsec=42\n');
    expect(rtc.written).toEqual([0]);
    expect([soc.pads.pinOfOutSignal(S2_SIG.I2C0_SDA), soc.pads.pinOfOutSignal(S2_SIG.I2C0_SCL)]).toEqual([8, 9]);
    expect([soc.pads.pinOfOutSignal(S2_SIG.I2C1_SDA), soc.pads.pinOfOutSignal(S2_SIG.I2C1_SCL)]).toEqual([39, 40]);
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S2 SPI2 (BT149)', () => {
  it('spi-loopback: every mode and bit order reaches a selected device; with CS high nothing does', () => {
    const { soc, uart } = bootS2Fixture('spi-loopback');
    let seen = 0;
    soc.spi2.devices = [{ device: { transfer: (m) => (seen++, ~m & 0xff) }, selected: () => soc.pads.mode[34] === S3_PAD_MODE.OUTPUT && soc.pads.level[34] === 0 }];
    run(soc, 0.5);
    expect(uart[0]).toBe('f1m sum=32640\nf8m sum=32640\nflsb sum=32640\nfm3 sum=32640\nnocs sum=4080\ndone\r\n');
    expect(seen).toBe(4 * 256);
    expect([soc.pads.pinOfOutSignal(S2_SIG.FSPICLK), soc.pads.pinOfOutSignal(S2_SIG.FSPID), soc.pads.pinOfInSignal(S2_SIG.FSPIQ)]).toEqual([36, 35, 37]);
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S2 RMT (BT149)', () => {
  it('rgb-blink: the DevKitM-1\'s WS2812 on GPIO18 gets red, green, blue, LED_BUILTIN white and off, with WS2812 timing (±50 ns)', () => {
    const { soc, uart } = bootS2Fixture('rgb-blink');
    const edges = recordEdges(soc, 18);
    run(soc, 2.4);
    expect(uart[0]).toBe('step 0\nstep 1\nstep 2\nstep 3\nstep 4\n');
    expect(soc.pads.mode[18]).toBe(S3_PAD_MODE.PERIPHERAL);
    const frames: { high: number; low: number }[][] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      if (edges[i][1] !== 1) continue;
      const high = ns(edges[i + 1][0] - edges[i][0]);
      const low = i + 2 < edges.length ? ns(edges[i + 2][0] - edges[i + 1][0]) : Number.POSITIVE_INFINITY;
      if (frames.length === 0 || ns(edges[i][0] - edges[i - 1][0]) > 50_000) frames.push([]);
      frames[frames.length - 1].push({ high, low });
    }
    const colors = frames.map((frame) => {
      expect(frame.length).toBe(24);
      let grb = 0;
      frame.forEach(({ high, low }, bit) => {
        const one = high > 600;
        expect(Math.abs(high - (one ? 800 : 400))).toBeLessThanOrEqual(50);
        if (bit < 23) expect(Math.abs(low - (one ? 400 : 800))).toBeLessThanOrEqual(50);
        grb = (grb << 1) | (one ? 1 : 0);
      });
      return [(grb >>> 8) & 0xff, (grb >>> 16) & 0xff, grb & 0xff];
    });
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [64, 64, 64],
      [0, 0, 0],
    ]);
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S2 USB-OTG (BT149)', () => {
  it('usb-cdc (CDC on boot): the bench\'s host enumerates the S2, opens its port, and Serial talks both ways', () => {
    const { soc, uart } = bootS2Fixture('usb-cdc');
    let usb = '';
    const notes: string[] = [];
    soc.usbOtg.host.onData = (b, n) => {
      for (let i = 0; i < n; i++) usb += String.fromCharCode(b[i]);
    };
    soc.usbOtg.host.onNote = (m) => notes.push(m);
    const runMs = (n: number) => {
      for (let i = 0; i < n; i++) soc.runUntil(soc.now() + REF_HZ / 1000);
    };
    runMs(600);
    expect(uart[0]).toBe('uart0 here\r\n');
    expect(soc.usbOtg.host.productName).toBe('ESP32S2_DEV');
    expect(soc.usbOtg.host.ports.length).toBe(1);
    expect(usb).toBe('usb cdc up baud 115200\ntick 0\n');
    soc.usbOtg.send(new TextEncoder().encode('ping 42\n'));
    runMs(10);
    expect(usb.endsWith('echo ping 42\n')).toBe(true);
    expect(notes).toEqual([]);
    expect(quiet(soc)).toEqual([]);
  });

  it('a build that never touches USB-OTG starts no frames', () => {
    const { soc } = bootS2Fixture('blink');
    run(soc, 0.05);
    expect(soc.usbOtg.active).toBe(false);
  });
});
